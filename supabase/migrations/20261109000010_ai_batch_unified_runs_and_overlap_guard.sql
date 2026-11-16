-- =============================================================================
-- Migration: 20261109000010_ai_batch_unified_runs_and_overlap_guard.sql
-- Purpose  : 1. 即時実行ジョブ (`ai_batch_jobs`) の動作モード別一覧取得インデックス追加
--            2. 予約 (`ai_batch_schedules`) への `force_regenerate` 列追加（完了後の意図的な再生成対応）
--            3. 予約中・処理待ち・処理中の商品重複チェック関数 `find_active_ai_batch_product_conflicts`
--            4. `enqueue_ai_batch_job_atomic` / `create_ai_batch_schedule_atomic` での
--               トランザクション排他ロック付き重複商品受付拒否（完了後・取消後の再生成は妨げない）
-- =============================================================================

-- 1. `ai_batch_schedules` に `force_regenerate` 列を追加（既定 false）
ALTER TABLE public.ai_batch_schedules
  ADD COLUMN IF NOT EXISTS force_regenerate BOOLEAN NOT NULL DEFAULT false;

-- 2. 即時実行一覧取得・アクティブ商品重複判定の高速化インデックス
CREATE INDEX IF NOT EXISTS idx_ai_batch_jobs_mode_created
  ON public.ai_batch_jobs (test_only, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_batch_items_active_product
  ON public.ai_batch_items (product_id, status)
  WHERE status IN ('pending', 'processing');

-- 3. アクティブ（予約中・処理待ち・処理中）な商品重複の検出ヘルパー関数
--    完了済み (`completed` / `partially_failed` / `failed`)・取消済み (`cancelled`)・
--    全件除外 (`completed_all_excluded`) のジョブは対象外とし、完了後の意図的な再生成は一切妨げない。
CREATE OR REPLACE FUNCTION public.find_active_ai_batch_product_conflicts(
  p_product_ids TEXT[],
  p_ignore_schedule_id TEXT DEFAULT NULL,
  p_ignore_batch_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ignore_sched TEXT := NULLIF(btrim(COALESCE(p_ignore_schedule_id, '')), '');
  v_ignore_batch TEXT := NULLIF(btrim(COALESCE(p_ignore_batch_id, '')), '');
  v_conflicts JSONB := '[]'::jsonb;
  v_conflict_ids TEXT[] := '{}'::TEXT[];
  v_conflicts_csv TEXT := '';
BEGIN
  IF COALESCE(array_length(p_product_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object(
      'has_conflict', false,
      'conflicting_product_ids', '[]'::jsonb,
      'conflicts', '[]'::jsonb,
      'conflicts_csv', ''
    );
  END IF;

  WITH requested AS (
    SELECT DISTINCT ON (btrim(COALESCE(raw_pid, '')))
      btrim(COALESCE(raw_pid, '')) AS pid,
      ord
    FROM unnest(p_product_ids) WITH ORDINALITY AS u(raw_pid, ord)
    WHERE btrim(COALESCE(raw_pid, '')) <> ''
    ORDER BY btrim(COALESCE(raw_pid, '')), ord ASC
  ),
  matched AS (
    SELECT
      r.pid,
      r.ord,
      COALESCE(item_hit.active_state, sched_hit.active_state) AS active_state,
      sched_hit.schedule_id,
      item_hit.batch_id
    FROM requested r
    LEFT JOIN LATERAL (
      SELECT
        i.status AS active_state,
        i.batch_id
      FROM public.ai_batch_items i
      WHERE i.product_id = r.pid
        AND i.status IN ('pending', 'processing')
        AND (v_ignore_batch IS NULL OR i.batch_id <> v_ignore_batch)
      ORDER BY CASE WHEN i.status = 'processing' THEN 0 ELSE 1 END, i.created_at ASC
      LIMIT 1
    ) item_hit ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        'scheduled'::TEXT AS active_state,
        s.schedule_id
      FROM public.ai_batch_schedules s
      WHERE s.status IN ('scheduled', 'starting', 'dispatch_retry')
        AND s.batch_id IS NULL
        AND r.pid = ANY(s.product_ids)
        AND (v_ignore_sched IS NULL OR s.schedule_id <> v_ignore_sched)
      ORDER BY s.scheduled_at ASC, s.created_at ASC
      LIMIT 1
    ) sched_hit ON TRUE
    WHERE item_hit.batch_id IS NOT NULL
       OR sched_hit.schedule_id IS NOT NULL
    ORDER BY r.ord ASC
  )
  SELECT
    COALESCE(array_agg(m.pid ORDER BY m.ord ASC), '{}'::TEXT[]),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'product_id', m.pid,
          'active_state', m.active_state,
          'schedule_id', m.schedule_id,
          'batch_id', m.batch_id
        )
        ORDER BY m.ord ASC
      ),
      '[]'::jsonb
    )
  INTO v_conflict_ids, v_conflicts
  FROM matched m;

  v_conflicts_csv := array_to_string(v_conflict_ids, ',');

  RETURN jsonb_build_object(
    'has_conflict', COALESCE(array_length(v_conflict_ids, 1), 0) > 0,
    'conflicting_product_ids', to_jsonb(v_conflict_ids),
    'conflicts', v_conflicts,
    'conflicts_csv', v_conflicts_csv
  );
END;
$$;

REVOKE ALL ON FUNCTION public.find_active_ai_batch_product_conflicts(
  TEXT[], TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_active_ai_batch_product_conflicts(
  TEXT[], TEXT, TEXT
) TO service_role;

-- 4. `enqueue_ai_batch_job_atomic` 更新（旧10引数シグネチャを DROP し、11引数 DEFAULT 付きへ統一）
DROP FUNCTION IF EXISTS public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN
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
  p_test_only BOOLEAN DEFAULT false,
  p_ignore_schedule_id TEXT DEFAULT NULL
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
  v_conflict_check JSONB;
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

  -- アクティブな商品重複チェックと新ジョブ登録を直列化する共通トランザクションロック
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_active_products_guard'));
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_req:' || v_req_id));

  -- 1. 同一 request_id の再送は重複エラーにせず冪等に既存ジョブを返す
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

  -- 2. 通常/テスト双方の混入を受付前に拒否
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

  -- 3. 予約中・処理待ち・処理中の商品との重複を受付前に拒否（ディスパッチャー自身の schedule_id は除外）
  v_conflict_check := public.find_active_ai_batch_product_conflicts(
    p_product_ids,
    p_ignore_schedule_id,
    NULL
  );
  IF COALESCE((v_conflict_check ->> 'has_conflict')::BOOLEAN, false) THEN
    RAISE EXCEPTION 'PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:%',
      COALESCE(v_conflict_check ->> 'conflicts_csv', '');
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
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_batch_job_atomic(
  TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN, TEXT
) TO service_role;

-- 5. `create_ai_batch_schedule_atomic` 更新（旧8引数シグネチャを DROP し、9引数 DEFAULT 付きへ統一）
DROP FUNCTION IF EXISTS public.create_ai_batch_schedule_atomic(
  TEXT, TEXT, TIMESTAMPTZ, TEXT[], JSONB, JSONB, NUMERIC, BOOLEAN
);

CREATE OR REPLACE FUNCTION public.create_ai_batch_schedule_atomic(
  p_schedule_id TEXT,
  p_request_id TEXT,
  p_scheduled_at TIMESTAMPTZ,
  p_product_ids TEXT[],
  p_product_names_json JSONB DEFAULT '{}'::jsonb,
  p_selected_image_ids_by_product JSONB DEFAULT '{}'::jsonb,
  p_min_cost_markup_rate NUMERIC DEFAULT 0.3000,
  p_test_only BOOLEAN DEFAULT false,
  p_force_regenerate BOOLEAN DEFAULT false
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
  v_force_regen BOOLEAN := COALESCE(p_force_regenerate, false);
  v_total INTEGER := COALESCE(array_length(p_product_ids, 1), 0);
  v_existing public.ai_batch_schedules%ROWTYPE;
  v_created public.ai_batch_schedules%ROWTYPE;
  v_conflict_check JSONB;
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

  -- アクティブな商品重複チェックと新規予約登録を直列化する共通トランザクションロック
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_active_products_guard'));
  PERFORM pg_advisory_xact_lock(hashtext('ai_batch_sched_req:' || v_req_id));

  -- 1. 同一 request_id の再送は重複エラーにせず冪等に既存予約を返す
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

  -- 2. 予約時の通常/テスト混入防止（全件実在かつ指定モードに一致すること）
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

  -- 3. 予約中・処理待ち・処理中の商品との重複を受付前に拒否
  v_conflict_check := public.find_active_ai_batch_product_conflicts(
    p_product_ids,
    NULL,
    NULL
  );
  IF COALESCE((v_conflict_check ->> 'has_conflict')::BOOLEAN, false) THEN
    RAISE EXCEPTION 'PRODUCT_ALREADY_IN_ACTIVE_AI_BATCH:%',
      COALESCE(v_conflict_check ->> 'conflicts_csv', '');
  END IF;

  INSERT INTO public.ai_batch_schedules (
    schedule_id,
    request_id,
    status,
    scheduled_at,
    test_only,
    force_regenerate,
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
    v_force_regen,
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
  TEXT, TEXT, TIMESTAMPTZ, TEXT[], JSONB, JSONB, NUMERIC, BOOLEAN, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ai_batch_schedule_atomic(
  TEXT, TEXT, TIMESTAMPTZ, TEXT[], JSONB, JSONB, NUMERIC, BOOLEAN, BOOLEAN
) TO service_role;
