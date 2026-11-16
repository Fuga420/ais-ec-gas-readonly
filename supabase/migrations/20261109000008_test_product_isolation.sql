-- =============================================================================
-- Migration: 20261109000008_test_product_isolation.sql
-- Purpose  : 夜間AI一括生成に向けたテスト商品の最小分離基盤
--            1. `public.products.is_test` 追加（既存商品はすべて `false`）
--            2. 通常一覧・公開一覧での取得段階除外用複合インデックス追加
--            3. `public.ai_batch_jobs.test_only` 追加 & 原子的キュー登録 RPC での二重ガード
--            4. ワーカークレーム RPC への `job_test_only` 伝播
-- =============================================================================

-- 1. 商品マスタへの `is_test` フラグ追加（既存レコードはすべて `false`）
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_is_test_record_row_seq
  ON public.products (is_test, record_status, row_seq DESC);

-- 2. AI一括生成ジョブへの `test_only` フラグ追加
ALTER TABLE public.ai_batch_jobs
  ADD COLUMN IF NOT EXISTS test_only BOOLEAN NOT NULL DEFAULT false;

-- 3. 原子的バッチジョブ登録 RPC 更新（旧9引数シグネチャを DROP してオーバーロード衝突を防止）
DROP FUNCTION IF EXISTS public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB
);

CREATE OR REPLACE FUNCTION public.enqueue_ai_batch_job_atomic(
  p_batch_id TEXT,
  p_request_id TEXT,
  p_product_ids TEXT[],
  p_job_source TEXT DEFAULT 'manual',
  p_force_regenerate BOOLEAN DEFAULT false,
  p_model_name TEXT DEFAULT '',
  p_min_cost_markup_rate NUMERIC DEFAULT 0.3000,
  p_product_costs_json JSONB DEFAULT '{}'::jsonb,
  p_selected_image_ids_by_product JSONB DEFAULT '{}'::jsonb,
  p_test_only BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid TEXT := btrim(COALESCE(p_batch_id, ''));
  v_req_id TEXT := btrim(COALESCE(p_request_id, ''));
  v_source TEXT := COALESCE(NULLIF(btrim(p_job_source), ''), 'manual');
  v_test_only BOOLEAN := COALESCE(p_test_only, false);
  v_existing public.ai_batch_jobs%ROWTYPE;
  v_created public.ai_batch_jobs%ROWTYPE;
  v_total INTEGER := COALESCE(array_length(p_product_ids, 1), 0);
  v_now TIMESTAMPTZ := now();
  v_idx INTEGER;
  v_pid TEXT;
  v_sel_json JSONB;
  v_sel_arr TEXT[];
BEGIN
  IF v_bid = '' OR v_req_id = '' THEN
    RAISE EXCEPTION 'p_batch_id and p_request_id are required';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'p_product_ids must not be empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_req:' || v_req_id));

  SELECT *
    INTO v_existing
    FROM public.ai_batch_jobs
   WHERE request_id = v_req_id;

  IF FOUND THEN
    IF v_test_only AND v_existing.test_only IS NOT TRUE THEN
      RAISE EXCEPTION 'NON_TEST_PRODUCT_INCLUDED: request_id already bound to non-test batch';
    END IF;
    RETURN jsonb_build_object(
      'is_reused', true,
      'job', to_jsonb(v_existing)
    );
  END IF;

  -- DB層での最終防衛ライン: test_only=true の場合、対象IDがすべて実在かつ is_test=true でなければ受付前に拒否
  IF v_test_only THEN
    IF EXISTS (
      SELECT 1
        FROM unnest(p_product_ids) AS u(raw_pid)
        LEFT JOIN public.products pr
          ON pr.product_id = btrim(COALESCE(u.raw_pid, ''))
       WHERE pr.product_id IS NULL
          OR pr.is_test IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'NON_TEST_PRODUCT_INCLUDED';
    END IF;
  END IF;

  INSERT INTO public.ai_batch_jobs (
    batch_id,
    request_id,
    job_source,
    status,
    total_count,
    completed_count,
    failed_count,
    processing_count,
    force_regenerate,
    test_only,
    model_name,
    min_cost_markup_rate,
    product_costs_json,
    retry_requests,
    created_at,
    updated_at,
    completed_at
  ) VALUES (
    v_bid,
    v_req_id,
    v_source,
    'queued',
    v_total,
    0,
    0,
    0,
    COALESCE(p_force_regenerate, false),
    v_test_only,
    COALESCE(btrim(p_model_name), ''),
    COALESCE(p_min_cost_markup_rate, 0.3000),
    COALESCE(p_product_costs_json, '{}'::jsonb),
    '{}'::jsonb,
    v_now,
    v_now,
    NULL
  )
  RETURNING * INTO v_created;

  FOR v_idx IN 1..v_total LOOP
    v_pid := btrim(COALESCE(p_product_ids[v_idx], ''));
    v_sel_arr := '{}'::TEXT[];
    IF p_selected_image_ids_by_product IS NOT NULL
       AND jsonb_typeof(p_selected_image_ids_by_product) = 'object'
       AND (p_selected_image_ids_by_product ? v_pid) THEN
      v_sel_json := p_selected_image_ids_by_product -> v_pid;
      IF jsonb_typeof(v_sel_json) = 'array' THEN
        SELECT COALESCE(array_agg(elem), '{}'::TEXT[])
          INTO v_sel_arr
          FROM jsonb_array_elements_text(v_sel_json) AS elem
         WHERE btrim(elem) <> '';
      END IF;
    END IF;

    INSERT INTO public.ai_batch_items (
      batch_id,
      product_id,
      item_index,
      status,
      selected_image_ids,
      created_at,
      updated_at
    ) VALUES (
      v_bid,
      v_pid,
      v_idx - 1,
      'pending',
      COALESCE(v_sel_arr, '{}'::TEXT[]),
      v_now,
      v_now
    );
  END LOOP;

  RETURN jsonb_build_object(
    'is_reused', false,
    'job', to_jsonb(v_created)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN
) TO service_role;

-- 4. ワーカークレーム RPC 更新（`job_test_only` を返却）
CREATE OR REPLACE FUNCTION public.claim_ai_batch_queue_items(
  p_limit INTEGER DEFAULT 1,
  p_max_global_concurrency INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_req_limit INTEGER := GREATEST(COALESCE(p_limit, 1), 1);
  v_max_global INTEGER := GREATEST(COALESCE(p_max_global_concurrency, 2), 1);
  v_lease_secs INTEGER := GREATEST(COALESCE(p_lease_seconds, 300), 30);
  v_active_count INTEGER := 0;
  v_slots INTEGER := 0;
  v_claimed_count INTEGER := 0;
  v_seen_products TEXT[] := '{}'::TEXT[];
  v_affected_batches TEXT[] := '{}'::TEXT[];
  v_result JSONB := '[]'::jsonb;
  v_cand RECORD;
  v_exec_id TEXT;
  v_lease_exp TIMESTAMPTZ;
  v_job RECORD;
  v_bid TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_queue_claim'));

  SELECT COUNT(*)::INTEGER
    INTO v_active_count
    FROM public.ai_batch_items
   WHERE status = 'processing'
     AND lease_expires_at > v_now;

  v_slots := LEAST(v_req_limit, GREATEST(0, v_max_global - v_active_count));
  IF v_slots <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_cand IN
    SELECT i.*
      FROM public.ai_batch_items i
     WHERE (
             (i.status = 'pending' AND (i.next_retry_at IS NULL OR i.next_retry_at <= v_now))
             OR
             (i.status = 'processing' AND (i.lease_expires_at IS NULL OR i.lease_expires_at <= v_now))
           )
       AND NOT EXISTS (
             SELECT 1
               FROM public.ai_batch_items active_i
              WHERE active_i.product_id = i.product_id
                AND active_i.id <> i.id
                AND active_i.status = 'processing'
                AND active_i.lease_expires_at > v_now
           )
     ORDER BY i.created_at ASC, i.item_index ASC, i.id ASC
     FOR UPDATE OF i SKIP LOCKED
  LOOP
    EXIT WHEN v_claimed_count >= v_slots;

    IF v_cand.product_id = ANY(v_seen_products) THEN
      CONTINUE;
    END IF;

    v_exec_id := 'WRK_' || to_char(v_now, 'YYYYMMDDHH24MISSMS') || '_' ||
                 substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8);
    v_lease_exp := v_now + make_interval(secs => v_lease_secs);

    UPDATE public.ai_batch_items
       SET status = 'processing',
           worker_execution_id = v_exec_id,
           lease_expires_at = v_lease_exp,
           updated_at = v_now
     WHERE id = v_cand.id;

    SELECT
      j.job_source,
      j.force_regenerate,
      j.test_only AS job_test_only,
      j.model_name AS job_model_name,
      j.min_cost_markup_rate,
      j.product_costs_json
      INTO v_job
      FROM public.ai_batch_jobs j
     WHERE j.batch_id = v_cand.batch_id;

    v_seen_products := array_append(v_seen_products, v_cand.product_id);
    IF NOT (v_cand.batch_id = ANY(v_affected_batches)) THEN
      v_affected_batches := array_append(v_affected_batches, v_cand.batch_id);
    END IF;

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'id', v_cand.id,
        'batch_id', v_cand.batch_id,
        'product_id', v_cand.product_id,
        'item_index', v_cand.item_index,
        'selected_image_ids', COALESCE(to_jsonb(v_cand.selected_image_ids), '[]'::jsonb),
        'linked_draft_id', COALESCE(v_cand.draft_id, ''),
        'retry_count', v_cand.retry_count,
        'worker_execution_id', v_exec_id,
        'lease_expires_at', v_lease_exp,
        'job_source', COALESCE(v_job.job_source, 'manual'),
        'force_regenerate', COALESCE(v_job.force_regenerate, false),
        'job_test_only', COALESCE(v_job.job_test_only, false),
        'job_model_name', COALESCE(v_job.job_model_name, ''),
        'min_cost_markup_rate', COALESCE(v_job.min_cost_markup_rate, 0.3000),
        'product_cost', CASE
          WHEN v_job.product_costs_json IS NOT NULL
               AND jsonb_typeof(v_job.product_costs_json) = 'object'
               AND (v_job.product_costs_json ? v_cand.product_id)
          THEN v_job.product_costs_json -> v_cand.product_id
          ELSE 'null'::jsonb
        END
      )
    );

    v_claimed_count := v_claimed_count + 1;
  END LOOP;

  FOREACH v_bid IN ARRAY v_affected_batches LOOP
    PERFORM public.recompute_ai_batch_job_summary(v_bid);
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_batch_queue_items(INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_batch_queue_items(INTEGER, INTEGER, INTEGER)
  TO service_role;

