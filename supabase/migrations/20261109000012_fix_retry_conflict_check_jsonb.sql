-- =============================================================================
-- Migration: 20261109000012_fix_retry_conflict_check_jsonb.sql
-- Purpose:
--   Fix type mismatch in `public.retry_ai_batch_failed_items_atomic`:
--   `public.find_active_ai_batch_product_conflicts` returns `JSONB`
--   (`{ has_conflict, conflicting_product_ids, conflicts, conflicts_csv }`),
--   so receive it into `v_conflict_check JSONB` and inspect `has_conflict`
--   and `conflicts_csv` (matching `enqueue_ai_batch_job_atomic` and
--   `create_ai_batch_schedule_atomic`).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retry_ai_batch_failed_items_atomic(
  p_batch_id TEXT,
  p_request_id TEXT,
  p_updated_product_costs JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid TEXT := btrim(COALESCE(p_batch_id, ''));
  v_req_id TEXT := btrim(COALESCE(p_request_id, ''));
  v_now TIMESTAMPTZ := now();
  v_now_iso TEXT;
  v_job public.ai_batch_jobs%ROWTYPE;
  v_retry_map JSONB;
  v_prev_entry JSONB;
  v_failed_product_ids TEXT[];
  v_conflict_check JSONB;
  v_retried_count INTEGER := 0;
  v_completed_count INTEGER := 0;
  v_failed_count INTEGER := 0;
  v_processing_count INTEGER := 0;
  v_next_status TEXT;
  v_response JSONB;
BEGIN
  IF v_bid = '' OR v_req_id = '' THEN
    RAISE EXCEPTION 'p_batch_id and p_request_id are required';
  END IF;

  -- Serialize active-product overlap checks across enqueue, schedule creation, and failed-item retry
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_active_products_guard'));
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_job:' || v_bid));

  SELECT *
    INTO v_job
    FROM public.ai_batch_jobs
   WHERE batch_id = v_bid
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false
    );
  END IF;

  v_retry_map := COALESCE(v_job.retry_requests, '{}'::jsonb);
  IF jsonb_typeof(v_retry_map) <> 'object' THEN
    v_retry_map := '{}'::jsonb;
  END IF;

  -- 1. Idempotent replay check FIRST (before active-product conflict check)
  IF v_retry_map ? v_req_id THEN
    v_prev_entry := v_retry_map -> v_req_id;
    RETURN jsonb_build_object(
      'found', true,
      'is_reused', true,
      'response', (COALESCE(v_prev_entry -> 'response', '{}'::jsonb) || jsonb_build_object(
        'batch_id', v_bid,
        'request_id', v_req_id,
        'is_reused', true
      ))
    );
  END IF;

  -- 2. Identify failed items in this batch and verify none are active in another batch/schedule
  SELECT COALESCE(array_agg(DISTINCT product_id ORDER BY product_id), '{}'::TEXT[])
    INTO v_failed_product_ids
    FROM public.ai_batch_items
   WHERE batch_id = v_bid
     AND status = 'failed';

  IF COALESCE(array_length(v_failed_product_ids, 1), 0) > 0 THEN
    v_conflict_check := public.find_active_ai_batch_product_conflicts(
      v_failed_product_ids,
      NULL,
      v_bid
    );
    IF COALESCE((v_conflict_check ->> 'has_conflict')::BOOLEAN, false) THEN
      RAISE EXCEPTION 'PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:%',
        COALESCE(v_conflict_check ->> 'conflicts_csv', '');
    END IF;
  END IF;

  IF p_updated_product_costs IS NOT NULL AND jsonb_typeof(p_updated_product_costs) = 'object' THEN
    UPDATE public.ai_batch_jobs
       SET product_costs_json = COALESCE(product_costs_json, '{}'::jsonb) || p_updated_product_costs
     WHERE batch_id = v_bid;
  END IF;

  -- 3. Flip ONLY status = 'failed' items back to 'pending' (completed / processing untouched)
  UPDATE public.ai_batch_items
     SET status = 'pending',
         draft_id = CASE
           WHEN COALESCE(error_code, '') IN (
             'SEARCH_GROUNDING_NOT_EXECUTED',
             'SEARCH_GROUNDING_NO_SOURCES',
             'STAGE_A_MAX_TOKENS',
             'STAGE_A_EMPTY_RESPONSE',
             'SELECTED_IMAGE_DELETED',
             'INVALID_IMAGE_SELECTION',
             'DUPLICATE_SELECTED_IMAGE_ID',
             'IMAGE_COUNT_EXCEEDED'
           )
           OR COALESCE(error_code, '') LIKE 'SEARCH_%'
           OR COALESCE(error_code, '') LIKE 'STAGE_A_%'
           THEN NULL
           ELSE draft_id
         END,
         draft_version = CASE
           WHEN COALESCE(error_code, '') IN (
             'SEARCH_GROUNDING_NOT_EXECUTED',
             'SEARCH_GROUNDING_NO_SOURCES',
             'STAGE_A_MAX_TOKENS',
             'STAGE_A_EMPTY_RESPONSE',
             'SELECTED_IMAGE_DELETED',
             'INVALID_IMAGE_SELECTION',
             'DUPLICATE_SELECTED_IMAGE_ID',
             'IMAGE_COUNT_EXCEEDED'
           )
           OR COALESCE(error_code, '') LIKE 'SEARCH_%'
           OR COALESCE(error_code, '') LIKE 'STAGE_A_%'
           THEN NULL
           ELSE draft_version
         END,
         model_name = CASE
           WHEN COALESCE(error_code, '') IN (
             'SEARCH_GROUNDING_NOT_EXECUTED',
             'SEARCH_GROUNDING_NO_SOURCES',
             'STAGE_A_MAX_TOKENS',
             'STAGE_A_EMPTY_RESPONSE',
             'SELECTED_IMAGE_DELETED',
             'INVALID_IMAGE_SELECTION',
             'DUPLICATE_SELECTED_IMAGE_ID',
             'IMAGE_COUNT_EXCEEDED'
           )
           OR COALESCE(error_code, '') LIKE 'SEARCH_%'
           OR COALESCE(error_code, '') LIKE 'STAGE_A_%'
           THEN NULL
           ELSE model_name
         END,
         error_code = NULL,
         error_message = NULL,
         retry_count = 0,
         next_retry_at = NULL,
         worker_execution_id = NULL,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE batch_id = v_bid
     AND status = 'failed';

  GET DIAGNOSTICS v_retried_count = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE status = 'completed')::INTEGER,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER,
    COUNT(*) FILTER (WHERE status = 'processing')::INTEGER
    INTO v_completed_count, v_failed_count, v_processing_count
    FROM public.ai_batch_items
   WHERE batch_id = v_bid;

  v_now_iso := to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  IF v_retried_count > 0 THEN
    v_next_status := CASE WHEN v_processing_count > 0 THEN 'processing' ELSE 'queued' END;
    UPDATE public.ai_batch_jobs
       SET status = v_next_status,
           completed_count = v_completed_count,
           failed_count = v_failed_count,
           processing_count = v_processing_count,
           updated_at = v_now,
           completed_at = NULL
     WHERE batch_id = v_bid
     RETURNING * INTO v_job;

    v_response := jsonb_build_object(
      'success', true,
      'batch_id', v_bid,
      'request_id', v_req_id,
      'status', v_next_status,
      'total_count', v_job.total_count,
      'retried_count', v_retried_count,
      'completed_count', v_completed_count,
      'failed_count', v_failed_count,
      'is_reused', false,
      'updated_at', v_now_iso
    );
  ELSE
    v_response := jsonb_build_object(
      'success', false,
      'error_code', 'NO_FAILED_ITEMS',
      'message', 'No failed items to retry in batch: ' || v_bid,
      'batch_id', v_bid,
      'request_id', v_req_id,
      'status', v_job.status,
      'total_count', v_job.total_count,
      'retried_count', 0,
      'completed_count', v_completed_count,
      'failed_count', v_failed_count,
      'is_reused', false,
      'updated_at', v_now_iso
    );
  END IF;

  -- Keep up to 50 most recent retry_requests entries
  WITH merged_entries AS (
    SELECT key, value
      FROM jsonb_each(
        v_retry_map || jsonb_build_object(
          v_req_id,
          jsonb_build_object('processed_at', v_now_iso, 'response', v_response)
        )
      )
     ORDER BY COALESCE(value ->> 'processed_at', '') DESC
     LIMIT 50
  )
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    INTO v_retry_map
    FROM merged_entries;

  UPDATE public.ai_batch_jobs
     SET retry_requests = v_retry_map
   WHERE batch_id = v_bid;

  RETURN jsonb_build_object(
    'found', true,
    'is_reused', false,
    'retried_count', v_retried_count,
    'response', v_response
  );
END;
$$;

REVOKE ALL ON FUNCTION public.retry_ai_batch_failed_items_atomic(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_ai_batch_failed_items_atomic(TEXT, TEXT, JSONB)
  TO service_role;
