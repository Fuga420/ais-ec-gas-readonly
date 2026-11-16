-- =============================================================================
-- Migration: 20261102000004_idempotency_recovery_state.sql
-- Purpose  : Phase 2 Unit 1 Review Fix — 新規下書き登録の途中失敗後の再送回復（二重作成防止）
--            1. product_write_idempotency に進行状態 (status / mirror_json / updated_at) を追加
--            2. allocate_next_product_id で in_progress / mirror_completed の予約済みIDも上限考慮
-- =============================================================================

ALTER TABLE public.product_write_idempotency
  ALTER COLUMN response_json SET DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('in_progress', 'mirror_completed', 'completed')),
  ADD COLUMN IF NOT EXISTS mirror_json JSONB NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

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
  max_idem_num BIGINT := 0;
  floor_num BIGINT := GREATEST(COALESCE(min_floor, 0), 0)::BIGINT;
  next_num BIGINT;
BEGIN
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

  SELECT COALESCE(
    MAX((regexp_match(product_id, '^TMP-([0-9]+)$'))[1]::BIGINT),
    0
  )
    INTO max_idem_num
    FROM public.product_write_idempotency
   WHERE product_id ~ '^TMP-[0-9]+$';

  next_num := GREATEST(cur_seq, max_db_num, max_idem_num, floor_num) + 1;

  PERFORM setval('public.product_id_seq', next_num, true);

  RETURN 'TMP-' || lpad(next_num::TEXT, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_next_product_id(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_next_product_id(INTEGER) TO service_role;

