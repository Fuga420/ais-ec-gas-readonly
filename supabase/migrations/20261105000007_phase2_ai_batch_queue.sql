-- =============================================================================
-- Migration: 20261105000007_phase2_ai_batch_queue.sql
-- Purpose  : Phase 2 Unit 5 — 手動AI一括生成の Cloud Run + Supabase キュー移行
--            （および将来の夜間定期実行 `scheduled_nightly` で共通利用する永続キュー基盤）
--            1. バッチジョブ管理テーブル `public.ai_batch_jobs` (request_id 冪等制御・原価スナップショット保持)
--            2. 商品別キューアイテムテーブル `public.ai_batch_items` (20件上限撤廃・リース排他・再試行制御)
--            3. 原子的キュー登録・排他クレーム(全体同時実行数上限対応)・所有権検証・完了反映・失敗分再試行 RPC群
-- =============================================================================

-- 1. バッチジョブ管理テーブル (`ai_batch_jobs`)
CREATE TABLE IF NOT EXISTS public.ai_batch_jobs (
  batch_id TEXT PRIMARY KEY CHECK (btrim(batch_id) <> ''),
  request_id TEXT NOT NULL UNIQUE CHECK (btrim(request_id) <> ''),
  job_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (job_source IN ('manual', 'scheduled_nightly', 'api')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'partially_failed', 'failed')),

  total_count INTEGER NOT NULL CHECK (total_count > 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  processing_count INTEGER NOT NULL DEFAULT 0 CHECK (processing_count >= 0),

  force_regenerate BOOLEAN NOT NULL DEFAULT false,
  model_name TEXT NOT NULL DEFAULT '',
  min_cost_markup_rate NUMERIC(8,4) NOT NULL DEFAULT 0.3000
    CHECK (min_cost_markup_rate > 0 AND min_cost_markup_rate <= 5.0000),
  product_costs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_requests JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_created_at
  ON public.ai_batch_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_status
  ON public.ai_batch_jobs (status);

CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_source_created
  ON public.ai_batch_jobs (job_source, created_at DESC);

DROP TRIGGER IF EXISTS trg_ai_batch_jobs_set_updated_at ON public.ai_batch_jobs;
CREATE TRIGGER trg_ai_batch_jobs_set_updated_at
  BEFORE UPDATE ON public.ai_batch_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.ai_batch_jobs ENABLE ROW LEVEL SECURITY;

-- 2. 商品別キューアイテムテーブル (`ai_batch_items`)
-- ※ 存在しない product_id が混在しても他商品の処理を継続し商品単位の PRODUCT_NOT_FOUND として記録できるよう
--    products への外部キー制約は張らず、batch_id のみ ON DELETE CASCADE とする。
CREATE TABLE IF NOT EXISTS public.ai_batch_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES public.ai_batch_jobs(batch_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL CHECK (btrim(product_id) <> ''),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

  selected_image_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  source_image_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  draft_id TEXT NULL,
  draft_version INTEGER NULL,
  model_name TEXT NULL,

  proposed_price INTEGER NULL,
  price_basis TEXT NULL,
  price_note TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at TIMESTAMPTZ NULL,

  worker_execution_id TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_ai_batch_items_batch_product UNIQUE (batch_id, product_id),
  CONSTRAINT uq_ai_batch_items_batch_index UNIQUE (batch_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_ai_batch_items_batch_order
  ON public.ai_batch_items (batch_id, item_index ASC);

CREATE INDEX IF NOT EXISTS idx_ai_batch_items_queue_ready
  ON public.ai_batch_items (status, next_retry_at, created_at ASC, item_index ASC)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_ai_batch_items_product_latest
  ON public.ai_batch_items (product_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_ai_batch_items_set_updated_at ON public.ai_batch_items;
CREATE TRIGGER trg_ai_batch_items_set_updated_at
  BEFORE UPDATE ON public.ai_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.ai_batch_items ENABLE ROW LEVEL SECURITY;

-- 3-1. バッチジョブ集計・ステータス再計算 RPC
CREATE OR REPLACE FUNCTION public.recompute_ai_batch_job_summary(
  p_batch_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid TEXT := btrim(COALESCE(p_batch_id, ''));
  v_now TIMESTAMPTZ := now();
  v_total INTEGER := 0;
  v_completed INTEGER := 0;
  v_failed INTEGER := 0;
  v_processing INTEGER := 0;
  v_pending INTEGER := 0;
  v_next_status TEXT := 'queued';
  v_is_terminal BOOLEAN := false;
  v_job public.ai_batch_jobs%ROWTYPE;
BEGIN
  IF v_bid = '' THEN
    RAISE EXCEPTION 'p_batch_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_job:' || v_bid));

  SELECT *
    INTO v_job
    FROM public.ai_batch_jobs
   WHERE batch_id = v_bid
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE status = 'completed')::INTEGER,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER,
    COUNT(*) FILTER (WHERE status = 'processing')::INTEGER,
    COUNT(*) FILTER (WHERE status = 'pending')::INTEGER
    INTO v_total, v_completed, v_failed, v_processing, v_pending
    FROM public.ai_batch_items
   WHERE batch_id = v_bid;

  IF v_total <= 0 THEN
    v_total := v_job.total_count;
  END IF;

  IF v_completed = v_total AND v_total > 0 THEN
    v_next_status := 'completed';
    v_is_terminal := true;
  ELSIF v_failed = v_total AND v_total > 0 THEN
    v_next_status := 'failed';
    v_is_terminal := true;
  ELSIF (v_completed + v_failed) = v_total AND v_total > 0 THEN
    v_next_status := 'partially_failed';
    v_is_terminal := true;
  ELSIF v_processing > 0 OR v_completed > 0 OR v_failed > 0 THEN
    v_next_status := 'processing';
    v_is_terminal := false;
  ELSE
    v_next_status := 'queued';
    v_is_terminal := false;
  END IF;

  UPDATE public.ai_batch_jobs
     SET status = v_next_status,
         total_count = v_total,
         completed_count = v_completed,
         failed_count = v_failed,
         processing_count = v_processing,
         updated_at = v_now,
         completed_at = CASE
           WHEN v_is_terminal THEN COALESCE(completed_at, v_now)
           ELSE NULL
         END
   WHERE batch_id = v_bid
   RETURNING * INTO v_job;

  RETURN to_jsonb(v_job);
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_ai_batch_job_summary(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_ai_batch_job_summary(TEXT)
  TO service_role;

-- 3-2. 原子的バッチジョブ + 商品キュー一括登録 RPC (`request_id` 重複防止付き)
CREATE OR REPLACE FUNCTION public.enqueue_ai_batch_job_atomic(
  p_batch_id TEXT,
  p_request_id TEXT,
  p_product_ids TEXT[],
  p_job_source TEXT DEFAULT 'manual',
  p_force_regenerate BOOLEAN DEFAULT false,
  p_model_name TEXT DEFAULT '',
  p_min_cost_markup_rate NUMERIC DEFAULT 0.3000,
  p_product_costs_json JSONB DEFAULT '{}'::jsonb,
  p_selected_image_ids_by_product JSONB DEFAULT '{}'::jsonb
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
    RETURN jsonb_build_object(
      'is_reused', true,
      'job', to_jsonb(v_existing)
    );
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
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB
) TO service_role;

-- 3-3. キューアイテム原子的クレーム RPC（クラスタ全体の同時実行数上限・リース期限切れ回収・同一商品重複実行抑止）
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

-- 3-4. ワーカー所有権検証 & コミット前 draft_id 予約 RPC（Fencing / 中断後回収用）
CREATE OR REPLACE FUNCTION public.verify_or_reserve_ai_batch_item_ownership(
  p_item_id BIGINT,
  p_worker_execution_id TEXT,
  p_draft_id TEXT DEFAULT NULL,
  p_model_name TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exec TEXT := btrim(COALESCE(p_worker_execution_id, ''));
  v_now TIMESTAMPTZ := now();
  v_updated INTEGER := 0;
BEGIN
  IF p_item_id IS NULL OR v_exec = '' THEN
    RETURN false;
  END IF;

  IF p_draft_id IS NOT NULL AND btrim(p_draft_id) <> '' THEN
    UPDATE public.ai_batch_items
       SET draft_id = btrim(p_draft_id),
           model_name = COALESCE(NULLIF(btrim(p_model_name), ''), model_name),
           updated_at = v_now
     WHERE id = p_item_id
       AND status = 'processing'
       AND worker_execution_id = v_exec
       AND lease_expires_at > v_now;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.ai_batch_items
     WHERE id = p_item_id
       AND status = 'processing'
       AND worker_execution_id = v_exec
       AND lease_expires_at > v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_or_reserve_ai_batch_item_ownership(BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_or_reserve_ai_batch_item_ownership(BIGINT, TEXT, TEXT, TEXT)
  TO service_role;

-- 3-5. キューアイテム処理結果保存 & 親バッチ集計更新 RPC（Fencing保護付き）
CREATE OR REPLACE FUNCTION public.complete_ai_batch_queue_item(
  p_item_id BIGINT,
  p_worker_execution_id TEXT,
  p_outcome TEXT,
  p_draft_id TEXT DEFAULT NULL,
  p_draft_version INTEGER DEFAULT NULL,
  p_model_name TEXT DEFAULT NULL,
  p_proposed_price INTEGER DEFAULT NULL,
  p_price_basis TEXT DEFAULT NULL,
  p_price_note TEXT DEFAULT NULL,
  p_source_image_ids TEXT[] DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_retry_count INTEGER DEFAULT NULL,
  p_next_retry_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exec TEXT := btrim(COALESCE(p_worker_execution_id, ''));
  v_now TIMESTAMPTZ := now();
  v_item public.ai_batch_items%ROWTYPE;
  v_summary JSONB;
BEGIN
  IF p_item_id IS NULL OR v_exec = '' THEN
    RETURN jsonb_build_object('committed', false, 'fenced', true);
  END IF;

  SELECT *
    INTO v_item
    FROM public.ai_batch_items
   WHERE id = p_item_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('committed', false, 'fenced', true);
  END IF;

  IF v_item.status <> 'processing' OR COALESCE(v_item.worker_execution_id, '') <> v_exec THEN
    RETURN jsonb_build_object(
      'committed', false,
      'fenced', true,
      'current_status', v_item.status,
      'current_worker_execution_id', COALESCE(v_item.worker_execution_id, '')
    );
  END IF;

  IF p_outcome = 'completed' THEN
    UPDATE public.ai_batch_items
       SET status = 'completed',
           draft_id = COALESCE(NULLIF(btrim(p_draft_id), ''), draft_id),
           draft_version = COALESCE(p_draft_version, draft_version),
           model_name = COALESCE(NULLIF(btrim(p_model_name), ''), model_name),
           proposed_price = p_proposed_price,
           price_basis = COALESCE(p_price_basis, ''),
           price_note = COALESCE(p_price_note, ''),
           source_image_ids = COALESCE(p_source_image_ids, source_image_ids),
           error_code = NULL,
           error_message = NULL,
           next_retry_at = NULL,
           lease_expires_at = NULL,
           updated_at = v_now
     WHERE id = p_item_id;
  ELSIF p_outcome = 'retry_pending' THEN
    UPDATE public.ai_batch_items
       SET status = 'pending',
           error_code = NULLIF(btrim(COALESCE(p_error_code, '')), ''),
           error_message = NULLIF(btrim(COALESCE(p_error_message, '')), ''),
           retry_count = COALESCE(p_retry_count, retry_count + 1),
           next_retry_at = p_next_retry_at,
           worker_execution_id = NULL,
           lease_expires_at = NULL,
           updated_at = v_now
     WHERE id = p_item_id;
  ELSE
    UPDATE public.ai_batch_items
       SET status = 'failed',
           draft_id = COALESCE(NULLIF(btrim(p_draft_id), ''), draft_id),
           draft_version = COALESCE(p_draft_version, draft_version),
           model_name = COALESCE(NULLIF(btrim(p_model_name), ''), model_name),
           error_code = COALESCE(NULLIF(btrim(p_error_code), ''), 'GENERATION_FAILED'),
           error_message = COALESCE(NULLIF(btrim(p_error_message), ''), 'Failed to generate draft'),
           next_retry_at = NULL,
           lease_expires_at = NULL,
           updated_at = v_now
     WHERE id = p_item_id;
  END IF;

  v_summary := public.recompute_ai_batch_job_summary(v_item.batch_id);

  RETURN jsonb_build_object(
    'committed', true,
    'fenced', false,
    'job', v_summary
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_batch_queue_item(
  BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT[], TEXT, TEXT, INTEGER, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_batch_queue_item(
  BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT[], TEXT, TEXT, INTEGER, TIMESTAMPTZ
) TO service_role;

-- 3-6. 失敗商品のみ原子的再試行 RPC (`request_id` 冪等・完了済み保護・NO_FAILED_ITEMS 対応)
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

  IF p_updated_product_costs IS NOT NULL AND jsonb_typeof(p_updated_product_costs) = 'object' THEN
    UPDATE public.ai_batch_jobs
       SET product_costs_json = COALESCE(product_costs_json, '{}'::jsonb) || p_updated_product_costs
     WHERE batch_id = v_bid;
  END IF;

  -- status = 'failed' のアイテムのみ pending に戻す（completed / processing は一切触らない）
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

  -- 最新50件まで retry_requests を保持
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
