import crypto from "node:crypto";

/**
 * Cloud Run AI Product Draft Engine (ported verbatim from `llm_product_draft.js` + `llm_translation.js`).
 * Shared by single-product interactive AI draft generation AND future AI batch / nightly workers.
 */


const AI_DRAFT_CONFIG = {
  SHEET_NAME: "product_ai_drafts",
  FLAG_VALUE: "ai_managed",
  AI_DRAFT_FLAG_COLUMN: 40, // AN列
  DEFAULT_MODEL: "gemini-3.8-flash",
  FALLBACK_MODEL: "gemini-3.5-flash-lite",
  MODEL_PROPERTY: "AI_DRAFT_MODEL",
  FALLBACK_MODEL_PROPERTY: "AI_DRAFT_FALLBACK_MODEL",
  API_KEY_PROPERTY: "LLM_API_KEY",
  MAX_IMAGES: 3,
  MAX_TOTAL_IMAGE_BYTES: 10 * 1024 * 1024, // 10MB
  ALLOWED_MIME_TYPES: ["image/jpeg", "image/png", "image/webp"],
  LOCK_TIMEOUT_MS: 5000,
  EXECUTION_TTL_MS: 240000, // 2段階検索グラウンディング (通信・外部検索) を考慮し240秒 (4分) に設定
  ENABLE_SEARCH_GROUNDING_PROPERTY: "AI_DRAFT_ENABLE_SEARCH_GROUNDING",
  SEARCH_GROUNDING_MODE_PROPERTY: "AI_DRAFT_SEARCH_GROUNDING_MODE",
  DEFAULT_SEARCH_GROUNDING_ENABLED: true,
  DEFAULT_SEARCH_GROUNDING_MODE: "two_stage", // 2段階方式 (Stage A 検索 -> Stage B 構造化) を標準経路とする
  PROHIBITED_PATTERNS: [
    /\b100%\s*(?:guaranteed\s+|certified\s+|verified\s+)?(?:authentic|genuine|original)\b/i,
    /\b(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)\b/i,
    /\b(?:authentic|genuine)\s+(?:and\s+(?:authentic|genuine)\s+)?(?:pair\s+|item\s+|product\s+|card\s+)?(?:guaranteed|guarantee|100%)\b/i,
    /\bauthenticity\s+(?:is\s+)?(?:guaranteed|verified|checked|inspected|assured|confirmed)\b/i,
    /\b(?:authenticated|appraised|verified)\s+by\s+(?:professional|expert|our)\b/i,
    /\bguaranteed\s+to\s+be\s+(?:authentic|genuine|real|original)\b/i,
    /(?:確実\s*|国内\s*)?正規品|本物保証|正規保証|真正品|真贋(?:鑑定|確認|チェック|保証)|(?:プロの)?鑑定士|鑑定済(?:み)?(?:の)?(?:正規品|本物|真正品)/i
  ],
  ALLOWED_CONDITIONS: [
    "新品・未使用",
    "未使用に近い",
    "目立った傷や汚れなし",
    "やや傷や汚れあり",
    "傷や汚れあり",
    "全体的に状態が悪い"
  ],
  // 既存仕様の正規コード値に統一 (指示4 + 全登録カテゴリ拡張)
  ALLOWED_CATEGORIES: [
    "sneaker",
    "pokemon_card",
    "apparel",
    "fashion_goods",
    "jewelry",
    "other"
  ],
  DEFAULT_MIN_COST_MARKUP_RATE: 0.30,
  SAFE_LLM_ERROR_MESSAGE: "[AI Draft] AI service communication failed. Please try again.",
  HEADERS: [
    "draft_id",
    "product_id",
    "draft_version",
    "review_status",
    "candidate_title_ja",
    "candidate_hashtags_ja",
    "candidate_description_ja",
    "candidate_title_en",
    "candidate_description_en",
    "candidate_condition",
    "candidate_price",
    "candidate_category",
    "candidate_brand",
    "candidate_sku",
    "candidate_size",
    "source_fingerprint",
    "source_image_fingerprint",
    "confirmed_fingerprint",
    "source_image_ids",
    "model_name",
    "generated_at",
    "confirmed_at",
    "confirmed_by",
    "last_confirmation_attempt_id",
    "last_confirmation_payload_hash",
    "search_grounding_enabled",
    "search_grounding_mode",
    "search_executed",
    "search_queries",
    "search_sources_count",
    "search_queries_count",
    "stage_a_elapsed_ms",
    "stage_b_elapsed_ms",
    "search_total_elapsed_ms",
    "search_finish_reason",
    "search_tokens_json",
    "candidate_price_basis",
    "candidate_price_note",
    "candidate_sku_source"
  ]
};

/**
 * カテゴリ入力値を既存仕様の正規コード値 (sneaker, pokemon_card, apparel) へ正規化 (指示4)
 * @param {string} rawCategory
 * @param {string|Object} [context] ブランド名や商品名などの文脈情報
 * @return {string} 正規化コード値 (不正値は空文字)
 */
function normalizeCategoryValue_(rawCategory, context) {
  const norm = String(rawCategory || "").trim().toLowerCase();
  if (
    norm === "sneaker" || norm === "スニーカー" || norm === "sneakers" ||
    norm === "shoes" || norm === "シューズ" || norm === "kicks" ||
    norm === "footwear" || norm === "靴"
  ) {
    return "sneaker";
  }
  // ポケモン固有の明示的表現
  if (
    norm === "pokemon_card" || norm === "ポケモンカード" || norm === "pokemon" ||
    norm === "pokémon" || norm === "pokémon_card" || norm === "pokemon card" ||
    norm === "pokémon card" || norm === "pokemon_cards" || norm === "pokemon cards" ||
    norm === "pokemon tcg" || norm === "ポケカ" || norm === "ポケモンカードゲーム" ||
    norm === "pokemon card game" || norm === "pokémon card game" || norm === "pokemoncard"
  ) {
    return "pokemon_card";
  }
  // 汎用カード・TCG表現: ポケモン固有の文脈証拠がある場合のみ pokemon_card と認定
  if (
    norm === "tcg" || norm === "trading card" || norm === "trading cards" ||
    norm === "trading card game" || norm === "トレーディングカード" ||
    norm === "トレカ" || norm === "card" || norm === "カード"
  ) {
    const ctxStr = (typeof context === "string") ? context : (context ? JSON.stringify(context) : "");
    if (/pok[eé]mon|ポケモン|ピカチュウ|pikachu|リザードン|charizard|ルギア|lugia|ミュウ|mew/i.test(ctxStr)) {
      return "pokemon_card";
    }
    // ポケモンの証拠がない単なる TCG/card は無条件にポケカと判定せず空文字（未確定）とする
    return "";
  }
  if (
    norm === "apparel" || norm === "アパレル" || norm === "clothing" ||
    norm === "wear" || norm === "洋服" || norm === "服" || norm === "ウェア" ||
    norm === "tシャツ" || norm === "t-shirt" || norm === "tee" || norm === "tops"
  ) {
    return "apparel";
  }
  if (
    norm === "fashion_goods" || norm === "ファッション小物" || norm === "小物" ||
    norm === "服飾小物" || norm === "accessories" || norm === "accessory" ||
    norm === "eyewear" || norm === "アイウェア" || norm === "wallet" || norm === "財布" ||
    norm === "bag" || norm === "バッグ" || norm === "belt" || norm === "ベルト" ||
    norm === "hat" || norm === "cap" || norm === "帽子"
  ) {
    return "fashion_goods";
  }
  if (
    norm === "jewelry" || norm === "ジュエリー" || norm === "宝飾" ||
    norm === "宝飾品" || norm === "貴金属" || norm === "jewellery" ||
    norm === "ring" || norm === "リング" || norm === "necklace" || norm === "ネックレス" ||
    norm === "bracelet" || norm === "ブレスレット" || norm === "pierce" || norm === "ピアス" ||
    norm === "earring" || norm === "イヤリング"
  ) {
    return "jewelry";
  }
  if (
    norm === "other" || norm === "その他" || norm === "others" || norm === "misc"
  ) {
    return "other";
  }
  if (AI_DRAFT_CONFIG.ALLOWED_CATEGORIES.indexOf(norm) !== -1) return norm;
  return "";
}

/**
 * スニーカーのSKU（スタイルコード・型番）を正式な形式に正規化する
 * 例: "IB4481 500" -> "IB4481-500", "IB4481_500" -> "IB4481-500", "ib4481-500" -> "IB4481-500"
 *     "SKU: DZ5485 612" -> "DZ5485-612", "IG1024" -> "IG1024", "M2002RDA" -> "M2002RDA"
 * 無効値や推測文言は空文字に正規化する
 *
 * @param {string} rawSku
 * @return {string}
 */
function normalizeSneakerSku_(rawSku) {
  if (!rawSku || typeof rawSku !== "string") return "";
  let s = rawSku.trim();

  // 無効・未確定・テスト値・プロンプト指示語・画像構図語句の排除
  if (
    /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-|unspecified|not\s*visible)$/i.test(s) ||
    /(?:画像から確認できず|確認不可|不明|テスト|推測|推定|candidate|inferred)/i.test(s) ||
    /(?:facing[\s_-]?the|label[\s_-]?side|facing|camera|shoe[\s_-]?box|angle|view|photo)/i.test(s)
  ) {
    return "";
  }

  // プレフィックスの除去 (例: "SKU: ", "Style Code: ", "型番: ")
  s = s.replace(/^(?:sku|style\s*(?:code|no|#)?|model|item\s*no|型番|スタイルコード)[\s:：#_-]*/i, "").trim();

  // 余分なクォートやブラケットを除去
  s = s.replace(/^["'「『\[\(]+|[\]\)'」』"']+$/g, "").trim();

  let result = "";

  // 1. "IB4481 500" や "IB4481_500" -> "IB4481-500" (5〜8桁の英数字 + 空白/アンダースコア + 3〜4桁の英数字)
  const spaceMatch = s.match(/^([A-Z0-9]{5,8})[\s_]+([A-Z0-9]{3,4})$/i);
  if (spaceMatch) {
    result = `${spaceMatch[1].toUpperCase()}-${spaceMatch[2].toUpperCase()}`;
  } else {
    // 2. 既にハイフンで繋がっている形式 "IB4481-500"
    const hyphenMatch = s.match(/^([A-Z0-9]{5,8})-([A-Z0-9]{3,4})$/i);
    if (hyphenMatch) {
      result = `${hyphenMatch[1].toUpperCase()}-${hyphenMatch[2].toUpperCase()}`;
    } else {
      // 3. 長い文字列の中に "IB4481 500" や "IB4481-500" パターンが含まれている場合
      const embeddedHyphen = s.match(/\b([A-Z0-9]{5,8})-([A-Z0-9]{3,4})\b/i);
      if (embeddedHyphen && !/^(?:NONE|N\/A|TEST)$/i.test(embeddedHyphen[1])) {
        result = `${embeddedHyphen[1].toUpperCase()}-${embeddedHyphen[2].toUpperCase()}`;
      } else {
        const embeddedSpace = s.match(/\b([A-Z0-9]{5,8})[\s_]+([A-Z0-9]{3,4})\b/i);
        if (embeddedSpace && !/^(?:NONE|N\/A|TEST)$/i.test(embeddedSpace[1])) {
          result = `${embeddedSpace[1].toUpperCase()}-${embeddedSpace[2].toUpperCase()}`;
        } else {
          // 4. ハイフンなしの単一英数字コード（Adidas, New Balance, Asics 等: 例 IG1024, M2002RDA, 1201A019）
          const singleMatch = s.match(/^([A-Z0-9]{5,12})$/i);
          if (singleMatch) {
            result = singleMatch[1].toUpperCase();
          } else {
            result = s;
          }
        }
      }
    }
  }

  // 抽出後の厳格検証:
  // - スニーカーのスタイルコード・型番は必ず数字を少なくとも1文字以上含む
  //   (英字のみの単語ペア "FACING-THE", "LABEL-SIDE", "SHOE-BOX" 等の誤読値を完全排除)
  // - 指示語・構図語句を含む場合は排除
  if (!/\d/.test(result)) {
    return "";
  }
  if (/(?:FACING|LABEL|SIDE|CAMERA|PHOTO|IMAGE|PICTURE|FRONT|BACK|ANGLE|SHOE|BOX)/i.test(result)) {
    return "";
  }

  return result;
}

/**
 * スニーカーのサイズ欄を正規化する（ラベル全文ではなく "25.5cm" のような cm 単位の標準形式に抽出）
 * 例: "7.5 (25.5cm) UK 6.5 EUR 40.5 cm 25.5" -> "25.5cm"
 *     "US 7.5 UK 6.5 EUR 40.5 cm 25.5 BR 39 CN 255(2.5)" -> "25.5cm"
 *     "25.5cm" -> "25.5cm", "25.5 cm" -> "25.5cm", "cm 25.5" -> "25.5cm"
 *     "27.0cm" -> "27.0cm", "27cm" -> "27cm"
 *     "US 9.5" (cmなしの場合) -> "US 9.5"
 *
 * @param {string} rawSize
 * @return {string}
 */
function normalizeSneakerSize_(rawSize) {
  if (!rawSize || typeof rawSize !== "string") return "";
  let s = rawSize.trim();

  // 無効・未確定・テスト値の排除
  if (
    /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-|unspecified|not\s*visible)$/i.test(s) ||
    /(?:画像から確認できず|確認不可|不明|テスト|未設定|推測)/i.test(s)
  ) {
    return "";
  }

  // プレフィックスの除去 (例: "Size: ", "サイズ: ")
  s = s.replace(/^(?:size|サイズ)[\s:：#_-]*/i, "").trim();

  // 1. "cm 25.5", "CM: 25.5", "JPN 25.5" のパターン（EUR 40.5 等の誤認を防ぐため最優先）
  const cmPrefixMatch = s.match(/(?:cm|CM|センチ|JPN|JP)\s*[:：]?\s*(\d{2}(?:\.[05])?)\b/i);
  if (cmPrefixMatch) {
    const val = parseFloat(cmPrefixMatch[1]);
    if (val >= 15.0 && val <= 35.0) {
      return `${cmPrefixMatch[1]}cm`;
    }
  }

  // 2. 括弧で括られた cm または数値: "(25.5cm)", "(25.5)"
  const parenMatch = s.match(/\(\s*(\d{2}(?:\.[05])?)\s*(?:cm|CM)?\s*\)/i);
  if (parenMatch) {
    const val = parseFloat(parenMatch[1]);
    if (val >= 15.0 && val <= 35.0) {
      return `${parenMatch[1]}cm`;
    }
  }

  // 3. "25.5cm" や "27cm" のような数字 + cm のパターン (ただし 15.0 〜 35.0 の現実的な靴サイズに限定し、EUR等の誤結合を排除)
  const cmSuffixMatches = s.matchAll(/\b(\d{2}(?:\.[05])?)\s*(?:cm|CM|センチ|JPN|JP)\b/gi);
  for (const match of cmSuffixMatches) {
    const val = parseFloat(match[1]);
    if (val >= 15.0 && val <= 35.0) {
      return `${match[1]}cm`;
    }
  }

  // 4. 単独の数値 "25.5" または "27"（一般的な靴サイズ 20.0 〜 35.0）
  const numOnlyMatch = s.match(/^\s*(\d{2}(?:\.[05])?)\s*$/);
  if (numOnlyMatch) {
    const num = parseFloat(numOnlyMatch[1]);
    if (num >= 20.0 && num <= 35.0) {
      return `${numOnlyMatch[1]}cm`;
    }
  }

  // 5. cmが見つからない場合の US 表記 (例: "US 9.5", "US9.5")
  const usMatch = s.match(/\b(US\s*\d+(?:\.[05])?)\b/i);
  if (usMatch) {
    return usMatch[1].toUpperCase().replace(/\s+/, " ");
  }

  // 6. すでに "25.5cm" 等の綺麗な形式ならトリム
  if (/^\d{2}(?:\.[05])?\s*cm$/i.test(s)) {
    return s.replace(/\s+/g, "").toLowerCase();
  }

  // 20文字以上の雑多なテキストでcmを抽出できなかった場合は、生テキスト全体を採用せず空文字にする
  if (s.length > 20) {
    return "";
  }

  return s;
}

/**
 * 価格根拠リスト内の同一URL重複を排除する
 * 同一URLで別取引を示す明確な個別情報（異なる取引日、異なる取引IDなど）がない限り、1件に集約する。
 *
 * @param {Array<Object>} evidenceList
 * @return {Array<Object>}
 */
function deduplicatePriceEvidenceItems_(evidenceList) {
  if (!Array.isArray(evidenceList) || evidenceList.length <= 1) {
    return Array.isArray(evidenceList) ? evidenceList.slice() : [];
  }

  const groups = {};
  const deduplicated = [];

  evidenceList.forEach(item => {
    if (!item || typeof item !== "object") return;
    const url = String(item.source_url || item.source || "").trim();
    const normUrl = url.toLowerCase().replace(/\/+$/, "");

    if (!normUrl) {
      deduplicated.push(item);
      return;
    }

    if (!groups[normUrl]) {
      groups[normUrl] = [item];
    } else {
      groups[normUrl].push(item);
    }
  });

  Object.keys(groups).forEach(normUrl => {
    const items = groups[normUrl];
    if (items.length === 1) {
      deduplicated.push(items[0]);
      return;
    }

    // 別取引を示す個別情報があるか判定
    const distinctDates = Array.from(new Set(items.map(it => String(it.transaction_date || "").trim()).filter(Boolean)));
    const distinctIds = Array.from(new Set(items.map(it => String(it.transaction_id || it.order_id || it.listing_id || "").trim()).filter(Boolean)));

    if (distinctDates.length > 1 || distinctIds.length > 1) {
      items.forEach(it => deduplicated.push(it));
    } else {
      let bestItem = items[0];
      for (let i = 1; i < items.length; i++) {
        const cur = items[i];
        if (cur.verification_status === "content_verified" && bestItem.verification_status !== "content_verified") {
          bestItem = cur;
        } else if (cur.verification_status === "format_valid" && bestItem.verification_status === "unverified") {
          bestItem = cur;
        }
      }

      const validAmounts = items.map(it => Number(it.amount)).filter(a => Number.isFinite(a) && a > 0);
      let mergedAmount = bestItem.amount;
      if (validAmounts.length > 1) {
        const sum = validAmounts.reduce((acc, v) => acc + v, 0);
        mergedAmount = Math.round(sum / validAmounts.length);
      }

      const firstDate = items.map(it => it.transaction_date).find(d => Boolean(d && String(d).trim())) || bestItem.transaction_date;

      let mergedType = bestItem.price_type;
      const types = items.map(it => it.price_type);
      if (types.indexOf("sold") !== -1) mergedType = "sold";
      else if (types.indexOf("active") !== -1) mergedType = "active";
      else mergedType = "unknown";

      const mergedItem = Object.assign({}, bestItem, {
        amount: mergedAmount,
        transaction_date: firstDate,
        price_type: mergedType,
        _deduplicated_count: items.length
      });

      deduplicated.push(mergedItem);
    }
  });

  return deduplicated;
}

/**
 * Stage A のテキストから価格情報（金額および参照URL）を抽出するフォールバックヘルパー
 * Stage B が価格を抽出し損ねた場合の安全救済
 * @param {string} pricingText
 * @param {string} searchText
 * @param {Array<Object>} [groundingSources]
 * @return {{ price: number, url: string, rawText: string }|null}
 */
function extractPriceFromStageAText_(pricingText, searchText, groundingSources) {
  const combined = [pricingText, searchText].filter(Boolean).join("\n");
  if (!combined) return null;

  // 年月日、日付、カード番号のマスク (年号や日付、型番が価格として誤認識されるのを防止)
  const masked = combined
    .replace(/\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}[日]?)?/g, "[DATE]")
    .replace(/\b\d{1,3}\/\d{1,3}\b/g, "[CARD_NUM]");

  // 明示的な通貨表記を優先検索 (例: "¥8,300", "8,300円", "8300 円", "JPY 8,300")
  const explicitMatches = [];
  const explicitRegex = /(?:¥|￥|JPY\s*)([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{2,6})|([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{2,6})\s*(?:円|JPY)/gi;
  let match;
  while ((match = explicitRegex.exec(masked)) !== null) {
    const rawNumStr = (match[1] || match[2]).replace(/,/g, "");
    const num = parseInt(rawNumStr, 10);
    if (Number.isFinite(num) && num >= 500 && num <= 50000000) {
      explicitMatches.push({ price: num, rawText: match[0] });
    }
  }

  let chosenPrice = null;
  let rawText = "";

  if (explicitMatches.length > 0) {
    if (explicitMatches.length >= 3) {
      const sorted = explicitMatches.map(m => m.price).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      chosenPrice = (sorted.length % 2 !== 0) ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      rawText = explicitMatches[0].rawText;
    } else {
      const sum = explicitMatches.reduce((acc, m) => acc + m.price, 0);
      chosenPrice = Math.round(sum / explicitMatches.length);
      rawText = explicitMatches[0].rawText;
    }
  } else {
    // 通貨記号なしの文脈検索 (価格: 8300, 相場 8300)
    const contextRegex = /(?:価格|相場|販売|成約|落札|約|around|approx|price|sold\s*for)[：:\s]*(?:¥|￥|JPY\s*)?([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{2,6})/gi;
    const contextMatch = contextRegex.exec(masked);
    if (contextMatch) {
      const rawNumStr = contextMatch[1].replace(/,/g, "");
      const num = parseInt(rawNumStr, 10);
      if (Number.isFinite(num) && num >= 500 && num <= 50000000) {
        chosenPrice = num;
        rawText = contextMatch[0];
      }
    }
  }

  if (chosenPrice === null) return null;

  let foundUrl = "";
  if (Array.isArray(groundingSources) && groundingSources.length > 0) {
    const firstSrc = groundingSources.find(
      s => s && s.url && /^https?:\/\//i.test(s.url) && !isSearchResultListingUrl_(s.url)
    );
    if (firstSrc) foundUrl = firstSrc.url;
  }
  if (!foundUrl) {
    const urlMatches = combined.match(/https?:\/\/[^\s$.?#].[^\s]*/gi);
    if (Array.isArray(urlMatches)) {
      const firstIndividualUrl = urlMatches.find(u => !isSearchResultListingUrl_(u));
      if (firstIndividualUrl) foundUrl = firstIndividualUrl;
    }
  }

  return {
    price: chosenPrice,
    url: foundUrl,
    rawText: rawText
  };
}

function detectCategoryFromCandidateContext_(rawCandidate, meta) {
  if (!rawCandidate || typeof rawCandidate !== "object") return "";
  const existingCat = normalizeCategoryValue_(rawCandidate.category || (meta && meta.category));
  if (existingCat) return existingCat;

  // ポケカの客観証拠: pokemon_card オブジェクト、型番 (xxx/yyy)、PSAなどの鑑定、カード名
  const poke = rawCandidate.pokemon_card;
  if (poke && typeof poke === "object") {
    if (poke.card_name || poke.card_number || poke.set_code || poke.rarity) {
      return "pokemon_card";
    }
  }
  const textContext = [
    rawCandidate.title_ja,
    rawCandidate.description_ja,
    rawCandidate.brand,
    meta && meta.productName,
    meta && meta.brand
  ].filter(Boolean).join(" ");

  if (/\b\d{3}\/\d{3}\b/.test(textContext) || /pok[eé]mon|ポケモン|ポケカ|ピカチュウ|ミュウ|ルギア/i.test(textContext)) {
    return "pokemon_card";
  }

  // スニーカーの客観証拠: スタイルコード (xxxxxx-xxx)、サイズ (xx.x cm)、スニーカーブランド
  if (rawCandidate.sku && /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/i.test(String(rawCandidate.sku).trim())) {
    return "sneaker";
  }
  if (rawCandidate.size && /\d{2}(?:\.\d)?\s*cm/i.test(String(rawCandidate.size).trim())) {
    return "sneaker";
  }
  const brand = String(rawCandidate.brand || (meta && meta.brand) || "").trim();
  if (/^(?:nike|jordan|adidas|new balance|asics|puma|converse|vans|salomon|reebok|yeezy)/i.test(brand)) {
    return "sneaker";
  }

  return "";
}

function parseStageASections_(stageAText) {
  if (!stageAText || typeof stageAText !== "string") {
    return {
      observedText: "",
      searchText: "",
      pricingText: "",
      unconfirmedText: "",
      observedFields: {},
      searchDerivedFields: {},
      extractedFields: {},
      missingFields: ["OBSERVED", "SEARCH", "PRICING", "UNCONFIRMED"]
    };
  }

  const secPatterns = {
    observed: /(?:###\s*(?:OBSERVED[_\s]CARD[_\s]ATTRIBUTES|OBSERVED[_\s]SNEAKER[_\s]ATTRIBUTES|OBSERVED[_\s]FEATURES|DIRECT[_\s]OBSERVATION)[\s\S]*?)(?=(?:###|$))/i,
    search: /(?:###\s*(?:SEARCH[_\s]FINDINGS|SEARCH[_\s]CORROBORATION|WEB[_\s]SEARCH)[\s\S]*?)(?=(?:###|$))/i,
    pricing: /(?:###\s*(?:PRICING[_\s]EVIDENCE|PRICE[_\s]GROUNDING|RECENT[_\s]TRANSACTIONS)[\s\S]*?)(?=(?:###|$))/i,
    unconfirmed: /(?:###\s*(?:UNCONFIRMED[_\s]FIELDS|UNCONFIRMED|MISSING[_\s]ATTRIBUTES)[\s\S]*?)(?=(?:###|$))/i
  };

  const obsMatch = stageAText.match(secPatterns.observed);
  const searchMatch = stageAText.match(secPatterns.search);
  const pricingMatch = stageAText.match(secPatterns.pricing);
  const unconfMatch = stageAText.match(secPatterns.unconfirmed);

  const observedText = obsMatch ? obsMatch[0].trim() : "(Direct physical observations not structured)";
  const searchText = searchMatch ? searchMatch[0].trim() : "(Search corroboration not structured)";
  const pricingText = pricingMatch ? pricingMatch[0].trim() : "(Pricing evidence not structured)";
  const unconfirmedText = unconfMatch ? unconfMatch[0].trim() : "(No unconfirmed fields flagged in Stage A)";

  const observedFields = {};
  const searchDerivedFields = {};
  const missingFields = [];

  const extractFromText = (targetText, keyPattern, keyName, targetObj) => {
    const regex = new RegExp("(?:^|[\\n\\r])[\\s\\-*•\\d.]*[*_`]*(?:" + keyPattern + ")[*_`]*\\s*[:：\\-]\\s*[*_`]*([^\\n\\r*`]+)", "i");
    const m = targetText.match(regex);
    if (m && m[1]) {
      const val = m[1].replace(/[*_`]/g, "").trim();
      if (!val || /^(?:none|not legible|unreadable|unknown|null|undefined|-)$/i.test(val)) {
        missingFields.push(keyName);
        targetObj[keyName] = "";
      } else {
        targetObj[keyName] = val;
      }
    } else {
      missingFields.push(keyName);
      targetObj[keyName] = "";
    }
  };

  // 1. 物理画像観察値 (observedFields): observedText のみから抽出（検索由来の混入を物理遮断）
  extractFromText(observedText, "CARD_NAME|カード名|Card\\s*Name", "card_name", observedFields);
  extractFromText(observedText, "SET_CODE|セットコード|エキスパンションマーク|Set\\s*Code", "set_code", observedFields);
  extractFromText(observedText, "CARD_NUMBER|カード番号|Card\\s*Number", "card_number", observedFields);
  extractFromText(observedText, "RARITY|レアリティ|Rarity", "rarity", observedFields);
  extractFromText(observedText, "PHYSICAL_BOX_LABEL_SKU|箱ラベルSKU|箱ラベル|Box\\s*Label(?:\\s*SKU)?|Shoe\\s*Box(?:\\s*Label)?|Physical\\s*(?:Box\\s*)?Label(?:\\s*SKU)?|Style\\s*Code\\s*\\(on\\s*box\\)", "box_label_sku", observedFields);
  extractFromText(observedText, "PHYSICAL_INNER_TAG_SIZE|内タグサイズ|タグサイズ|サイズ|Inner\\s*Tag\\s*Size|Box\\s*Label\\s*Size|Physical\\s*(?:Inner\\s*Tag\\s*)?Size|Shoe\\s*Size", "inner_tag_size", observedFields);

  // 生文字列の退避 (監査・根拠用)
  observedFields.raw_box_label_sku = observedFields.box_label_sku || "";
  observedFields.raw_inner_tag_size = observedFields.inner_tag_size || "";

  // 観察値のフォールバック抽出（observedText のみ対象）
  if (!observedFields.card_number) {
    const numM = observedText.match(/\b(\d{3}\/\d{3})\b/);
    if (numM) observedFields.card_number = numM[1];
  }
  if (!observedFields.set_code) {
    const setM = observedText.match(/\b(M6a|SV\d+[a-z]?|S\d+[a-z]?)\b/i);
    if (setM) observedFields.set_code = setM[1];
  }
  if (!observedFields.rarity) {
    const rarM = observedText.match(/\b(SAR|UR|SR|AR|RR|CHR|CSR)\b/i);
    if (rarM) observedFields.rarity = rarM[1].toUpperCase();
  }
  if (!observedFields.box_label_sku) {
    // 観察テキスト内にスタイルコード / 型番パターン（例: IB4481-500, IB4481 500, DZ5485-612）が直接記載されている場合
    const skuM = observedText.match(/\b([A-Z0-9]{5,8}(?:[-_\s]+[A-Z0-9]{3,4})?)\b/i);
    if (skuM && !/^(?:NONE|N\/A|TEST)$/i.test(skuM[1])) {
      const norm = normalizeSneakerSku_(skuM[1]);
      if (norm && norm.includes("-")) {
        observedFields.box_label_sku = norm;
        if (!observedFields.raw_box_label_sku) observedFields.raw_box_label_sku = skuM[1];
      }
    }
  }
  if (!observedFields.inner_tag_size) {
    const sizeNorm = normalizeSneakerSize_(observedText);
    if (sizeNorm) {
      observedFields.inner_tag_size = sizeNorm;
      if (!observedFields.raw_inner_tag_size) observedFields.raw_inner_tag_size = sizeNorm;
    }
  }

  // 観察値のSKUおよびサイズを正式形式に正規化
  if (observedFields.box_label_sku) {
    observedFields.box_label_sku = normalizeSneakerSku_(observedFields.box_label_sku);
  }
  if (observedFields.inner_tag_size) {
    observedFields.inner_tag_size = normalizeSneakerSize_(observedFields.inner_tag_size);
  }

  // 2. Web検索由来値 (searchDerivedFields): searchText のみから抽出
  extractFromText(searchText, "STYLE_CODE|型番|スタイルコード|Style\\s*Code|SKU", "style_code", searchDerivedFields);
  extractFromText(searchText, "MODEL(?:_NAME)?|モデル名?|Model\\s*Name|Model", "corroborated_model", searchDerivedFields);
  extractFromText(searchText, "COLORWAY|カラー名?|カラーウェイ|Colorway", "corroborated_colorway", searchDerivedFields);

  // 検索由来値のフォールバック抽出（searchText のみ対象）
  if (!searchDerivedFields.style_code) {
    const skuM = searchText.match(/\b([A-Z0-9]{5,8}(?:[-_\s]+[A-Z0-9]{3,4})?)\b/i);
    if (skuM && !/^(?:NONE|N\/A|TEST)$/i.test(skuM[1])) {
      const norm = normalizeSneakerSku_(skuM[1]);
      if (norm && norm.includes("-")) {
        searchDerivedFields.style_code = norm;
      }
    }
  }
  if (searchDerivedFields.style_code) {
    searchDerivedFields.style_code = normalizeSneakerSku_(searchDerivedFields.style_code);
  }

  // 後方互換性のための結合オブジェクト（ただし物理視認と検索由来はキー別に明確に分離）
  const extractedFields = Object.assign({}, observedFields, searchDerivedFields);

  return {
    observedText: observedText,
    searchText: searchText,
    pricingText: pricingText,
    unconfirmedText: unconfirmedText,
    observedFields: observedFields,
    searchDerivedFields: searchDerivedFields,
    extractedFields: extractedFields,
    missingFields: missingFields
  };
}

/**
 * スニーカーの商品名／モデルと型番（SKU）の整合性を検証
 * 検索対象の商品名と型番が矛盾している（例: "NIKE Vomero 17" に Kobe V Protro の型番 "IB4481-500" が混入等）場合、
 * 誤同定の自動反映を防ぐため不一致（棄却）とする。
 *
 * @param {string} candidateTitle
 * @param {string} sku
 * @param {Object} [context] { searchText?: string, searchDerivedFields?: Object }
 * @return {{ matched: boolean, reason?: string, title_family?: string, sku_family?: string }}
 */
function verifySneakerModelSkuMatch_(candidateTitle, sku, context) {
  const normTitle = String(candidateTitle || "").trim().toLowerCase();
  const normSku = String(sku || "").trim().toUpperCase();
  context = context || {};

  if (!normSku) {
    return { matched: true, reason: "No SKU provided" };
  }
  if (!normTitle) {
    return { matched: true, reason: "No Title provided" };
  }

  // スニーカーファミリー定義（モデル名パターンと代表的既知型番プレフィックス）
  const SNEAKER_FAMILIES = [
    {
      family: "kobe",
      titlePatterns: [/\bkobe\b/i, /コービー/, /\bmamba\b/i, /マンバ/],
      skuPrefixes: ["IB4481", "FZ5834", "FQ3545", "FQ3548", "CW2190", "CD4991"]
    },
    {
      family: "vomero",
      titlePatterns: [/\bvomero\b/i, /ボメロ/],
      skuPrefixes: ["FB8502", "BV1358", "FD0884"]
    },
    {
      family: "jordan",
      titlePatterns: [/\bjordan\b/i, /ジョーダン/, /\baj\d+\b/i],
      skuPrefixes: ["DZ5485", "FD1437", "DH6927", "CT8527", "CD0461", "555088"]
    },
    {
      family: "dunk",
      titlePatterns: [/\bdunk\b/i, /ダンク/],
      skuPrefixes: ["DD1391", "DD1503", "BQ6817"]
    },
    {
      family: "air_force",
      titlePatterns: [/\bair\s*force\b/i, /\baf1\b/i, /エアフォース/],
      skuPrefixes: ["CW2288", "DD8959", "315122"]
    },
    {
      family: "air_max",
      titlePatterns: [/\bair\s*max\b/i, /エアマックス/],
      skuPrefixes: ["DM0029", "DJ6188", "DV3337"]
    },
    {
      family: "pegasus",
      titlePatterns: [/\bpegasus\b/i, /ペガサス/],
      skuPrefixes: ["HF9506", "DV3853", "FD2722"]
    },
    {
      family: "new_balance_2002",
      titlePatterns: [/\b2002r?\b/i],
      skuPrefixes: ["M2002", "ML2002"]
    },
    {
      family: "samba",
      titlePatterns: [/\bsamba\b/i, /サンバ/],
      skuPrefixes: ["B75806", "B75807"]
    },
    {
      family: "gazelle",
      titlePatterns: [/\bgazelle\b/i, /ガゼル/],
      skuPrefixes: ["BB5476", "BB5478"]
    }
  ];

  // 1. タイトルからファミリーを特定
  let titleFamily = null;
  for (let i = 0; i < SNEAKER_FAMILIES.length; i++) {
    const f = SNEAKER_FAMILIES[i];
    if (f.titlePatterns.some(pat => pat.test(normTitle))) {
      titleFamily = f.family;
      break;
    }
  }

  // 2. SKUプレフィックスからファミリーを特定
  let skuFamily = null;
  for (let i = 0; i < SNEAKER_FAMILIES.length; i++) {
    const f = SNEAKER_FAMILIES[i];
    if (f.skuPrefixes.some(prefix => normSku.startsWith(prefix))) {
      skuFamily = f.family;
      break;
    }
  }

  // 3. 検索テキスト（Stage A searchText または searchDerivedFields）のコンテキストからSKUファミリーを補完特定
  const searchText = String(context.searchText || "").toLowerCase();
  const searchModel = String((context.searchDerivedFields && context.searchDerivedFields.corroborated_model) || "").toLowerCase();
  if (!skuFamily && (searchText || searchModel)) {
    for (let i = 0; i < SNEAKER_FAMILIES.length; i++) {
      const f = SNEAKER_FAMILIES[i];
      if (f.titlePatterns.some(pat => pat.test(searchModel))) {
        skuFamily = f.family;
        break;
      }
      if (searchText.indexOf(normSku.toLowerCase()) !== -1) {
        const idx = searchText.indexOf(normSku.toLowerCase());
        const snippet = searchText.substring(Math.max(0, idx - 150), Math.min(searchText.length, idx + 150));
        if (f.titlePatterns.some(pat => pat.test(snippet))) {
          skuFamily = f.family;
          break;
        }
      }
    }
  }

  // ファミリーが両方判明し、食い違っている場合は不一致（棄却）
  if (titleFamily && skuFamily && titleFamily !== skuFamily) {
    return {
      matched: false,
      reason: `Sneaker family mismatch: title indicates '${titleFamily}', but SKU '${sku}' indicates '${skuFamily}'`,
      title_family: titleFamily,
      sku_family: skuFamily
    };
  }

  return {
    matched: true,
    title_family: titleFamily,
    sku_family: skuFamily
  };
}

/**
 * ブランド入力値をReaddy登録画面の正規選択肢へ正規化 (表記揺れの解消)
 * @param {string} rawBrand
 * @param {string} [category]
 * @return {string} 正規化ブランド名 (例: "Pokemon Card Game", "NIKE", "JORDAN", "adidas")
 */
function normalizeBrandValue_(rawBrand, category) {
  const trimmed = String(rawBrand || "").trim();
  if (!trimmed) return "";
  if (/^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(trimmed)) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  const normCat = normalizeCategoryValue_(category);

  // ポケモンカードの場合、またはブランド名がポケモン関連の場合: Readdy正規選択肢 "Pokemon Card Game" に統一
  if (
    normCat === "pokemon_card" ||
    /^(?:pokemon\s*card\s*game|pok[eé]mon\s*card\s*game|pok[eé]mon|pokemon|ポケモン|ポケモンカード|ポケモンカードゲーム|the\s*pok[eé]mon\s*company|nintendo|任天堂|creatures|game\s*freak)$/i.test(trimmed)
  ) {
    return "Pokemon Card Game";
  }

  // 主要スニーカーブランドの正規化
  if (
    normCat === "sneaker" ||
    /^(?:nike|adidas|jordan|air\s*jordan|new\s*balance|asics|puma|converse|vans|salomon|reebok|yeezy)/i.test(lower) ||
    /^(?:ナイキ|アディダス|ジョーダン|エアジョーダン|ニューバランス|アシックス|プーマ|コンバース|ヴァンズ|バンズ|サロモン|リーボック)/i.test(trimmed)
  ) {
    if (/^nike(?:\s+.*)?$/i.test(lower) || /^ナイキ(?:[\s・].*)?$/i.test(trimmed)) return "NIKE";
    if (/^(?:air\s+)?jordan(?:\s+.*)?$/i.test(lower) || /^(?:エア)?ジョーダン(?:[\s・].*)?$/i.test(trimmed)) return "JORDAN";
    if (/^adidas(?:\s+.*)?$/i.test(lower) || /^アディダス(?:[\s・].*)?$/i.test(trimmed)) return "adidas";
    if (/^new\s*balance(?:\s+.*)?$/i.test(lower) || /^ニューバランス(?:[\s・].*)?$/i.test(trimmed)) return "New Balance";
    if (/^asics(?:\s+.*)?$/i.test(lower) || /^アシックス(?:[\s・].*)?$/i.test(trimmed)) return "ASICS";
    if (/^puma(?:\s+.*)?$/i.test(lower) || /^プーマ(?:[\s・].*)?$/i.test(trimmed)) return "PUMA";
    if (/^converse(?:\s+.*)?$/i.test(lower) || /^コンバース(?:[\s・].*)?$/i.test(trimmed)) return "CONVERSE";
    if (/^vans(?:\s+.*)?$/i.test(lower) || /^(?:ヴァンズ|バンズ)(?:[\s・].*)?$/i.test(trimmed)) return "VANS";
    if (/^salomon(?:\s+.*)?$/i.test(lower) || /^サロモン(?:[\s・].*)?$/i.test(trimmed)) return "SALOMON";
    if (/^reebok(?:\s+.*)?$/i.test(lower) || /^リーボック(?:[\s・].*)?$/i.test(trimmed)) return "Reebok";
    if (/^yeezy(?:\s+.*)?$/i.test(lower)) return "YEEZY";
  }

  // その他ブランドはトリムした値を返却
  return trimmed;
}

function parseStoredSelectedImageIds_(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map(v => String(v === undefined || v === null ? "" : v).trim()).filter(Boolean);
  }
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v === undefined || v === null ? "" : v).trim()).filter(Boolean);
      }
    } catch (_) {}
  }
  return str.split(",").map(s => String(s || "").trim()).filter(Boolean);
}

/**
 * selected_image_ids の構文・枚数（最大3枚）・重複IDチェック
 * @param {*} rawIds
 * @param {string} productId
 * @return {Array<string>} 正規化済みID配列
 */
function validateSelectedImageIdsSyntax_(rawIds, productId) {
  if (!Array.isArray(rawIds)) {
    const err = new Error("selected_image_ids must be an array for product: " + productId);
    err.error_code = "INVALID_IMAGE_SELECTION";
    err.preserve_message = true;
    throw err;
  }

  if (rawIds.length > AI_DRAFT_CONFIG.MAX_IMAGES) {
    const err = new Error(
      `Selected images count (${rawIds.length}) exceeds maximum limit (${AI_DRAFT_CONFIG.MAX_IMAGES}) for product: ` + productId
    );
    err.error_code = "IMAGE_COUNT_EXCEEDED";
    err.preserve_message = true;
    throw err;
  }

  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < rawIds.length; i++) {
    const sId = String(rawIds[i] === undefined || rawIds[i] === null ? "" : rawIds[i]).trim();
    if (!sId) {
      const err = new Error(`Selected image ID at index ${i} is empty for product: ${productId}`);
      err.error_code = "INVALID_IMAGE_SELECTION";
      err.preserve_message = true;
      throw err;
    }
    if (seen.has(sId)) {
      const err = new Error(`Duplicate image ID '${sId}' in selected_image_ids for product: ${productId}`);
      err.error_code = "DUPLICATE_SELECTED_IMAGE_ID";
      err.preserve_message = true;
      throw err;
    }
    seen.add(sId);
    normalized.push(sId);
  }

  return normalized;
}

/**
 * AI出品ドラフト生成用システムインストラクション
 * @return {string}
 */
function buildAiDraftSystemInstruction_() {
  return [
    "You are an expert e-commerce catalog specialist for high-end sneakers, streetwear, trading cards, and collectibles.",
    "Your objective is to inspect the provided product images and metadata, then generate natural, precise, and faithful listing draft candidates in Japanese and English.",
    "",
    "Strict Generation Rules:",
    "1. DO NOT JUDGE OR MENTION AUTHENTICITY: All items are sourced through B2B brand auctions where authenticity is already verified. Do NOT attempt authenticity appraisal, and NEVER write words or sentences about authenticity or guarantees (e.g. 'Authentic', 'Genuine', '100% Original', '正規品', '確実正規品', '本物保証', '正規保証', '真正品', '真贋鑑定済み', '鑑定済み') in titles, descriptions, or hashtags. Preserve formal product names, brand names, card editions, and official grading facts (such as PSA grade and certification number).",
    "2. STRICT IDENTITY OVER SPECULATION:",
    "   - Distinguish directly observed features (from images) vs search-inferred candidates vs unconfirmed attributes.",
    "   - Never conflate different editions, printings, alternate art variants (e.g. SAR/FUR vs regular), or grading states (e.g. raw ungraded vs PSA 10).",
    "   - If identity is ambiguous or required attributes (e.g. card number, SKU) are not legible, mark identity_status as 'ambiguous' or 'candidate' and add unconfirmed fields to needs_review. Do NOT invent values.",
    "3. POKÉMON CARD GUIDELINES:",
    "   - Transcribe visible card text: card_name, set_code, card_number, rarity, language.",
    "   - Title format: strictly '{card_name} [{set_code} {card_number}] {set_name}' (or '[PSA10] {card_name} [{set_code} {card_number}] {set_name}' if graded). NEVER prepend 'ポケモンカードゲーム'. NEVER include rarity in the title.",
    "   - Description: keep concise and factual (set name, card name, card count: 1). NEVER assert mint/flawless condition ('白かけなし' etc.) unless both front and back are clearly visible.",
    "   - Canonical brand must be 'Pokemon Card Game'. Canonical category must be 'pokemon_card'.",
    "4. SNEAKER GUIDELINES:",
    "   - Check box label and inner size tag. Extract SKU and size ONLY if directly legible from physical labels in the images. If not legible, leave sku and size as empty strings ('') and add to needs_review. NEVER put search-inferred model codes into the definitive sku field.",
    "   - Canonical category must be 'sneaker'.",
    "4B. APPAREL GUIDELINES (applies to category 'apparel', and clothing/garment items even when category is 'other' or unconfirmed):",
    "   - NO BRAND ASSUMPTION: Never assume or default to 'Chrome Hearts' (or any specific brand) from generic motifs (crosses, skulls, gothic lettering, black fabric) or removable paper dry-cleaning/shop tags. Confirm brand ONLY from legible garment tags/logos/hallmarks or explicit metadata; otherwise output brand: ''.",
    "   - TITLE FORMAT (title_ja & title_en):",
    "     * Write principally in English, concisely arranging ONLY confirmed elements in natural order: '[Brand] [× Collaboration] [Model or Item Type] [Color] [Size]' (format illustration only: 'SUPREME × HONDA HRC RACING JACKET S' — NEVER copy example words, brands, or sizes).",
    "     * If brand or official model is unconfirmed, do NOT guess or fabricate them; use confirmed visual appearance, garment/item type, and color in English (plus size only if confirmed). Append concise Japanese to title_ja ONLY when English alone would be unclear. Keep title_en strictly in English.",
    "   - DESCRIPTION ORDER (description_ja) & HASHTAGS (hashtags_ja):",
    "     1) Confirmed brand/model and concise product overview (if brand/model is unconfirmed, state only the confirmed garment type/appearance).",
    "     2) Design features directly visible in the actual product photos.",
    "     3) Condition and signs of wear visible in the photos. NEVER assert the condition of unphotographed areas (e.g., unseen back, interior, or tags). NEVER automatically write boilerplate phrases like 'クリーニング済み' (cleaned).",
    "     4) Spec block using ONLY '【サイズ】', '【素材】', '【原産国】', '【付属品】' — include ONLY items positively confirmed from physical garment tags, registered metadata, or reliable official specifications of a confirmed model. Include flat measurements (実寸) ONLY when actual measured data is provided; NEVER estimate measurements from photos or copy catalog size charts. Completely OMIT any unconfirmed '【...】' header/line (never write '不明', '未確認', or borrow example values).",
    "     5) Necessary notes (concise, only if needed) at the end of description_ja, and a small number (2–5) of relevant hashtags in hashtags_ja based strictly on confirmed attributes (do NOT duplicate hashtags inside description_ja).",
    "   - MISSING INFO HANDLING: Do NOT fabricate filler sentences or borrow example numbers, conditions, or wording when details are unconfirmed; simply omit unconfirmed items. Insufficient information (e.g., 1 front image with no tag visible) must NEVER cause generation failure.",
    "5. PRICE GROUNDING & TIERED PRICING PROPOSALS:",
    "   - Search specifically for market pricing in JPY for the identified product.",
    "   - Always propose a numeric price whenever pricing or market information is found. Price is a draft proposal for staff review before final approval.",
    "   - Tiered Priority:",
    "     1) Recent sold/completed transactions (成約参考): price_type: 'sold', price_basis: 'recent_sold_provisional', propose numeric price.",
    "     2) Active listings of identical item (販売中参考): price_type: 'active', price_basis: 'active_listing_reference', propose numeric price. NEVER call active listings 'sold'.",
    "     3) Comparable market evidence / unknown transaction type (市場参考): price_type: 'unknown', price_basis: 'market_reference_proposal', propose numeric price.",
    "     4) AI estimation based on category/model (AI概算): price_basis: 'unverified_estimate', propose numeric price.",
    "   - Output price: null ONLY in exceptional cases where the product itself cannot be identified or absolutely no market reference exists anywhere.",
    "6. CONDITION CANDIDATE: Choose from: '新品・未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い'.",
    "   - APPAREL & SNEAKERS / SHOES: Evaluate items assuming their post-cleaning appearance. Unless there are obvious scratches, prominent stains, or structural damage, propose '目立った傷や汚れなし' as the standard good used condition candidate. Do NOT over-penalize minor signs of wear into lower condition tiers. When obvious damage or prominent stains are visible, reflect them accurately ('やや傷や汚れあり' or '傷や汚れあり'). Do NOT propose '新品・未使用' without clear objective proof (such as attached retail tags / unworn deadstock). NEVER automatically write 'クリーニング済み' in descriptions.",
    "   - POKÉMON CARDS (UNGRADED): In pokemon_card.card_condition, assign 'A', 'B', or 'C'. Default to 'A' as pre-review draft. Assign 'B' or 'C' only when visible flaws, scratches, creases, or edge wear are clearly identified in the images. Never leave blank or fail solely because back image is missing (draft 'A' is used).",
    "   - POKÉMON CARDS (GRADED): In pokemon_card.card_condition, leave strictly empty string (''). Use grader and grade fields instead.",
    "7. OUTPUT FORMAT: Output ONLY valid JSON adhering strictly to the response schema."
  ].join("\n");
}

/**
 * 禁止語句（真贋保証・過剰主張表現）の検知
 * @param {string} text 対象文字列
 * @return {Array<string>} 検知された禁止語句一覧
 */
function detectProhibitedWords_(text) {
  if (!text) return [];
  const detected = [];
  AI_DRAFT_CONFIG.PROHIBITED_PATTERNS.forEach(pattern => {
    const match = String(text).match(pattern);
    if (match) {
      detected.push(match[0]);
    }
  });
  return detected;
}

/**
 * 出品文（タイトル・説明文・ハッシュタグ）から真贋判定・正規保証に関する不要な文や語句を除去する。
 * - PSAグレード ([PSA10], PSA 10, BGS, CGC, ARS) や証明番号の事実記載、正式な商品名・ブランド名・カードの版は保持する。
 * - 真贋保証語句が含まれていても生成エラーにはせず、該当文・語句のみを除去して有用な内容を保持する。
 *
 * @param {string} text
 * @param {Object} [options] { mode?: "title" | "description" | "hashtags" }
 * @return {string}
 */
function stripAuthenticityGuaranteeText_(text, options) {
  options = options || {};
  const mode = String(options.mode || "description").trim().toLowerCase();
  const raw = String(text || "");
  if (!raw.trim()) return "";

  if (mode === "hashtags") {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((tok) => {
      return !/(?:正規品|確実正規|本物保証|正規保証|真正品|真贋|鑑定済|本物|100%authentic|100%genuine|100%original|guaranteedauthentic|certifiedauthentic|authenticguaranteed)/i.test(
        tok
      );
    });
    return filtered.join(" ").trim();
  }

  // インラインの真贋・保証語句の除去（Vans Authentic 44 DX、PSA10、Certified Fresh、adidas Originals 等の正式名称・型名・ブランド名は保護）
  const stripInlinePhrases = (str) => {
    let s = String(str || "");
    // 1. 括弧付きの真贋・保証タグを除去（[PSA10] 等は対象外）
    s = s.replace(
      /(?:【[^】]*(?:正規品|本物保証|正規保証|真正品|真贋|(?:プロ|AACD)?鑑定済)[^】]*】|\[[^\]]*(?:正規品|本物保証|正規保証|真正品|真贋|(?:プロ|AACD)?鑑定済|(?:100%\s*)?(?:authentic|genuine|original)|(?:guaranteed|certified)\s+authentic)[^\]]*\]|\([^)]*(?:正規品|本物保証|正規保証|真正品|真贋|(?:プロ|AACD)?鑑定済|(?:100%\s*)?(?:authentic|genuine|original)|(?:guaranteed|certified)\s+authentic)[^)]*\)|（[^）]*(?:正規品|本物保証|正規保証|真正品|真贋|(?:プロ|AACD)?鑑定済|(?:100%\s*)?(?:authentic|genuine|original)|(?:guaranteed|certified)\s+authentic)[^）]*）)/gi,
      " "
    );
    // 2. 日本語の真贋保証フレーズを除去
    s = s.replace(
      /(?:100%\s*)?(?:国内\s*)?(?:確実\s*)?正規品(?:保証|です|になります|となります|を保証(?:します|いたします)?|につきご安心ください)?|(?:100%\s*)?本物保証(?:いたします|します|付き|済)?|正規保証(?:付き|済)?|真正品(?:保証)?|(?:真贋)?鑑定済(?:み)?(?:の)?(?:国内\s*)?(?:確実\s*)?(?:正規品|本物|真正品)|真贋(?:鑑定|確認|チェック|保証)(?:済(?:み)?)?|本物(?:です|になります|を保証(?:します|いたします)?)/gi,
      ""
    );
    // 3. 英語の真贋保証・鑑定主張フレーズを除去（単体の Authentic / Genuine / Original / Certified は正式商品名・型名保護のため除去しない）
    s = s.replace(
      /\b(?:genuine\s+|authentic\s+)?100%\s*(?:guaranteed\s+|certified\s+|verified\s+)?(?:authentic|genuine|original)(?:\s+(?:and\s+(?:authentic|genuine)|guaranteed|guarantee|pair|item|product|card))?\b|\b(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)(?:\s+(?:and\s+(?:authentic|genuine)|pair|item|product|card|guaranteed|guarantee))?\b|\b(?:authentic|genuine)\s+(?:and\s+(?:authentic|genuine)\s+)?(?:pair\s+|item\s+|product\s+|card\s+)?(?:guaranteed|guarantee|100%)\b|\bauthenticity\s+(?:is\s+)?(?:guaranteed|verified|checked|inspected|assured|confirmed)\b|\b(?:authenticated|appraised|verified)\s+by\s+(?:professional|expert|our)(?:\s+\w+)?\b|\bguaranteed\s+to\s+be\s+(?:authentic|genuine|real|original)\b/gi,
      ""
    );
    return s;
  };

  if (mode === "title") {
    let cleanedTitle = stripInlinePhrases(raw)
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-/|:：・,、]+|[\s\-/|:：・,、]+$/g, "")
      .trim();
    return cleanedTitle;
  }

  // description モード: 行・文単位で真贋保証の専用文を除去し、PSA等の事実文・商品名文は保護しつつインライン保証語句のみ除去
  const isPsaOrGradingFactSentence = (sentence) =>
    /(?:\b(?:PSA|BGS|CGC|ARS)\s*\d+|証明番号|認定番号|certification\s*(?:number|no)|graded\s+by\s+(?:PSA|BGS|CGC|ARS))/i.test(
      sentence
    );

  const isAuthenticityClaimSentence = (sentence) => {
    if (isPsaOrGradingFactSentence(sentence)) return false;
    return (
      /(?:確実\s*|国内\s*)?正規品|本物保証|正規保証|真正品|真贋(?:鑑定|確認|チェック|保証)|(?:プロの)?鑑定士|AACD|(?:ブランドオークション|古物市場|買取店).*(?:真贋|鑑定)|(?:当店|弊社|出品商品).*(?:本物|正規)|偽物(?:では|じゃ)|模造品|コピー品/i.test(
        sentence
      ) ||
      /\b100%\s*(?:guaranteed\s+|certified\s+|verified\s+)?(?:authentic|genuine|original)\b|\b(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)\b|\b(?:authentic|genuine)\b[^.!?]*\b(?:guaranteed|guarantee|100%)\b|\bauthenticity\s+(?:is\s+)?(?:guaranteed|verified|checked|inspected|assured|confirmed)\b|\b(?:authenticated|appraised|verified)\s+by\s+(?:professional|expert|our)\b|\bguaranteed\s+to\s+be\s+(?:authentic|genuine|real|original)\b/i.test(
        sentence
      )
    );
  };

  const lines = raw.split(/\r?\n/);
  const processedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      processedLines.push("");
      continue;
    }
    // 日本語の句点・感嘆符または英語のピリオド区切りで文分割
    const sentences = line
      .split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z0-9"'\(\[])/)
      .filter((seg) => seg && seg.trim().length > 0);

    const keptSentences = [];
    for (let j = 0; j < sentences.length; j++) {
      const sent = sentences[j];
      if (isAuthenticityClaimSentence(sent)) {
        // 文の中に他の事実説明がなく真贋主張文である場合は文ごと除去、
        // ただし「Genuine 100% Original なスニーカーです。」のように商品記述を含む短文が1文だけの場合はインライン除去結果を確認
        const inlineCleaned = stripInlinePhrases(sent)
          .replace(/^\s*(?:な|の|で|かつ|、|,)\s*/, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        const isPureGuarantee =
          /^(?:当店|弊社|こちら|本商品|すべて|全て)?[\s、,]*(?:いたします|します|です|ます|おります|ください|保証|鑑定|確認|チェック|済み|品|pair|item|product|guaranteed|verified|only)*[.。！!？?\s]*$/i.test(
            inlineCleaned
          );
        if (!isPureGuarantee && inlineCleaned.length >= 4 && !detectProhibitedWords_(inlineCleaned).length) {
          keptSentences.push(inlineCleaned);
        }
        continue;
      }
      const cleanedSent = stripInlinePhrases(sent)
        .replace(/\s{2,}/g, " ")
        .trim();
      if (cleanedSent) {
        keptSentences.push(cleanedSent);
      }
    }

    if (keptSentences.length > 0) {
      const joiner = /[a-zA-Z]\.$/.test(keptSentences[0]) ? " " : "";
      processedLines.push(keptSentences.join(joiner).replace(/\s{2,}/g, " ").trim());
    }
  }

  let result = processedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 万一すべての文が除去されて空になった場合の安全フォールバック
  if (!result) {
    result = stripInlinePhrases(raw)
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-/|:：・,、.。]+|[\s\-/|:：・,、]+$/g, "")
      .trim();
  }

  return result;
}

/**
 * 説明文・タイトル・ハッシュタグから「クリーニング済み」等の自動定型文を除去する。
 *
 * @param {string} text
 * @param {Object} [options] { mode?: "title" | "description" | "hashtags" }
 * @return {string}
 */
function stripCleaningBoilerplateText_(text, options) {
  options = options || {};
  const mode = String(options.mode || "description").trim().toLowerCase();
  const raw = String(text || "");
  if (!raw.trim()) return "";

  if (mode === "hashtags") {
    return raw
      .split(/\s+/)
      .filter((tok) => tok && !/(?:クリーニング済|ホームクリーニング|cleaned)/i.test(tok))
      .join(" ")
      .trim();
  }

  if (mode === "title") {
    return raw
      .replace(/(?:【[^】]*クリーニング済[^】]*】|\[[^\]]*クリーニング済[^\]]*\]|\([^)]*クリーニング済[^)]*\)|（[^）]*クリーニング済[^）]*）|(?:ホーム)?クリーニング済(?:み)?)/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // description モード
  let s = raw;
  // 括弧付き【クリーニング済み】等を除去
  s = s.replace(/(?:【[^】]*クリーニング済[^】]*】|\[[^\]]*クリーニング済[^\]]*\])/gi, "");
  // 「出品にあたりクリーニング済みです。」等の定型文を除去
  s = s.replace(
    /(?:出品にあたり|専門業者にて|専用クリーナーにて|専用クリーナーで|丁寧に)?(?:ホーム)?クリーニング済(?:み)?(?:です|となっております|の商品です|ですので[^\n。！!]*)[。！!]?\s*/gi,
    ""
  );
  // 文中の「クリーニング済みで、」「クリーニング済みのため」等を除去
  s = s.replace(/(?:ホーム)?クリーニング済(?:み)?(?:で[、,]?\s*|のため[、,]?\s*|につき[、,]?\s*|・)/gi, "");
  // 残った単独の「クリーニング済み」「クリーニング済」を除去
  s = s.replace(/(?:ホーム)?クリーニング済(?:み)?[。！!]?/gi, "");
  // 英語の "Professionally cleaned before listing." 等の定型文を除去
  s = s.replace(
    /\b(?:professionally|already|freshly)\s+cleaned(?:\s+before\s+listing|\s+and\s+ready\s+to\s+wear)?\.?\s*/gi,
    ""
  );
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * アパレル・ファッション小物・スニーカー（靴）の状態候補を要件に沿って正規化する。
 * - クリーニング後の見た目で判断する前提とし、明らかな傷・汚れ・破損がなければ「目立った傷や汚れなし」を標準候補とする。
 * - 軽い使用感だけで「やや傷や汚れあり」等に下げすぎない。
 * - 明らかな破損や目立つ汚れがある場合は状態（「やや傷や汚れあり」「傷や汚れあり」）に反映する。
 * - 根拠（タグ付き・未使用等の明記）なく中古商品を「新品・未使用」にしない。
 *
 * @param {string} rawCondition
 * @param {Object} [context] { category, title_ja, description_ja, title_en, description_en, enforce_used_condition_policy }
 * @return {string}
 */
function normalizeApparelAndShoeCondition_(rawCondition, context) {
  const cond = String(rawCondition || "").trim();
  context = context || {};
  const cat = String(context.category || "").trim().toLowerCase();
  if (cat === "pokemon_card") return cond;

  const textPool = [
    context.title_ja,
    context.description_ja,
    context.title_en,
    context.description_en
  ]
    .filter(Boolean)
    .join(" ");

  const isApparelOrShoe =
    cat === "sneaker" ||
    cat === "apparel" ||
    cat === "fashion_goods" ||
    /(?:スニーカー|シューズ|ブーツ|サンダル|靴|Tシャツ|ロンT|シャツ|カットソー|スウェット|パーカー|フーディー|ニット|セーター|カーディガン|ジャケット|コート|ブルゾン|ダウン|パンツ|デニム|ジーンズ|スカート|ワンピース|古着|アパレル|衣類|\bsneakers?\b|\bshoes?\b|\bt-?shirt\b|\bhoodie\b|\bsweatshirt\b|\bjacket\b|\bcoat\b|\bpants\b|\bjeans\b|\bdenim\b|\bdress\b)/i.test(
      textPool
    );

  if (!isApparelOrShoe) return cond;

  const negatedDamageRx =
    /(?:目立[つった]|明らかな|顕著な|大きな|ひどい|気になる|特筆すべき)?(?:傷|キズ|汚れ|ダメージ|シミ|破れ|ほつれ|色褪せ|変色|加水分解|ソールの減り|破損)(?:[や・、,](?:目立[つった]|明らかな|大きな)?(?:傷|キズ|汚れ|ダメージ|シミ|破れ|ほつれ|破損))*(?:等)?(?:は|も|が)?(?:一切)?(?:なく|見当たらず|見当たりません|見受けられず|見受けられません|ございません|ありません|ない|なし)|\b(?:no|without\s+any|free\s+of)\s+(?:obvious|prominent|major|heavy|visible|significant)\s+(?:damage|stains?|scratches|tears?|flaws?)\b/gi;
  const textWithoutNegatedDamage = textPool.replace(negatedDamageRx, " ");

  const hasSevereDamage =
    /(?:大きな破損|致命的な破損|ソール剥がれ|加水分解|大きな破れ|着用困難|ジャンク|全体的に状態が悪い|\bheavily\s+damaged\b|\bstructural\s+damage\b|\bsole\s+separation\b)/i.test(
      textWithoutNegatedDamage
    );
  const hasObviousDamageOrStain =
    hasSevereDamage ||
    /(?:明らかな(?:傷|汚れ|破損|ダメージ)|目立つ(?:傷|汚れ|シミ|黄ばみ|ダメージ|擦れ|毛玉|色褪せ)|大きな(?:傷|汚れ|シミ|ダメージ)|破れ|穴あき|穴が|ひび割れ|欠損|強い使用感|激しい(?:傷|汚れ|使用感)|\bobvious\s+(?:damage|stain|scratches|wear)\b|\bprominent\s+(?:stain|damage|scratches)\b|\bheavy\s+(?:stains?|wear|scratches)\b|\bvisible\s+tears?\b)/i.test(
      textWithoutNegatedDamage
    );
  const hasOnlyMinorWear =
    !hasObviousDamageOrStain &&
    /(?:軽い使用感|若干の使用感|多少の使用感|わずかな使用感|軽微な(?:使用感|擦れ|スレ|汚れ|履きジワ)|若干の(?:擦れ|スレ|履きジワ)|目立[つった](?:傷|汚れ)(?:や(?:傷|汚れ))?は(?:なく|ありません|見当たりません)|状態良好|良好な状態|\bminor\s+(?:signs\s+of\s+)?wear\b|\blight\s+wear\b|\bslight\s+wear\b|\bgood\s+used\s+condition\b|\bgood\s+pre-?owned\s+condition\b)/i.test(
      textPool
    );
  const hasExplicitNewUnusedBasis =
    /(?:新品タグ|タグ付き|黒タグ付|未使用品|新品未使用|デッドストック|未試着|未着用|\bbrand\s+new\s+with\s+tags\b|\bnwt\b|\bdeadstock\b|\bunworn\b)/i.test(
      textPool
    );
  const hasUsedIndication =
    Boolean(context.enforce_used_condition_policy) ||
    /(?:中古|ユーズド|USED|古着|着用感|使用感|履きジワ|pre-?owned|secondhand|worn|used\s+condition)/i.test(
      textPool
    );

  // 1. 明らかな破損や目立つ汚れがあるのに「新品・未使用」「未使用に近い」「目立った傷や汚れなし」になっている場合は下方修正
  if (hasSevereDamage) {
    if (cond === "新品・未使用" || cond === "未使用に近い" || cond === "目立った傷や汚れなし" || cond === "やや傷や汚れあり") {
      return "傷や汚れあり";
    }
  } else if (hasObviousDamageOrStain) {
    if (cond === "新品・未使用" || cond === "未使用に近い" || cond === "目立った傷や汚れなし") {
      return "やや傷や汚れあり";
    }
  }

  // 2. 軽い使用感のみで明らかな傷・汚れ・破損がないのに「やや傷や汚れあり」「傷や汚れあり」に下げすぎている場合は「目立った傷や汚れなし」に補正
  if (hasOnlyMinorWear && (cond === "やや傷や汚れあり" || cond === "傷や汚れあり")) {
    return "目立った傷や汚れなし";
  }

  // 3. 根拠なく「新品・未使用」（または中古示唆があるのに「未使用に近い」）になっている場合は標準候補「目立った傷や汚れなし」に補正
  if (cond === "新品・未使用" && !hasExplicitNewUnusedBasis) {
    return "目立った傷や汚れなし";
  }
  if (cond === "未使用に近い" && !hasExplicitNewUnusedBasis && hasUsedIndication) {
    return "目立った傷や汚れなし";
  }

  return cond;
}

/**
 * ポケモンカード用商品名のサニタイズ (冗長接頭辞の排除 & BISテンプレート整形)
 * @param {string} titleJa
 * @param {Object} [pokemonCardData]
 * @return {string} 整形済み商品名
 */
function sanitizePokemonCardTitle_(titleJa, pokemonCardData) {
  let cleaned = String(titleJa || "").trim();
  // 先頭の「ポケモンカードゲーム」「ポケモンカード」「Pokemon Card Game」「Pokémon Card」等の冗長プレフィックスを除去
  cleaned = cleaned.replace(/^(?:ポケモンカードゲーム|ポケモンカード|pok[eé]mon\s*card\s*game|pok[eé]mon\s*card)\s*[:：\-ー・]?\s*/i, "");
  // 空の角括弧 [] やプレースホルダー [none] 等の残骸を除去
  cleaned = cleaned.replace(/\[\s*\]/g, "").replace(/\[\s*(?:none|null|undefined|-)\s*\]/gi, "").trim();

  // もし pokemonCardData (card_name, card_number, set_name等) が揃っている場合、
  // Readdy手動登録見本フォーマット: {card_name} [{set_code} {card_number}] {set_name} に整形 (指示1, 指示4)
  if (pokemonCardData && typeof pokemonCardData === "object") {
    const cardName = String(pokemonCardData.card_name || "").trim();
    const rawSetCode = String(pokemonCardData.set_code || "").trim();
    const rawCardNum = String(pokemonCardData.card_number || "").trim();
    let rawSetName = String(pokemonCardData.set_name || pokemonCardData.expansion || "").trim();

    const isPlaceholder = (val) => !val || /^(?:none|null|undefined|unknown|n\/?a|-)$/i.test(val);

    const setCode = isPlaceholder(rawSetCode) ? "" : rawSetCode;
    const cardNum = isPlaceholder(rawCardNum) ? "" : rawCardNum;
    const setName = isPlaceholder(rawSetName) ? "" : rawSetName;

    if (cardName && !isPlaceholder(cardName)) {
      const parts = [];

      // 1. 鑑定品プレフィックス ([PSA10] 等)
      if (pokemonCardData.grading_status === "graded" && pokemonCardData.grader && pokemonCardData.grade) {
        parts.push(`[${pokemonCardData.grader}${pokemonCardData.grade}]`);
      } else {
        const gradeMatch = cleaned.match(/^(\[?(?:PSA|BGS|CGC|ARS)\s*\d+(?:\.\d+)?\]?)\s*/i);
        if (gradeMatch) {
          const gStr = gradeMatch[1];
          parts.push(gStr.startsWith("[") ? gStr : `[${gStr}]`);
        }
      }

      // 2. カード名
      parts.push(cardName);

      // 3. [セットコード カード番号] 括弧ブロック (読めた場合のみ作成し、不完全な空ブラケット[]は作らない)
      const bracketInner = [];
      if (setCode) bracketInner.push(setCode);
      if (cardNum) bracketInner.push(cardNum);

      if (bracketInner.length > 0) {
        parts.push(`[${bracketInner.join(" ")}]`);
      }

      // 4. セット名 (拡張パック名)
      if (setName) {
        parts.push(setName);
      }

      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
  }

  return cleaned.replace(/\[\s*\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * サーバー側価格丸めポリシー (LLM暗算の排除)
 * @param {number} rawPrice
 * @return {number}
 */
function roundPriceByPolicy_(rawPrice) {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return 0;
  if (rawPrice >= 10000) {
    // 1万円以上: 100円単位で四捨五入
    return Math.round(rawPrice / 100) * 100;
  } else if (rawPrice >= 1000) {
    // 1千円以上1万円未満: 50円単位で四捨五入
    return Math.round(rawPrice / 50) * 50;
  } else {
    // 1千円未満: 10円単位で四捨五入
    return Math.round(rawPrice / 10) * 10;
  }
}

/**
 * 参照URLがサイト内検索結果一覧ページまたは検索エンジン結果ページであるか判定する
 * - 検索結果一覧URLは個別商品の一致・成約有無・取引価格を証明しないため、確認済み価格根拠として採用しない
 * - 個別商品ページ (/item/..., /products/..., /jp/auction/..., /itm/... 等) は一律除外しない
 * @param {string} rawUrl
 * @return {boolean}
 */
function isSearchResultListingUrl_(rawUrl) {
  let url = String(rawUrl || "").trim();
  if (!url) return false;
  if (!/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/i.test(url)) {
    url = "https://" + url;
  }
  const m = url.match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return false;

  const host = String(m[1] || "").toLowerCase();
  const pathname = String(m[2] || "/").toLowerCase();
  const query = String(m[3] || "");

  // 1. 検索エンジン結果ページは一覧扱い
  if (
    /^(?:www\.)?(?:google\.[a-z.]+|bing\.com|duckduckgo\.com)$/i.test(host) ||
    host === "search.yahoo.co.jp" ||
    host === "search.rakuten.co.jp"
  ) {
    return true;
  }

  // 2. 明示的な個別商品ページパスは保護（クエリに流入元やサイズ指定が付いていても除外しない）
  if (host === "item.fril.jp" && pathname.length > 1 && !/^\/search(?:\/|$)/i.test(pathname)) {
    return false;
  }
  const individualItemPathPattern = /(?:^|\/)(?:items?|products?|itm|dp|gp\/product|jp\/auction|auction|shops\/product|goods\/detail|apparels|streetwears|trading-cards|used)\/(?!search(?:\/|$)|search_results?(?:\/|$)|list(?:\/|$))[a-z0-9%._-]+/i;
  if (individualItemPathPattern.test(pathname)) {
    return false;
  }

  // 3. サイト内検索結果一覧パス (/search, /sch, fril.jp/s, amazon/s 等)
  if (/(?:^|\/)(?:search|search_result|searchresults)(?:\/|$|\.[a-z0-9]+$)/i.test(pathname)) {
    return true;
  }
  if (/^\/sch(?:\/|$)/i.test(pathname)) {
    return true;
  }
  if (
    /^\/s(?:\/|$)/i.test(pathname) &&
    (/(?:^|\.)(?:fril\.jp|amazon\.[a-z.]+)$/i.test(host) || /(?:^|&)(?:q|query|k|keyword)=/i.test(query))
  ) {
    return true;
  }

  // 4. 個別商品パスではなく、検索キーワード系クエリパラメータを持つ一覧URL
  if (query && /(?:^|&)(?:keyword|keywords|q|query|search|search_word|search_keyword|freeword|word|_nkw|va|ve)=[^&]+/i.test(query)) {
    return true;
  }

  return false;
}

/**
 * ブランド・型番(SKU)を特定できていないアパレル相当の商品であるか判定する
 * - カテゴリ分類自体は変更せず、apparel / fashion_goods に加え、
 *   category が "other" や未設定のまま衣類系タイトル・ハッシュタグを持つ商品（TMP-000159相当）も対象とする
 * - スニーカー・ポケモンカード・ジュエリーは対象外
 * @param {Object} rawCandidate
 * @param {Object} [targetMeta]
 * @return {boolean}
 */
function isUnidentifiedApparelEquivalent_(rawCandidate, targetMeta) {
  if (!rawCandidate || typeof rawCandidate !== "object") return false;
  const meta = targetMeta || {};
  const rawCat = String(meta.category !== undefined ? meta.category : (rawCandidate.category || "")).trim().toLowerCase();

  if (rawCat === "pokemon_card" || rawCat === "sneaker" || rawCat === "jewelry") {
    return false;
  }

  let isApparelEquivalent = (
    rawCat === "apparel" ||
    rawCat === "fashion_goods" ||
    rawCat === "アパレル" ||
    rawCat === "衣類" ||
    rawCat === "ファッション小物"
  );

  if (!isApparelEquivalent && (!rawCat || rawCat === "other" || rawCat === "その他")) {
    const textPool = [
      meta.title_ja !== undefined ? meta.title_ja : rawCandidate.title_ja,
      meta.title_en !== undefined ? meta.title_en : rawCandidate.title_en,
      meta.description_ja !== undefined ? meta.description_ja : rawCandidate.description_ja,
      meta.hashtags_ja !== undefined ? meta.hashtags_ja : rawCandidate.hashtags_ja
    ].filter(Boolean).join(" ");

    if (textPool) {
      const apparelKeywordPattern = /(?:Tシャツ|ロンT|ロングスリーブ|長袖|半袖|シャツ|カットソー|ポロシャツ|タンクトップ|スウェット|トレーナー|パーカー|フーディー|ニット|セーター|カーディガン|ベスト|ジャケット|コート|ブルゾン|ジャンパー|ダウン|マウンテンパーカー|テーラード|パンツ|デニム|ジーンズ|スラックス|チノパン|カーゴパンツ|ショーツ|ショートパンツ|ハーフパンツ|スカート|ワンピース|セットアップ|スーツ|ジャージ|トラックジャケット|トラックパンツ|オーバーオール|サロペット|古着|アパレル|衣類|トップス|ボトムス|アウター|\bt-?shirt\b|\btee\b|\blong\s*sleeve\b|\bsweatshirt\b|\bhoodie\b|\bsweater\b|\bcardigan\b|\bjacket\b|\bcoat\b|\bblouson\b|\bpants\b|\btrousers\b|\bjeans\b|\bdenim\b|\bshorts\b|\bskirt\b|\bdress\b|\bapparel\b|\bgarment\b)/i;
      isApparelEquivalent = apparelKeywordPattern.test(textPool);
    }
  }

  if (!isApparelEquivalent) return false;

  const rawBrand = String(meta.brand !== undefined ? meta.brand : (rawCandidate.brand || "")).trim();
  const rawSku = String(meta.sku !== undefined ? meta.sku : (rawCandidate.sku || "")).trim();

  const isPlaceholderBrand =
    !rawBrand ||
    /^(?:不明|ブランド不明|ノーブランド|未確認|未特定|unknown|unbranded|no\s*brand|n\/?a|none|null|undefined|-)$/i.test(rawBrand);
  const isPlaceholderSku =
    !rawSku ||
    /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-|unspecified|not\s*visible)$/i.test(rawSku) ||
    /(?:画像から確認できず|確認不可|不明|未確認|テスト|推測|推定|candidate|inferred)/i.test(rawSku);

  return isPlaceholderBrand && isPlaceholderSku;
}

/**
 * 個別価格根拠アイテムのサーバー側厳格検証
 * 1. source_url: 有効なHTTP/HTTPS形式であり、かつサイト内検索結果一覧URLではないこと
 *    (https形式であるだけでは「確認済み」とせず、検索結果一覧URLは未検証として除外する)
 * 2. price_type: "sold" (成約) または "active" (出品中)
 * 3. amount: 正の整数
 * 4. currency: 明示的に "JPY" であること (未指定時の勝手な補完は禁止)
 * 5. transaction_date: YYYY-MM または YYYY-MM-DD 形式の日付が存在すること
 * 6. item_match_condition: 明示的に "exact_match" / "verified_match" / "comparable_model" であること
 * 7. verification_status:
 *    - URL形式・必須項目が揃う個別ページ: "format_valid" (URL形式通過のみ・個別取引内容や成約有無は未確認)
 *    - 明示的な実取引確認フラグがある場合: "content_verified"
 *    - 検索結果一覧URLや項目不備がある場合: "unverified"
 *
 * @param {Object} rawEvidence
 * @param {Object} [targetMeta]
 * @return {Object|null}
 */
function verifyPriceEvidenceItem_(rawEvidence, targetMeta) {
  if (!rawEvidence || typeof rawEvidence !== "object") return null;

  let url = String(rawEvidence.source_url || rawEvidence.source || "").trim();
  // プロトコル補完: URLが "snkrdunk.com/..." などの場合に https:// を自動補完
  if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/i.test(url)) {
    url = "https://" + url;
  }

  const rawType = String(rawEvidence.price_type || rawEvidence.type || "").trim().toLowerCase();
  const priceType = (rawType === "sold" || rawType === "completed" || rawType === "成約" || rawType === "落札")
    ? "sold"
    : (rawType === "active" || rawType === "listing" || rawType === "出品中" || rawType === "販売中" || rawType === "active_listing" || rawType === "for_sale" || rawType === "sale" || rawType === "ask" || rawType === "onsale")
      ? "active"
      : "unknown";
  const rawAmt = Number(rawEvidence.amount !== undefined ? rawEvidence.amount : rawEvidence.price);
  const amount = (Number.isFinite(rawAmt) && Number.isSafeInteger(Math.round(rawAmt)) && rawAmt > 0) ? Math.round(rawAmt) : null;

  let currency = rawEvidence.currency !== undefined ? String(rawEvidence.currency).trim().toUpperCase() : "";
  if (currency === "円" || currency === "¥" || currency === "YEN" || currency === "JAPANESE YEN") {
    currency = "JPY";
  }

  const dateStr = String(rawEvidence.transaction_date || rawEvidence.date || "").trim();
  let matchCond = rawEvidence.item_match_condition !== undefined ? String(rawEvidence.item_match_condition).trim() : (rawEvidence.condition !== undefined ? String(rawEvidence.condition).trim() : "");
  if (matchCond && /^(?:exact|same|identical|新品|一致|同等)$/i.test(matchCond)) {
    matchCond = "exact_match";
  }

  // サーバー側客観検証:
  // a) URLが有効な形式であり、かつサイト内検索結果一覧ページではないこと
  const isUrlSyntaxValid = /^https?:\/\/[^\s$.?#].[^\s]*$/i.test(url);
  const isSearchListingUrl = isUrlSyntaxValid && isSearchResultListingUrl_(url);
  const isIndividualEvidenceUrl = isUrlSyntaxValid && !isSearchListingUrl;
  // b) 取引日付が存在するか (日付フォーマット崩れを理由に全破棄しない)
  const isDateValid = !dateStr || /^\d{4}(?:[-/.]\d{1,2})?(?:[-/.]\d{1,2})?$/.test(dateStr) || dateStr.length <= 30;
  // c) 通貨が明示的に JPY か (未指定や他通貨は不可)
  const isCurrencyJpy = (currency === "JPY");
  // d) 商品一致条件が明示的に exact_match / verified_match / comparable_model か (未指定や他条件は不可)
  const isMatchExact = (matchCond === "exact_match" || matchCond === "verified_match" || matchCond === "comparable_model");

  // 形式検査判定 (format_valid): 個別参照URLと金額が存在し、通貨がJPY、一致条件が妥当（実取引内容は未確認）
  const isFormatValid = isIndividualEvidenceUrl && isDateValid && (amount !== null) && isCurrencyJpy && isMatchExact;

  // 実取引内容確認判定 (content_verified): 個別URL形式に加え、明示的な実取引確認フラグがある場合
  // ただし price_type === "unknown" の場合は成約とは見なさないため content_verified にしない
  const isContentVerified = isFormatValid && Boolean(rawEvidence.is_content_verified) && priceType !== "unknown";

  let verificationStatus = "unverified";
  if (isContentVerified) {
    verificationStatus = "content_verified";
  } else if (isFormatValid) {
    verificationStatus = "format_valid";
  }

  return {
    source_url: url,
    price_type: priceType,
    amount: amount,
    currency: currency,
    transaction_date: dateStr,
    item_match_condition: matchCond,
    verification_status: verificationStatus
  };
}

/**
 * サーバー側での成約根拠に基づく価格算出 (LLMの暗算に依存せず、成約証拠を厳格検査)
 * 優先順位: 直近の成約取引 ＞ 同一商品の販売中価格 ＞ 取引種別不明の市場参考価格案 ＞ サイズ未確認なら同一モデルの比較可能価格
 *
 * @param {Object} rawCandidate
 * @param {Object} [targetMeta]
 * @return {{ price: number|null, price_basis: string, price_note: string, price_evidence: Array<Object>, price_evidence_verified: boolean, needs_review_price: boolean }}
 */
function calculateServerGroundedPrice_(rawCandidate, targetMeta) {
  const rawBasis = String(rawCandidate.price_basis || "").trim().toLowerCase();
  const rawEvidence = Array.isArray(rawCandidate.price_evidence) ? rawCandidate.price_evidence : [];
  const unidentifiedApparel = isUnidentifiedApparelEquivalent_(rawCandidate, targetMeta);
  const hasRejectedSearchUrl = rawEvidence.some(item => item && isSearchResultListingUrl_(item.source_url || item.source));

  // 各根拠アイテムをサーバー側で厳格検査
  const checkedItems = [];
  rawEvidence.forEach(item => {
    const checked = verifyPriceEvidenceItem_(item, targetMeta);
    if (!checked || checked.amount === null) return;
    checkedItems.push(checked);
  });

  // 同一URLの重複を排除（別取引を示す個別情報がない場合は1件に集約）
  const deduplicatedItems = deduplicatePriceEvidenceItems_(checkedItems);

  const validList = [];
  const unverifiedList = [];

  deduplicatedItems.forEach(checked => {
    if (checked.verification_status === "content_verified" || checked.verification_status === "format_valid") {
      validList.push(checked);
    } else {
      unverifiedList.push(checked);
    }
  });

  const validExactSold = validList.filter(e => e.price_type === "sold" && e.item_match_condition !== "comparable_model");
  const validExactActive = validList.filter(e => e.price_type === "active" && e.item_match_condition !== "comparable_model");
  const validExactUnknown = validList.filter(e => e.price_type === "unknown" && e.item_match_condition !== "comparable_model");
  // ブランド・商品を特定できないアパレル相当商品では「同一モデル(comparable_model)」自体が成立しないため採用しない
  const validComparable = unidentifiedApparel
    ? []
    : validList.filter(e => e.item_match_condition === "comparable_model");

  let calculatedPrice = null;
  let priceBasis = "no_evidence";
  let priceNote = "価格根拠が確認できないため空欄です。スタッフによる手入力が必要です。";
  let needsReviewPrice = true;
  let priceEvidenceVerified = false;

  const formatSummary = (list) => {
    const urls = list.map(e => e.source_url).filter(Boolean);
    const urlStr = urls.length > 0 ? urls.slice(0, 3).join(", ") : "(URL未取得)";
    const dates = list.map(e => e.transaction_date).filter(Boolean);
    const dateStr = dates.length > 0 ? dates.slice(0, 3).join(", ") : "日付未詳";
    return { urlStr, dateStr };
  };

  // 優先順位 1: 直近の成約取引 (Sold)
  if (validExactSold.length >= 1) {
    const isMedian = validExactSold.length >= 3;
    let priceVal = 0;
    let calcMethod = "";
    if (isMedian) {
      const sortedPrices = validExactSold.map(e => e.amount).sort((a, b) => a - b);
      const mid = Math.floor(sortedPrices.length / 2);
      priceVal = (sortedPrices.length % 2 !== 0)
        ? sortedPrices[mid]
        : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);
      calcMethod = "中央値";
    } else {
      const sum = validExactSold.reduce((acc, e) => acc + e.amount, 0);
      priceVal = Math.round(sum / validExactSold.length);
      calcMethod = validExactSold.length === 1 ? "採用値" : "平均値";
    }
    calculatedPrice = roundPriceByPolicy_(priceVal);

    const hasContentVerified = validExactSold.some(e => e.verification_status === "content_verified");
    const { urlStr, dateStr } = formatSummary(validExactSold);

    if (hasContentVerified) {
      priceBasis = "recent_sold_verified";
      priceEvidenceVerified = true;
      needsReviewPrice = false;
      priceNote = `個別取引および成約内容を確認済みの直近成約事例を含む${validExactSold.length}件の${calcMethod}（${calculatedPrice}円）に基づく成約参考価格です。参照元: ${urlStr}（取引日: ${dateStr}）。`;
    } else {
      priceBasis = "recent_transaction_reference";
      priceEvidenceVerified = false;
      needsReviewPrice = true;
      priceNote = `検索で取得した同一商品候補の個別URL ${validExactSold.length}件（${calcMethod}${calculatedPrice}円）を参照した暫定案です。参照元: ${urlStr}（記載日: ${dateStr}）。リンク先の個別取引内容および実際の成約有無・状態は未確認のため、成約価格とは確定しておらずスタッフによる最終確認が必要です。`;
    }
  } else if (validExactActive.length >= 1) {
    // 優先順位 2: 同一商品の販売中価格 (Active listings) - 参考価格案（成約価格ではない）
    const isMedian = validExactActive.length >= 3;
    let priceVal = 0;
    let calcMethod = "";
    if (isMedian) {
      const sortedPrices = validExactActive.map(e => e.amount).sort((a, b) => a - b);
      const mid = Math.floor(sortedPrices.length / 2);
      priceVal = (sortedPrices.length % 2 !== 0)
        ? sortedPrices[mid]
        : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);
      calcMethod = "中央値";
    } else {
      const sum = validExactActive.reduce((acc, e) => acc + e.amount, 0);
      priceVal = Math.round(sum / validExactActive.length);
      calcMethod = validExactActive.length === 1 ? "採用値" : "平均値";
    }
    calculatedPrice = roundPriceByPolicy_(priceVal);
    priceBasis = "active_listing_reference";
    priceEvidenceVerified = false;
    needsReviewPrice = true;
    const { urlStr, dateStr } = formatSummary(validExactActive);
    priceNote = `検索で取得した個別出品URL ${validExactActive.length}件を参照した販売中出品の参考価格案です（販売中価格であり成約価格ではありません・リンク先の個別内容は未確認のため要スタッフ確認）。参照元: ${urlStr}（記載日: ${dateStr}、${calcMethod}${calculatedPrice}円）。`;
  } else if (validExactUnknown.length >= 1) {
    // 優先順位 3: 取引種別不明（成約か出品中か未確定だが比較可能金額あり） -> 市場参考価格案（成約とは呼ばない）
    const isMedian = validExactUnknown.length >= 3;
    let priceVal = 0;
    let calcMethod = "";
    if (isMedian) {
      const sortedPrices = validExactUnknown.map(e => e.amount).sort((a, b) => a - b);
      const mid = Math.floor(sortedPrices.length / 2);
      priceVal = (sortedPrices.length % 2 !== 0)
        ? sortedPrices[mid]
        : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);
      calcMethod = "中央値";
    } else {
      const sum = validExactUnknown.reduce((acc, e) => acc + e.amount, 0);
      priceVal = Math.round(sum / validExactUnknown.length);
      calcMethod = validExactUnknown.length === 1 ? "採用値" : "平均値";
    }
    calculatedPrice = roundPriceByPolicy_(priceVal);
    priceBasis = "market_reference_proposal";
    priceEvidenceVerified = false;
    needsReviewPrice = true;
    const { urlStr, dateStr } = formatSummary(validExactUnknown);
    priceNote = `取引種別（成約取引か販売中出品か）および実取引内容が未確認のため、検索で取得した個別商品URL（${validExactUnknown.length}件・${calcMethod}${calculatedPrice}円）を参照した市場参考価格案です。参照元: ${urlStr}（記載日: ${dateStr}）。成約価格とは確定しておらず、スタッフによる個別取引内容・取引形態の確認が必要です。`;
  } else if (validComparable.length >= 1) {
    // 優先順位 4: サイズ未確認なら同一モデルの比較可能価格 (Comparable Model)
    const isMedian = validComparable.length >= 3;
    let priceVal = 0;
    let calcMethod = "";
    if (isMedian) {
      const sortedPrices = validComparable.map(e => e.amount).sort((a, b) => a - b);
      const mid = Math.floor(sortedPrices.length / 2);
      priceVal = (sortedPrices.length % 2 !== 0)
        ? sortedPrices[mid]
        : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);
      calcMethod = "中央値";
    } else {
      const sum = validComparable.reduce((acc, e) => acc + e.amount, 0);
      priceVal = Math.round(sum / validComparable.length);
      calcMethod = validComparable.length === 1 ? "採用値" : "平均値";
    }
    calculatedPrice = roundPriceByPolicy_(priceVal);
    priceBasis = "comparable_model_reference";
    priceEvidenceVerified = false;
    needsReviewPrice = true;
    const { urlStr, dateStr } = formatSummary(validComparable);
    const allContentVerifiedSold = validComparable.every(e => e.price_type === "sold" && e.verification_status === "content_verified");
    const allActive = validComparable.every(e => e.price_type === "active");
    if (allContentVerifiedSold) {
      priceNote = `サイズ未確認のため、個別取引・成約内容を確認済みの同一モデル別サイズ成約事例（${validComparable.length}件・${calcMethod}${calculatedPrice}円）を参照した参考価格案です。参照元: ${urlStr}（取引日: ${dateStr}）。スタッフによるサイズ確認と最終決定が必要です。`;
    } else {
      const typeCaveat = allActive ? "販売中出品価格であり成約価格ではありません" : "成約価格とは確定していません";
      priceNote = `サイズ未確認かつリンク先の個別取引内容が未確認（${typeCaveat}）のため、検索で取得した同一モデル候補の個別商品URL（${validComparable.length}件・${calcMethod}${calculatedPrice}円）を参照した参考価格案です。参照元: ${urlStr}（記載日: ${dateStr}）。スタッフによるサイズ・個別取引内容の確認と最終決定が必要です。`;
    }
  } else if (unverifiedList.length > 0) {
    // 根拠アイテムはあるが形式検証で未完全な項目がある場合:
    // - サイト内検索結果一覧URLは除外する
    // - ブランド・商品を特定できないアパレル相当商品では未検証URLからの相場算出を行わない
    const withValidUrlAndAmount = unidentifiedApparel
      ? []
      : unverifiedList.filter(
        e => e.amount !== null && e.amount > 0 && e.source_url && /^https?:\/\/[^\s$.?#].[^\s]*$/i.test(e.source_url) && !isSearchResultListingUrl_(e.source_url)
      );
    if (withValidUrlAndAmount.length > 0) {
      const isMedian = withValidUrlAndAmount.length >= 3;
      let priceVal = 0;
      let calcMethod = "";
      if (isMedian) {
        const sortedPrices = withValidUrlAndAmount.map(e => e.amount).sort((a, b) => a - b);
        const mid = Math.floor(sortedPrices.length / 2);
        priceVal = (sortedPrices.length % 2 !== 0)
          ? sortedPrices[mid]
          : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);
        calcMethod = "中央値";
      } else {
        const sum = withValidUrlAndAmount.reduce((acc, e) => acc + e.amount, 0);
        priceVal = Math.round(sum / withValidUrlAndAmount.length);
        calcMethod = withValidUrlAndAmount.length === 1 ? "採用値" : "平均値";
      }
      calculatedPrice = roundPriceByPolicy_(priceVal);
      priceBasis = "market_reference_proposal";
      priceEvidenceVerified = false;
      needsReviewPrice = true;
      const { urlStr } = formatSummary(withValidUrlAndAmount);
      priceNote = `取引種別・一致条件・個別取引内容が未確認ですが、検索で取得した個別URL（${withValidUrlAndAmount.length}件・${calcMethod}${calculatedPrice}円）を参照した市場参考価格案です（成約価格とは確定していません・要スタッフ確認）。参照元: ${urlStr}。`;
    } else if (unidentifiedApparel || hasRejectedSearchUrl) {
      // 検索結果一覧URLのみが渡された場合、またはブランド・商品未特定のアパレル相当で有効な個別根拠がない場合は、
      // 無関係な商品の平均価格や根拠のないAI概算を「Web相場」や提案価格として採用しない
      calculatedPrice = null;
      priceBasis = "no_evidence";
      if (unidentifiedApparel && hasRejectedSearchUrl) {
        priceNote = "Web検索を実行しましたが、参照先がサイト内検索結果一覧ページのみで個別商品の取引および成約価格は未確認（ブランド・商品も未特定）のため、Web相場は未設定です。スタッフによる確認が必要です。";
      } else if (hasRejectedSearchUrl) {
        priceNote = "Web検索の参照先がサイト内検索結果一覧ページのみで個別商品の取引および成約価格は未確認のため、Web相場は未設定です。スタッフによる確認が必要です。";
      } else {
        priceNote = "ブランド・商品を特定できず、個別商品の有効な価格根拠も未確認のため、Web相場は未設定です。スタッフによる確認が必要です。";
      }
      needsReviewPrice = true;
      priceEvidenceVerified = false;
    } else {
      // 参照URL欠落や非URLスニペット等の場合でも、rawCandidate.price に数値が存在する場合はAI概算価格として救済
      const rawPrice = rawCandidate.price;
      let parsedPrice = null;
      if (typeof rawPrice === "number" && Number.isFinite(rawPrice)) {
        const rounded = Math.round(rawPrice);
        if (rounded > 0 && Number.isSafeInteger(rounded)) {
          parsedPrice = rounded;
        }
      } else if (typeof rawPrice === "string" && rawPrice.trim()) {
        const cleaned = rawPrice.replace(/[,円\s]/g, "");
        const parsedNum = Number(cleaned);
        if (Number.isFinite(parsedNum) && parsedNum > 0) {
          parsedPrice = Math.round(parsedNum);
        }
      }

      if (parsedPrice !== null) {
        calculatedPrice = parsedPrice;
        priceBasis = "unverified_estimate";
        priceNote = "AIによる概算価格です（個別取引・成約根拠は未確認のためスタッフ確認必須）";
        needsReviewPrice = true;
        priceEvidenceVerified = false;
      } else {
        calculatedPrice = null;
        priceBasis = "unverified_evidence";
        priceNote = "参照先URLや取引日・一致条件が確認できない未検証根拠のため価格は未設定です（スタッフ入力必須）";
        needsReviewPrice = true;
        priceEvidenceVerified = false;
      }
    }
  } else if (unidentifiedApparel) {
    // ブランド・商品を特定できず有効な個別価格根拠も0件のアパレル相当商品では、根拠のないAI概算も採用しない
    calculatedPrice = null;
    priceBasis = "no_evidence";
    priceNote = "ブランド・商品を特定できず、根拠となる取引事例が確認できないためWeb相場は未設定です（スタッフ判断が必要）。";
    needsReviewPrice = true;
    priceEvidenceVerified = false;
  } else {
    // 根拠なし / 旧形式フォールバック
    const rawPrice = rawCandidate.price;
    let parsedPrice = null;
    if (typeof rawPrice === "number" && Number.isFinite(rawPrice)) {
      const rounded = Math.round(rawPrice);
      if (rounded > 0 && Number.isSafeInteger(rounded)) {
        parsedPrice = rounded;
      }
    } else if (typeof rawPrice === "string" && rawPrice.trim()) {
      const cleaned = rawPrice.replace(/[,円\s]/g, "");
      const parsedNum = Number(cleaned);
      if (Number.isFinite(parsedNum) && parsedNum > 0) {
        parsedPrice = Math.round(parsedNum);
      }
    }

    if (parsedPrice !== null) {
      // 根拠なし推測価格: 成約価格と表現せず概算価格と明記、自動反映を完全遮断
      calculatedPrice = parsedPrice;
      priceBasis = "unverified_estimate";
      priceNote = "AIによる概算価格です";
      needsReviewPrice = true;
      priceEvidenceVerified = false;
    } else {
      calculatedPrice = null;
      priceBasis = "no_evidence";
      priceNote = (rawBasis === "no_evidence")
        ? "根拠となる取引事例が確認できないため価格は未設定です（スタッフ入力必須）"
        : "AIによる概算価格です";
      needsReviewPrice = true;
      priceEvidenceVerified = false;
    }
  }

  // 全アイテム（valid + unverified）を返却
  const allProcessedEvidence = validList.concat(unverifiedList);

  return {
    price: calculatedPrice,
    price_basis: priceBasis,
    price_note: priceNote,
    price_evidence: allProcessedEvidence,
    price_evidence_verified: priceEvidenceVerified,
    needs_review_price: needsReviewPrice
  };
}

/**
 * 販売価格に対する最低粗利率 (min_cost_markup_rate / min_gross_margin_rate) を検証・正規化する (既定: 0.30 = 最低粗利率30%, 原価 ÷ (1 − 0.30))
 * - 0.30 (小数指定: 0 < rate < 1.0) または 30 (百分率指定: 1 <= pct < 100) の両方を受け付ける
 * - strictMode === true の場合、不正値 (0以下、100%以上、非数値) は INVALID_MIN_COST_MARKUP_RATE 例外を送出する
 * @param {*} rawRate
 * @param {boolean} [strictMode]
 * @return {number} 0より大きく1.0未満の小数 (例: 0.30)
 */
function validateMinCostMarkupRateInput_(rawRate, strictMode) {
  const defaultRate = AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE || 0.30;
  if (rawRate === undefined || rawRate === null || rawRate === "") {
    return defaultRate;
  }
  if (typeof rawRate === "boolean") {
    if (strictMode) {
      const err = new Error("min_cost_markup_rate must be a positive number (e.g. 0.30 for 30% minimum gross margin rate)");
      err.error_code = "INVALID_MIN_COST_MARKUP_RATE";
      err.preserve_message = true;
      throw err;
    }
    return defaultRate;
  }
  const num = Number(rawRate);
  if (!Number.isFinite(num) || num <= 0) {
    if (strictMode) {
      const err = new Error("min_cost_markup_rate must be a positive number greater than 0 (e.g. 0.30 for 30% minimum gross margin rate)");
      err.error_code = "INVALID_MIN_COST_MARKUP_RATE";
      err.preserve_message = true;
      throw err;
    }
    return defaultRate;
  }
  const rate = num >= 1 && num < 100 ? num / 100 : num;
  if (rate <= 0 || rate >= 1) {
    if (strictMode) {
      const err = new Error("min_cost_markup_rate is out of range (allowed: 0 < rate < 1.0 or 1 <= percentage < 100)");
      err.error_code = "INVALID_MIN_COST_MARKUP_RATE";
      err.preserve_message = true;
      throw err;
    }
    return defaultRate;
  }
  return Math.round(rate * 10000) / 10000;
}

function normalizeMinCostMarkupRate_(rawRate) {
  return validateMinCostMarkupRateInput_(rawRate, false);
}

/**
 * min_gross_margin_rate が明示指定された場合の境界検証 (0 < rate < 1 以外はエラー送出)
 * @param {*} rawGrossMarginRate
 */
function validateLegacyGrossMarginRateIfPresent_(rawGrossMarginRate) {
  if (rawGrossMarginRate === undefined || rawGrossMarginRate === null || rawGrossMarginRate === "") {
    return;
  }
  const num = Number(rawGrossMarginRate);
  if (typeof rawGrossMarginRate === "boolean" || !Number.isFinite(num) || num <= 0 || num >= 1) {
    const err = new Error("min_gross_margin_rate is invalid (must be 0 < rate < 1, default 0.30 = 30% minimum gross margin rate).");
    err.error_code = "INVALID_MIN_GROSS_MARGIN_RATE";
    err.preserve_message = true;
    throw err;
  }
}

/**
 * 下限価格の切り上げ丸め (原価 ÷ (1 − 最低粗利率) を下回らないよう常に切り上げ)
 * - 10,000円以上: 100円単位切り上げ
 * - 1,000円以上10,000円未満: 50円単位切り上げ
 * - 1,000円未満: 10円単位切り上げ
 * @param {number} rawPrice
 * @return {number|null}
 */
function ceilPriceByPolicy_(rawPrice) {
  const num = Number(rawPrice);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num >= 10000) {
    return Math.ceil(num / 100) * 100;
  } else if (num >= 1000) {
    return Math.ceil(num / 50) * 50;
  } else {
    return Math.ceil(num / 10) * 10;
  }
}

function toFiniteCostNumberOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractNormalizedPurchaseLineAmounts_(line) {
  if (!line || typeof line !== "object") {
    return {
      itemAmount: null,
      feeAmount: null,
      taxAmount: null,
      feeTaxAmount: null,
      totalLineAmount: null,
      isCombinedLegacyTax: false
    };
  }
  const itemAmount = toFiniteCostNumberOrNull_(
    line.item_amount !== undefined ? line.item_amount : (line.itemAmount !== undefined ? line.itemAmount : line.amount)
  );
  const feeAmount = toFiniteCostNumberOrNull_(
    line.fee_amount !== undefined ? line.fee_amount : (line.feeAmount !== undefined ? line.feeAmount : line.buyer_fee_amount)
  );
  const taxAmount = toFiniteCostNumberOrNull_(
    line.tax_amount !== undefined ? line.tax_amount : (line.taxAmount !== undefined ? line.taxAmount : line.line_tax_amount)
  );
  const feeTaxAmount = toFiniteCostNumberOrNull_(
    line.fee_tax_amount !== undefined ? line.fee_tax_amount : line.feeTaxAmount
  );
  const totalLineAmount = toFiniteCostNumberOrNull_(
    line.total_line_amount !== undefined ? line.total_line_amount : line.totalLineAmount
  );
  const isCombinedLegacyTax =
    line.fee_tax_amount === undefined &&
    line.feeTaxAmount === undefined &&
    line.line_tax_amount !== undefined &&
    line.line_tax_amount !== null;

  return {
    itemAmount: itemAmount,
    feeAmount: feeAmount,
    taxAmount: taxAmount,
    feeTaxAmount: feeTaxAmount,
    totalLineAmount: totalLineAmount,
    isCombinedLegacyTax: isCombinedLegacyTax
  };
}

/**
 * 仕入明細行の税額が過不足なく確認済みか判定 (ProductCostSection.tsx の isPurchaseLineTaxComplete と同一基準)
 * - total_line_amount (totalLineAmount) が非 null であること
 * - 商品代金 (item_amount > 0) がある場合は商品税 (tax_amount) が非 null であること
 * - 落札手数料 (fee_amount > 0) がある場合は手数料税 (fee_tax_amount) が非 null であること
 * - 4項目 (item_amount + fee_amount + tax_amount + fee_tax_amount) の合計が total_line_amount と一致すること
 * @param {Object} line
 * @return {boolean}
 */
function isPurchaseLineTaxComplete_(line) {
  if (!line || typeof line !== "object") return false;
  const norm = extractNormalizedPurchaseLineAmounts_(line);
  if (norm.totalLineAmount === null) {
    return false;
  }

  const hasItem = norm.itemAmount !== null && norm.itemAmount > 0;
  const hasFee = norm.feeAmount !== null && norm.feeAmount > 0;

  if (hasItem && norm.taxAmount === null) {
    return false;
  }
  if (hasFee && norm.feeTaxAmount === null && !norm.isCombinedLegacyTax) {
    return false;
  }
  if (!hasItem && !hasFee && norm.taxAmount === null && norm.feeTaxAmount === null) {
    if (line.tax_included_flag === true || line.tax_Included_flag === true) {
      return norm.totalLineAmount > 0;
    }
    return false;
  }

  const sum4 =
    (norm.itemAmount !== null ? norm.itemAmount : 0) +
    (norm.feeAmount !== null ? norm.feeAmount : 0) +
    (norm.taxAmount !== null ? norm.taxAmount : 0) +
    (norm.feeTaxAmount !== null ? norm.feeTaxAmount : 0);
  return sum4 === norm.totalLineAmount;
}

/**
 * 明細全体の基準金額 (ProductCostSection.tsx の getLineFullBaseAmount と同一基準)
 * - 税額確認済なら税込行合計 total_line_amount
 * - 税額未確認なら商品代金 (item_amount) + 落札手数料 (fee_amount) の税抜合計
 * @param {Object} line
 * @return {number}
 */
function getPurchaseLineFullBaseAmount_(line) {
  const norm = extractNormalizedPurchaseLineAmounts_(line);
  if (isPurchaseLineTaxComplete_(line) && norm.totalLineAmount !== null) {
    return norm.totalLineAmount;
  }
  const exTaxSum =
    (norm.itemAmount !== null ? norm.itemAmount : 0) +
    (norm.feeAmount !== null ? norm.feeAmount : 0);
  if (exTaxSum > 0) return exTaxSum;
  return norm.totalLineAmount !== null ? norm.totalLineAmount : 0;
}

/**
 * 商品別原価入力 (documents-relay get_product_cost の { cost_breakdown, links }、または ProductCostSection サマリ/数値) から
 * 商品詳細画面 (ProductCostSection.tsx) と同一基準の概算原価サマリを算出する
 * - 二重加算防止: total_line_amount には既に item_amount + fee_amount + tax_amount + fee_tax_amount が含まれているため、
 *   手数料や税額を再加算しない
 *
 * @param {*} rawCostInput
 * @return {{
 *   has_confirmed_links: boolean,
 *   confirmed_link_count: number,
 *   confirmed_tax_included_cost: number|null,
 *   reference_allocated_total: number,
 *   effective_cost_amount: number|null,
 *   all_tax_confirmed: boolean,
 *   cost_source: string
 * }}
 */
function computeProductCostSummaryFromInput_(rawCostInput) {
  const emptySummary = {
    has_confirmed_links: false,
    confirmed_link_count: 0,
    confirmed_tax_included_cost: null,
    reference_allocated_total: null,
    effective_cost_amount: null,
    all_tax_confirmed: false,
    cost_source: "unmatched",
    cost_status: "no_cost",
    cost_lookup_error: null
  };

  if (rawCostInput === null || rawCostInput === undefined || rawCostInput === "") {
    return emptySummary;
  }

  // 数値が直接渡された場合 (確定税込原価として扱う)
  if (typeof rawCostInput === "number" && Number.isFinite(rawCostInput)) {
    if (rawCostInput <= 0) return emptySummary;
    const rounded = Math.round(rawCostInput);
    return {
      has_confirmed_links: true,
      confirmed_link_count: 1,
      confirmed_tax_included_cost: rounded,
      reference_allocated_total: rounded,
      effective_cost_amount: rounded,
      all_tax_confirmed: true,
      cost_source: "confirmed_tax_included",
      cost_status: "confirmed",
      cost_lookup_error: null
    };
  }

  if (typeof rawCostInput !== "object") {
    return emptySummary;
  }

  if (!Array.isArray(rawCostInput) && String(rawCostInput.cost_status || "").trim() === "lookup_failed") {
    return {
      ...emptySummary,
      cost_source: "lookup_failed",
      cost_status: "lookup_failed",
      cost_lookup_error: String(rawCostInput.cost_lookup_error || "Cost lookup failed").trim() || "Cost lookup failed"
    };
  }

  // links 配列 (documents-relay get_product_cost の返却形式 { cost_breakdown, links: [{ allocated_amount, status, line: {...} }] }、配列直接指定、または単一リンク/明細行オブジェクト)
  const hasDirectLineFields = !Array.isArray(rawCostInput) && (
    (rawCostInput.line && typeof rawCostInput.line === "object") ||
    (rawCostInput.document_lines && typeof rawCostInput.document_lines === "object") ||
    rawCostInput.total_line_amount !== undefined ||
    rawCostInput.totalLineAmount !== undefined ||
    rawCostInput.item_amount !== undefined ||
    rawCostInput.itemAmount !== undefined
  );
  const rawLinks = Array.isArray(rawCostInput)
    ? rawCostInput
    : (Array.isArray(rawCostInput.links)
        ? rawCostInput.links
        : (hasDirectLineFields ? [rawCostInput] : null));

  if (rawLinks !== null) {
    const validLinks = [];
    for (let i = 0; i < rawLinks.length; i++) {
      const link = rawLinks[i];
      if (!link || typeof link !== "object") continue;
      if (link.is_deleted === true) continue;
      const st = String(link.status || "confirmed").trim().toLowerCase();
      if (st !== "confirmed") continue;

      const line = (link.line && typeof link.line === "object")
        ? link.line
        : ((link.document_lines && typeof link.document_lines === "object") ? link.document_lines : link);
      if (line.is_deleted === true || line.is_active === false) continue;
      if (line.document && typeof line.document === "object" && line.document.is_deleted === true) continue;

      validLinks.push({ link: link, line: line });
    }

    if (validLinks.length === 0) {
      return emptySummary;
    }

    let allTaxComplete = true;
    let totalAllocated = 0;

    for (let i = 0; i < validLinks.length; i++) {
      const link = validLinks[i].link;
      const line = validLinks[i].line;

      const norm = extractNormalizedPurchaseLineAmounts_(line);
      const taxComplete = isPurchaseLineTaxComplete_(line);
      const fullBase = getPurchaseLineFullBaseAmount_(line);
      const exTaxSum =
        (norm.itemAmount !== null ? norm.itemAmount : 0) +
        (norm.feeAmount !== null ? norm.feeAmount : 0);
      const rawAlloc = toFiniteCostNumberOrNull_(
        link.allocated_amount !== undefined ? link.allocated_amount : link.allocatedAmount
      );
      const allocMethod = String(link.allocation_method || link.allocationMethod || "direct").trim().toLowerCase();

      // 税額確認済みの明細 (fullBase = 商品代金 + 落札手数料 + 確認済み税額 = total_line_amount) において、
      // link.allocated_amount に税抜合計 (item_amount + fee_amount) または商品代金のみ (direct割当) が
      // 保存されている場合は、確認済み税額を除外せず税込総額 (fullBase) を有効原価として採用する。
      // ※同一明細を複数商品へ分割した部分割当 (rawAlloc < fullBase かつ税抜全額一致ではない) は rawAlloc を維持し、
      //   税額未確認の明細に対してGAS側で税額を推測補完することも行わない。
      let effectiveAllocated;
      if (rawAlloc === null) {
        effectiveAllocated = fullBase;
      } else if (
        taxComplete &&
        fullBase > 0 &&
        ((exTaxSum > 0 && Math.round(rawAlloc) === Math.round(exTaxSum)) ||
          (allocMethod !== "split" && norm.itemAmount !== null && norm.itemAmount > 0 && Math.round(rawAlloc) === Math.round(norm.itemAmount)))
      ) {
        effectiveAllocated = fullBase;
      } else {
        effectiveAllocated = fullBase > 0
          ? Math.min(Math.max(0, rawAlloc), fullBase)
          : Math.max(0, rawAlloc);
      }

      if (!taxComplete) {
        allTaxComplete = false;
      }

      if (Number.isFinite(effectiveAllocated) && effectiveAllocated > 0) {
        totalAllocated += effectiveAllocated;
      }
    }

    const roundedTotal = Math.round(totalAllocated);
    if (roundedTotal <= 0) {
      return emptySummary;
    }

    return {
      has_confirmed_links: true,
      confirmed_link_count: validLinks.length,
      confirmed_tax_included_cost: allTaxComplete ? roundedTotal : null,
      reference_allocated_total: roundedTotal,
      effective_cost_amount: roundedTotal,
      all_tax_confirmed: allTaxComplete,
      cost_source: allTaxComplete ? "confirmed_tax_included" : "reference_allocated_unconfirmed_tax",
      cost_status: "confirmed",
      cost_lookup_error: null
    };
  }

  // 集計済みオブジェクト形式 (ProductCostSection.tsx の camelCase / snake_case / cost_breakdown 対応)
  const breakdownObj = (rawCostInput.cost_breakdown && typeof rawCostInput.cost_breakdown === "object")
    ? rawCostInput.cost_breakdown
    : null;
  const rawConfirmedCost = toFiniteCostNumberOrNull_(
    rawCostInput.confirmed_tax_included_cost !== undefined
      ? rawCostInput.confirmed_tax_included_cost
      : rawCostInput.confirmedTaxIncludedCost
  );
  const rawRefTotal = toFiniteCostNumberOrNull_(
    rawCostInput.reference_allocated_total !== undefined
      ? rawCostInput.reference_allocated_total
      : (rawCostInput.referenceAllocatedTotal !== undefined
          ? rawCostInput.referenceAllocatedTotal
          : (breakdownObj ? breakdownObj.total_allocated_cost : rawCostInput.total_allocated_cost))
  );
  const rawEffective = toFiniteCostNumberOrNull_(
    rawCostInput.effective_cost_amount !== undefined
      ? rawCostInput.effective_cost_amount
      : rawCostInput.cost_amount
  );
  const rawAllTaxConfirmed = rawCostInput.all_tax_confirmed !== undefined
    ? Boolean(rawCostInput.all_tax_confirmed)
    : (rawCostInput.allTaxConfirmed !== undefined ? Boolean(rawCostInput.allTaxConfirmed) : null);

  if (rawConfirmedCost !== null && rawConfirmedCost > 0) {
    const rounded = Math.round(rawConfirmedCost);
    return {
      has_confirmed_links: true,
      confirmed_link_count: Number(rawCostInput.confirmed_link_count || (breakdownObj && breakdownObj.matched_lines_count) || 1),
      confirmed_tax_included_cost: rounded,
      reference_allocated_total: (rawRefTotal !== null && rawRefTotal > 0) ? Math.round(rawRefTotal) : rounded,
      effective_cost_amount: rounded,
      all_tax_confirmed: rawAllTaxConfirmed !== null ? rawAllTaxConfirmed : true,
      cost_source: "confirmed_tax_included",
      cost_status: "confirmed",
      cost_lookup_error: null
    };
  }

  const fallbackCost = (rawEffective !== null && rawEffective > 0)
    ? Math.round(rawEffective)
    : ((rawRefTotal !== null && rawRefTotal > 0) ? Math.round(rawRefTotal) : null);

  if (fallbackCost !== null && fallbackCost > 0) {
    const taxConfirmed = rawAllTaxConfirmed !== null ? rawAllTaxConfirmed : false;
    return {
      has_confirmed_links: true,
      confirmed_link_count: Number(rawCostInput.confirmed_link_count || (breakdownObj && breakdownObj.matched_lines_count) || 1),
      confirmed_tax_included_cost: taxConfirmed ? fallbackCost : null,
      reference_allocated_total: fallbackCost,
      effective_cost_amount: fallbackCost,
      all_tax_confirmed: taxConfirmed,
      cost_source: taxConfirmed ? "confirmed_tax_included" : "reference_allocated_unconfirmed_tax",
      cost_status: "confirmed",
      cost_lookup_error: null
    };
  }

  return emptySummary;
}

/**
 * 候補オブジェクトに販売価格に対する最低粗利率（既定30%・下限 = 原価 ÷ (1 − 0.30) を価格単位で切り上げ）を反映し、
 * Web相場と比較して価格提案を決定する
 * - 最低粗利率下限価格 P_floor = ceilPriceByPolicy_(原価 ÷ (1 − minGrossMarginRate))
 * - 相場価格 P_market >= P_floor なら P_market を採用、そうでなければ P_floor を採用
 * - 原価未照合・未取得または税額未確定の場合は概算であることとスタッフ最終判断である旨を price_note に明記
 *
 * @param {Object} candidate
 * @param {*} rawCostInput
 * @param {*} [rawMinCostMarkupRate]
 * @return {Object} candidate (破壊的更新＋返却)
 */
function applyCostFloorToCandidate_(candidate, rawCostInput, rawMinCostMarkupRate) {
  if (!candidate || typeof candidate !== "object") return candidate;

  const minGrossMarginRate = normalizeMinCostMarkupRate_(rawMinCostMarkupRate);
  const marginPct = Math.round(minGrossMarginRate * 1000) / 10;
  const marginDivisor = Math.round((1 - minGrossMarginRate) * 1000000) / 1000000;
  const divisorLabel = Number.isInteger(marginDivisor * 10)
    ? marginDivisor.toFixed(2)
    : String(marginDivisor);
  const costSummary = computeProductCostSummaryFromInput_(rawCostInput);
  const rawMarketPrice = candidate.price;
  const marketPrice = (rawMarketPrice !== null && rawMarketPrice !== undefined && rawMarketPrice !== "" && Number.isFinite(Number(rawMarketPrice)) && Number(rawMarketPrice) > 0)
    ? Math.round(Number(rawMarketPrice))
    : null;
  const isUngroundedAiEstimate = String(candidate.price_basis || "").trim().toLowerCase() === "unverified_estimate";
  const marketPriceDesc = marketPrice !== null
    ? (isUngroundedAiEstimate ? `AI概算参考値（${marketPrice}円・Web相場未確認）` : `Web相場価格（${marketPrice}円）`)
    : "";
  const adoptedMarketDesc = isUngroundedAiEstimate ? "AI概算参考値" : "相場価格";
  const existingNote = String(candidate.price_note || "").trim();

  if (!Array.isArray(candidate.needs_review)) {
    candidate.needs_review = [];
  }

  let floorPrice = null;
  let adoptedPrice = marketPrice;
  let decisionSource = "market_unmatched";

  if (costSummary.has_confirmed_links && costSummary.effective_cost_amount !== null && costSummary.effective_cost_amount > 0) {
    const costAmount = costSummary.effective_cost_amount;
    const rawMarginFloor = marginDivisor > 0
      ? Math.round((costAmount / marginDivisor) * 1e6) / 1e6
      : costAmount;
    floorPrice = ceilPriceByPolicy_(rawMarginFloor);
    const costLabel = costSummary.all_tax_confirmed
      ? `確定税込原価（${costAmount}円）`
      : `参考配賦原価（${costAmount}円・税額未確定のため概算）`;

    if (marketPrice !== null && floorPrice !== null && marketPrice >= floorPrice) {
      // 相場価格が最低粗利率下限価格以上のため相場価格を採用
      adoptedPrice = marketPrice;
      decisionSource = "market_above_gross_margin_floor";
      const actualGrossMarginPct = Math.round(((marketPrice - costAmount) / marketPrice) * 1000) / 10;
      const costComparisonNote = costSummary.all_tax_confirmed
        ? `【最低粗利率照合】販売価格に対する最低粗利率${marginPct}%（${costLabel}÷${divisorLabel}）による下限価格（${floorPrice}円）を${marketPriceDesc}が上回るため、${adoptedMarketDesc}（${marketPrice}円・粗利率${actualGrossMarginPct}%）を採用しました（原価に基づく提案・最終判断はスタッフが行います）。`
        : `【最低粗利率照合（概算）】販売価格に対する最低粗利率${marginPct}%（${costLabel}÷${divisorLabel}）による下限価格（${floorPrice}円・概算）を${marketPriceDesc}が上回るため、${adoptedMarketDesc}（${marketPrice}円・粗利率${actualGrossMarginPct}%）を採用しました（原価・税額未確定のため概算・最終判断はスタッフが行います）。`;

      candidate.price_note = existingNote ? `${existingNote} ${costComparisonNote}` : costComparisonNote;
      if (!costSummary.all_tax_confirmed && candidate.needs_review.indexOf("price") === -1) {
        candidate.needs_review.push("price");
      }
    } else if (floorPrice !== null) {
      // 相場価格が最低粗利率下限価格未満、または有効なWeb相場が未確認のため最低粗利率下限価格を採用
      adoptedPrice = floorPrice;
      decisionSource = "gross_margin_floor";
      candidate.price = floorPrice;
      candidate.price_basis = "gross_margin_floor";
      candidate.price_evidence_verified = false;
      if (candidate.needs_review.indexOf("price") === -1) {
        candidate.needs_review.push("price");
      }

      const actualGrossMarginPct = Math.round(((floorPrice - costAmount) / floorPrice) * 1000) / 10;
      const unconfirmedCaveat = costSummary.all_tax_confirmed
        ? "原価に基づく提案であり、最終判断はスタッフが行います。"
        : "原価・税額が未確定のため概算での提案であり、最終判断はスタッフが行います。";

      const floorNote = (marketPrice !== null)
        ? `【最低粗利率下限価格採用${costSummary.all_tax_confirmed ? "" : "（概算）"}】${marketPriceDesc}が販売価格に対する最低粗利率${marginPct}%（${costLabel}÷${divisorLabel}）による下限価格（${floorPrice}円）を下回るため、下限価格（${floorPrice}円・粗利率${actualGrossMarginPct}%）を提案します。${unconfirmedCaveat}`
        : `【最低粗利率下限価格採用（相場未確認${costSummary.all_tax_confirmed ? "" : "・概算"}）】有効な個別商品のWeb相場が未確認のため、販売価格に対する最低粗利率${marginPct}%（${costLabel}÷${divisorLabel}）による下限価格（${floorPrice}円・粗利率${actualGrossMarginPct}%）を相場未確認の価格案として提案します。${unconfirmedCaveat}`;

      candidate.price_note = existingNote ? `${floorNote} [価格根拠確認メモ: ${existingNote}]` : floorNote;
    }
  } else if (costSummary.cost_status === "lookup_failed") {
    decisionSource = marketPrice !== null ? "market_without_cost_lookup_failed" : "no_price_cost_lookup_failed";
    if (candidate.needs_review.indexOf("price") === -1) {
      candidate.needs_review.push("price");
    }
    if (marketPrice === null) {
      const lookupFailedNoPriceNote = "【価格未設定（相場未確認・原価未取得）】有効な個別商品のWeb相場が未確認であり、仕入原価も未取得（原価未照合）のため価格は未設定です。スタッフの判断で価格を設定してください。";
      if (existingNote.indexOf("原価未取得") === -1 && existingNote.indexOf("原価未照合") === -1) {
        candidate.price_note = existingNote ? `${existingNote} ${lookupFailedNoPriceNote}` : lookupFailedNoPriceNote;
      }
    } else {
      const lookupFailedNote = isUngroundedAiEstimate
        ? "【原価未取得（概算）】仕入原価が未取得（原価未照合・価格下限未適用）かつWeb相場も未確認のためAI概算による参考価格提案です。最終判断はスタッフが行います。"
        : "【原価未取得（概算）】仕入原価が未取得（原価未照合・価格下限未適用）のためWeb相場参照値に基づく概算価格提案です。最終判断はスタッフが行います。";
      if (existingNote.indexOf("原価未取得") === -1 && existingNote.indexOf("原価未照合") === -1) {
        candidate.price_note = existingNote ? `${existingNote} ${lookupFailedNote}` : lookupFailedNote;
      }
    }
  } else {
    // 仕入原価未照合（未確定 / 原価なし）商品:
    // - 有効な相場参照値がある場合は相場参照の概算価格案とする
    // - 有効な相場がなく価格未設定(null)の場合は「Web相場に基づく概算価格提案」とは表示せず、未設定のままスタッフ判断に委ねる
    decisionSource = "market_unmatched";
    if (candidate.needs_review.indexOf("price") === -1) {
      candidate.needs_review.push("price");
    }
    if (marketPrice === null) {
      const unmatchedNoPriceNote = "【価格未設定（相場未確認・原価未照合）】有効な個別商品のWeb相場が未確認であり、仕入原価も未照合のため価格は未設定です。スタッフの判断で価格を設定してください。";
      if (existingNote.indexOf("原価未照合") === -1 && existingNote.indexOf("仕入原価が未確定") === -1) {
        candidate.price_note = existingNote ? `${existingNote} ${unmatchedNoPriceNote}` : unmatchedNoPriceNote;
      }
    } else {
      const unmatchedNote = isUngroundedAiEstimate
        ? "【原価未照合（概算）】仕入原価が未確定（未照合）かつWeb相場も未確認のためAI概算による参考価格提案です。最終判断はスタッフが行います。"
        : "【原価未照合（概算）】仕入原価が未確定（未照合）のためWeb相場参照値に基づく概算価格提案です。最終判断はスタッフが行います。";
      if (existingNote.indexOf("原価未照合") === -1 && existingNote.indexOf("仕入原価が未確定") === -1) {
        candidate.price_note = existingNote ? `${existingNote} ${unmatchedNote}` : unmatchedNote;
      }
    }
  }

  const actualGrossMarginRate = (
    adoptedPrice !== null &&
    adoptedPrice > 0 &&
    costSummary.has_confirmed_links &&
    costSummary.effective_cost_amount !== null &&
    costSummary.effective_cost_amount > 0
  )
    ? Math.round(((adoptedPrice - costSummary.effective_cost_amount) / adoptedPrice) * 10000) / 10000
    : null;

  candidate.cost_calculation = {
    pricing_rule: "gross_margin_floor",
    has_confirmed_links: costSummary.has_confirmed_links,
    confirmed_link_count: costSummary.confirmed_link_count,
    confirmed_tax_included_cost: costSummary.confirmed_tax_included_cost,
    reference_allocated_total: costSummary.reference_allocated_total,
    effective_cost_amount: costSummary.effective_cost_amount,
    all_tax_confirmed: costSummary.all_tax_confirmed,
    cost_source: costSummary.cost_source,
    cost_status: costSummary.cost_status || (costSummary.has_confirmed_links ? "confirmed" : "no_cost"),
    cost_lookup_error: costSummary.cost_lookup_error || null,
    min_gross_margin_rate: minGrossMarginRate,
    min_cost_markup_rate: minGrossMarginRate,
    gross_margin_divisor: marginDivisor,
    floor_price: floorPrice,
    market_price: marketPrice,
    adopted_price: adoptedPrice,
    actual_gross_margin_rate: actualGrossMarginRate,
    price_decision_source: decisionSource
  };

  return candidate;
}

/**
 * AI出品ドラフト構造化出力スキーマ (responseSchema) の定義
 * ポケカ属性・スニーカーSKU・価格根拠・要確認リストを包含
 * @return {Object}
 */
function buildAiDraftResponseSchema_() {
  return {
    type: "OBJECT",
    properties: {
      title_ja: { type: "STRING" },
      hashtags_ja: { type: "STRING" },
      description_ja: { type: "STRING" },
      title_en: { type: "STRING" },
      description_en: { type: "STRING" },
      condition: { type: "STRING" },
      price: { type: "INTEGER" },
      category: { type: "STRING" },
      brand: { type: "STRING" },
      sku: { type: "STRING" },
      size: { type: "STRING" },
      identity_status: { type: "STRING" },
      price_basis: { type: "STRING" },
      price_evidence: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            source_url: { type: "STRING" },
            price_type: { type: "STRING" },
            amount: { type: "INTEGER" },
            currency: { type: "STRING" },
            transaction_date: { type: "STRING" },
            item_match_condition: { type: "STRING" },
            verification_status: { type: "STRING" }
          }
        }
      },
      needs_review: {
        type: "ARRAY",
        items: { type: "STRING" }
      },
      pokemon_card: {
        type: "OBJECT",
        properties: {
          card_name: { type: "STRING" },
          set_code: { type: "STRING" },
          set_name: { type: "STRING" },
          card_number: { type: "STRING" },
          rarity: { type: "STRING" },
          language: { type: "STRING" },
          grading_status: { type: "STRING" },
          grader: { type: "STRING" },
          grade: { type: "STRING" },
          certification_number: { type: "STRING" },
          card_condition: { type: "STRING" }
        }
      }
    },
    required: ["title_ja", "description_ja", "title_en", "description_en"]
  };
}

/**
 * 候補レスポンスのバリデーション
 * 自動置換（「公式仕様」等への置換で新しい断定を作ること）は行わず、
 * 禁止語が検知された場合は候補検証エラー（PROHIBITED_WORDS_DETECTED）としてフェイルクローズにする。
 * @param {Object} rawCandidate
 * @param {Object} [options]
 * @return {Object} バリデーション済み候補オブジェクト
 */
/**
 * 裏面未確認時における状態断定（「白かけなし」「美品」等）の排除とサニタイズ (指示5)
 * 画像が2枚以上あっても、裏面が確認できていない場合は断定文を除去し、注記と要確認フラグを付与
 *
 * @param {string} descJa
 * @param {string} cardCondition
 * @param {boolean} hasBackImage
 * @return {{ description_ja: string, card_condition: string, sanitized_claims: boolean }}
 */
function sanitizeConditionClaimsWithoutBackImage_(descJa, cardCondition, hasBackImage) {
  let sanitizedDesc = String(descJa || "");
  let sanitizedCond = String(cardCondition || "");
  let sanitized = false;

  if (!hasBackImage) {
    // 裏面画像未確認時の断定表現パターン（「白かけなし」「美品」「目立った傷や汚れなし」等を網羅）
    const claimsPattern = /(?:白[か欠]け(?:は\s*)?(?:なし|見当たりません|ありません)|極美品|完品|初期傷なし|傷(?:は\s*)?(?:なし|ありません)|目立った傷や汚れなし|美品|新品・未使用|未使用に近い)/g;
    if (claimsPattern.test(sanitizedDesc)) {
      sanitizedDesc = sanitizedDesc.replace(claimsPattern, "要現物確認（裏面未確認）");
      sanitized = true;
    }
    if (claimsPattern.test(sanitizedCond)) {
      sanitizedCond = sanitizedCond.replace(claimsPattern, "要現物確認（裏面未確認）");
      sanitized = true;
    }

    // 美品単体の過大主張もサニタイズ
    if (/(?:^|[^\w])美品(?:[^\w]|$)/.test(sanitizedCond)) {
      sanitizedCond = sanitizedCond.replace(/(?:^|[^\w])美品(?:[^\w]|$)/g, "要現物確認");
      sanitized = true;
    }

    if (sanitized || !sanitizedDesc.includes("裏面未確認")) {
      sanitizedDesc += "\n\n※裏面画像が未確認のため、白欠け等のカード詳細状態はスタッフによる現物確認が必要です。";
    }
  }

  return {
    description_ja: sanitizedDesc,
    card_condition: sanitizedCond,
    sanitized_claims: sanitized
  };
}

/**
 * サーバー側での商品同定（Identity）の客観照合 (指示3)
 * LLMの自己申告に依存せず、属性の完全性・不整合・版違い・SKU推測を検査
 *
 * @param {Object} candidateObj
 * @param {Object} [options]
 * @return {{ identity_status: string, needs_review_items: Array<string> }}
 */
function verifyProductIdentityOnServer_(candidateObj, options) {
  options = options || {};
  const normCategory = candidateObj.category;
  const needsReviewItems = [];
  let status = "confident";

  if (normCategory === "pokemon_card") {
    const poke = candidateObj.pokemon_card || {};
    const cardName = String(poke.card_name || candidateObj.title_ja || "").trim();
    const cardNum = String(poke.card_number || "").trim();
    const rarity = String(poke.rarity || "").trim();
    const setName = String(poke.set_name || poke.expansion || "").trim();
    const isGraded = String(poke.grading_status || "").toLowerCase() === "graded";
    const language = String(poke.language || "Japanese").trim().toLowerCase();

    // 1. カード名検証: 汎用プレースホルダーは不可
    if (!cardName || /^(?:ポケモン|カード|ポケカ|pokemon|card|tcg)$/i.test(cardName)) {
      needsReviewItems.push("card_name");
      status = "ambiguous";
    }

    // 2. カード番号検証: 不明・不鮮明・推測は不可
    if (!cardNum || /(?:不明|確認できず|unspecified|\?)/.test(cardNum)) {
      needsReviewItems.push("card_number");
      status = "ambiguous";
    }

    // 3. レアリティ検証
    if (!rarity) {
      needsReviewItems.push("rarity");
      if (status !== "ambiguous") status = "candidate";
    }

    // 4. エキスパンション/セット名検証
    if (!setName) {
      needsReviewItems.push("set_name");
      if (status !== "ambiguous") status = "candidate";
    }

    // 5. 鑑定状態の整合性検証 (PSA品と通常品の混同防止)
    const titleHasPsa = /(?:\[?(?:PSA|BGS|CGC|ARS)\s*\d+(?:\.\d+)?\]?)/i.test(candidateObj.title_ja || "");
    if (titleHasPsa && !isGraded) {
      needsReviewItems.push("grading_status");
      status = "ambiguous";
    } else if (!titleHasPsa && isGraded) {
      needsReviewItems.push("grading_status");
      if (status !== "ambiguous") status = "candidate";
    }

    // 6. 言語の整合性検証 (別言語版の混同検知: 英語 vs 日本語)
    const titleIsEnglish = /(?:English|英語版|海外版|\bEN\b)/i.test(candidateObj.title_ja || "");
    const attrIsEnglish = (language === "english" || language === "英語版" || language === "海外版" || language === "en");
    if (titleIsEnglish !== attrIsEnglish) {
      needsReviewItems.push("language");
      status = "ambiguous";
    }

    // 7. 別番号・別レアリティの検知 (タイトル記載と属性の不一致)
    const titleStr = candidateObj.title_ja || "";
    const titleNumMatch = titleStr.match(/\b\d{3}\/\d{3}\b/);
    if (titleNumMatch && cardNum && titleNumMatch[0] !== cardNum) {
      needsReviewItems.push("card_number");
      status = "ambiguous";
    }
    const rarities = ["SAR", "AR", "UR", "SR", "HR", "RR", "R", "U", "C"];
    const titleRarityMatch = rarities.find(r => new RegExp(`\\b${r}\\b`).test(titleStr));
    if (titleRarityMatch && rarity && titleRarityMatch !== rarity) {
      needsReviewItems.push("rarity");
      status = "ambiguous";
    }

    // 8. 裏面未確認の判定
    if (!options.has_back_image) {
      needsReviewItems.push("card_condition");
    }

  } else if (normCategory === "sneaker") {
    const sku = String(candidateObj.sku || "").trim();
    const size = String(candidateObj.size || "").trim();

    // 1. SKU検証: 現物ラベルから直接読取られた確定値であること
    if (!sku) {
      needsReviewItems.push("sku");
      status = "ambiguous";
    } else if (/(?:推測|見込み|推定|candidate|inferred)/i.test(sku)) {
      needsReviewItems.push("sku");
      status = "ambiguous";
    }

    // 2. サイズ検証
    if (!size) {
      needsReviewItems.push("size");
      if (status !== "ambiguous") status = "candidate";
    }
  } else {
    // カテゴリ未確定
    if (!normCategory) {
      needsReviewItems.push("category");
      status = "ambiguous";
    }
  }

  // LLMが自ら ambiguous または unconfirmed と報告している場合はそれを尊重し降格
  const llmStatus = String(candidateObj.identity_status || "").trim().toLowerCase();
  if (llmStatus === "ambiguous" || llmStatus === "unconfirmed") {
    status = llmStatus;
  } else if (llmStatus === "candidate" && status === "confident") {
    status = "candidate";
  }

  return {
    identity_status: status,
    needs_review_items: needsReviewItems
  };
}

/**
 * 候補レスポンスのバリデーションとサニタイズ
 * - 真贋保証語句が含まれていてもエラー（PROHIBITED_WORDS_DETECTED）にはせず、該当文・語句のみを除去して有用な内容を保持する。
 * - 「クリーニング済み」等の定型文を除去する。
 * - アパレル・靴の状態候補をクリーニング後前提の基準（標準「目立った傷や汚れなし」）に沿って正規化する。
 * @param {Object} rawCandidate
 * @param {Object} [options]
 * @return {Object} バリデーション済み候補オブジェクト
 */
function validateAndSanitizeDraftCandidate_(rawCandidate, options) {
  options = options || {};
  if (!rawCandidate || typeof rawCandidate !== "object") {
    const err = new Error("[AI Draft] LLM returned invalid candidate object.");
    err.error_code = "INVALID_CANDIDATE_FORMAT";
    throw err;
  }

  const rawTitleJa = String(rawCandidate.title_ja || "").trim();
  if (!rawTitleJa) {
    const err = new Error("[AI Draft] LLM candidate is missing required 'title_ja'.");
    err.error_code = "MISSING_TITLE_JA";
    throw err;
  }

  const rawDescJa = String(rawCandidate.description_ja || "").trim();
  const rawTitleEn = String(rawCandidate.title_en || "").trim();
  const rawDescEn = String(rawCandidate.description_en || "").trim();
  let condition = String(rawCandidate.condition || "").trim();
  const rawHashtags = String(rawCandidate.hashtags_ja || "").trim();

  // 真贋保証語句の検知（エラー停止ではなく、不要な真贋文の除去後に記録）
  const combinedRawText = [rawTitleJa, rawDescJa, rawTitleEn, rawDescEn, rawHashtags].join(" ");
  const detectedProhibited = detectProhibitedWords_(combinedRawText);

  let titleJa = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(rawTitleJa, { mode: "title" }),
    { mode: "title" }
  );
  if (!titleJa) {
    titleJa = rawTitleJa;
  }
  let descJa = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(rawDescJa, { mode: "description" }),
    { mode: "description" }
  );
  const titleEn =
    stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(rawTitleEn, { mode: "title" }),
      { mode: "title" }
    ) || titleJa;
  const descEn = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(rawDescEn, { mode: "description" }),
    { mode: "description" }
  );
  const hashtags = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(rawHashtags, { mode: "hashtags" }),
    { mode: "hashtags" }
  );

  const upperRootCond = condition.toUpperCase();
  if (["A", "B", "C"].includes(upperRootCond)) {
    // ポケカ向け等でLLMがルートのconditionにA/B/Cを返却した場合の救済マッピング
    condition = (upperRootCond === "A") ? "目立った傷や汚れなし" : (upperRootCond === "B" ? "やや傷や汚れあり" : "傷や汚れあり");
    if (!rawCandidate.pokemon_card || typeof rawCandidate.pokemon_card !== "object") {
      rawCandidate.pokemon_card = {};
    }
    if (!rawCandidate.pokemon_card.card_condition) {
      rawCandidate.pokemon_card.card_condition = upperRootCond;
    }
  }

  if (!condition) {
    const err = new Error("[AI Draft] LLM candidate is missing required 'condition'.");
    err.error_code = "CONDITION_REQUIRED";
    throw err;
  }

  if (AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(condition) === -1) {
    const err = new Error(`[AI Draft] LLM candidate condition '${condition}' is invalid.`);
    err.error_code = "INVALID_CONDITION_CANDIDATE";
    throw err;
  }

  // カテゴリ & ブランドの正規化 (登録済みカテゴリがあればそれを最優先し、未入力・曖昧時はコンテキストから自動判定)
  const registeredCategory = (options && options.productMeta && !options.is_category_mismatch)
    ? normalizeCategoryValue_(options.productMeta.category)
    : "";
  let normCategory = registeredCategory || normalizeCategoryValue_(rawCandidate.category, rawCandidate);
  if (!normCategory) {
    normCategory = detectCategoryFromCandidateContext_(rawCandidate, options && options.productMeta);
  }
  const normBrand = normalizeBrandValue_(rawCandidate.brand, normCategory);

  // ポケカ固有属性の抽出とサニタイズ
  let pokeData = null;
  const hasBackImage = Boolean(options.has_back_image);

  let finalCondition = normalizeApparelAndShoeCondition_(condition, {
    category: normCategory,
    title_ja: titleJa,
    description_ja: descJa,
    title_en: titleEn,
    description_en: descEn,
    enforce_used_condition_policy: Boolean(options.enforce_used_condition_policy)
  });
  if (normCategory === "pokemon_card") {
    const rawPoke = (rawCandidate.pokemon_card && typeof rawCandidate.pokemon_card === "object")
      ? rawCandidate.pokemon_card
      : {};
    const cardName = String(rawPoke.card_name || titleJa).trim();
    const setCode = String(rawPoke.set_code || "").trim();
    const setName = String(rawPoke.set_name || rawPoke.expansion || "").trim();
    const cardNum = String(rawPoke.card_number || "").trim();
    const rarity = String(rawPoke.rarity || "").trim();
    const language = String(rawPoke.language || "Japanese").trim();
    const isGraded = String(rawPoke.grading_status || "").trim().toLowerCase() === "graded";

    let rawCardCondition = "";
    if (isGraded) {
      // 鑑定済みカード（PSA等）は従来どおり grading_status, grader, grade を使用し、未鑑定用A/B/Cは混入させない（必ず空文字）
      rawCardCondition = "";
    } else {
      // 未鑑定カード: 原則A、画像から明確な状態差が判断できる場合だけBまたはC
      const pokeCondRaw = String(rawPoke.card_condition || "").trim().toUpperCase();
      if (pokeCondRaw === "B" || pokeCondRaw === "C") {
        rawCardCondition = pokeCondRaw;
      } else if (pokeCondRaw === "A") {
        rawCardCondition = "A";
      } else if (condition === "やや傷や汚れあり") {
        rawCardCondition = "B";
      } else if (condition === "傷や汚れあり" || condition === "全体的に状態が悪い") {
        rawCardCondition = "C";
      } else {
        // 未鑑定ポケカのドラフト状態は原則A（スタッフ確認前のドラフト値）
        rawCardCondition = "A";
      }
    }

    // 裏面未確認時の状態断定排除 (指示5: 画像枚数に関わらず裏面未確認なら説明文中の断定を除去)
    const conditionSanitized = sanitizeConditionClaimsWithoutBackImage_(descJa, rawCardCondition, hasBackImage);
    descJa = conditionSanitized.description_ja;

    // 要件: ポケカ本票F列（状態）にA/B/Cを書き込まない（F列は従来商品の日本語状態区分用、ポケカの正式状態は pokemon_card.card_condition）
    finalCondition = "";

    pokeData = {
      card_name: cardName,
      set_code: setCode,
      set_name: setName,
      card_number: cardNum,
      rarity: rarity,
      language: language,
      grading_status: isGraded ? "graded" : "ungraded",
      grader: isGraded ? String(rawPoke.grader || "").trim() : "",
      grade: isGraded ? String(rawPoke.grade || "").trim() : "",
      certification_number: isGraded ? String(rawPoke.certification_number || "").trim() : "",
      card_condition: rawCardCondition
    };
  }

  let sku = normalizeSneakerSku_(rawCandidate.sku);
  // SKUが画像から確認できない場合は、TEST等の仮値で補わず空欄にする
  if (
    /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-|unspecified|not\s*visible)$/i.test(sku) ||
    /(?:画像から確認できず|確認不可|不明|テスト|推測|推定|candidate|inferred)/i.test(sku)
  ) {
    sku = "";
  }

  // サーバー側での価格算出 (厳格な成約証拠検査・検索一覧URL除外・未特定アパレル抑止・中央値/平均値・ポリシー丸め)
  const rawSkuCandidateForMeta = sku || String(rawCandidate.sku || "").trim();
  const priceResult = calculateServerGroundedPrice_(rawCandidate, {
    category: normCategory,
    brand: normBrand,
    sku: rawSkuCandidateForMeta,
    title_ja: titleJa,
    title_en: titleEn,
    description_ja: descJa,
    hashtags_ja: hashtags
  });
  const price = priceResult.price;
  const priceBasis = priceResult.price_basis;
  const priceNote = priceResult.price_note;
  const priceEvidence = priceResult.price_evidence;
  const priceEvidenceVerified = priceResult.price_evidence_verified;

  // スニーカーかつSKUが存在する場合、商品名／モデルとSKUの整合性を検証 (不一致は自動反映を防ぎ棄却)
  let isSneakerSkuMismatch = false;
  if (normCategory === "sneaker" && sku) {
    const skuMatch = verifySneakerModelSkuMatch_(titleJa + " " + titleEn, sku, options);
    if (!skuMatch.matched) {
      console.warn(`[AI Draft SKU Model Mismatch] Rejected SKU '${sku}' for title '${titleJa}': ${skuMatch.reason}`);
      sku = "";
      isSneakerSkuMismatch = true;
      if (descJa) {
        descJa = descJa.replace(/\n*※型番[^\n]*は画像検索に基づく推定候補です[^\n]*/g, "").trim();
      }
    }
  }

  let size = (normCategory === "sneaker") ? normalizeSneakerSize_(rawCandidate.size) : String(rawCandidate.size || "").trim();
  // サイズが画像から確認できない場合は、TEST等の仮値や推測で補わず空欄にする
  if (
    /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-|unspecified|not\s*visible)$/i.test(size) ||
    /(?:画像から確認できず|確認不可|不明|テスト|未設定|推測)/.test(size)
  ) {
    size = "";
  }

  // サーバー側での商品同定（Identity）の客観照合 (指示3)
  // 入力された元のタイトルと抽出属性の整合性を客観照合
  const tempCandidateForIdentity = {
    title_ja: titleJa,
    category: normCategory,
    brand: normBrand,
    sku: sku,
    size: size,
    identity_status: rawCandidate.identity_status,
    pokemon_card: pokeData
  };
  const identityCheck = verifyProductIdentityOnServer_(tempCandidateForIdentity, { has_back_image: hasBackImage });
  const identityStatus = identityCheck.identity_status;

  // ポケカ商品名のサニタイズ（冗長プレフィックス排除 & テンプレート整形 & PSAプレフィックス保持）
  if (normCategory === "pokemon_card" && pokeData) {
    if (identityStatus !== "ambiguous") {
      titleJa = sanitizePokemonCardTitle_(titleJa, pokeData);
    } else {
      titleJa = titleJa.replace(/^(?:ポケモンカードゲーム|ポケモンカード|pok[eé]mon\s*card\s*game|pok[eé]mon\s*card)\s*[:：\-ー・]?\s*/i, "").trim();
    }
  }

  // 要確認リスト (needs_review) の収集
  const needsReviewSet = new Set(
    Array.isArray(rawCandidate.needs_review)
      ? rawCandidate.needs_review.map(r => String(r || "").trim()).filter(Boolean)
      : []
  );

  // サーバー側同定検査で指摘された項目を追加
  identityCheck.needs_review_items.forEach(item => needsReviewSet.add(item));

  // スニーカー型番不一致時は要確認項目を追加、検索推定型番時も現物確認のため要確認フラグを担保
  if (isSneakerSkuMismatch) {
    needsReviewSet.add("sku");
    needsReviewSet.add("sku_model_mismatch");
  } else if (normCategory === "sneaker" && rawCandidate.sku_source === "search_corroborated") {
    needsReviewSet.add("sku");
  }

  // ポケカ裏面未撮影時は状態を要確認
  if (normCategory === "pokemon_card" && !hasBackImage) {
    needsReviewSet.add("card_condition");
    needsReviewSet.add("condition");
  }

  // 価格検査で指摘された項目を追加
  if (priceResult.needs_review_price) {
    needsReviewSet.add("price");
  }

  const needsReviewList = Array.from(needsReviewSet);

  return {
    title_ja: titleJa,
    hashtags_ja: hashtags,
    description_ja: descJa,
    title_en: titleEn,
    description_en: descEn,
    condition: finalCondition,
    price: price,
    price_basis: priceBasis,
    price_note: priceNote,
    price_evidence: priceEvidence,
    price_evidence_verified: priceEvidenceVerified,
    category: normCategory,
    brand: normBrand,
    sku: sku,
    sku_source: isSneakerSkuMismatch
      ? "unconfirmed"
      : (rawCandidate.sku_source || ""),
    raw_box_label_sku: rawCandidate.raw_box_label_sku || "",
    size: size,
    raw_inner_tag_size: rawCandidate.raw_inner_tag_size || "",
    identity_status: identityStatus,
    needs_review: needsReviewList,
    pokemon_card: pokeData,
    sanitized_authenticity_terms: detectedProhibited
  };
}

function extractGroundingMetadata_(candidateObj) {
  const meta = candidateObj && candidateObj.groundingMetadata ? candidateObj.groundingMetadata : null;
  const queries = [];
  const sources = [];

  if (meta) {
    if (Array.isArray(meta.webSearchQueries)) {
      meta.webSearchQueries.forEach(q => {
        if (typeof q === "string" && q.trim()) {
          queries.push(q.trim());
        }
      });
    }

    if (Array.isArray(meta.groundingChunks)) {
      meta.groundingChunks.forEach(chunk => {
        if (chunk && chunk.web) {
          const u = String(chunk.web.uri || "").trim();
          const t = String(chunk.web.title || "").trim();
          if (u) {
            sources.push({ url: u, title: t });
          }
        }
      });
    }
  }

  return {
    search_executed: queries.length > 0,
    queries: queries,
    sources: sources
  };
}

/**
 * 検索グラウンディング用 システム指示文
 * 具体的な商品名提案を促し、SKU保護規則を厳格に指示する
 * @return {string}
 */
function buildSearchGroundingSystemInstruction_() {
  const baseInstruction = buildAiDraftSystemInstruction_();
  const searchAddition = [
    "",
    "--- ADDITIONAL INSTRUCTIONS FOR WEB SEARCH GROUNDING ---",
    "1. Identity & Specificity: Use the Google Search tool to verify visual features (model, design, colorway, logos, text) against real product catalogs. Do NOT revert to broad generic terms (e.g., merely 'sneakers' or 'card') solely to avoid misidentification. Prioritize suggesting the most specific, accurate official product title and edition.",
    "2. Strict SKU Protection: Do NOT output an inferred or searched SKU into the 'sku' field unless the model number/SKU is clearly and directly legible on the product label/tag/box within the attached images. If not directly legible from image labels, leave 'sku' strictly as an empty string (\"\"). Inferred model codes may be included in the product title (title_ja / title_en) or description, but NEVER as the confirmed 'sku' attribute.",
    "3. Pokémon Card Identity & Verification: For Pokémon cards, search using [card_name] [set_code] [card_number] [rarity]. Verify the exact expansion set name and card number. Never confuse normal cards with alternate art (SAR, FUR), promos, or PSA graded slabs. For ungraded cards, assign card_condition 'A' (default draft), or 'B'/'C' if clear flaws or wear are observed. If back image is missing, do not fail or leave blank; set 'A' as pre-review draft with staff inspection note. Graded cards must have empty card_condition ('').",
    "4. Price Grounding in Market Transactions: Use Google Search to find current market pricing in JPY for the identified product (using card number/rarity, or shoe SKU/size). Follow tiered priority: (1) Recent sold transactions, (2) Active listings of identical item, (3) Comparable market evidence. Always propose a numeric price proposal when market data is found. Distinguish sold transactions from active asking prices. Do NOT default to null when market info exists."
  ].join("\n");
  return baseInstruction + "\n" + searchAddition;
}

const TRANSLATION_DICTIONARIES = {
  condition: {
    "新品・未使用": "Brand New / Unused",
    "未使用に近い": "Like New / Near Mint",
    "目立った傷や汚れなし": "Excellent",
    "やや傷や汚れあり": "Good",
    "傷や汚れあり": "Fair",
    "全体的に状態が悪い": "Poor"
  },
  box: {
    "あり": "Original Box Included",
    "なし": "No Box"
  },
  sneaker_accessories: {
    "タグ": "Japanese Black Tag",
    "予備のシューレース": "Extra Laces",
    "購入時の領収書": "Original Receipt",
    "その他": "Other Accessories"
  }
};

function translateFixedAttributes(productData) {
  if (!productData || typeof productData !== "object") {
    return {
      translated_condition: "",
      translated_box: "",
      translated_accessories: ""
    };
  }

  // 1. 商品状態 (condition)
  const rawCondition = String(productData.condition || "").trim();
  let translatedCondition = "";
  if (rawCondition) {
    translatedCondition = TRANSLATION_DICTIONARIES.condition[rawCondition] || rawCondition;
  }

  // 2. 箱の有無 (sneaker_box または box)
  const rawBox = String(
    productData.sneaker_box !== undefined
      ? productData.sneaker_box
      : (productData.box || "")
  ).trim();
  let translatedBox = "";
  if (rawBox) {
    translatedBox = TRANSLATION_DICTIONARIES.box[rawBox] || rawBox;
  }

  // 3. 付属品 (sneaker_accessories または accessories, カンマ区切りまたは配列)
  const rawAccessories =
    productData.sneaker_accessories !== undefined
      ? productData.sneaker_accessories
      : productData.accessories;

  let translatedAccessories = "";
  if (Array.isArray(rawAccessories)) {
    translatedAccessories = rawAccessories
      .map(item => {
        const trimmed = String(item || "").trim();
        if (!trimmed) return "";
        return TRANSLATION_DICTIONARIES.sneaker_accessories[trimmed] || trimmed;
      })
      .filter(Boolean)
      .join(", ");
  } else if (rawAccessories !== undefined && rawAccessories !== null) {
    const accStr = String(rawAccessories).trim();
    if (accStr) {
      const items = accStr.split(/[,\u3001]/).map(s => s.trim()).filter(Boolean);
      translatedAccessories = items
        .map(item => TRANSLATION_DICTIONARIES.sneaker_accessories[item] || item)
        .join(", ");
    }
  }

  return {
    translated_condition: translatedCondition,
    translated_box: translatedBox,
    translated_accessories: translatedAccessories
  };
}


function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input ?? ""), "utf8").digest("hex");
}

export function computeConfirmationPayloadHash_(confirmedData) {
  if (!confirmedData || typeof confirmedData !== "object") return "";
  const poke = confirmedData.pokemon_card || {};
  const normalizedPoke = [
    String(poke.card_name || "").trim(),
    String(poke.set_name || "").trim(),
    String(poke.card_number || "").trim(),
    String(poke.rarity || "").trim(),
    String(poke.language || "").trim(),
    String(poke.grading_status || "").trim(),
    String(poke.grader || "").trim(),
    String(poke.grade || "").trim(),
    String(poke.certification_number || "").trim(),
    String(poke.card_condition || "").trim(),
  ].join("|");

  const pName = String(confirmedData.product_name || confirmedData.title_ja || "").trim();
  const pPrice = String(
    confirmedData.planned_sale_price !== undefined
      ? confirmedData.planned_sale_price
      : confirmedData.price !== undefined
        ? confirmedData.price
        : ""
  ).trim();
  const pCond = String(confirmedData.condition || "").trim();
  const pTitle = String(confirmedData.translated_title || confirmedData.title_en || "").trim();
  const pDesc = String(
    confirmedData.translated_description || confirmedData.description_en || ""
  ).trim();
  const pCat = normalizeCategoryValue_(confirmedData.category || "");
  const pSize = String(
    confirmedData.sneaker_size !== undefined
      ? confirmedData.sneaker_size
      : confirmedData.size !== undefined
        ? confirmedData.size
        : ""
  ).trim();
  const pBrand = normalizeBrandValue_(confirmedData.brand || "", pCat);
  const pSku = String(
    confirmedData.sneaker_sku !== undefined
      ? confirmedData.sneaker_sku
      : confirmedData.sku !== undefined
        ? confirmedData.sku
        : ""
  ).trim();
  const pDescription = String(confirmedData.description || "").trim();
  const pHashtags = String(confirmedData.hashtags_ja || "").trim();

  const normalized = [
    pName,
    pPrice,
    pCond,
    pTitle,
    pDesc,
    pCat,
    pSize,
    pBrand,
    pSku,
    pDescription,
    pHashtags,
    normalizedPoke,
  ].join("::");

  return sha256Hex(normalized);
}

export function resolveAiDraftModelName(overrideModel) {
  const custom = String(overrideModel || process.env.AI_DRAFT_MODEL || "").trim();
  if (custom === "gemini-3.5-flash-lite" && !overrideModel) {
    return AI_DRAFT_CONFIG.DEFAULT_MODEL;
  }
  return custom || AI_DRAFT_CONFIG.DEFAULT_MODEL;
}

export function resolveAiDraftFallbackModelName() {
  const custom = String(process.env.AI_DRAFT_FALLBACK_MODEL || "").trim();
  return custom || AI_DRAFT_CONFIG.FALLBACK_MODEL;
}

export function resolveSearchGroundingEnabled(explicitFlag) {
  if (explicitFlag !== undefined) return Boolean(explicitFlag);
  const envVal = String(process.env.AI_DRAFT_ENABLE_SEARCH_GROUNDING ?? "").trim().toLowerCase();
  if (!envVal) return AI_DRAFT_CONFIG.DEFAULT_SEARCH_GROUNDING_ENABLED;
  return envVal !== "false" && envVal !== "0";
}

export function resolveSearchGroundingMode(explicitMode) {
  const raw = String(explicitMode || process.env.AI_DRAFT_SEARCH_GROUNDING_MODE || "")
    .trim()
    .toLowerCase();
  if (raw === "two_stage" || raw === "single" || raw === "auto") {
    return raw;
  }
  return AI_DRAFT_CONFIG.DEFAULT_SEARCH_GROUNDING_MODE;
}

function redactSecretInMessage(msg) {
  return String(msg || "")
    .replace(/key=[^&\s]+/gi, "key=[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]");
}

async function postGeminiGenerateContent({ fetchImpl, modelName, apiKey, payload }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent`;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  return { statusCode: res.status, bodyText };
}

export async function fetchDedicatedPriceSearch_(queryContext, apiKey, modelName, fetchImpl = globalThis.fetch) {
  queryContext = queryContext || {};
  const queryTerms = [];
  if (queryContext.category === "pokemon_card") {
    if (queryContext.cardName) queryTerms.push(queryContext.cardName);
    if (queryContext.setCode) queryTerms.push(queryContext.setCode);
    if (queryContext.cardNumber) queryTerms.push(queryContext.cardNumber);
    if (queryContext.rarity) queryTerms.push(queryContext.rarity);
    queryTerms.push("相場 価格");
  } else if (queryContext.category === "sneaker") {
    if (queryContext.brand) queryTerms.push(queryContext.brand);
    if (queryContext.sku) queryTerms.push(queryContext.sku);
    if (queryContext.size) queryTerms.push(queryContext.size);
    queryTerms.push("スニーカー 価格 相場");
  } else {
    if (queryContext.titleJa) queryTerms.push(queryContext.titleJa);
    queryTerms.push("価格 相場");
  }

  const query = queryTerms.filter(Boolean).join(" ").trim();
  if (!query || !apiKey) return null;

  const prompt = [
    "Use Google Search to find current market pricing in JPY for the following product:",
    `Product Query: ${query}`,
    "",
    "Search specifically for:",
    "1. Recent sold / completed transactions (成約実績, 落札相場) in JPY (with dates and sources).",
    "2. If no sold transactions, find current active listing prices (販売中価格, 出品価格) of the identical product in JPY.",
    "3. If still not found, find comparable market prices in JPY.",
    "",
    "Report the findings in Japanese: list amounts in JPY (e.g. 8,300円), transaction type (成約 / 販売中 / 相場), dates, and source URLs.",
    "Always report numeric amounts found.",
  ].join("\n");

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  };

  const startTime = Date.now();
  try {
    const { statusCode, bodyText } = await postGeminiGenerateContent({
      fetchImpl,
      modelName,
      apiKey,
      payload,
    });
    const elapsedMs = Date.now() - startTime;
    if (statusCode !== 200) {
      console.warn(`[AI Draft Dedicated Price Search] HTTP ${statusCode}`);
      return null;
    }
    const parsed = JSON.parse(bodyText);
    const cand = parsed.candidates && parsed.candidates[0];
    if (!cand) return null;

    const grounding = extractGroundingMetadata_(cand);
    const nonThought =
      cand.content && Array.isArray(cand.content.parts)
        ? cand.content.parts.filter(
            (p) => !p.thought && typeof p.text === "string" && p.text.trim().length > 0
          )
        : [];
    const text =
      nonThought.length > 0
        ? nonThought.map((p) => p.text).join("\n")
        : cand.content && Array.isArray(cand.content.parts)
          ? cand.content.parts.map((p) => p.text || "").join("\n")
          : "";

    return {
      pricingText: text,
      sources: grounding.sources || [],
      query,
      elapsedMs,
    };
  } catch (err) {
    console.warn(`[AI Draft Dedicated Price Search] Exception: ${redactSecretInMessage(err.message)}`);
    return null;
  }
}

export async function classifyCategoryPriorFromImages_(images, productMeta, modelName, options = {}) {
  productMeta = productMeta || {};
  const existingNormCategory = normalizeCategoryValue_(productMeta.category);
  const metaWithoutCat = { ...productMeta, category: "" };
  const localDetected = detectCategoryFromCandidateContext_({}, metaWithoutCat);

  let apiDetectedCat = "";
  let confidence = localDetected ? "medium" : existingNormCategory ? "high" : "none";
  let mismatchDetected = false;
  let mismatchReason = "";
  let apiExecuted = false;
  let apiSuccess = false;
  let apiFailed = false;

  if (existingNormCategory && localDetected && existingNormCategory !== localDetected) {
    const isNonSneakerRegistered =
      ["apparel", "fashion_goods", "jewelry", "other"].indexOf(existingNormCategory) !== -1;
    const hasExplicitSneakerSku = Boolean(String(metaWithoutCat.sneakerSku || "").trim());
    const shouldFlagMismatch = !(
      isNonSneakerRegistered &&
      localDetected === "sneaker" &&
      !hasExplicitSneakerSku
    );
    if (shouldFlagMismatch) {
      mismatchDetected = true;
      mismatchReason = `Metadata specifies category '${existingNormCategory}', but text/attributes indicate '${localDetected}'.`;
      console.warn(`[Category Mismatch Detected] ${mismatchReason}`);
    }
  }

  if (Array.isArray(images) && images.length > 0) {
    const shouldCallApi =
      Boolean(options.enable_prior_classification_api) || (!existingNormCategory && !localDetected);

    if (shouldCallApi && options.apiKey) {
      apiExecuted = true;
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      try {
        const selectedModel = modelName || resolveAiDraftModelName();
        const imageParts = images.slice(0, 4).map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.base64 },
        }));
        const promptText = [
          "Examine the attached product images (which may include product appearance, packaging/box, and barcode/size labels). Determine the product category strictly from the following choices:",
          '- "pokemon_card": Pokémon trading cards, booster packs, graded card slabs (PSA/BGS/CGC), or Pokémon card game singles.',
          '- "sneaker": Athletic sneakers, footwear, shoes, shoe boxes, or sneaker size tags.',
          '- "other": Apparel/clothing, accessories, other trading cards, or unidentifiable items.',
          "",
          "Respond strictly in JSON:",
          '{"category": "pokemon_card" | "sneaker" | "other", "confidence": "high" | "low", "rationale": "brief rationale"}',
        ].join("\n");

        const payload = {
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }, ...imageParts],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 100,
            responseMimeType: "application/json",
          },
        };

        const { statusCode, bodyText } = await postGeminiGenerateContent({
          fetchImpl,
          modelName: selectedModel,
          apiKey: options.apiKey,
          payload,
        });

        if (statusCode === 200) {
          apiSuccess = true;
          const parsed = JSON.parse(bodyText);
          const cand = parsed.candidates && parsed.candidates[0];
          if (cand && cand.content && cand.content.parts && cand.content.parts[0]) {
            let rawTxt = String(cand.content.parts[0].text || "").trim();
            if (/^```(?:json)?/i.test(rawTxt)) {
              rawTxt = rawTxt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
            }
            let resObj = null;
            try {
              resObj = JSON.parse(rawTxt);
            } catch {
              const catM = rawTxt.match(/"category"\s*:\s*"([^"]+)"/i);
              const confM = rawTxt.match(/"confidence"\s*:\s*"([^"]+)"/i);
              if (catM) {
                resObj = { category: catM[1], confidence: confM ? confM[1] : "high" };
              }
            }
            if (resObj) {
              const normCat = normalizeCategoryValue_(resObj.category);
              if (normCat === "pokemon_card" && (resObj.confidence === "high" || !resObj.confidence)) {
                apiDetectedCat = "pokemon_card";
                confidence = "high";
              } else if (normCat === "sneaker" && (resObj.confidence === "high" || !resObj.confidence)) {
                apiDetectedCat = "sneaker";
                confidence = "high";
              } else {
                apiDetectedCat = normCat || "";
                confidence = resObj.confidence || "low";
              }
            }
          }
        } else {
          apiFailed = true;
          console.warn(`[Prior Category Detection] API returned HTTP ${statusCode}`);
        }
      } catch (err) {
        apiFailed = true;
        console.warn(
          "[Prior Category Detection] Exception in API call, falling back to local heuristic:",
          redactSecretInMessage(err.message)
        );
      }
    }

    if (existingNormCategory && apiDetectedCat && existingNormCategory !== apiDetectedCat) {
      mismatchDetected = true;
      mismatchReason = `Metadata specifies category '${existingNormCategory}', but product image analysis identified '${apiDetectedCat}'.`;
      console.warn(`[Category Mismatch Detected] ${mismatchReason}`);
    }
  }

  let finalCategory = "";
  let status = "unconfirmed";
  if (mismatchDetected) {
    finalCategory = "";
    status = "category_mismatch";
  } else if (existingNormCategory) {
    finalCategory = existingNormCategory;
    status = "classified";
  } else if (apiDetectedCat) {
    finalCategory = apiDetectedCat;
    status = "classified";
  } else if (localDetected) {
    finalCategory = localDetected;
    status = "classified";
  } else if (apiFailed) {
    status = "api_failed";
  }

  return {
    category: finalCategory,
    confidence,
    mismatchDetected,
    mismatchReason,
    apiExecuted,
    apiSuccess,
    apiFailed,
    status,
  };
}

export async function callGeminiMultimodalAiDraft_(images, productMeta, overrideModel, options = {}) {
  const apiKey = String(options.apiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("[AI Draft] GEMINI_API_KEY is not configured.");
    err.error_code = "LLM_API_KEY_MISSING";
    throw err;
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const defaultPrimary = resolveAiDraftModelName();
  const primaryModel = String(overrideModel || "").trim() || defaultPrimary;
  const isDedicatedOverride = Boolean(overrideModel && overrideModel !== defaultPrimary);
  const fallbackModel = isDedicatedOverride ? null : resolveAiDraftFallbackModelName();

  const existingSku = String(productMeta.sneakerSku || "").trim();
  const safeExistingSku = /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(
    existingSku
  )
    ? ""
    : existingSku;

  const promptText = [
    "Analyze the attached product images and the following metadata to generate listing draft candidates:",
    `- Product ID: ${productMeta.productId}`,
    `- Existing Category: ${productMeta.category || "Unspecified"}`,
    `- Existing Brand: ${productMeta.brand || "Unspecified"}`,
    `- Existing Name: ${productMeta.productName || "Unspecified"}`,
    `- Existing SKU: ${safeExistingSku || "Unspecified"}`,
    "",
    'Note on SKU: Confirm the SKU strictly from the attached images. If not confirmed from images, output an empty string ("") for sku. Do NOT fill with \'TEST\' or any placeholder.',
    "",
    "Follow all system instructions strictly. Return valid JSON.",
  ].join("\n");

  const parts = [{ text: promptText }];
  images.forEach((img) => {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64,
      },
    });
  });

  const payload = {
    contents: [{ role: "user", parts }],
    systemInstruction: {
      parts: [{ text: buildAiDraftSystemInstruction_() }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: buildAiDraftResponseSchema_(),
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const retryableStatuses = [429, 500, 502, 503, 504];
  const initialDelayMs = options.retryDelayMs !== undefined ? Number(options.retryDelayMs) : 1500;
  const maxElapsedLimitMs = 45000;
  const callStartTime = Date.now();

  const modelsToTry = [primaryModel];
  if (fallbackModel && fallbackModel !== primaryModel) {
    modelsToTry.push(fallbackModel);
  }

  let parsed = null;
  let actuallyUsedModel = primaryModel;
  let lastStatusCode = 0;

  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const currentModel = modelsToTry[mIdx];
    const isFallback = mIdx > 0;
    const maxModelAttempts = isFallback ? 1 : 2;

    if (isFallback) {
      console.warn(
        `[AI Draft] 主モデル '${primaryModel}' で再試行可能エラーが継続したため、予備モデル '${currentModel}' へ一度だけ切り替えます。`
      );
    }

    let modelSuccess = false;
    for (let attempt = 0; attempt < maxModelAttempts; attempt++) {
      const elapsedSoFar = Date.now() - callStartTime;
      if (elapsedSoFar >= maxElapsedLimitMs) break;

      let statusCode = 0;
      let bodyText = "";
      try {
        const res = await postGeminiGenerateContent({
          fetchImpl,
          modelName: currentModel,
          apiKey,
          payload,
        });
        statusCode = res.statusCode;
        bodyText = res.bodyText;
      } catch (netErr) {
        lastStatusCode = 0;
        const elapsedAfter = Date.now() - callStartTime;
        if (attempt + 1 < maxModelAttempts && elapsedAfter + initialDelayMs < maxElapsedLimitMs) {
          await sleepMs(initialDelayMs);
          continue;
        }
        break;
      }

      lastStatusCode = statusCode;
      if (statusCode === 200) {
        try {
          parsed = JSON.parse(bodyText);
          actuallyUsedModel = currentModel;
          modelSuccess = true;
          break;
        } catch {
          break;
        }
      }

      if (retryableStatuses.includes(statusCode) && attempt + 1 < maxModelAttempts) {
        const waitMs = initialDelayMs * (attempt + 1);
        if (Date.now() - callStartTime + waitMs < maxElapsedLimitMs) {
          await sleepMs(waitMs);
          continue;
        }
      }
      break;
    }

    if (modelSuccess) break;
  }

  if (!parsed) {
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = lastStatusCode ? `LLM_HTTP_ERROR_${lastStatusCode}` : "LLM_COMMUNICATION_FAILED";
    throw err;
  }

  const candidate = parsed.candidates && parsed.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = "EMPTY_LLM_RESPONSE";
    throw err;
  }

  const nonThoughtParts = candidate.content.parts.filter(
    (p) => !p.thought && typeof p.text === "string" && p.text.trim().length > 0
  );
  const rawText =
    nonThoughtParts.length > 0
      ? nonThoughtParts.map((p) => p.text).join("")
      : candidate.content.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("");

  let rawJson;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = "STRUCTURED_PARSE_FAILED";
    throw err;
  }

  const sanitized = validateAndSanitizeDraftCandidate_(rawJson, {
    image_count: images.length,
    has_back_image: Boolean(options && options.has_back_image),
    productMeta,
  });
  sanitized.actual_model_name = actuallyUsedModel;
  return sanitized;
}

export async function callGeminiSingleRequestSearchGrounding_(
  images,
  productMeta,
  modelName,
  options = {}
) {
  const apiKey = String(options.apiKey || process.env.GEMINI_API_KEY || "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const existingSku = String(productMeta.sneakerSku || "").trim();
  const safeExistingSku = /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(
    existingSku
  )
    ? ""
    : existingSku;

  const ignoreIdentity = Boolean(options.ignore_existing_identity);
  const metaName = ignoreIdentity
    ? "Unspecified (diagnose from visual features)"
    : productMeta.productName || "Unspecified";
  const metaSku = ignoreIdentity
    ? "Unspecified (diagnose from visual features)"
    : safeExistingSku || "Unspecified";

  const promptText = [
    "Analyze the attached product images and the following metadata. Use Google Search to identify the specific product model and official colorway, then generate listing draft candidates:",
    `- Product ID: ${productMeta.productId}`,
    `- Existing Category: ${productMeta.category || "Unspecified"}`,
    `- Existing Brand: ${productMeta.brand || "Unspecified"}`,
    `- Existing Name: ${metaName}`,
    `- Existing SKU: ${metaSku}`,
    "",
    "Guidelines:",
    "- Cross-reference visible design details with web search results to propose the specific product name.",
    "- Do not regress to vague names when brand/model is corroborated; however, for apparel with unconfirmed brand/model, NEVER guess (and NEVER assume Chrome Hearts)—follow the apparel title and 5-part description format in system instructions and omit unconfirmed items cleanly.",
    '- STRICT SKU PROTECTION: Output an empty string ("") for sku unless directly legible on a label/tag image.',
    "Return valid JSON adhering to the response schema.",
  ].join("\n");

  const parts = [{ text: promptText }];
  images.forEach((img) => {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64,
      },
    });
  });

  const payload = {
    contents: [{ role: "user", parts }],
    tools: [{ google_search: {} }],
    systemInstruction: {
      parts: [{ text: buildSearchGroundingSystemInstruction_() }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: buildAiDraftResponseSchema_(),
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  let statusCode = 0;
  let bodyText = "";
  try {
    const res = await postGeminiGenerateContent({
      fetchImpl,
      modelName,
      apiKey,
      payload,
    });
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (netErr) {
    const err = new Error(
      `[AI Draft Single Grounding] Network exception: ${redactSecretInMessage(netErr.message)}`
    );
    err.error_code = "LLM_COMMUNICATION_FAILED";
    throw err;
  }

  if (statusCode === 200) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (jErr) {
      return {
        success: false,
        status_code: 200,
        error_code: "STRUCTURED_PARSE_FAILED",
        error_message: jErr.message,
      };
    }

    const candObj = parsed.candidates && parsed.candidates[0];
    if (!candObj || !candObj.content || !candObj.content.parts || candObj.content.parts.length === 0) {
      return {
        success: false,
        status_code: 200,
        error_code: "EMPTY_LLM_RESPONSE",
        error_message: "Empty candidate parts",
      };
    }

    const nonThought = candObj.content.parts.filter(
      (p) => !p.thought && typeof p.text === "string" && p.text.trim().length > 0
    );
    const rawText =
      nonThought.length > 0
        ? nonThought.map((p) => p.text).join("")
        : candObj.content.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("");

    let rawJson;
    try {
      rawJson = JSON.parse(rawText);
    } catch (sErr) {
      return {
        success: false,
        status_code: 200,
        error_code: "STRUCTURED_PARSE_FAILED",
        error_message: sErr.message,
      };
    }

    const sanitized = validateAndSanitizeDraftCandidate_(rawJson, {
      image_count: images.length,
      has_back_image: Boolean(options && options.has_back_image),
      productMeta,
    });
    sanitized.actual_model_name = modelName;

    const grounding = extractGroundingMetadata_(candObj);
    if (!grounding.search_executed) {
      return {
        success: false,
        status_code: 200,
        error_code: "SEARCH_GROUNDING_NOT_EXECUTED",
        error_message: "Web search was not executed by model (0 search queries generated)",
        grounding,
      };
    }
    if (grounding.sources.length === 0) {
      return {
        success: false,
        status_code: 200,
        error_code: "SEARCH_GROUNDING_NOT_EXECUTED",
        error_message: "Search queries generated but 0 grounding sources returned (unconfirmed match)",
        grounding,
      };
    }
    return {
      success: true,
      status_code: 200,
      candidate: sanitized,
      grounding,
    };
  }

  let errDetail = { code: statusCode, status: "UNKNOWN", message: "" };
  try {
    const errJson = JSON.parse(bodyText);
    if (errJson && errJson.error) {
      errDetail.code = errJson.error.code || statusCode;
      errDetail.status = errJson.error.status || "UNKNOWN";
      errDetail.message = redactSecretInMessage(errJson.error.message || "");
    }
  } catch {
    errDetail.message = redactSecretInMessage(bodyText.substring(0, 300));
  }

  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
    const err = new Error(`[AI Draft Single Grounding] Transient error HTTP ${statusCode}: ${errDetail.message}`);
    err.error_code = `LLM_HTTP_ERROR_${statusCode}`;
    err.status_code = statusCode;
    err.error_details = errDetail;
    throw err;
  }

  const schemaConflictPatterns = [
    /tools?\s*(?:are\s*)?not\s*supported\s*with\s*(?:responseSchema|response_schema|structured\s*output|responseMimeType|response_mime_type)/i,
    /(?:responseSchema|response_schema|structured\s*output)\s*(?:is\s*)?not\s*supported\s*with\s*tools?/i,
    /cannot\s*use\s*tools?\s*with\s*(?:responseSchema|structured\s*output)/i,
    /google_?search\s*(?:is\s*)?not\s*supported\s*with\s*(?:responseSchema|json)/i,
    /tool\s*use\s*is\s*not\s*supported\s*in\s*json\s*mode/i,
  ];
  const isSchemaUnsupported = schemaConflictPatterns.some((pat) => pat.test(errDetail.message));

  return {
    success: false,
    status_code: statusCode,
    is_schema_unsupported: isSchemaUnsupported,
    error_code: `LLM_HTTP_ERROR_${statusCode}`,
    error_message: errDetail.message,
    error_details: errDetail,
  };
}


export async function callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options) {
  options = options || {};
  const apiKey = String(options.apiKey || process.env.GEMINI_API_KEY || "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  // プロンプト浄化: 既存の商品名やSKUをモデル入力から排除し、
  // 画像から自律的に特徴・文字を観察して検索させる (スタッフ入力のSKU・価格・サイズを保護)
  const safeBrand = String(productMeta.brand || "").trim();
  const safeCategory = String(productMeta.category || "").trim();

  // --------------------------------------------------
  // Pre-Stage: 画像先行カテゴリー判定 (Prior Category Detection)
  // --------------------------------------------------
  const priorClass = options.prior_classification || (await classifyCategoryPriorFromImages_(images, productMeta, modelName, { ...options, apiKey, fetchImpl }));
  const isCategoryMismatch = Boolean(priorClass.mismatchDetected);

  // カテゴリー決定 (指示2):
  // カテゴリー矛盾時は既存メタデータへフォールバックしてはならない
  let normCategory = "";
  if (isCategoryMismatch) {
    normCategory = ""; // 矛盾時は強制的に未確定とし、専用Stage Aを絶対に選ばない
  } else {
    normCategory = priorClass.category || normalizeCategoryValue_(productMeta.category) || "";
  }

  const isPokemonCard = normCategory === "pokemon_card";
  const isSneaker = normCategory === "sneaker";
  const isApparelOrFashion = normCategory === "apparel" || normCategory === "fashion_goods";
  const isJewelry = normCategory === "jewelry";
  const isOtherCategory = normCategory === "other";

  const stageAPromptLines = [
    "You are an expert e-commerce catalog specialist and market researcher.",
    "Carefully examine the attached product images. Do NOT make assumptions based on brand alone. Do NOT judge or mention authenticity (items are already authenticated via B2B brand auctions).",
    ""
  ];

  if (isPokemonCard) {
    stageAPromptLines.push(
      "TASK INSTRUCTIONS FOR POKÉMON CARD IDENTIFICATION & PRICING:",
      "Step 1. DIRECT OBSERVATION: Transcribe all visible card attributes strictly from the image:",
      "  - CARD_NAME: Exact visible card name (e.g. ルギア, ミュウex)",
      "  - SET_CODE: Visible bottom border set code (e.g. M6a, SV4a, S8a-P). If obscured/missing, write NONE.",
      "  - CARD_NUMBER: Visible card number (e.g. 142/103, 135/103). If obscured/missing, write NONE.",
      "  - RARITY: Visible rarity symbol/text (e.g. UR, SAR, SR, AR, RR, R, PROMO, その他). If none, write NONE.",
      "  - LANGUAGE: Japanese, English, etc.",
      "  - GRADING: 'graded' (with grader name, grade e.g. PSA 10, and cert number) or 'ungraded'.",
      "  - VISIBLE_FLAWS: Whitening, scratches, or state 'back view unconfirmed' if only front is visible.",
      "Step 2. WEB SEARCH & CARD CATALOG VERIFICATION:",
      "  - Use Google Search strictly with observed identifiers: [card_name] [set_code] [card_number] [rarity].",
      "  - Corroborate official expansion set name (e.g. 拡張パック『30th CELEBRATION』, ポケモンカード151).",
      "  - ISOLATION RULE: Do NOT confuse with different card numbers, regular vs alternate art variants (SAR/FUR), reprints, or PSA slabs.",
      "Step 3. PRICE GROUNDING & TIERED MARKET PRICING:",
      "  - Search specifically for current market pricing in JPY for this exact card (using card name, set code, card number, rarity).",
      "  - Priority order:",
      "    1) Recent verified sold/completed transactions (成約実績, 落札価格).",
      "    2) Active listings of identical card (販売中価格, 出品価格). Clearly distinguish from sold transactions.",
      "    3) Comparable market evidence / historical sales.",
      "  - Always report numeric market pricing found in JPY, dates, and sources so a draft proposal can be made for staff review. Do not leave empty if market information exists.",
      "Step 4. TITLE FORMULA: Format as '{card_name} [{set_code} {card_number}] {set_name}' (or '[PSA10] {card_name} [{set_code} {card_number}] {set_name}' if graded). If set_code is NONE, format as '{card_name} [{card_number}] {set_name}'. If card_number is also NONE, format as '{card_name} {set_name}'. NEVER include rarity in title. NEVER prepend 'ポケモンカードゲーム'.",
      ""
    );
  } else if (isSneaker) {
    stageAPromptLines.push(
      "TASK INSTRUCTIONS FOR SNEAKER IDENTIFICATION & PRICING:",
      "Step 1. PHYSICAL LABEL & TAG CHECK: Inspect all images carefully, including shoe appearance, shoe box barcode label, and inner size tags.",
      "  - PHYSICAL_BOX_LABEL_SKU: Exact SKU / style code legible on shoe box label or barcode sticker (e.g. IB4481-500, DZ5485-612). If a box label is visible, transcribe the printed style code. If not visible or unreadable, write NONE.",
      "  - PHYSICAL_INNER_TAG_SIZE: Exact size legible on inner tag or shoe box label (e.g. 27.5cm / US 9.5). If not visible or unreadable, write NONE.",
      "  - VISUAL_APPEARANCE: Silhouette, colorway, overlays, materials, logos, distinct emblems.",
      "Step 2. WEB SEARCH & VERIFICATION: Use Google Search to cross-reference design details and find official model name and colorway. Note: searched style codes must be treated as inferred candidates, NOT physical label SKU.",
      "Step 3. PRICE GROUNDING: Search for recent market pricing in JPY for this exact model. Priority: (1) Recent verified sold transactions, (2) Active listings of identical item, (3) Comparable model transactions if size is unconfirmed. Report prices, dates, and sources. Do not leave empty if market information exists.",
      "Step 4. CANDIDATE PROPOSAL: Propose official Japanese and English product titles.",
      ""
    );
  } else if (isApparelOrFashion || isJewelry || isOtherCategory) {
    const catHeading = isApparelOrFashion
      ? `APPAREL / FASHION GOODS (${normCategory})`
      : isJewelry
        ? "JEWELRY (jewelry)"
        : "GENERAL MERCHANDISE (other)";
    stageAPromptLines.push(
      `TASK INSTRUCTIONS FOR ${catHeading} IDENTIFICATION & PRICING:`,
      "Step 1. PHYSICAL TAG, LABEL & HALLMARK CHECK: Inspect all images carefully, including garment/product appearance, neck/care tags, hangtags, box labels, or metal hallmarks/engravings.",
      "  - PHYSICAL_BOX_LABEL_SKU: Exact official model number / style code / item code legible on product tag, care label, or box label. If not visible or unreadable, write NONE.",
      "  - PHYSICAL_INNER_TAG_SIZE: Exact size notation legible on neck tag, care label, or product tag (e.g. S, M, L, XL, 46, FREE). If not visible or unreadable, write NONE.",
      "  - CARE_TAG_SPECS: For apparel/garments, transcribe material composition (素材), country of origin (原産国, e.g. MADE IN ...), and any visibly included accessories (付属品) ONLY if directly legible in the photos; otherwise write NONE. Do NOT mistake paper dry-cleaning/shop tags for brand tags, and NEVER assume 'Chrome Hearts' without direct garment tag/logo/hallmark proof.",
      "  - VISUAL_APPEARANCE: Brand logos, garment/item type, colorway, design details, and visible condition (do NOT assert unseen back/interior areas or invent flat measurements).",
      "Step 2. WEB SEARCH & VERIFICATION: Use Google Search to cross-reference visible tags, model numbers, brand, and design details to identify the official product name, collaboration, collection/season, and confirmed official specifications.",
      "Step 3. PRICE GROUNDING: Search for recent market pricing in JPY for this exact item (or closest comparable model). Priority: (1) Recent verified sold transactions, (2) Active listings of identical item, (3) Comparable model transactions. Report numeric prices in JPY, dates, and sources.",
      "Step 4. CANDIDATE PROPOSAL: For apparel, propose a concise English-first title ('[Brand] [× Collaboration] [Model or Item Type] [Color] [Size]' using ONLY confirmed elements; do not guess unconfirmed brand/model) and factual description ingredients. Missing tags or single front-only images must NOT cause failure—simply record unconfirmed items under UNCONFIRMED_FIELDS.",
      ""
    );
  } else {
    stageAPromptLines.push(
      "TASK INSTRUCTIONS (Category Unconfirmed - Objective Physical Inspection):",
      "Step 1. VISIBLE TEXT & MARKS: Transcribe and describe any text, numbers, words, or distinct emblems directly visible on the product, box, labels, tags, or materials.",
      "  - PHYSICAL_BOX_LABEL_SKU: If a shoe box label or product tag with style code / SKU is visible, transcribe it here (e.g. IB4481-500). If not visible, write NONE.",
      "  - PHYSICAL_INNER_TAG_SIZE: If a size tag or box label with size is visible, transcribe it here (e.g. 27.5cm / US 9.5, or S / M / L / XL). If not visible, write NONE.",
      "  - If the item is apparel/clothing, also note any legible material (素材), country of origin (原産国), or photographed accessories (付属品), write NONE if unseen, distinguish paper dry-cleaning tags from garment brand tags, and NEVER assume 'Chrome Hearts' without direct tag/logo proof.",
      "Step 2. VISUAL APPEARANCE: Describe the product silhouette, color scheme, upper/body materials, overlays, and structural characteristics (only what is visible in the photos).",
      "Step 3. WEB SEARCH & VERIFICATION: Based on the visible text and appearance described above, actively use Google Search to search for candidate product models, official edition/collaboration names, and colorways.",
      "Step 4. PRICE GROUNDING: Search for recent sold transactions, active listings, or comparable model prices for this item in JPY. Report prices, dates, and sources.",
      ""
    );
  }

  if (!isCategoryMismatch && safeBrand && !/^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(safeBrand)) {
    stageAPromptLines.push(`Brand constraint: ${safeBrand}`);
  }
  if (!isCategoryMismatch && safeCategory && !/^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(safeCategory)) {
    stageAPromptLines.push(`Category: ${safeCategory}`);
  }
  if (isCategoryMismatch) {
    stageAPromptLines.push(
      "NOTE: Category conflict detected between metadata and images. Conduct objective neutral inspection without assuming category."
    );
  }
  stageAPromptLines.push(
    "",
    "Format your response strictly using the following section headers:",
    isPokemonCard ? "### OBSERVED_CARD_ATTRIBUTES" : isSneaker ? "### OBSERVED_SNEAKER_ATTRIBUTES" : "### OBSERVED_FEATURES",
    "(Detailed transcription of directly legible card text or shoe tags. Write NONE for unreadable fields)",
    "",
    "### SEARCH_FINDINGS",
    "(Web search findings, official corroborated expansion/model name)",
    "",
    "### PRICING_EVIDENCE",
    "(Recent sold/completed transactions found with prices in JPY, dates, sources. If sold transactions are unavailable, search and report active listing/asking prices of identical items with sources, clearly distinguished from sold)",
    "",
    "### UNCONFIRMED_FIELDS",
    "(Explicit list of missing, obscured, or unverified attributes that staff must review)",
    "",
    "CRITICAL RULES:",
    "- Existing product name and SKU are intentionally NOT provided. Identify purely from visual cues and web search.",
    "- Do NOT guess or hallucinate text that is not visible. Only write text you can see in the image.",
    "- Do NOT treat search-discovered SKUs as physical SKUs. Only confirm an SKU if directly legible from a physical label in the image.",
    "- For Pokémon cards, title must NOT prepend 'ポケモンカードゲーム'. Format: '{card_name} [{set_code} {card_number}] {set_name}' (or '[PSA10] {card_name} [{set_code} {card_number}] {set_name}' if graded). If set_code or card_number is missing, do NOT output empty brackets.",
    "- For Pokémon cards, if back side is not visible, explicitly state that condition is unconfirmed."
  );

  const stageAPrompt = stageAPromptLines.join("\n");

  const stageAParts = [{ text: stageAPrompt }];
  images.forEach(img => {
    stageAParts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    });
  });

  const stageAGenConfig = {
    temperature: 0.2,
    maxOutputTokens: 4096 // TMP-000102 で確認された思考トークン消費による MAX_TOKENS 打ち切りを防ぐため 4096 を適用
  };

  if (options.thinking_level) {
    stageAGenConfig.thinkingConfig = {
      thinkingLevel: String(options.thinking_level).toUpperCase()
    };
  }

  const stageAPayload = {
    contents: [{ role: "user", parts: stageAParts }],
    tools: [{ google_search: {} }],
    generationConfig: stageAGenConfig
  };

  const stageAStart = Date.now();
  let stageARes;
  let stageACode = 0;
  let stageABody = "";

  try {
    stageARes = await postGeminiGenerateContent({
      fetchImpl,
      modelName,
      apiKey,
      payload: stageAPayload,
    });
    stageACode = stageARes.statusCode;
    stageABody = stageARes.bodyText;
  } catch (sAErr) {
    const err = new Error(`[AI Draft Two-Stage: Stage A] Network exception: ${sAErr.message}`);
    err.error_code = "LLM_COMMUNICATION_FAILED";
    throw err;
  }
  const stageAElapsed = Date.now() - stageAStart;

  if (stageACode !== 200) {
    let errDetail = { code: stageACode, status: "UNKNOWN", message: "" };
    try {
      const errJson = JSON.parse(stageABody);
      if (errJson && errJson.error) {
        errDetail.code = errJson.error.code || stageACode;
        errDetail.status = errJson.error.status || "UNKNOWN";
        errDetail.message = String(errJson.error.message || "").replace(/key=[^&\s]+/gi, "key=[REDACTED]");
      }
    } catch (_) {
      errDetail.message = stageABody.substring(0, 300);
    }
    const err = new Error(`[AI Draft Two-Stage: Stage A] HTTP ${stageACode}: ${errDetail.message}`);
    err.error_code = `LLM_HTTP_ERROR_${stageACode}`;
    err.status_code = stageACode;
    err.error_details = errDetail;
    throw err;
  }

  let stageAParsed;
  try {
    stageAParsed = JSON.parse(stageABody);
  } catch (jErr) {
    const err = new Error("[AI Draft Two-Stage: Stage A] Invalid JSON response");
    err.error_code = "LLM_COMMUNICATION_FAILED";
    throw err;
  }

  const stageACand = stageAParsed.candidates && stageAParsed.candidates[0];
  if (!stageACand) {
    const err = new Error("[AI Draft Two-Stage: Stage A] No candidate returned by LLM");
    err.error_code = "EMPTY_LLM_RESPONSE";
    throw err;
  }

  const stageAFinishReason = stageACand.finishReason || "";
  if (stageAFinishReason === "MAX_TOKENS") {
    const err = new Error("[AI Draft Two-Stage: Stage A] Output truncated due to MAX_TOKENS limit");
    err.error_code = "STAGE_A_MAX_TOKENS";
    err.finish_reason = stageAFinishReason;
    throw err;
  }

  const stageAGrounding = extractGroundingMetadata_(stageACand);
  if (!stageAGrounding.queries || stageAGrounding.queries.length === 0) {
    const err = new Error("[AI Draft Two-Stage: Stage A] Web search was not executed by model (0 queries generated)");
    err.error_code = "SEARCH_GROUNDING_NOT_EXECUTED";
    err.finish_reason = stageAFinishReason;
    throw err;
  }

  if (!stageAGrounding.sources || stageAGrounding.sources.length === 0) {
    const err = new Error(`[AI Draft Two-Stage: Stage A] Search queries were generated (${stageAGrounding.queries.length}) but 0 grounding sources returned`);
    err.error_code = "SEARCH_GROUNDING_NO_SOURCES";
    err.finish_reason = stageAFinishReason;
    throw err;
  }

  const stageANonThought = stageACand.content && Array.isArray(stageACand.content.parts)
    ? stageACand.content.parts.filter(p => !p.thought && typeof p.text === "string" && p.text.trim().length > 0)
    : [];
  const stageAText = stageANonThought.length > 0
    ? stageANonThought.map(p => p.text).join("\n")
    : (stageACand.content && Array.isArray(stageACand.content.parts) ? stageACand.content.parts.map(p => p.text || "").join("\n") : "");

  if (!stageAText || !stageAText.trim()) {
    const err = new Error("[AI Draft Two-Stage: Stage A] Empty response text returned by LLM");
    err.error_code = "STAGE_A_EMPTY_RESPONSE";
    err.finish_reason = stageAFinishReason;
    throw err;
  }

  const stageAUsage = stageAParsed.usageMetadata || {};

  // --------------------------------------------------
  // Stage B: 検索結果を取り込んだ構造化ドラフト生成 (toolsなし)
  // --------------------------------------------------
  const stageBPromptLines = [
    "Analyze the attached product images, metadata, and the following research findings from Google Search and visual verification to generate listing draft candidates:",
    `- Product ID: ${productMeta.productId}`
  ];
  if (!isCategoryMismatch && safeCategory) {
    stageBPromptLines.push(`- Category constraint: ${safeCategory}`);
  }
  if (!isCategoryMismatch && safeBrand) {
    stageBPromptLines.push(`- Brand constraint: ${safeBrand}`);
  }
  if (isCategoryMismatch) {
    stageBPromptLines.push("- NOTE: Category conflict detected between metadata and image observations. Do NOT enforce existing category/brand constraint.");
  }
  const parsedStageA = parseStageASections_(stageAText);

  // Stage A からの価格検出確認
  let stageAPriceInfo = extractPriceFromStageAText_(
    parsedStageA.pricingText,
    parsedStageA.searchText,
    stageAGrounding && stageAGrounding.sources
  );

  let dedicatedSearchExecuted = false;
  let dedicatedSearchQuery = "";
  let dedicatedSearchResult = null;

  // 価格情報が未検出の場合、特定された識別情報（カード番号/レアリティ、または靴のSKU/サイズ）を用いて価格に絞った追加検索（最大1回）を実行
  const queryContext = {
    category: isPokemonCard ? "pokemon_card" : isSneaker ? "sneaker" : normCategory,
    cardName: parsedStageA.observedFields.card_name || parsedStageA.extractedFields.card_name,
    setCode: parsedStageA.observedFields.set_code || parsedStageA.extractedFields.set_code,
    cardNumber: parsedStageA.observedFields.card_number || parsedStageA.extractedFields.card_number,
    rarity: parsedStageA.observedFields.rarity || parsedStageA.extractedFields.rarity,
    brand: safeBrand || (isPokemonCard ? "Pokemon Card Game" : isSneaker ? "NIKE" : ""),
    sku: parsedStageA.observedFields.box_label_sku || parsedStageA.searchDerivedFields.style_code,
    size: parsedStageA.observedFields.inner_tag_size,
    titleJa: parsedStageA.searchDerivedFields.corroborated_model || productMeta.productName
  };

  const hasSpecificIdentity = (
    (isPokemonCard && Boolean(queryContext.cardName && (queryContext.cardNumber || queryContext.setCode || queryContext.rarity))) ||
    (isSneaker && Boolean(queryContext.sku || (queryContext.brand && queryContext.size))) ||
    (!isPokemonCard && !isSneaker && Boolean(queryContext.titleJa || queryContext.sku || queryContext.brand))
  );

  if (!stageAPriceInfo && hasSpecificIdentity) {
    console.log(`[AI Draft Dedicated Price Search] Stage Aで価格未検出のため、特定された識別情報で追加価格検索を開始...`);
    dedicatedSearchResult = await fetchDedicatedPriceSearch_(queryContext, apiKey, modelName, fetchImpl);
    if (dedicatedSearchResult && dedicatedSearchResult.pricingText) {
      dedicatedSearchExecuted = true;
      dedicatedSearchQuery = dedicatedSearchResult.query;
      console.log(`[AI Draft Dedicated Price Search] 追加価格検索完了 (${dedicatedSearchResult.elapsedMs}ms, query='${dedicatedSearchQuery}'):\n${dedicatedSearchResult.pricingText.substring(0, 200)}...`);

      // 検索結果を parsedStageA.pricingText に統合
      parsedStageA.pricingText = [
        parsedStageA.pricingText,
        `### DEDICATED PRICE SEARCH FINDINGS (${dedicatedSearchQuery}):`,
        dedicatedSearchResult.pricingText
      ].filter(Boolean).join("\n\n");

      // 参照元ソースを一意に統合
      if (Array.isArray(dedicatedSearchResult.sources) && dedicatedSearchResult.sources.length > 0) {
        dedicatedSearchResult.sources.forEach(src => {
          if (src && src.url && !stageAGrounding.sources.some(s => s && s.url === src.url)) {
            stageAGrounding.sources.push(src);
          }
        });
      }

      // 追加検索結果から再度価格抽出を試行
      stageAPriceInfo = extractPriceFromStageAText_(
        parsedStageA.pricingText,
        parsedStageA.searchText,
        stageAGrounding && stageAGrounding.sources
      );
    }
  }

  stageBPromptLines.push(
    "",
    "=== DIRECT PHYSICAL IDENTIFIERS FROM STAGE A (OBSERVED FROM IMAGES ONLY) ===",
    `- Observed Card Name: ${parsedStageA.observedFields.card_name || "(none/unconfirmed)"}`,
    `- Observed Set Code: ${parsedStageA.observedFields.set_code || "(none/unconfirmed)"}`,
    `- Observed Card Number: ${parsedStageA.observedFields.card_number || "(none/unconfirmed)"}`,
    `- Observed Rarity: ${parsedStageA.observedFields.rarity || "(none/unconfirmed)"}`,
    `- Observed Box Label SKU: ${parsedStageA.observedFields.box_label_sku || "(none/unconfirmed)"}`,
    `- Observed Inner Tag Size: ${parsedStageA.observedFields.inner_tag_size || "(none/unconfirmed)"}`,
    "===========================================================================",
    "",
    "=== SEARCH-DERIVED CORROBORATIONS FROM STAGE A (NOT VISIBLE ON PHYSICAL PRODUCT) ===",
    `- Inferred / Corroborated Style Code from Search: ${parsedStageA.searchDerivedFields.style_code || "(none/unconfirmed)"}`,
    `- Corroborated Model: ${parsedStageA.searchDerivedFields.corroborated_model || "(none/unconfirmed)"}`,
    `- Corroborated Colorway: ${parsedStageA.searchDerivedFields.corroborated_colorway || "(none/unconfirmed)"}`,
    "====================================================================================",
    "",
    "=== STRUCTURED RESEARCH & OBSERVATION FINDINGS FROM STAGE A ===",
    "--- 1. DIRECT PHYSICAL OBSERVATIONS (FROM IMAGES ONLY) ---",
    parsedStageA.observedText,
    "----------------------------------------------------------",
    "",
    "--- 2. EXTERNAL SEARCH CORROBORATIONS -------------------",
    parsedStageA.searchText,
    "----------------------------------------------------------",
    "",
    "--- 3. PRICING TRANSACTIONS (RECENT MARKET EVIDENCE) -----",
    parsedStageA.pricingText,
    "----------------------------------------------------------",
    "",
    "--- 4. UNCONFIRMED ATTRIBUTES (FLAG IN needs_review) ------",
    parsedStageA.unconfirmedText,
    "----------------------------------------------------------",
    "===========================================================",
    "",
    "Rules:",
    "1. CATEGORY & BRAND NORMALIZATION:",
    "   - category: must be one of 'pokemon_card', 'sneaker', 'apparel', 'fashion_goods', 'jewelry', 'other'. If a Category constraint is provided above, strictly keep that category. If image is unconfirmed, output empty string (\"\").",
    "   - brand: for pokemon_card, always output 'Pokemon Card Game'. For sneaker, apparel, fashion_goods, jewelry, output canonical brand ONLY when confirmed from garment/product tags, logos, or Brand constraint (e.g. 'NIKE', 'JORDAN', 'adidas', 'New Balance', 'Supreme', 'Stussy', 'GUCCI', 'TIFFANY & CO.'); if unconfirmed, output empty string (\"\"). NEVER assume or default to 'Chrome Hearts' from motifs or paper cleaning tags.",
    "2. MANDATORY USE OF STAGE A IDENTIFIERS FOR PRODUCT NAME & DETAIL FIELDS:",
    "   - For Pokémon cards:",
    "     * pokemon_card.card_name: strictly adopt 'Observed Card Name' (or visual card name).",
    "     * pokemon_card.set_code: strictly adopt 'Observed Set Code'. Do NOT replace with guessed set codes.",
    "     * pokemon_card.card_number: strictly adopt 'Observed Card Number'. Do NOT change to other numbers.",
    "     * pokemon_card.rarity: strictly adopt 'Observed Rarity'.",
    "     * title_ja strictly follows manual registration sample: '{card_name} [{set_code} {card_number}] {set_name}' (or '[PSA10] {card_name} [{set_code} {card_number}] {set_name}' if graded).",
    "       If set_code is unconfirmed, format as '{card_name} [{card_number}] {set_name}'. If card_number is also unconfirmed, format as '{card_name} {set_name}' (NEVER create empty brackets '[]' or '[undefined]').",
    "       NEVER include 'ポケモンカードゲーム' in title_ja. NEVER include rarity in the title (rarity belongs exclusively to pokemon_card.rarity).",
    "   - For sneakers:",
    "     * sku: If 'Observed Box Label SKU' is visible, format into standard SKU (e.g. 'IB4481 500' -> 'IB4481-500') and adopt directly. If box label is unconfirmed/missing, but official style code is corroborated from web search findings, output that style code into sku as a candidate, and flag 'sku' in needs_review with note. If no style code is found, output \"\" and flag 'sku' in needs_review.",
    "     * size: Extract the Japanese cm size (e.g. '25.5cm', '27.0cm') from observed box label or inner tag rather than dumping the entire label text. If not observed, output size: \"\" and flag 'size' in needs_review.",
    "     * title_ja / title_en: adopt the official corroborated model and colorway name from search findings.",
    "   - For apparel (category 'apparel', or clothing/garment items even when category is 'other' or unconfirmed):",
    "     * title_ja & title_en: Write principally in English, concisely arranging ONLY confirmed elements in natural order: '[Brand] [× Collaboration] [Model or Item Type] [Color] [Size]' (format illustration only: 'SUPREME × HONDA HRC RACING JACKET S' — NEVER copy example brands, models, or sizes).",
    "     * If brand or official model is unconfirmed, do NOT guess or fabricate them; build a concise English title from confirmed visual appearance, garment/item type, and color (plus size ONLY if confirmed). Append concise Japanese to title_ja ONLY when English alone would be hard to understand. Keep title_en strictly English.",
    "     * sku / size: Output ONLY values confirmed from physical garment tags or registered metadata; otherwise output \"\" and include in needs_review. Do NOT fail generation when tags or attributes are missing.",
    "3. DESCRIPTION RULES:",
    "   - For Pokémon cards: concise and factual (e.g. '拡張パック『30th CELEBRATION』収録のミュウexです。カード1枚での販売です。'). Do NOT make unverified claims of mint condition ('白かけなし' etc.) unless back view was inspected.",
    "   - For apparel (category 'apparel', or clothing/garment items even when category is 'other' or unconfirmed): format description_ja strictly in the following 1-to-5 order, omitting any unconfirmed item rather than guessing or borrowing example wording/values:",
    "     1) Confirmed brand/model and concise item overview (if brand/model is unconfirmed, describe only the confirmed garment type/appearance).",
    "     2) Design features directly visible in the actual product photos.",
    "     3) Condition and signs of wear visible in the photos (NEVER assert condition of unphotographed areas such as unseen back side, interior, or tags).",
    "     4) Spec lines using ONLY '【サイズ】', '【素材】', '【原産国】', '【付属品】' — include ONLY items confirmed from physical garment tags, registered data, or reliable official info for a confirmed model. Include flat measurements (実寸) ONLY when actual measured data is provided (NEVER estimate from photos or copy catalog charts). Completely OMIT any unconfirmed '【...】' header/line.",
    "     5) Concise necessary notes (only if needed) at the end of description_ja, and output a small number (2–5) of relevant hashtags in hashtags_ja based only on confirmed attributes (do NOT embed hashtags inside description_ja).",
    "   - Do NOT include hashtag clutter in description.",
    "   - NEVER write claims or sentences about authenticity or guarantees (e.g. '正規品', '本物保証', '真贋鑑定済', 'Authentic', 'Genuine', '100% Original'). Preserve formal product names, brand names, card editions, and PSA grades.",
    "   - For apparel and sneakers/shoes, evaluate condition assuming post-cleaning appearance: propose '目立った傷や汚れなし' as the standard good used condition unless obvious scratches, prominent stains, or structural damage are visible (in which case reflect them as 'やや傷や汚れあり' or '傷や汚れあり'). Do NOT over-penalize minor wear. Do NOT set '新品・未使用' without clear objective basis (such as attached retail tags / unworn proof). NEVER automatically write boilerplate like 'クリーニング済み' in descriptions.",
    "4. PRICING RULES (STRICT PRIORITY: 1. Sold Transactions > 2. Active Listings > 3. Unknown Transaction Type Market Reference > 4. Comparable Model):",
    "   - ALWAYS propose a numeric price whenever pricing/market info is found. Do NOT leave price as null when active listings or market data exists.",
    "   - If sold transaction details are missing or incomplete, MUST use active listing prices of the identical product as numeric reference price (price_basis: 'active_listing_reference', price_type: 'active'). NEVER call active listing prices '成約'!",
    "   - Priority order:",
    "     1. Recent sold transactions (成約): price_type: 'sold', price_basis: 'recent_sold_provisional', propose numeric price.",
    "     2. Active listings of identical item (販売中): price_type: 'active', price_basis: 'active_listing_reference', propose numeric price.",
    "     3. Evidence where transaction type (sold vs active) is unknown (根拠種別不明): price_type: 'unknown', price_basis: 'market_reference_proposal', propose numeric price as '市場参考価格案'. Clearly state what is unconfirmed in price_note. NEVER call it '成約'!",
    "     4. Comparable model transactions if size is unconfirmed (同一モデル比較): item_match_condition: 'comparable_model', price_basis: 'comparable_model_reference', propose numeric price.",
    "   - Populate price_evidence with: { source_url, price_type ('sold'|'active'|'unknown'), amount (number in JPY), currency: 'JPY', transaction_date (YYYY-MM-DD or YYYY-MM), item_match_condition ('exact_match'|'comparable_model'), verification_status: 'unverified' }.",
    "   - In price_note, clearly describe the evidence type (成約取引 / 販売中出品 / 市場参考価格案 / 同一モデル比較), reference URL, date found, amount adopted, and calculation method.",
    "   - Do NOT duplicate identical URLs without distinct transaction info. Output price: null ONLY in exceptional cases where the product itself cannot be identified or no market price exists anywhere.",
    "5. POKEMON CARD OBJECT (if pokemon_card):",
    "   - Populate pokemon_card: { card_name, set_code, set_name, card_number, rarity, language, grading_status, grader, grade, certification_number, card_condition }.",
    "   - If ungraded: grading_status: 'ungraded', grader: '', grade: '', cert: '', card_condition: 'A' (default draft) or 'B'/'C' (if clear visible flaws or wear).",
    "   - If graded: grading_status: 'graded', grader: (e.g. 'PSA'), grade: (e.g. '10'), card_condition: ''.",
    "Return valid JSON adhering to the response schema strictly."
  );

  const stageBPrompt = stageBPromptLines.join("\n");

  const stageBParts = [{ text: stageBPrompt }];
  images.forEach(img => {
    stageBParts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    });
  });

  const stageBPayload = {
    contents: [{ role: "user", parts: stageBParts }],
    systemInstruction: {
      parts: [{ text: buildSearchGroundingSystemInstruction_() }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: buildAiDraftResponseSchema_(),
      temperature: 0.2,
      maxOutputTokens: 4096
    }
  };

  const stageBStart = Date.now();
  let stageBRes;
  let stageBCode = 0;
  let stageBBody = "";

  try {
    stageBRes = await postGeminiGenerateContent({
      fetchImpl,
      modelName,
      apiKey,
      payload: stageBPayload,
    });
    stageBCode = stageBRes.statusCode;
    stageBBody = stageBRes.bodyText;
  } catch (sBErr) {
    const err = new Error(`[AI Draft Two-Stage: Stage B] Network exception: ${sBErr.message}`);
    err.error_code = "LLM_COMMUNICATION_FAILED";
    err.stage_a_text = stageAText;
    err.stage_a_grounding = stageAGrounding;
    err.parsed_stage_a = parsedStageA;
    throw err;
  }
  const stageBElapsed = Date.now() - stageBStart;

  if (stageBCode !== 200) {
    let errDetail = { code: stageBCode, status: "UNKNOWN", message: "" };
    try {
      const errJson = JSON.parse(stageBBody);
      if (errJson && errJson.error) {
        errDetail.code = errJson.error.code || stageBCode;
        errDetail.status = errJson.error.status || "UNKNOWN";
        errDetail.message = String(errJson.error.message || "").replace(/key=[^&\s]+/gi, "key=[REDACTED]");
      }
    } catch (_) {
      errDetail.message = stageBBody.substring(0, 300);
    }
    const err = new Error(`[AI Draft Two-Stage: Stage B] HTTP ${stageBCode}: ${errDetail.message}`);
    err.error_code = `LLM_HTTP_ERROR_${stageBCode}`;
    err.status_code = stageBCode;
    err.error_details = errDetail;
    err.stage_a_text = stageAText;
    err.stage_a_grounding = stageAGrounding;
    err.parsed_stage_a = parsedStageA;
    throw err;
  }

  let stageBParsed;
  try {
    stageBParsed = JSON.parse(stageBBody);
  } catch (jErr) {
    const err = new Error("[AI Draft Two-Stage: Stage B] Invalid JSON response");
    err.error_code = "STRUCTURED_PARSE_FAILED";
    err.stage_a_text = stageAText;
    err.stage_a_grounding = stageAGrounding;
    err.parsed_stage_a = parsedStageA;
    err.stage_b_diagnostics = {
      finish_reason: "BODY_PARSE_ERROR",
      usage: {},
      output_length: stageBBody.length,
      output_head: stageBBody.substring(0, 300),
      output_tail: stageBBody.length > 500 ? stageBBody.substring(stageBBody.length - 500) : stageBBody,
      parse_error: jErr.message
    };
    throw err;
  }

  const stageBCand = stageBParsed.candidates && stageBParsed.candidates[0];
  if (!stageBCand || !stageBCand.content || !stageBCand.content.parts || stageBCand.content.parts.length === 0) {
    const err = new Error("[AI Draft Two-Stage: Stage B] Empty content returned by LLM");
    err.error_code = "EMPTY_LLM_RESPONSE";
    err.stage_a_text = stageAText;
    err.stage_a_grounding = stageAGrounding;
    err.parsed_stage_a = parsedStageA;
    err.stage_b_diagnostics = {
      finish_reason: (stageBCand && stageBCand.finishReason) || "EMPTY_PARTS",
      usage: stageBParsed.usageMetadata || {},
      output_length: 0,
      output_head: "",
      output_tail: "",
      parse_error: "Empty content returned by LLM"
    };
    throw err;
  }

  const stageBFinishReason = (stageBCand && stageBCand.finishReason) || "UNKNOWN";
  const stageBUsage = stageBParsed.usageMetadata || {};

  const bNonThought = stageBCand.content.parts.filter(p => !p.thought && typeof p.text === "string" && p.text.trim().length > 0);
  const bRawText = bNonThought.length > 0
    ? bNonThought.map(p => p.text).join("")
    : stageBCand.content.parts.filter(p => typeof p.text === "string").map(p => p.text).join("");

  let cleanJsonText = bRawText.trim();
  // Markdown コードブロックの除去 (```json ... ``` または ``` ... ```)
  if (/^```(?:json)?/i.test(cleanJsonText)) {
    cleanJsonText = cleanJsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  let bRawJson;
  try {
    bRawJson = JSON.parse(cleanJsonText);
  } catch (pErr) {
    const diagInfo = {
      finish_reason: stageBFinishReason,
      usage: stageBUsage,
      output_length: cleanJsonText.length,
      output_head: cleanJsonText.substring(0, 300),
      output_tail: cleanJsonText.length > 500 ? cleanJsonText.substring(cleanJsonText.length - 500) : cleanJsonText,
      parse_error: pErr.message
    };
    console.error(`[AI Draft Two-Stage: Stage B] Structured JSON parse failed! finishReason: ${stageBFinishReason}, usage: ${JSON.stringify(stageBUsage)}, len: ${cleanJsonText.length}`);
    console.error(`[AI Draft Two-Stage: Stage B Output Tail]: ${diagInfo.output_tail}`);

    const err = new Error(`[AI Draft Two-Stage: Stage B] Failed to parse structured output (${pErr.message}, finishReason: ${stageBFinishReason})`);
    err.error_code = "STRUCTURED_PARSE_FAILED";
    err.stage_b_diagnostics = diagInfo;
    err.stage_a_text = stageAText;
    err.stage_a_grounding = stageAGrounding;
    err.parsed_stage_a = parsedStageA;
    throw err;
  }

  const candidate = validateAndSanitizeDraftCandidate_(bRawJson, {
    image_count: images.length,
    has_back_image: Boolean(options && options.has_back_image),
    productMeta: isCategoryMismatch ? {} : productMeta,
    is_category_mismatch: isCategoryMismatch
  });
  candidate.actual_model_name = modelName;

  // 先行分類で未判定（一時パースエラー等）だった場合でも、Stage A/B の推論結果からカテゴリを救済
  // 登録済みカテゴリ (normCategory) がある場合はそれを最優先して candidate.category に固定する
  let effectiveCategory = normCategory;
  if (effectiveCategory && !isCategoryMismatch) {
    candidate.category = effectiveCategory;
  } else if (!effectiveCategory && !isCategoryMismatch) {
    if (AI_DRAFT_CONFIG.ALLOWED_CATEGORIES.indexOf(candidate.category) !== -1) {
      effectiveCategory = candidate.category;
    } else if (parsedStageA.extractedFields.style_code || parsedStageA.extractedFields.box_label_sku) {
      effectiveCategory = "sneaker";
      candidate.category = "sneaker";
    } else if (parsedStageA.extractedFields.card_number || parsedStageA.extractedFields.card_name) {
      effectiveCategory = "pokemon_card";
      candidate.category = "pokemon_card";
    }
  }

  const effectiveIsPokemonCard = effectiveCategory === "pokemon_card";
  const effectiveIsSneaker = effectiveCategory === "sneaker";
  const effectiveIsApparelOrFashion = effectiveCategory === "apparel" || effectiveCategory === "fashion_goods";

  // Stage A 直接視認値（Ground Truth）の各個別欄への厳格バインド (自由文からの推測混入を物理遮断)
  if (effectiveIsPokemonCard && candidate.pokemon_card) {
    if (parsedStageA.observedFields.card_name && !candidate.pokemon_card.card_name) {
      candidate.pokemon_card.card_name = parsedStageA.observedFields.card_name;
    }
    if (parsedStageA.observedFields.set_code) {
      candidate.pokemon_card.set_code = parsedStageA.observedFields.set_code;
    }
    if (parsedStageA.observedFields.card_number) {
      candidate.pokemon_card.card_number = parsedStageA.observedFields.card_number;
    }
    if (parsedStageA.observedFields.rarity) {
      candidate.pokemon_card.rarity = parsedStageA.observedFields.rarity;
    }
    candidate.title_ja = sanitizePokemonCardTitle_(candidate.title_ja, candidate.pokemon_card);
  } else if (effectiveIsSneaker) {
    if (parsedStageA.observedFields.box_label_sku) {
      // 写真の箱ラベルから直接読んだSKU
      candidate.sku = normalizeSneakerSku_(parsedStageA.observedFields.box_label_sku);
      candidate.sku_source = "box_label";
      candidate.raw_box_label_sku = parsedStageA.observedFields.raw_box_label_sku || parsedStageA.observedFields.box_label_sku;
      // 箱ラベル直接視認時は needs_review から sku を除去
      if (Array.isArray(candidate.needs_review)) {
        candidate.needs_review = candidate.needs_review.filter(f => f !== "sku" && f !== "sku_model_mismatch");
      }
    } else {
      // 箱ラベル未撮影時: Stage A検索またはStage B推論で確認された型番候補（IB4481-500等）を提示
      const rawCorroboratedSku = parsedStageA.searchDerivedFields.style_code || candidate.sku;
      let adoptedSku = "";
      let skuSource = "unconfirmed";

      if (rawCorroboratedSku) {
        // 型番候補を採用する前に、検索対象の商品名／モデルと型番が同一商品を指しているか検証
        const matchCheck = verifySneakerModelSkuMatch_(
          candidate.title_ja + " " + (candidate.title_en || ""),
          rawCorroboratedSku,
          { searchText: parsedStageA.searchText, searchDerivedFields: parsedStageA.searchDerivedFields }
        );

        if (matchCheck.matched) {
          adoptedSku = normalizeSneakerSku_(rawCorroboratedSku);
          skuSource = "search_corroborated";
          // 出典の明記: 説明文に注記を追加（二重追加防止）
          if (candidate.description_ja && candidate.description_ja.indexOf("推定候補") === -1) {
            candidate.description_ja += `\n\n※型番（${adoptedSku}）は画像検索に基づく推定候補です。実物の箱ラベルまたは内タグをご確認ください。`;
          }
          console.log(`[AI Draft SKU Protection] 検索由来の推定型番 '${adoptedSku}' をドラフト候補として提示（needs_review: sku付き）`);
        } else {
          // 不一致時は自動反映を防ぎ棄却（不採用）
          console.warn(`[AI Draft SKU Mismatch Rejected] ${matchCheck.reason}`);
          if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
          if (candidate.needs_review.indexOf("sku_model_mismatch") === -1) {
            candidate.needs_review.push("sku_model_mismatch");
          }
        }
      }

      candidate.sku = adoptedSku;
      candidate.sku_source = skuSource;
      if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
      if (candidate.needs_review.indexOf("sku") === -1) candidate.needs_review.push("sku");
    }
    if (parsedStageA.observedFields.inner_tag_size) {
      candidate.size = normalizeSneakerSize_(parsedStageA.observedFields.inner_tag_size);
      candidate.raw_inner_tag_size = parsedStageA.observedFields.raw_inner_tag_size || parsedStageA.observedFields.inner_tag_size;
      if (Array.isArray(candidate.needs_review)) {
        candidate.needs_review = candidate.needs_review.filter(f => f !== "size");
      }
    }
  } else if (effectiveIsApparelOrFashion) {
    if (parsedStageA.observedFields.box_label_sku) {
      candidate.sku = String(parsedStageA.observedFields.box_label_sku).trim();
      candidate.sku_source = "box_label";
      candidate.raw_box_label_sku = parsedStageA.observedFields.raw_box_label_sku || parsedStageA.observedFields.box_label_sku;
      if (Array.isArray(candidate.needs_review)) {
        candidate.needs_review = candidate.needs_review.filter(f => f !== "sku");
      }
    }
    if (parsedStageA.observedFields.raw_inner_tag_size || parsedStageA.observedFields.inner_tag_size) {
      candidate.size = String(parsedStageA.observedFields.raw_inner_tag_size || parsedStageA.observedFields.inner_tag_size).trim();
      candidate.raw_inner_tag_size = candidate.size;
      if (Array.isArray(candidate.needs_review)) {
        candidate.needs_review = candidate.needs_review.filter(f => f !== "size");
      }
    }
  }

  // 指示2 & 3: 成約価格の項目が揃わなければ、同一商品の販売中価格・市場価格を使って数値の参考価格案をドラフトに出す
  // Stage B が価格を出さなかった場合、Stage A または追加価格検索結果から参考価格案を復元
  // ただし、ブランド・商品を特定できないアパレル相当商品や、検索結果一覧URLしか存在しない場合は無関係な相場復元を行わない
  const isUnidentifiedApparelInTwoStage = isUnidentifiedApparelEquivalent_(candidate, {
    category: effectiveCategory || candidate.category,
    brand: candidate.brand,
    sku: candidate.sku,
    title_ja: candidate.title_ja,
    title_en: candidate.title_en,
    description_ja: candidate.description_ja,
    hashtags_ja: candidate.hashtags_ja
  });
  if (candidate.price === null && !isUnidentifiedApparelInTwoStage) {
    const fallbackPriceInfo = stageAPriceInfo || extractPriceFromStageAText_(
      parsedStageA.pricingText,
      parsedStageA.searchText,
      stageAGrounding && stageAGrounding.sources
    );
    if (fallbackPriceInfo) {
      const validGroundingSrc = (stageAGrounding && Array.isArray(stageAGrounding.sources))
        ? stageAGrounding.sources.find(s => s && s.url && /^https?:\/\//i.test(s.url) && !isSearchResultListingUrl_(s.url))
        : null;
      const refUrl = (fallbackPriceInfo.url && !isSearchResultListingUrl_(fallbackPriceInfo.url))
        ? fallbackPriceInfo.url
        : (validGroundingSrc ? validGroundingSrc.url : "");
      const hasOnlySearchListingSources = !refUrl && (
        Boolean(fallbackPriceInfo.url && isSearchResultListingUrl_(fallbackPriceInfo.url)) ||
        Boolean(stageAGrounding && Array.isArray(stageAGrounding.sources) && stageAGrounding.sources.length > 0 &&
          stageAGrounding.sources.every(s => !s || !s.url || isSearchResultListingUrl_(s.url)))
      );

      if (!hasOnlySearchListingSources) {
        const displayRefUrl = refUrl || "(URL未取得)";
        candidate.price = roundPriceByPolicy_(fallbackPriceInfo.price);
        candidate.price_basis = effectiveIsSneaker ? "active_listing_reference" : "market_reference_proposal";
        candidate.price_evidence_verified = false;
        candidate.price_note = effectiveIsSneaker
          ? `検索結果テキスト内の価格情報（${fallbackPriceInfo.price}円）を参照した販売中参考価格案です（個別取引・成約価格は未確認のため要スタッフ確認）。参照元: ${displayRefUrl}。`
          : `検索結果テキスト内の価格情報（${fallbackPriceInfo.price}円）を参照した市場参考価格案です（個別取引・成約価格は未確認のため要スタッフ確認）。参照元: ${displayRefUrl}。`;
        if (!Array.isArray(candidate.price_evidence) || candidate.price_evidence.length === 0) {
          candidate.price_evidence = [{
            source_url: displayRefUrl,
            price_type: effectiveIsSneaker ? "active" : "unknown",
            amount: fallbackPriceInfo.price,
            currency: "JPY",
            transaction_date: "",
            item_match_condition: "exact_match",
            verification_status: (refUrl && refUrl.indexOf("http") === 0 && !isSearchResultListingUrl_(refUrl)) ? "format_valid" : "unverified"
          }];
        }
        if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
        if (candidate.needs_review.indexOf("price") === -1) candidate.needs_review.push("price");
        console.log(`[AI Draft Price Fallback] Stage A / 追加検索結果から参考価格案を復旧: ${candidate.price}円 (basis: ${candidate.price_basis})`);
      }
    }
  }

  // 先行カテゴリー判定に基づく安全ガード (指示3)
  if (isCategoryMismatch) {
    candidate.identity_status = "ambiguous";
    if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
    if (candidate.needs_review.indexOf("category_mismatch") === -1) {
      candidate.needs_review.push("category_mismatch");
    }
  } else if (!effectiveCategory) {
    // カテゴリーが依然として未確定の場合のみ要確認
    candidate.identity_status = "ambiguous";
    if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
    if (candidate.needs_review.indexOf("category") === -1) {
      candidate.needs_review.push("category");
    }
  }

  // ポケカ同定ガード: カード番号が読めない場合は必ず要確認 (指示4)
  if (effectiveIsPokemonCard) {
    const pokeCardNum = candidate.pokemon_card && String(candidate.pokemon_card.card_number || "").trim();
    if (!pokeCardNum || /^(?:none|null|undefined|-)$/i.test(pokeCardNum)) {
      candidate.identity_status = "ambiguous";
      if (!Array.isArray(candidate.needs_review)) candidate.needs_review = [];
      if (candidate.needs_review.indexOf("card_number") === -1) {
        candidate.needs_review.push("card_number");
      }
    }
  }

  const priceTrace = {
    stage_a_detected_price: stageAPriceInfo ? stageAPriceInfo.price : null,
    dedicated_price_search_executed: dedicatedSearchExecuted,
    dedicated_price_search_query: dedicatedSearchQuery,
    dedicated_price_search_price: dedicatedSearchResult ? (stageAPriceInfo ? stageAPriceInfo.price : null) : null,
    stage_b_raw_price: bRawJson ? bRawJson.price : null,
    stage_b_raw_basis: bRawJson ? bRawJson.price_basis : null,
    stage_b_raw_evidence_count: (bRawJson && Array.isArray(bRawJson.price_evidence)) ? bRawJson.price_evidence.length : 0,
    server_calculated_price: candidate.price,
    server_calculated_basis: candidate.price_basis,
    final_adopted_price: candidate.price,
    final_adopted_basis: candidate.price_basis
  };
  candidate._price_trace = priceTrace;

  return {
    success: true,
    candidate: candidate,
    prior_classification: priorClass,
    grounding: stageAGrounding,
    stage_a_text: stageAText,
    stage_a_elapsed_ms: stageAElapsed,
    stage_b_elapsed_ms: stageBElapsed,
    stage_a_finish_reason: stageAFinishReason,
    stage_a_usage: stageAUsage,
    stage_b_usage: stageBUsage,
    price_trace: priceTrace
  };
}

/**
 * 検索グラウンディング付きマルチモーダルAIドラフト生成メイン処理
 *
 * 検索必須方針に基づき、標準経路として 2段階方式 (Stage A 検索 -> Stage B 構造化) を実行
 *
 * @param {Array<Object>} images
 * @param {Object} productMeta
 * @param {string} [overrideModel]
 * @param {Object} [options]
 * @return {Object} サニタイズ済み候補オブジェクト (search_grounding メタデータ付き)
 */
async function runSingleAttemptWithSearch_(images, productMeta, modelName, mode, options) {
  options = options || {};

  console.log(`[AI Draft Search Grounding] 検索付き生成開始: model='${modelName}', mode='${mode}', product='${productMeta.productId}'`);

  let finalCandidate = null;
  let groundingInfo = null;
  let modeUsed = mode;
  let stageAElapsed = 0;
  let stageBElapsed = 0;
  let stageAFinishReason = "";
  let stageAUsage = null;
  let stageBUsage = null;

  if (mode === "single") {
    // 1回方式 (比較診断などの明示的指定時のみ)
    const singleResult = await callGeminiSingleRequestSearchGrounding_(images, productMeta, modelName, options);
    if (!singleResult.success) {
      const err = new Error(`[AI Draft Single Grounding] Generation failed (${singleResult.error_code}): ${singleResult.error_message}`);
      err.error_code = singleResult.error_code || "LLM_GENERATION_FAILED";
      throw err;
    }
    finalCandidate = singleResult.candidate;
    groundingInfo = singleResult.grounding;
    modeUsed = "single_request";
  } else if (mode === "auto") {
    // auto モード: 1回方式を試行し、スキーマ非互換(400)または検索未達成時に2段階方式へフォールバック
    let singleResult = null;
    let singleSucceeded = false;
    try {
      singleResult = await callGeminiSingleRequestSearchGrounding_(images, productMeta, modelName, options);
      if (singleResult.success) {
        finalCandidate = singleResult.candidate;
        groundingInfo = singleResult.grounding;
        modeUsed = "single_request";
        singleSucceeded = true;
      }
    } catch (singleErr) {
      // 429 や 5xx、通信エラー等の場合は、仕様非互換ではないためそのまま上位へスロー
      console.warn(`[AI Draft Search Grounding] 1回方式で一時的または通信エラー (${singleErr.error_code}): ${singleErr.message}`);
      throw singleErr;
    }

    if (!singleSucceeded) {
      const shouldFallback = singleResult && (
        singleResult.is_schema_unsupported ||
        singleResult.error_code === "SEARCH_GROUNDING_NOT_EXECUTED" ||
        singleResult.error_code === "SEARCH_GROUNDING_NO_SOURCES"
      );
      if (shouldFallback) {
        console.warn(`[AI Draft Search Grounding] 1回方式ではグラウンディング不可 (${singleResult.error_code})。2段階方式へフォールバックします。`);
        const twoStageResult = await callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options);
        finalCandidate = twoStageResult.candidate;
        groundingInfo = twoStageResult.grounding;
        modeUsed = "two_stage_fallback";
        stageAElapsed = twoStageResult.stage_a_elapsed_ms || 0;
        stageBElapsed = twoStageResult.stage_b_elapsed_ms || 0;
        stageAFinishReason = twoStageResult.stage_a_finish_reason || "";
        stageAUsage = twoStageResult.stage_a_usage || null;
        stageBUsage = twoStageResult.stage_b_usage || null;
      } else {
        const err = new Error(`[AI Draft Search Grounding] 1回方式失敗 (${singleResult ? singleResult.error_code : "UNKNOWN"}): ${singleResult ? singleResult.error_message : ""}`);
        err.error_code = (singleResult && singleResult.error_code) || "LLM_GENERATION_FAILED";
        throw err;
      }
    }
  } else {
    // two_stage または既定モード: 2段階方式
    const twoStageResult = await callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options);
    finalCandidate = twoStageResult.candidate;
    groundingInfo = twoStageResult.grounding;
    modeUsed = "two_stage";
    stageAElapsed = twoStageResult.stage_a_elapsed_ms || 0;
    stageBElapsed = twoStageResult.stage_b_elapsed_ms || 0;
    stageAFinishReason = twoStageResult.stage_a_finish_reason || "";
    stageAUsage = twoStageResult.stage_a_usage || null;
    stageBUsage = twoStageResult.stage_b_usage || null;
  }

  // 検索メタデータを候補オブジェクトに付与 (追跡項目を完備)
  const searchExecuted = Boolean(groundingInfo && groundingInfo.search_executed);
  const queries = (groundingInfo && groundingInfo.queries) || [];
  const sources = (groundingInfo && groundingInfo.sources) || [];

  finalCandidate.search_grounding = {
    enabled: true,
    mode_used: modeUsed,
    search_executed: searchExecuted,
    price_evidence_verified: Boolean(finalCandidate.price_evidence_verified),
    queries: queries,
    sources: sources,
    queries_count: queries.length,
    sources_count: sources.length,
    stage_a_elapsed_ms: stageAElapsed,
    stage_b_elapsed_ms: stageBElapsed,
    search_total_elapsed_ms: stageAElapsed + stageBElapsed,
    search_finish_reason: stageAFinishReason,
    search_tokens_json: JSON.stringify({
      stage_a: stageAUsage,
      stage_b: stageBUsage
    })
  };

  // SKU保護規則の最終サニタイズ:
  // スタッフ手入力済みの既存SKUは最優先で保護
  // 箱ラベル未撮影でも検索で確認された型番はドラフト候補として提示し、出典注記・needs_reviewを残す
  const existingSku = String(productMeta.sneakerSku || "").trim();
  const safeExisting = /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingSku) ? "" : existingSku;
  if (!safeExisting) {
    if (finalCandidate.sku) {
      if (finalCandidate.sku_source !== "box_label") {
        finalCandidate.sku_source = "search_corroborated";
        finalCandidate.inferred_sku_from_search = finalCandidate.sku;
        if (!Array.isArray(finalCandidate.needs_review)) finalCandidate.needs_review = [];
        if (finalCandidate.needs_review.indexOf("sku") === -1) finalCandidate.needs_review.push("sku");
        console.log(`[AI Draft SKU Protection] 検索由来の推定型番 '${finalCandidate.sku}' をドラフト候補として提示（needs_review: sku付き）`);
      }
    }
  } else {
    finalCandidate.sku = safeExisting;
    finalCandidate.sku_source = "staff_input";
  }

  console.log(`[AI Draft Search Grounding 完了] mode='${modeUsed}', search_executed=${searchExecuted}, queries=${finalCandidate.search_grounding.queries.length}件, sources=${finalCandidate.search_grounding.sources.length}件, title='${finalCandidate.title_ja}'`);
  return finalCandidate;
}


const TRANSIENT_SEARCH_ERROR_CODES = new Set([
  "LLM_HTTP_ERROR_429",
  "LLM_HTTP_ERROR_500",
  "LLM_HTTP_ERROR_502",
  "LLM_HTTP_ERROR_503",
  "LLM_HTTP_ERROR_504",
  "LLM_COMMUNICATION_FAILED",
]);

export async function callGeminiMultimodalAiDraftWithSearch_(
  images,
  productMeta,
  overrideModel,
  options = {}
) {
  const apiKey = String(options.apiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("[AI Draft] GEMINI_API_KEY is not configured.");
    err.error_code = "LLM_API_KEY_MISSING";
    throw err;
  }
  const defaultPrimary = resolveAiDraftModelName();
  const primaryModel = String(overrideModel || "").trim() || defaultPrimary;
  const isDedicatedOverride = Boolean(overrideModel && overrideModel !== defaultPrimary);
  const fallbackModel = isDedicatedOverride ? null : resolveAiDraftFallbackModelName();
  const mode = resolveSearchGroundingMode(options.search_mode);
  const retryDelayMs = options.retryDelayMs !== undefined ? Number(options.retryDelayMs) : 1500;

  const modelsToTry = [primaryModel];
  if (fallbackModel && fallbackModel !== primaryModel) {
    modelsToTry.push(fallbackModel);
  }

  let lastErr = null;
  for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
    const currentModel = modelsToTry[mIdx];
    const isFallback = mIdx > 0;
    const maxAttempts = isFallback ? 1 : 2;

    if (isFallback) {
      console.warn(
        `[AI Draft Search Grounding] 主モデル '${primaryModel}' で一時エラーが継続したため、予備モデル '${currentModel}' へ切り替えます。`
      );
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await runSingleAttemptWithSearch_(images, productMeta, currentModel, mode, {
          ...options,
          apiKey,
        });
      } catch (err) {
        lastErr = err;
        const code = String(err?.error_code || "");
        if (TRANSIENT_SEARCH_ERROR_CODES.has(code)) {
          if (attempt + 1 < maxAttempts) {
            await sleepMs(retryDelayMs * (attempt + 1));
            continue;
          }
          // Break inner loop to try fallbackModel if available
          break;
        }
        // Non-transient error (e.g. PROHIBITED_WORDS_DETECTED, SEARCH_GROUNDING_NOT_EXECUTED): rethrow immediately
        throw err;
      }
    }
  }

  throw lastErr || new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
}

export {
  AI_DRAFT_CONFIG,
  TRANSLATION_DICTIONARIES,
  translateFixedAttributes,
  normalizeCategoryValue_,
  normalizeSneakerSku_,
  normalizeSneakerSize_,
  normalizeBrandValue_,
  parseStoredSelectedImageIds_,
  validateSelectedImageIdsSyntax_,
  deduplicatePriceEvidenceItems_,
  extractPriceFromStageAText_,
  isSearchResultListingUrl_,
  isUnidentifiedApparelEquivalent_,
  verifyPriceEvidenceItem_,
  calculateServerGroundedPrice_,
  roundPriceByPolicy_,
  ceilPriceByPolicy_,
  validateMinCostMarkupRateInput_,
  normalizeMinCostMarkupRate_,
  validateLegacyGrossMarginRateIfPresent_,
  computeProductCostSummaryFromInput_,
  applyCostFloorToCandidate_,
  detectCategoryFromCandidateContext_,
  parseStageASections_,
  verifySneakerModelSkuMatch_,
  sanitizePokemonCardTitle_,
  sanitizeConditionClaimsWithoutBackImage_,
  verifyProductIdentityOnServer_,
  detectProhibitedWords_,
  stripAuthenticityGuaranteeText_,
  stripCleaningBoilerplateText_,
  normalizeApparelAndShoeCondition_,
  validateAndSanitizeDraftCandidate_,
  extractGroundingMetadata_,
  buildAiDraftSystemInstruction_,
  buildSearchGroundingSystemInstruction_,
  buildAiDraftResponseSchema_,
};
