-- =============================================================================
-- Migration: 20261102000003_phase2_draft_write_support.sql
-- Purpose  : Phase 2 Unit 1 — Cloud Run + Supabase 下書き商品の新規登録・編集サポート
--            1. TMP-XXXXXX 原子的採番シーケンス & RPC (allocate_next_product_id)
--            2. 新規追加商品の先頭表示順序番号採番 RPC (allocate_next_product_row_seq)
--            3. Supabase 正本書込追跡・Sheets 互換ミラー状態管理列
--            4. 新規登録リクエスト冪等性テーブル (product_write_idempotency)
-- =============================================================================

-- 1. Supabase 書込メタデータ列（Sheets 互換ミラーとの整合管理用）
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS write_source TEXT NOT NULL DEFAULT 'sheets'
    CHECK (write_source IN ('sheets', 'supabase')),
  ADD COLUMN IF NOT EXISTS supabase_written_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sheets_mirror_pending BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_sheets_mirror_pending
  ON public.products (sheets_mirror_pending)
  WHERE sheets_mirror_pending = true;

-- 2. 商品ID (TMP-XXXXXX) 採番用シーケンス & 原子的採番 RPC
CREATE SEQUENCE IF NOT EXISTS public.product_id_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

CREATE OR REPLACE FUNCTION public.allocate_next_product_id(min_floor INTEGER DEFAULT 0)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur_seq BIGINT := 0;
  seq_called BOOLEAN := false;
  max_db_num BIGINT := 0;
  floor_num BIGINT := GREATEST(COALESCE(min_floor, 0), 0)::BIGINT;
  next_num BIGINT;
BEGIN
  -- 同時登録（複数スタッフ・Muse AI）での採番競合をトランザクション単位で直列化
  PERFORM pg_advisory_xact_lock(981234567);

  SELECT last_value, is_called
    INTO cur_seq, seq_called
    FROM public.product_id_seq;

  IF NOT seq_called THEN
    cur_seq := 0;
  END IF;

  SELECT COALESCE(
    MAX((regexp_match(product_id, '^TMP-([0-9]+)$'))[1]::BIGINT),
    0
  )
    INTO max_db_num
    FROM public.products
   WHERE product_id ~ '^TMP-[0-9]+$';

  next_num := GREATEST(cur_seq, max_db_num, floor_num) + 1;

  PERFORM setval('public.product_id_seq', next_num, true);

  RETURN 'TMP-' || lpad(next_num::TEXT, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_next_product_id(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_next_product_id(INTEGER) TO service_role;

-- 初期値を既存商品の最大番号に同期（まだ1件も採番していない場合でも安全）
DO $$
DECLARE
  init_max BIGINT;
BEGIN
  SELECT COALESCE(
    MAX((regexp_match(product_id, '^TMP-([0-9]+)$'))[1]::BIGINT),
    0
  )
    INTO init_max
    FROM public.products
   WHERE product_id ~ '^TMP-[0-9]+$';

  IF init_max > 0 THEN
    PERFORM setval('public.product_id_seq', init_max, true);
  END IF;
END;
$$;

-- 3. 新規登録商品の row_seq 原子的採番 RPC（常に既存最大値 + 1 を払い出し一覧先頭に表示）
CREATE OR REPLACE FUNCTION public.allocate_next_product_row_seq()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_seq BIGINT;
  seq_name TEXT;
  next_seq BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(981234568);

  seq_name := pg_get_serial_sequence('public.products', 'row_seq');
  SELECT COALESCE(MAX(row_seq), 0) INTO max_seq FROM public.products;

  IF max_seq > 0 THEN
    PERFORM setval(seq_name, max_seq, true);
  END IF;

  next_seq := nextval(seq_name);
  RETURN next_seq;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_next_product_row_seq() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_next_product_row_seq() TO service_role;

-- 4. 新規下書き登録リクエスト冪等性テーブル（通信再送時の二重作成防止）
CREATE TABLE IF NOT EXISTS public.product_write_idempotency (
  request_id TEXT PRIMARY KEY CHECK (btrim(request_id) <> ''),
  payload_hash TEXT NOT NULL,
  product_id TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_write_idempotency_created_at
  ON public.product_write_idempotency (created_at DESC);

ALTER TABLE public.product_write_idempotency ENABLE ROW LEVEL SECURITY;
