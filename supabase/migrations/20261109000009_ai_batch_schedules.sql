-- =============================================================================
-- Migration: 20261109000009_ai_batch_schedules.sql
-- Purpose  : スタッフ手動選択・開始日時指定による AI一括生成予約基盤
--            1. 予約管理テーブル `public.ai_batch_schedules`（固定商品ID・JST日時・除外理由・バッチ紐付け）
--            2. 原子的予約登録 RPC `create_ai_batch_schedule_atomic`（request_id 冪等制御・通常/テスト混入DB防止）
--            3. 開始前キャンセル RPC `cancel_ai_batch_schedule_atomic`（開始後キャンセル拒否）
--            4. 期限到来予約の排他クレーム RPC `claim_due_ai_batch_schedules`（二重起動防止リース）
--            5. ディスパッチ完了/再試行記録 RPC `complete_ai_batch_schedule_dispatch`
--            6. `enqueue_ai_batch_job_atomic` の通常モード `is_test=true` 混入DB防御強化
-- =============================================================================

-- 1. 予約管理テーブル (`ai_batch_schedules`)
CREATE TABLE IF NOT EXISTS public.ai_batch_schedules (
  schedule_id TEXT PRIMARY KEY CHECK (btrim(schedule_id) <> ''),
  request_id TEXT NOT NULL UNIQUE CHECK (btrim(request_id) <> ''),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN (
      'scheduled',
      'starting',
      'dispatch_retry',
      'started',
      'completed_all_excluded',
      'cancelled',
      'failed'
    )),

  scheduled_at TIMESTAMPTZ NOT NULL,
  test_only BOOLEAN NOT NULL DEFAULT false,
  min_cost_markup_rate NUMERIC(8,4) NOT NULL DEFAULT 0.3000
    CHECK (min_cost_markup_rate > 0 AND min_cost_markup_rate <= 5.0000),

  product_ids TEXT[] NOT NULL
    CHECK (COALESCE(array_length(product_ids, 1), 0) BETWEEN 1 AND 500),
  product_names_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_image_ids_by_product JSONB NOT NULL DEFAULT '{}'::jsonb,
  excluded_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,

  batch_id TEXT NULL REFERENCES public.ai_batch_jobs(batch_id) ON DELETE SET NULL,

  dispatch_token TEXT NULL,
  dispatch_lease_expires_at TIMESTAMPTZ NULL,
  dispatch_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_retry_count >= 0),
  next_dispatch_retry_at TIMESTAMPTZ NULL,
  dispatch_error_code TEXT NULL,
  dispatch_error_message TEXT NULL,

  started_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_batch_schedules_due
  ON public.ai_batch_schedules (status, scheduled_at ASC, created_at ASC)
  WHERE status IN ('scheduled', 'dispatch_retry', 'starting');

CREATE INDEX IF NOT EXISTS idx_ai_batch_schedules_mode_created
  ON public.ai_batch_schedules (test_only, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_batch_schedules_batch_id
  ON public.ai_batch_schedules (batch_id)
  WHERE batch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ai_batch_schedules_set_updated_at ON public.ai_batch_schedules;
CREATE TRIGGER trg_ai_batch_schedules_set_updated_at
  BEFORE UPDATE ON public.ai_batch_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.ai_batch_schedules ENABLE ROW LEVEL SECURITY;

-- 2. `enqueue_ai_batch_job_atomic` の通常モード側テスト商品混入ガード強化
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
    IF NOT v_test_only AND v_existing.test_only IS TRUE THEN
      RAISE EXCEPTION 'TEST_PRODUCT_INCLUDED: request_id already bound to test batch';
    END IF;
    RETURN jsonb_build_object(
      'is_reused', true,
      'job', to_jsonb(v_existing)
    );
  END IF;

  -- DB層での最終防衛ライン: 通常/テスト双方の混入を受付前に拒否
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
  ELSE
    IF EXISTS (
      SELECT 1
        FROM unnest(p_product_ids) AS u(raw_pid)
        JOIN public.products pr
          ON pr.product_id = btrim(COALESCE(u.raw_pid, ''))
       WHERE pr.is_test IS TRUE
    ) THEN
      RAISE EXCEPTION 'TEST_PRODUCT_INCLUDED';
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

-- 3. 原子的予約登録 RPC (`create_ai_batch_schedule_atomic`)
CREATE OR REPLACE FUNCTION public.create_ai_batch_schedule_atomic(
  p_schedule_id TEXT,
  p_request_id TEXT,
  p_scheduled_at TIMESTAMPTZ,
  p_product_ids TEXT[],
  p_product_names_json JSONB DEFAULT '{}'::jsonb,
  p_selected_image_ids_by_product JSONB DEFAULT '{}'::jsonb,
  p_min_cost_markup_rate NUMERIC DEFAULT 0.3000,
  p_test_only BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sid TEXT := btrim(COALESCE(p_schedule_id, ''));
  v_req_id TEXT := btrim(COALESCE(p_request_id, ''));
  v_test_only BOOLEAN := COALESCE(p_test_only, false);
  v_total INTEGER := COALESCE(array_length(p_product_ids, 1), 0);
  v_existing public.ai_batch_schedules%ROWTYPE;
  v_created public.ai_batch_schedules%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_sid = '' OR v_req_id = '' THEN
    RAISE EXCEPTION 'p_schedule_id and p_request_id are required';
  END IF;
  IF p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'p_scheduled_at is required';
  END IF;
  IF v_total < 1 OR v_total > 500 THEN
    RAISE EXCEPTION 'BATCH_SIZE_EXCEEDED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_sched_req:' || v_req_id));

  SELECT *
    INTO v_existing
    FROM public.ai_batch_schedules
   WHERE request_id = v_req_id;

  IF FOUND THEN
    IF v_test_only AND v_existing.test_only IS NOT TRUE THEN
      RAISE EXCEPTION 'NON_TEST_PRODUCT_INCLUDED';
    END IF;
    IF NOT v_test_only AND v_existing.test_only IS TRUE THEN
      RAISE EXCEPTION 'TEST_PRODUCT_INCLUDED';
    END IF;
    RETURN jsonb_build_object(
      'is_reused', true,
      'schedule', to_jsonb(v_existing)
    );
  END IF;

  -- 予約時の通常/テスト混入防止（全件実在かつ指定モードに一致すること）
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
  ELSE
    IF EXISTS (
      SELECT 1
        FROM unnest(p_product_ids) AS u(raw_pid)
        LEFT JOIN public.products pr
          ON pr.product_id = btrim(COALESCE(u.raw_pid, ''))
       WHERE pr.product_id IS NULL
          OR pr.is_test IS TRUE
    ) THEN
      RAISE EXCEPTION 'TEST_PRODUCT_INCLUDED';
    END IF;
  END IF;

  INSERT INTO public.ai_batch_schedules (
    schedule_id,
    request_id,
    status,
    scheduled_at,
    test_only,
    min_cost_markup_rate,
    product_ids,
    product_names_json,
    selected_image_ids_by_product,
    excluded_items_json,
    created_at,
    updated_at
  ) VALUES (
    v_sid,
    v_req_id,
    'scheduled',
    p_scheduled_at,
    v_test_only,
    COALESCE(p_min_cost_markup_rate, 0.3000),
    p_product_ids,
    COALESCE(p_product_names_json, '{}'::jsonb),
    COALESCE(p_selected_image_ids_by_product, '{}'::jsonb),
    '[]'::jsonb,
    v_now,
    v_now
  )
  RETURNING * INTO v_created;

  RETURN jsonb_build_object(
    'is_reused', false,
    'schedule', to_jsonb(v_created)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_ai_batch_schedule_atomic(
  TEXT, TEXT, TIMESTAMPTZ, TEXT[], JSONB, JSONB, NUMERIC, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ai_batch_schedule_atomic(
  TEXT, TEXT, TIMESTAMPTZ, TEXT[], JSONB, JSONB, NUMERIC, BOOLEAN
) TO service_role;

-- 4. 開始前予約キャンセル RPC (`cancel_ai_batch_schedule_atomic`)
CREATE OR REPLACE FUNCTION public.cancel_ai_batch_schedule_atomic(
  p_schedule_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sid TEXT := btrim(COALESCE(p_schedule_id, ''));
  v_row public.ai_batch_schedules%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_sid = '' THEN
    RAISE EXCEPTION 'p_schedule_id is required';
  END IF;

  SELECT *
    INTO v_row
    FROM public.ai_batch_schedules
   WHERE schedule_id = v_sid
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false,
      'cancelled', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  IF v_row.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'found', true,
      'cancelled', true,
      'is_reused', true,
      'schedule', to_jsonb(v_row)
    );
  END IF;

  -- 開始前（scheduled または原価取得再試行待ち dispatch_retry、かつ batch_id 未生成）のみ取消可能
  IF v_row.status IN ('scheduled', 'dispatch_retry') AND v_row.batch_id IS NULL THEN
    UPDATE public.ai_batch_schedules
       SET status = 'cancelled',
           cancelled_at = v_now,
           dispatch_token = NULL,
           dispatch_lease_expires_at = NULL,
           next_dispatch_retry_at = NULL,
           updated_at = v_now
     WHERE schedule_id = v_sid
     RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'found', true,
      'cancelled', true,
      'is_reused', false,
      'schedule', to_jsonb(v_row)
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'cancelled', false,
    'reason', 'ALREADY_STARTED',
    'schedule', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_ai_batch_schedule_atomic(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_ai_batch_schedule_atomic(TEXT)
  TO service_role;

-- 5. 期限到来予約の排他クレーム RPC (`claim_due_ai_batch_schedules`)
CREATE OR REPLACE FUNCTION public.claim_due_ai_batch_schedules(
  p_limit INTEGER DEFAULT 1,
  p_lease_seconds INTEGER DEFAULT 180,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_limit INTEGER := GREATEST(COALESCE(p_limit, 1), 1);
  v_lease_secs INTEGER := GREATEST(COALESCE(p_lease_seconds, 180), 30);
  v_claimed_count INTEGER := 0;
  v_result JSONB := '[]'::jsonb;
  v_cand public.ai_batch_schedules%ROWTYPE;
  v_updated public.ai_batch_schedules%ROWTYPE;
  v_token TEXT;
  v_lease_exp TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_schedule_dispatch'));

  FOR v_cand IN
    SELECT *
      FROM public.ai_batch_schedules s
     WHERE s.batch_id IS NULL
       AND (
             (
               s.status = 'scheduled'
               AND s.scheduled_at <= v_now
             )
             OR
             (
               s.status = 'dispatch_retry'
               AND s.scheduled_at <= v_now
               AND (s.next_dispatch_retry_at IS NULL OR s.next_dispatch_retry_at <= v_now)
             )
             OR
             (
               s.status = 'starting'
               AND (s.dispatch_lease_expires_at IS NULL OR s.dispatch_lease_expires_at <= v_now)
             )
           )
     ORDER BY s.scheduled_at ASC, s.created_at ASC
     FOR UPDATE SKIP LOCKED
  LOOP
    EXIT WHEN v_claimed_count >= v_limit;

    v_token := 'DSP_' || to_char(v_now, 'YYYYMMDDHH24MISSMS') || '_' ||
               substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8);
    v_lease_exp := v_now + make_interval(secs => v_lease_secs);

    UPDATE public.ai_batch_schedules
       SET status = 'starting',
           dispatch_token = v_token,
           dispatch_lease_expires_at = v_lease_exp,
           updated_at = v_now
     WHERE schedule_id = v_cand.schedule_id
     RETURNING * INTO v_updated;

    v_result := v_result || jsonb_build_array(to_jsonb(v_updated));
    v_claimed_count := v_claimed_count + 1;
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_ai_batch_schedules(INTEGER, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_ai_batch_schedules(INTEGER, INTEGER, TIMESTAMPTZ)
  TO service_role;

-- 6. ディスパッチ完了/再試行記録 RPC (`complete_ai_batch_schedule_dispatch`)
CREATE OR REPLACE FUNCTION public.complete_ai_batch_schedule_dispatch(
  p_schedule_id TEXT,
  p_dispatch_token TEXT,
  p_outcome TEXT,
  p_batch_id TEXT DEFAULT NULL,
  p_excluded_items_json JSONB DEFAULT '[]'::jsonb,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_retry_count INTEGER DEFAULT NULL,
  p_next_dispatch_retry_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sid TEXT := btrim(COALESCE(p_schedule_id, ''));
  v_tok TEXT := btrim(COALESCE(p_dispatch_token, ''));
  v_outcome TEXT := btrim(COALESCE(p_outcome, ''));
  v_row public.ai_batch_schedules%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_sid = '' OR v_tok = '' THEN
    RAISE EXCEPTION 'p_schedule_id and p_dispatch_token are required';
  END IF;

  SELECT *
    INTO v_row
    FROM public.ai_batch_schedules
   WHERE schedule_id = v_sid
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_FOUND');
  END IF;

  -- 既に開始完了または取消済みの場合は冪等にそのまま返す
  IF v_row.status IN ('started', 'completed_all_excluded', 'cancelled') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'ALREADY_FINALIZED',
      'schedule', to_jsonb(v_row)
    );
  END IF;

  IF COALESCE(v_row.dispatch_token, '') <> v_tok THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'TOKEN_MISMATCH',
      'schedule', to_jsonb(v_row)
    );
  END IF;

  IF v_outcome = 'started' THEN
    IF NULLIF(btrim(COALESCE(p_batch_id, '')), '') IS NULL THEN
      RAISE EXCEPTION 'p_batch_id is required when p_outcome = started';
    END IF;
    UPDATE public.ai_batch_schedules
       SET status = 'started',
           batch_id = btrim(p_batch_id),
           excluded_items_json = COALESCE(p_excluded_items_json, '[]'::jsonb),
           dispatch_token = NULL,
           dispatch_lease_expires_at = NULL,
           next_dispatch_retry_at = NULL,
           dispatch_error_code = NULL,
           dispatch_error_message = NULL,
           started_at = COALESCE(started_at, v_now),
           updated_at = v_now
     WHERE schedule_id = v_sid
     RETURNING * INTO v_row;

  ELSIF v_outcome = 'completed_all_excluded' THEN
    UPDATE public.ai_batch_schedules
       SET status = 'completed_all_excluded',
           excluded_items_json = COALESCE(p_excluded_items_json, '[]'::jsonb),
           dispatch_token = NULL,
           dispatch_lease_expires_at = NULL,
           next_dispatch_retry_at = NULL,
           dispatch_error_code = NULL,
           dispatch_error_message = NULL,
           started_at = COALESCE(started_at, v_now),
           completed_at = COALESCE(completed_at, v_now),
           updated_at = v_now
     WHERE schedule_id = v_sid
     RETURNING * INTO v_row;

  ELSIF v_outcome = 'dispatch_retry' THEN
    UPDATE public.ai_batch_schedules
       SET status = 'dispatch_retry',
           dispatch_token = NULL,
           dispatch_lease_expires_at = NULL,
           dispatch_retry_count = COALESCE(p_retry_count, dispatch_retry_count + 1),
           next_dispatch_retry_at = p_next_dispatch_retry_at,
           dispatch_error_code = NULLIF(btrim(COALESCE(p_error_code, '')), ''),
           dispatch_error_message = NULLIF(btrim(COALESCE(p_error_message, '')), ''),
           updated_at = v_now
     WHERE schedule_id = v_sid
     RETURNING * INTO v_row;

  ELSIF v_outcome = 'failed' THEN
    UPDATE public.ai_batch_schedules
       SET status = 'failed',
           excluded_items_json = COALESCE(p_excluded_items_json, excluded_items_json),
           dispatch_token = NULL,
           dispatch_lease_expires_at = NULL,
           next_dispatch_retry_at = NULL,
           dispatch_retry_count = COALESCE(p_retry_count, dispatch_retry_count),
           dispatch_error_code = NULLIF(btrim(COALESCE(p_error_code, '')), ''),
           dispatch_error_message = NULLIF(btrim(COALESCE(p_error_message, '')), ''),
           completed_at = COALESCE(completed_at, v_now),
           updated_at = v_now
     WHERE schedule_id = v_sid
     RETURNING * INTO v_row;

  ELSE
    RAISE EXCEPTION 'Unsupported p_outcome: %', v_outcome;
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'schedule', to_jsonb(v_row)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_batch_schedule_dispatch(
  TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, INTEGER, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_batch_schedule_dispatch(
  TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, INTEGER, TIMESTAMPTZ
) TO service_role;
