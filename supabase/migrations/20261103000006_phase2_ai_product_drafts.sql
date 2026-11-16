-- =============================================================================
-- Migration: 20261103000006_phase2_ai_product_drafts.sql
-- Purpose  : Phase 2 Unit 4 — 単品AI下書き生成・保存・確定処理（および後続のAI一括生成・夜間実行での共通基盤）
--            1. AI下書き候補・確定台帳テーブル `public.product_ai_drafts`
--            2. 商品単位の並行安全なAI生成排他ロックテーブル `public.ai_draft_execution_locks` & RPC群
--            3. 原子的ドラフト版採番・旧 pending_review 失効・保存 RPC `public.save_generated_ai_draft_atomic`
-- =============================================================================

-- 1. AI出品ドラフト台帳テーブル (`product_ai_drafts` シート互換 + JSONB拡張)
CREATE TABLE IF NOT EXISTS public.product_ai_drafts (
  draft_id TEXT PRIMARY KEY CHECK (btrim(draft_id) <> ''),
  product_id TEXT NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
  draft_version INTEGER NOT NULL CHECK (draft_version >= 1),
  review_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (review_status IN ('pending_review', 'confirmed', 'stale', 'rejected')),

  candidate_title_ja TEXT NOT NULL DEFAULT '',
  candidate_hashtags_ja TEXT NOT NULL DEFAULT '',
  candidate_description_ja TEXT NOT NULL DEFAULT '',
  candidate_title_en TEXT NOT NULL DEFAULT '',
  candidate_description_en TEXT NOT NULL DEFAULT '',
  candidate_condition TEXT NOT NULL DEFAULT '',
  candidate_price INTEGER NULL,
  candidate_price_basis TEXT NOT NULL DEFAULT '',
  candidate_price_note TEXT NOT NULL DEFAULT '',
  candidate_category TEXT NOT NULL DEFAULT '',
  candidate_brand TEXT NOT NULL DEFAULT '',
  candidate_sku TEXT NOT NULL DEFAULT '',
  candidate_sku_source TEXT NOT NULL DEFAULT '',
  candidate_size TEXT NOT NULL DEFAULT '',
  candidate_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  source_fingerprint TEXT NOT NULL DEFAULT '',
  source_image_fingerprint TEXT NOT NULL DEFAULT '',
  confirmed_fingerprint TEXT NOT NULL DEFAULT '',
  source_image_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  model_name TEXT NOT NULL DEFAULT '',

  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ NULL,
  confirmed_by TEXT NOT NULL DEFAULT '',
  last_confirmation_attempt_id TEXT NOT NULL DEFAULT '',
  last_confirmation_payload_hash TEXT NOT NULL DEFAULT '',

  search_grounding_enabled BOOLEAN NOT NULL DEFAULT true,
  search_grounding_mode TEXT NOT NULL DEFAULT '',
  search_executed BOOLEAN NOT NULL DEFAULT false,
  search_queries TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  write_source TEXT NOT NULL DEFAULT 'supabase'
    CHECK (write_source IN ('sheets', 'supabase')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_product_ai_drafts_product_version UNIQUE (product_id, draft_version)
);

CREATE INDEX IF NOT EXISTS idx_product_ai_drafts_product_latest
  ON public.product_ai_drafts (product_id, draft_version DESC);

CREATE INDEX IF NOT EXISTS idx_product_ai_drafts_review_status
  ON public.product_ai_drafts (review_status);

DROP TRIGGER IF EXISTS trg_product_ai_drafts_set_updated_at ON public.product_ai_drafts;
CREATE TRIGGER trg_product_ai_drafts_set_updated_at
  BEFORE UPDATE ON public.product_ai_drafts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.product_ai_drafts ENABLE ROW LEVEL SECURITY;

-- 2. 商品単位の並行安全なAI生成排他ロックテーブル（単品生成・AI一括生成・夜間実行で共通利用）
CREATE TABLE IF NOT EXISTS public.ai_draft_execution_locks (
  product_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_draft_execution_locks_expires_at
  ON public.ai_draft_execution_locks (expires_at);

ALTER TABLE public.ai_draft_execution_locks ENABLE ROW LEVEL SECURITY;

-- 2-1. 商品別ロック取得 RPC（TTL切れロックの自動回収付き・Superseded Release Protection対応）
CREATE OR REPLACE FUNCTION public.acquire_ai_draft_execution_lock(
  p_product_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 180
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid TEXT := btrim(COALESCE(p_product_id, ''));
  v_ttl INTEGER := GREATEST(COALESCE(p_ttl_seconds, 180), 10);
  v_now TIMESTAMPTZ := now();
  v_existing RECORD;
  v_new_exec_id TEXT;
BEGIN
  IF v_pid = '' THEN
    RAISE EXCEPTION 'p_product_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_draft_exec_lock:' || v_pid));

  SELECT product_id, execution_id, started_at, expires_at
    INTO v_existing
    FROM public.ai_draft_execution_locks
   WHERE product_id = v_pid;

  IF FOUND AND v_existing.expires_at > v_now THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'execution_id', '',
      'existing_execution_id', v_existing.execution_id,
      'started_at', v_existing.started_at,
      'expires_at', v_existing.expires_at
    );
  END IF;

  v_new_exec_id := 'EXEC_' || v_pid || '_' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8);

  INSERT INTO public.ai_draft_execution_locks (
    product_id,
    execution_id,
    started_at,
    expires_at
  ) VALUES (
    v_pid,
    v_new_exec_id,
    v_now,
    v_now + make_interval(secs => v_ttl)
  )
  ON CONFLICT (product_id) DO UPDATE
    SET execution_id = EXCLUDED.execution_id,
        started_at = EXCLUDED.started_at,
        expires_at = EXCLUDED.expires_at;

  RETURN jsonb_build_object(
    'acquired', true,
    'execution_id', v_new_exec_id,
    'started_at', v_now,
    'expires_at', v_now + make_interval(secs => v_ttl)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_ai_draft_execution_lock(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_ai_draft_execution_lock(TEXT, INTEGER)
  TO service_role;

-- 2-2. ロック所有権・有効期限検証 RPC（保存直前に Superseded でないことを検証）
CREATE OR REPLACE FUNCTION public.verify_ai_draft_execution_lock(
  p_product_id TEXT,
  p_execution_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid TEXT := btrim(COALESCE(p_product_id, ''));
  v_eid TEXT := btrim(COALESCE(p_execution_id, ''));
  v_valid BOOLEAN := false;
BEGIN
  IF v_pid = '' OR v_eid = '' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.ai_draft_execution_locks
     WHERE product_id = v_pid
       AND execution_id = v_eid
       AND expires_at > now()
  ) INTO v_valid;

  RETURN v_valid;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_ai_draft_execution_lock(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ai_draft_execution_lock(TEXT, TEXT)
  TO service_role;

-- 2-3. ロック解放 RPC（自分の execution_id と一致する場合のみ削除）
CREATE OR REPLACE FUNCTION public.release_ai_draft_execution_lock(
  p_product_id TEXT,
  p_execution_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid TEXT := btrim(COALESCE(p_product_id, ''));
  v_eid TEXT := btrim(COALESCE(p_execution_id, ''));
  v_deleted INTEGER := 0;
BEGIN
  IF v_pid = '' OR v_eid = '' THEN
    RETURN false;
  END IF;

  DELETE FROM public.ai_draft_execution_locks
   WHERE product_id = v_pid
     AND execution_id = v_eid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.release_ai_draft_execution_lock(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ai_draft_execution_lock(TEXT, TEXT)
  TO service_role;

-- 3. 原子的ドラフト版採番・旧 pending_review 失効・保存 RPC
CREATE OR REPLACE FUNCTION public.save_generated_ai_draft_atomic(
  p_product_id TEXT,
  p_draft_id TEXT,
  p_review_status TEXT,
  p_candidate_title_ja TEXT,
  p_candidate_hashtags_ja TEXT,
  p_candidate_description_ja TEXT,
  p_candidate_title_en TEXT,
  p_candidate_description_en TEXT,
  p_candidate_condition TEXT,
  p_candidate_price INTEGER,
  p_candidate_price_basis TEXT,
  p_candidate_price_note TEXT,
  p_candidate_category TEXT,
  p_candidate_brand TEXT,
  p_candidate_sku TEXT,
  p_candidate_sku_source TEXT,
  p_candidate_size TEXT,
  p_candidate_json JSONB,
  p_source_fingerprint TEXT,
  p_source_image_fingerprint TEXT,
  p_confirmed_fingerprint TEXT,
  p_source_image_ids TEXT[],
  p_model_name TEXT,
  p_generated_at TIMESTAMPTZ,
  p_confirmed_at TIMESTAMPTZ,
  p_confirmed_by TEXT,
  p_search_grounding_enabled BOOLEAN,
  p_search_grounding_mode TEXT,
  p_search_executed BOOLEAN,
  p_search_queries TEXT[],
  p_min_draft_version INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid TEXT := btrim(COALESCE(p_product_id, ''));
  v_did TEXT := btrim(COALESCE(p_draft_id, ''));
  v_max_ver INTEGER := 0;
  v_next_ver INTEGER;
BEGIN
  IF v_pid = '' OR v_did = '' THEN
    RAISE EXCEPTION 'p_product_id and p_draft_id are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_draft_save:' || v_pid));

  -- 既存の pending_review 行を stale に更新
  UPDATE public.product_ai_drafts
     SET review_status = 'stale'
   WHERE product_id = v_pid
     AND review_status = 'pending_review';

  SELECT COALESCE(MAX(draft_version), 0)
    INTO v_max_ver
    FROM public.product_ai_drafts
   WHERE product_id = v_pid;

  v_next_ver := GREATEST(v_max_ver, COALESCE(p_min_draft_version, 0)) + 1;

  INSERT INTO public.product_ai_drafts (
    draft_id,
    product_id,
    draft_version,
    review_status,
    candidate_title_ja,
    candidate_hashtags_ja,
    candidate_description_ja,
    candidate_title_en,
    candidate_description_en,
    candidate_condition,
    candidate_price,
    candidate_price_basis,
    candidate_price_note,
    candidate_category,
    candidate_brand,
    candidate_sku,
    candidate_sku_source,
    candidate_size,
    candidate_json,
    source_fingerprint,
    source_image_fingerprint,
    confirmed_fingerprint,
    source_image_ids,
    model_name,
    generated_at,
    confirmed_at,
    confirmed_by,
    search_grounding_enabled,
    search_grounding_mode,
    search_executed,
    search_queries,
    write_source
  ) VALUES (
    v_did,
    v_pid,
    v_next_ver,
    COALESCE(NULLIF(btrim(p_review_status), ''), 'pending_review'),
    COALESCE(p_candidate_title_ja, ''),
    COALESCE(p_candidate_hashtags_ja, ''),
    COALESCE(p_candidate_description_ja, ''),
    COALESCE(p_candidate_title_en, ''),
    COALESCE(p_candidate_description_en, ''),
    COALESCE(p_candidate_condition, ''),
    p_candidate_price,
    COALESCE(p_candidate_price_basis, ''),
    COALESCE(p_candidate_price_note, ''),
    COALESCE(p_candidate_category, ''),
    COALESCE(p_candidate_brand, ''),
    COALESCE(p_candidate_sku, ''),
    COALESCE(p_candidate_sku_source, ''),
    COALESCE(p_candidate_size, ''),
    COALESCE(p_candidate_json, '{}'::jsonb),
    COALESCE(p_source_fingerprint, ''),
    COALESCE(p_source_image_fingerprint, ''),
    COALESCE(p_confirmed_fingerprint, ''),
    COALESCE(p_source_image_ids, '{}'::TEXT[]),
    COALESCE(p_model_name, ''),
    COALESCE(p_generated_at, now()),
    p_confirmed_at,
    COALESCE(p_confirmed_by, ''),
    COALESCE(p_search_grounding_enabled, true),
    COALESCE(p_search_grounding_mode, ''),
    COALESCE(p_search_executed, false),
    COALESCE(p_search_queries, '{}'::TEXT[]),
    'supabase'
  );

  RETURN jsonb_build_object(
    'draft_id', v_did,
    'product_id', v_pid,
    'draft_version', v_next_ver
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_generated_ai_draft_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT[], TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[], INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_generated_ai_draft_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT[], TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[], INTEGER
) TO service_role;

