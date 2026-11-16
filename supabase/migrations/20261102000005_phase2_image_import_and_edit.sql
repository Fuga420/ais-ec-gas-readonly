-- =============================================================================
-- Migration: 20261102000005_phase2_image_import_and_edit.sql
-- Purpose  : Phase 2 Unit 2 — 商品画像の取込・追加・並べ替え・削除の Cloud Run + Supabase 移行
--            1. 複数画像取込の冪等台帳 `public.product_import_attempts` を新設
--               （import_attempt_id, payload_fingerprint, 途中失敗回復用 mirror_json 等）
--            2. `public.allocate_next_product_id` で `product_import_attempts` の予約IDも上限考慮
--            3. 画像並べ替え・追加・削除を 1 トランザクションで原子的に反映する
--               `public.replace_product_images_atomic` RPC を追加
-- =============================================================================

-- 1. 複数画像取込の冪等台帳テーブル
CREATE TABLE IF NOT EXISTS public.product_import_attempts (
  attempt_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'drive_saved', 'completed', 'failed')),
  payload_fingerprint TEXT NOT NULL,
  product_id TEXT NOT NULL DEFAULT '',
  drive_folder_id TEXT NOT NULL DEFAULT '',
  drive_folder_url TEXT NOT NULL DEFAULT '',
  main_image_url TEXT NOT NULL DEFAULT '',
  image_count INTEGER NOT NULL DEFAULT 0,
  mirror_json JSONB NULL,
  response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_import_attempts_product_id
  ON public.product_import_attempts (product_id);

CREATE INDEX IF NOT EXISTS idx_product_import_attempts_created_at
  ON public.product_import_attempts (created_at DESC);

DROP TRIGGER IF EXISTS trg_product_import_attempts_set_updated_at ON public.product_import_attempts;
CREATE TRIGGER trg_product_import_attempts_set_updated_at
  BEFORE UPDATE ON public.product_import_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.product_import_attempts ENABLE ROW LEVEL SECURITY;

-- 2. 商品ID原子的採番関数を更新（products / product_write_idempotency / product_import_attempts の最大値を反映）
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
  max_import_num BIGINT := 0;
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

  SELECT COALESCE(
    MAX((regexp_match(product_id, '^TMP-([0-9]+)$'))[1]::BIGINT),
    0
  )
    INTO max_import_num
    FROM public.product_import_attempts
   WHERE product_id ~ '^TMP-[0-9]+$';

  next_num := GREATEST(cur_seq, max_db_num, max_idem_num, max_import_num, floor_num) + 1;

  PERFORM setval('public.product_id_seq', next_num, true);

  RETURN 'TMP-' || lpad(next_num::TEXT, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_next_product_id(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_next_product_id(INTEGER) TO service_role;

-- 3. 商品画像一覧・メイン画像・選択画像IDの単一トランザクション更新関数
CREATE OR REPLACE FUNCTION public.replace_product_images_atomic(
  p_product_id TEXT,
  p_main_image_url TEXT,
  p_main_image_display_url TEXT,
  p_images JSONB DEFAULT '[]'::jsonb,
  p_update_selected_ids BOOLEAN DEFAULT false,
  p_selected_image_ids TEXT[] DEFAULT '{}'::TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_product_id IS NULL OR btrim(p_product_id) = '' THEN
    RAISE EXCEPTION 'p_product_id is required';
  END IF;

  UPDATE public.products
     SET main_image_url = COALESCE(p_main_image_url, ''),
         main_image_display_url = COALESCE(p_main_image_display_url, ''),
         selected_image_ids = CASE
           WHEN p_update_selected_ids THEN COALESCE(p_selected_image_ids, '{}'::TEXT[])
           ELSE selected_image_ids
         END,
         write_source = 'supabase',
         supabase_written_at = v_now,
         sheets_mirror_pending = false,
         synced_from_sheets_at = v_now
   WHERE product_id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found: %', p_product_id;
  END IF;

  DELETE FROM public.product_images
   WHERE product_id = p_product_id;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' AND jsonb_array_length(p_images) > 0 THEN
    INSERT INTO public.product_images (
      product_id,
      sort_order,
      file_id,
      name,
      mime_type,
      view_url,
      display_url
    )
    SELECT
      p_product_id,
      COALESCE((elem->>'sort_order')::INTEGER, (ord - 1)::INTEGER),
      COALESCE(elem->>'file_id', ''),
      COALESCE(elem->>'name', ''),
      COALESCE(NULLIF(elem->>'mime_type', ''), 'image/jpeg'),
      COALESCE(elem->>'view_url', ''),
      COALESCE(elem->>'display_url', '')
    FROM jsonb_array_elements(p_images) WITH ORDINALITY AS t(elem, ord)
    WHERE COALESCE(elem->>'file_id', '') <> '';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_product_images_atomic(TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_product_images_atomic(TEXT, TEXT, TEXT, JSONB, BOOLEAN, TEXT[])
  TO service_role;

