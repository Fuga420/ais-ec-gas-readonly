// ==================================================
// AI画像入力・日英出品ドラフト管理モジュール
// ファイル名: llm_product_draft.js
// ==================================================

/**
 * AI出品ドラフト定数設定
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
    /\b100%\s*(?:authentic|genuine|original)\b/i,
    /\b(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)\b/i,
    /\b(?:authentic(?:ity)?|genuine)\s+(?:guaranteed|verified|certified)\b/i,
    /(?:確実)?正規品|本物保証|正規保証|真正品|真贋鑑定済(?:み)?|鑑定済(?:み)?(?:の)?(?:正規品|本物)/i
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

/**
 * Stage Aの検索で価格が取れなかった場合に行う、価格に絞った追加検索 (最大1回)
 * @param {Object} queryContext { category, cardName, setCode, cardNumber, rarity, brand, sku, size, titleJa }
 * @param {string} apiKey
 * @param {string} modelName
 * @return {{ pricingText: string, sources: Array<Object>, query: string, elapsedMs: number }|null}
 */
function fetchDedicatedPriceSearch_(queryContext, apiKey, modelName) {
  queryContext = queryContext || {};
  let queryTerms = [];
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
  if (!query) return null;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const prompt = [
    `Use Google Search to find current market pricing in JPY for the following product:`,
    `Product Query: ${query}`,
    ``,
    `Search specifically for:`,
    `1. Recent sold / completed transactions (成約実績, 落札相場) in JPY (with dates and sources).`,
    `2. If no sold transactions, find current active listing prices (販売中価格, 出品価格) of the identical product in JPY.`,
    `3. If still not found, find comparable market prices in JPY.`,
    ``,
    `Report the findings in Japanese: list amounts in JPY (e.g. 8,300円), transaction type (成約 / 販売中 / 相場), dates, and source URLs.`,
    `Always report numeric amounts found.`
  ].join("\n");

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024
    }
  };

  const startTime = Date.now();
  try {
    const res = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const elapsedMs = Date.now() - startTime;
    if (res.getResponseCode() !== 200) {
      console.warn(`[AI Draft Dedicated Price Search] HTTP ${res.getResponseCode()}`);
      return null;
    }
    const parsed = JSON.parse(res.getContentText());
    const cand = parsed.candidates && parsed.candidates[0];
    if (!cand) return null;

    const grounding = extractGroundingMetadata_(cand);
    const nonThought = cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.filter(p => !p.thought && typeof p.text === "string" && p.text.trim().length > 0)
      : [];
    const text = nonThought.length > 0
      ? nonThought.map(p => p.text).join("\n")
      : (cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(p => p.text || "").join("\n") : "");

    return {
      pricingText: text,
      sources: grounding.sources || [],
      query: query,
      elapsedMs: elapsedMs
    };
  } catch (err) {
    console.warn(`[AI Draft Dedicated Price Search] Exception: ${err.message}`);
    return null;
  }
}

/**
 * 画像やメタデータから推測される属性に基づき、カテゴリー未入力時の自動判定を行う
 * @param {Object} rawCandidate
 * @param {Object} [meta]
 * @return {string} "pokemon_card" | "sneaker" | "" (曖昧・未確定時は空文字)
 */
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

/**
 * 商品画像を用いた先行カテゴリー判定 (Pre-classification)
 * Stage A の実行前に商品画像から客観的にポケカ / スニーカー / 未確定を決定する。
 * また、既存指定カテゴリーと画像判定の矛盾検知（Category Mismatch）を行う。
 *
 * @param {Array<Object>} images [{ mimeType, base64 }]
 * @param {Object} [productMeta] { category, brand, productName, productId }
 * @param {string} [modelName]
 * @param {Object} [options]
 * @return {{ category: string, confidence: string, mismatchDetected: boolean, mismatchReason: string, apiExecuted: boolean, apiSuccess: boolean, status: string }}
 */
function classifyCategoryPriorFromImages_(images, productMeta, modelName, options) {
  options = options || {};
  productMeta = productMeta || {};
  const existingNormCategory = normalizeCategoryValue_(productMeta.category);

  // 1. メタデータやテキストコンテキストからの事前判定 (既存カテゴリーに引っ張られず純粋な特徴から判定)
  const metaWithoutCat = Object.assign({}, productMeta, { category: "" });
  const localDetected = detectCategoryFromCandidateContext_({}, metaWithoutCat);

  let apiDetectedCat = "";
  let confidence = localDetected ? "medium" : (existingNormCategory ? "high" : "none");
  let mismatchDetected = false;
  let mismatchReason = "";
  let apiExecuted = false;
  let apiSuccess = false;
  let apiFailed = false;

  // 既存カテゴリーとコンテキスト判定の矛盾チェック
  // ※ apparel / fashion_goods / jewelry / other が登録済みの場合、NIKE / adidas 等のブランド名のみを根拠とした
  //    localDetected === "sneaker" では矛盾扱いとせず、登録済みカテゴリを優先する（明示的な sneakerSku やポケカ特徴がある場合は矛盾検知を維持）
  if (existingNormCategory && localDetected && existingNormCategory !== localDetected) {
    const isNonSneakerRegistered = ["apparel", "fashion_goods", "jewelry", "other"].indexOf(existingNormCategory) !== -1;
    const hasExplicitSneakerSku = Boolean(String(metaWithoutCat.sneakerSku || "").trim());
    const shouldFlagMismatch = !(isNonSneakerRegistered && localDetected === "sneaker" && !hasExplicitSneakerSku);
    if (shouldFlagMismatch) {
      mismatchDetected = true;
      mismatchReason = `Metadata specifies category '${existingNormCategory}', but text/attributes indicate '${localDetected}'.`;
      console.warn(`[Category Mismatch Detected] ${mismatchReason}`);
    }
  }

  // 画像がある場合の処理
  if (Array.isArray(images) && images.length > 0) {
    // 2. 実API利用判定:
    // カテゴリーが未確定の場合、または options.enable_prior_classification_api が true の場合にAPI呼出しを実行
    // （既存カテゴリーが確定しており options.enable_prior_classification_api が指定されていない場合はAPI呼出しを節約）
    const shouldCallApi = Boolean(options.enable_prior_classification_api) || (!existingNormCategory && !localDetected);

    if (shouldCallApi) {
      apiExecuted = true;
      try {
        const apiKey = (typeof getLlmApiKey_ === "function") ? getLlmApiKey_() : "";
        if (apiKey && typeof UrlFetchApp !== "undefined") {
          const selectedModel = modelName || (typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : "gemini-3.8-flash");
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;

          const imageParts = images.slice(0, 4).map(img => ({
            inlineData: { mimeType: img.mimeType, data: img.base64 }
          }));
          const promptText = [
            "Examine the attached product images (which may include product appearance, packaging/box, and barcode/size labels). Determine the product category strictly from the following choices:",
            "- \"pokemon_card\": Pokémon trading cards, booster packs, graded card slabs (PSA/BGS/CGC), or Pokémon card game singles.",
            "- \"sneaker\": Athletic sneakers, footwear, shoes, shoe boxes, or sneaker size tags.",
            "- \"other\": Apparel/clothing, accessories, other trading cards, or unidentifiable items.",
            "",
            "Respond strictly in JSON:",
            "{\"category\": \"pokemon_card\" | \"sneaker\" | \"other\", \"confidence\": \"high\" | \"low\", \"rationale\": \"brief rationale\"}"
          ].join("\n");

          const payload = {
            contents: [{
              role: "user",
              parts: [{ text: promptText }].concat(imageParts)
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 100,
              responseMimeType: "application/json"
            }
          };

          const res = UrlFetchApp.fetch(endpoint, {
            method: "post",
            contentType: "application/json",
            headers: { "x-goog-api-key": apiKey },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
          });

          if (res.getResponseCode() === 200) {
            apiSuccess = true;
            const parsed = JSON.parse(res.getContentText());
            const cand = parsed.candidates && parsed.candidates[0];
            if (cand && cand.content && cand.content.parts && cand.content.parts[0]) {
              let rawTxt = String(cand.content.parts[0].text || "").trim();
              if (/^```(?:json)?/i.test(rawTxt)) {
                rawTxt = rawTxt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
              }
              let resObj = null;
              try {
                resObj = JSON.parse(rawTxt);
              } catch (_) {
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
            console.warn(`[Prior Category Detection] API returned HTTP ${res.getResponseCode()}`);
          }
        }
      } catch (err) {
        apiFailed = true;
        console.warn("[Prior Category Detection] Exception in API call, falling back to local heuristic:", err.message);
      }
    }

    // 画像API判定と既存カテゴリーの矛盾チェック
    if (existingNormCategory && apiDetectedCat && existingNormCategory !== apiDetectedCat) {
      mismatchDetected = true;
      mismatchReason = `Metadata specifies category '${existingNormCategory}', but product image analysis identified '${apiDetectedCat}'.`;
      console.warn(`[Category Mismatch Detected] ${mismatchReason}`);
    }
  }

  // 確定カテゴリーの決定:
  // 矛盾がある場合は空欄にして安全停止。矛盾がない場合は商品シートの登録済みカテゴリ (existingNormCategory) を最優先する
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
    confidence: confidence,
    mismatchDetected: mismatchDetected,
    mismatchReason: mismatchReason,
    apiExecuted: apiExecuted,
    apiSuccess: apiSuccess,
    apiFailed: apiFailed,
    status: status
  };
}

/**
 * Stage A の自由文出力からセクションおよび主要属性キーを抽出する (暫定構造化パーサー)
 *
 * 【重要・暫定措置の明示】
 * 本関数はプロンプトのセクション見出し（### OBSERVED_*等）および行頭キーに基づくテキスト分割と
 * 簡易抽出を行う暫定措置であり、確定属性の完全な構造化検証やスキーマ制約を保証するものではありません。
 * 確定値の検証は後段のサーバー側検査 (verifyProductIdentityOnServer_) で行われます。
 *
 * @param {string} stageAText
 * @return {{
 *   observedText: string,
 *   searchText: string,
 *   pricingText: string,
 *   unconfirmedText: string,
 *   observedFields: Object,
 *   searchDerivedFields: Object,
 *   extractedFields: Object,
 *   missingFields: Array<string>
 * }}
 */
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

/**
 * 確認要求の確定内容（confirmed_data）を正規化し、SHA-256ダイジェストを算出 (指示1)
 * @param {Object} confirmedData
 * @return {string}
 */
function computeConfirmationPayloadHash_(confirmedData) {
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
    String(poke.card_condition || "").trim()
  ].join("|");

  const pName = String(confirmedData.product_name || confirmedData.title_ja || "").trim();
  const pPrice = String(confirmedData.planned_sale_price !== undefined ? confirmedData.planned_sale_price : (confirmedData.price !== undefined ? confirmedData.price : "")).trim();
  const pCond = String(confirmedData.condition || "").trim();
  const pTitle = String(confirmedData.translated_title || confirmedData.title_en || "").trim();
  const pDesc = String(confirmedData.translated_description || confirmedData.description_en || "").trim();
  const pCat = normalizeCategoryValue_(confirmedData.category || "");
  const pSize = String(confirmedData.sneaker_size !== undefined ? confirmedData.sneaker_size : (confirmedData.size !== undefined ? confirmedData.size : "")).trim();
  const pBrand = normalizeBrandValue_(confirmedData.brand || "", pCat);
  const pSku = String(confirmedData.sneaker_sku !== undefined ? confirmedData.sneaker_sku : (confirmedData.sku !== undefined ? confirmedData.sku : "")).trim();
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
    normalizedPoke
  ].join("::");

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    normalized,
    Utilities.Charset.UTF_8
  );
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
}

// ==================================================
// 1. スキーマ確認・シート確保
// ==================================================

/**
 * product_ai_drafts シートを取得、存在しない場合は作成してヘッダーを設定
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateProductAiDraftsSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = AI_DRAFT_CONFIG.SHEET_NAME;
  const expectedHeaders = AI_DRAFT_CONFIG.HEADERS;

  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }

  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }

  const currentLastCol = sheet.getLastColumn();
  const currentHeaders = sheet
    .getRange(1, 1, 1, currentLastCol)
    .getValues()[0]
    .map(h => String(h || "").trim());

  const missingHeaders = expectedHeaders.filter(h => currentHeaders.indexOf(h) === -1);
  if (missingHeaders.length > 0) {
    sheet.getRange(1, currentLastCol + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }

  return sheet;
}

/**
 * 商品マスターシート AN列 (40列目) の ai_draft_flag ヘッダーを確認・確保
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート (Sheets[0])
 */
function ensureAiDraftColumns_(sheet) {
  const flagColumn = AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN;
  const maxColumns = sheet.getMaxColumns();

  if (maxColumns < flagColumn) {
    sheet.insertColumnsAfter(maxColumns, flagColumn - maxColumns);
  }

  const headerVal = String(sheet.getRange(1, flagColumn).getValue() || "").trim();
  const expectedHeader = "ai_draft_flag";

  if (headerVal && headerVal !== expectedHeader) {
    throw new Error(
      "AN (40) column is already in use: expected '" +
      expectedHeader +
      "', found '" +
      headerVal +
      "'"
    );
  }

  if (!headerVal) {
    sheet.getRange(1, flagColumn).setValue(expectedHeader);
  }
}

// ==================================================
// 2. 指紋（Fingerprint）計算
// ==================================================

/**
 * Drive画像のファイル情報から画像指紋（SHA-256）を計算
 * @param {string} driveFolderUrl
 * @return {string}
 */
function computeImageFingerprintFromFolderUrl_(driveFolderUrl) {
  if (!driveFolderUrl) {
    const err = new Error("Drive folder URL is missing.");
    err.error_code = "NO_DRIVE_FOLDER";
    throw err;
  }

  const folderId = extractDriveFolderId(driveFolderUrl);
  if (!folderId) {
    const err = new Error("Invalid Drive folder URL: " + driveFolderUrl);
    err.error_code = "INVALID_DRIVE_FOLDER";
    throw err;
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (driveErr) {
    const err = new Error("Failed to access Drive folder (" + folderId + "): " + driveErr.message);
    err.error_code = "DRIVE_FOLDER_ACCESS_FAILED";
    throw err;
  }

  const files = folder.getFiles();
  const fileList = [];
  let prodId = "";
  try {
    prodId = folder.getName();
  } catch (_) {}
  const docFileIds = typeof getProductDocumentFileIds_ === "function" ? getProductDocumentFileIds_(prodId) : new Set();

  while (files.hasNext()) {
    const file = files.next();
    if (docFileIds.has(file.getId())) continue;
    if (typeof file.isTrashed === "function" && file.isTrashed()) continue;
    const mime = file.getMimeType();
    if (mime.startsWith("image/")) {
      fileList.push({
        id: file.getId(),
        name: file.getName(),
        size: file.getSize(),
        updatedAt: file.getLastUpdated().getTime()
      });
    }
  }

  fileList.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const combined = fileList.map(f => `${f.id}:${f.name}:${f.size}:${f.updatedAt}`).join("|");

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    combined || "empty_folder",
    Utilities.Charset.UTF_8
  );
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
}

/**
 * ポケモンカード情報の安全な読取 (Fail-Closed)
 * 取得例外を catch で無視せず POKEMON_CARD_READ_FAILED 例外をスロー。
 * レコード欠損時は null を返却。
 * @param {string} productId
 * @return {Object|null}
 */
function safeGetPokemonCard_(productId) {
  try {
    const poke = getPokemonCardByProductId(productId);
    return poke || null;
  } catch (err) {
    if (err && err.error_code) throw err;
    const readErr = new Error(`Failed to read pokemon card attributes for ${productId}: ${err.message}`);
    readErr.error_code = "POKEMON_CARD_READ_FAILED";
    throw readErr;
  }
}

/**
 * 英文翻訳情報の安全な読取 (Fail-Closed)
 * 取得例外を catch で無視せず TRANSLATION_READ_FAILED 例外をスロー。
 * レコード欠損時は null を返却。
 * @param {string} productId
 * @return {Object|null}
 */
function safeGetProductTranslation_(productId) {
  try {
    const trans = getProductTranslation(productId);
    return trans || null;
  } catch (err) {
    if (err && err.error_code) throw err;
    const readErr = new Error(`Failed to read product translation for ${productId}: ${err.message}`);
    readErr.error_code = "TRANSLATION_READ_FAILED";
    throw readErr;
  }
}

/**
 * 1) 生成元指紋（source_fingerprint）:
 *    AI生成開始時点の Drive画像 ＋ 本票全確認対象項目（商品名、状態、価格、説明、カテゴリ、ブランド、SKU、サイズ）
 *    ＋ ポケカ属性 ＋ 英文翻訳の統合ハッシュ
 *    指示: 生成元指紋に含まれない項目だけの他スタッフ変更も確実に検知できるよう、全確認対象項目を包含する。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {number} targetRow 行番号
 * @param {string} productId 商品ID
 * @return {string} SHA-256ハッシュ文字列
 */
function computeProductSourceFingerprint_(sheet, targetRow, productId) {
  const row = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];

  const driveFolderUrl = String(row[29] || "").trim(); // AD列 (30)
  const category = String(row[2] || "").trim();       // C列 (3)
  const brand = String(row[3] || "").trim();          // D列 (4)
  const productName = String(row[4] || "").trim();    // E列 (5)
  const condition = String(row[5] || "").trim();      // F列 (6)
  const plannedSalePrice = String(row[7] || "").trim(); // H列 (8)
  const description = String(row[9] || "").trim();    // J列 (10)
  const sneakerSku = String(row[11] || "").trim();    // L列 (12)
  const sneakerSize = String(row[12] || "").trim();   // M列 (13)

  const imageFp = computeImageFingerprintFromFolderUrl_(driveFolderUrl);

  // ポケカ属性 (読取例外は Fail-Closed、欠損時は "no_poke_record")
  let pokeStr = "";
  if (category === "pokemon_card" || category === "ポケモンカード") {
    const poke = safeGetPokemonCard_(productId);
    if (poke) {
      pokeStr = [
        poke.card_name || "",
        poke.set_name || "",
        poke.card_number || "",
        poke.rarity || "",
        poke.language || "",
        poke.grading_status || "",
        poke.grader || "",
        poke.grade || "",
        poke.certification_number || "",
        poke.card_condition || ""
      ].join(",");
    } else {
      pokeStr = "no_poke_record";
    }
  }

  // 英文翻訳 (読取例外は Fail-Closed、欠損時は "no_trans_record")
  let transStr = "";
  const trans = safeGetProductTranslation_(productId);
  if (trans) {
    transStr = [
      trans.translated_title || "",
      trans.translated_description || "",
      trans.translation_status || ""
    ].join(",");
  } else {
    transStr = "no_trans_record";
  }

  const combinedString = [
    productId,
    category,
    brand,
    productName,
    condition,
    plannedSalePrice,
    description,
    sneakerSku,
    sneakerSize,
    pokeStr,
    transStr,
    imageFp
  ].join("::");

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    combinedString,
    Utilities.Charset.UTF_8
  );

  return digest
    .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 2) 確定内容指紋（confirmed_fingerprint）:
 *    スタッフ確認完了時点の Drive画像 ＋ 本票全確定項目 ＋ カテゴリ属性 ＋ 英文の統合ハッシュ
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {number} targetRow 行番号
 * @param {string} productId 商品ID
 * @return {string} SHA-256ハッシュ文字列
 */
function computeConfirmedProductFingerprint_(sheet, targetRow, productId) {
  const row = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 43)).getValues()[0];

  const category = String(row[2] || "").trim();
  const brand = String(row[3] || "").trim();
  const productName = String(row[4] || "").trim();
  const condition = String(row[5] || "").trim();
  const plannedSalePrice = String(row[7] || "").trim();
  const description = String(row[9] || "").trim();
  const notes = String(row[10] || "").trim();

  // スニーカー属性
  const sneakerSku = String(row[11] || "").trim();
  const sneakerSize = String(row[12] || "").trim();
  const sneakerColorway = String(row[13] || "").trim();
  const sneakerBox = String(row[14] || "").trim();
  const sneakerAccessories = String(row[15] || "").trim();

  // アパレル・ファッション小物属性 (41: subcategory, 42: size, 43: official_sku)
  const apparelSubcategory = String(row[40] || "").trim();
  const apparelSize = String(row[41] || "").trim();
  const apparelSku = String(row[42] || "").trim();

  // ポケモンカード固有属性
  let pokeStr = "";
  if (category === "pokemon_card") {
    const poke = safeGetPokemonCard_(productId);
    if (!poke) {
      const err = new Error(`[Confirmed Fingerprint] Pokemon card record missing for ${productId} (category: pokemon_card).`);
      err.error_code = "POKEMON_CARD_RECORD_MISSING";
      throw err;
    }
    // ポケモンカード固有全属性 (指示4)
    pokeStr = [
      poke.card_name || "",
      poke.set_name || "",
      poke.card_number || "",
      poke.rarity || "",
      poke.language || "",
      poke.grading_status || "",
      poke.grader || "",
      poke.grade || "",
      poke.certification_number || "",
      poke.card_condition || ""
    ].join(",");
  }

  // 確定英文データ (箱・付属品も含む)
  let transStr = "";
  const trans = safeGetProductTranslation_(productId);
  if (!trans || trans.translation_status !== "approved") {
    const err = new Error(`[Confirmed Fingerprint] Approved product translation record missing for ${productId}.`);
    err.error_code = "TRANSLATION_RECORD_MISSING";
    throw err;
  }
  transStr = [
    trans.translated_title || "",
    trans.translated_description || "",
    trans.translated_condition || "",
    trans.translated_box || "",
    trans.translated_accessories || "",
    trans.translation_status || ""
  ].join(",");

  // 画像指紋
  const driveFolderUrl = String(row[29] || "").trim();
  const imageFp = computeImageFingerprintFromFolderUrl_(driveFolderUrl);

  const combinedString = [
    productId,
    category,
    brand,
    productName,
    condition,
    plannedSalePrice,
    description,
    notes,
    sneakerSku,
    sneakerSize,
    sneakerColorway,
    sneakerBox,
    sneakerAccessories,
    apparelSubcategory,
    apparelSize,
    apparelSku,
    pokeStr,
    transStr,
    imageFp
  ].join("::");

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    combinedString,
    Utilities.Charset.UTF_8
  );

  return digest
    .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"))
    .join("");
}

// ==================================================
// 3. 排他制御・実行ID管理（Superseded Release Protection）
// ==================================================

/**
 * AIドラフト生成の実行ロックを取得
 * @param {string} productId
 * @return {string} 一意な execution_id
 */
function acquireAiDraftExecutionLock_(productId) {
  const lockKey = "AI_GEN_LOCK_" + productId;
  const scriptLock = LockService.getScriptLock();
  scriptLock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);

  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const currentVal = scriptProperties.getProperty(lockKey);
    const now = Date.now();

    if (currentVal) {
      try {
        const parsed = JSON.parse(currentVal);
        if (parsed.started_at && now - parsed.started_at < AI_DRAFT_CONFIG.EXECUTION_TTL_MS) {
          const err = new Error(
            "AI draft generation already in progress for product " +
            productId +
            " (execution_id: " + parsed.execution_id + ")"
          );
          err.error_code = "GENERATION_ALREADY_IN_PROGRESS";
          throw err;
        }
      } catch (parseErr) {
        if (parseErr.error_code === "GENERATION_ALREADY_IN_PROGRESS") {
          throw parseErr;
        }
      }
    }

    const executionId = "EXEC_" + productId + "_" + Utilities.getUuid().substring(0, 8);
    const lockData = JSON.stringify({
      execution_id: executionId,
      started_at: now
    });

    scriptProperties.setProperty(lockKey, lockData);
    return executionId;
  } finally {
    try {
      scriptLock.releaseLock();
    } catch (_) {}
  }
}

/**
 * AIドラフト生成の実行ロックを安全に解除 (指示2: ScriptLock保護)
 * ※引数 executionId が指定されている場合、現在のロックが一致する場合のみ解除し、
 * 後続の新実行を誤って解除しないよう保護する (Superseded Release Protection)
 * @param {string} productId
 * @param {string} [executionId]
 */
function releaseAiDraftExecutionLock_(productId, executionId) {
  const lockKey = "AI_GEN_LOCK_" + productId;
  const scriptLock = LockService.getScriptLock();

  try {
    scriptLock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);
    const props = PropertiesService.getScriptProperties();
    const currentVal = props.getProperty(lockKey);
    if (!currentVal) return;

    if (executionId) {
      try {
        const parsed = JSON.parse(currentVal);
        if (parsed.execution_id !== executionId) {
          console.warn(`[AI Draft] Skip releasing lock for ${productId}: superseded by ${parsed.execution_id}`);
          return;
        }
      } catch (_) {
        // パース失敗時は不正値とみなして削除継続
      }
    }

    props.deleteProperty(lockKey);
  } catch (err) {
    console.error(`[AI Draft] Error during releaseAiDraftExecutionLock_ for ${productId}:`, err);
  } finally {
    try {
      scriptLock.releaseLock();
    } catch (_) {}
  }
}

/**
 * 実行ロックが自分自身の executionId と一致しているか検証
 * @param {string} productId
 * @param {string} executionId
 * @return {boolean}
 */
function verifyAiDraftExecutionLock_(productId, executionId) {
  const lockKey = "AI_GEN_LOCK_" + productId;
  const currentVal = PropertiesService.getScriptProperties().getProperty(lockKey);
  if (!currentVal) return false;
  try {
    const parsed = JSON.parse(currentVal);
    const now = Date.now();
    // 期限検証: TTL を超えていたら失効とみなす
    if (parsed.started_at && now - parsed.started_at > AI_DRAFT_CONFIG.EXECUTION_TTL_MS) {
      console.warn(`[AI Draft] Execution lock expired for ${productId}`);
      return false;
    }
    return parsed.execution_id === executionId;
  } catch (_) {
    return false;
  }
}

/**
 * 指定商品について有効期限内の生成実行ロック (他実行) が存在するか確認 (読取専用)
 * @param {string} productId
 * @return {boolean}
 */
function isAiDraftExecutionInProgress_(productId) {
  const currentVal = PropertiesService.getScriptProperties().getProperty("AI_GEN_LOCK_" + productId);
  if (!currentVal) return false;
  try {
    const parsed = JSON.parse(currentVal);
    return Boolean(parsed.started_at && Date.now() - parsed.started_at < AI_DRAFT_CONFIG.EXECUTION_TTL_MS);
  } catch (_) {
    return false;
  }
}

// ==================================================
// 4. Drive画像取得 & バリデーション
// ==================================================

/**
 * 画像メタデータリストを検証し、枚数・MIME・容量をチェック
 * @param {Array<{ id: string, name: string, mimeType: string, size: number, getBlob: Function }>} fileList
 * @param {string} productId
 * @return {{ images: Array<{ mimeType: string, base64: string, fileId: string, fileName: string }>, imageIds: Array<string> }}
 */
function validateDriveImagesData_(fileList, productId) {
  if (!fileList || fileList.length === 0) {
    const err = new Error("No images found for product: " + productId);
    err.error_code = "NO_IMAGES_FOUND";
    err.preserve_message = true;
    throw err;
  }

  // 4枚以上は拒絶 (最大3枚制限)
  if (fileList.length > AI_DRAFT_CONFIG.MAX_IMAGES) {
    const err = new Error(
      "Image count (" + fileList.length + ") exceeds maximum limit (" +
      AI_DRAFT_CONFIG.MAX_IMAGES + ") for product: " + productId
    );
    err.error_code = "IMAGE_COUNT_EXCEEDED";
    err.preserve_message = true;
    throw err;
  }

  let totalBytes = 0;
  const images = [];
  const imageIds = [];

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const mime = file.mimeType || (typeof file.getMimeType === "function" ? file.getMimeType() : "");

    if (AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.indexOf(mime) === -1) {
      const err = new Error(
        "Unsupported image MIME type '" + mime + "' in file: " + (file.name || file.getName())
      );
      err.error_code = "UNSUPPORTED_MIME_TYPE";
      err.preserve_message = true;
      throw err;
    }

    const fileSize = typeof file.size === "number" ? file.size : file.getSize();
    totalBytes += fileSize;

    if (totalBytes > AI_DRAFT_CONFIG.MAX_TOTAL_IMAGE_BYTES) {
      const err = new Error(
        "Total image size exceeds limit (" +
        AI_DRAFT_CONFIG.MAX_TOTAL_IMAGE_BYTES +
        " bytes) for product: " + productId
      );
      err.error_code = "IMAGE_SIZE_EXCEEDED";
      err.preserve_message = true;
      throw err;
    }

    const blob = typeof file.getBlob === "function" ? file.getBlob() : file.blob;
    const base64 = Utilities.base64Encode(blob.getBytes());
    const fileId = file.id || (typeof file.getId === "function" ? file.getId() : String(i));
    const fileName = file.name || (typeof file.getName === "function" ? file.getName() : "img_" + i);

    images.push({
      mimeType: mime,
      base64: base64,
      fileId: fileId,
      fileName: fileName
    });
    imageIds.push(fileId);
  }

  return { images: images, imageIds: imageIds };
}

/**
 * 商品別AI解析用画像選択 (selected_image_ids) 永続化シート設定
 * 販売用のメイン画像 (AE列) や Drive画像順 (01_main_... 等) を一切変更せず、
 * 商品ごとにスタッフが選択した最大3枚のDriveファイルIDを保持する。
 */
const PRODUCT_AI_IMAGE_SELECTION_CONFIG = {
  SHEET_NAME: "product_ai_image_selections",
  HEADERS: [
    "product_id",
    "selected_image_ids",
    "updated_at"
  ]
};

/**
 * product_ai_image_selections シートを取得または作成
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateProductAiImageSelectionsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PRODUCT_AI_IMAGE_SELECTION_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PRODUCT_AI_IMAGE_SELECTION_CONFIG.SHEET_NAME);
    sheet.appendRow(PRODUCT_AI_IMAGE_SELECTION_CONFIG.HEADERS);
    if (typeof sheet.setFrozenRows === "function") {
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/**
 * シート保存値または配列から selected_image_ids 配列を復元
 * @param {*} raw
 * @return {Array<string>}
 */
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
 * 商品の保存済み AI解析用画像ID一覧を取得（未選択時は空配列 []）
 * @param {string} productId
 * @return {Array<string>}
 */
function getProductAiSelectedImageIds_(productId) {
  const normId = String(productId || "").trim();
  if (!normId) return [];
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return [];
    const selSheet = ss.getSheetByName(PRODUCT_AI_IMAGE_SELECTION_CONFIG.SHEET_NAME);
    if (!selSheet) return [];
    const lastRow = selSheet.getLastRow();
    const lastCol = selSheet.getLastColumn();
    if (lastRow < 2 || lastCol < 2) return [];
    const rows = selSheet.getRange(2, 1, lastRow - 1, Math.min(lastCol, 3)).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || "").trim() === normId) {
        return parseStoredSelectedImageIds_(rows[i][1]);
      }
    }
  } catch (err) {
    console.warn("getProductAiSelectedImageIds_ error for " + normId + ":", err);
  }
  return [];
}

/**
 * 全商品の product_id -> selected_image_ids マップを一括取得（一覧取得時のN+1回避用）
 * @return {Object<string, Array<string>>}
 */
function getProductAiSelectedImagesMap_() {
  const map = {};
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return map;
    const selSheet = ss.getSheetByName(PRODUCT_AI_IMAGE_SELECTION_CONFIG.SHEET_NAME);
    if (!selSheet) return map;
    const lastRow = selSheet.getLastRow();
    const lastCol = selSheet.getLastColumn();
    if (lastRow < 2 || lastCol < 2) return map;
    const rows = selSheet.getRange(2, 1, lastRow - 1, Math.min(lastCol, 3)).getValues();
    for (let i = 0; i < rows.length; i++) {
      const pid = String(rows[i][0] || "").trim();
      if (pid) {
        map[pid] = parseStoredSelectedImageIds_(rows[i][1]);
      }
    }
  } catch (err) {
    console.warn("getProductAiSelectedImagesMap_ error:", err);
  }
  return map;
}

/**
 * 商品ごとの AI解析用選択画像ID (selected_image_ids) を検証して保存する。
 * 販売用メイン画像 (AE列) や Drive内のファイル名・並び順は一切変更しない。
 * 空配列 [] または null が渡された場合は選択を解除（未選択＝先頭3枚使用へ戻す）する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {string} productId
 * @param {Array<string>|null} rawSelectedImageIds
 * @param {Object} [options]
 * @param {boolean} [options.skipDriveValidation] 呼び出し元でDrive所有確認済みの場合のみtrue
 * @return {{ product_id: string, selected_image_ids: Array<string>, updated_at: string }}
 */
function saveProductAiSelectedImageIds_(sheet, productId, rawSelectedImageIds, options) {
  options = options || {};
  const normId = String(productId || "").trim();
  if (!normId) {
    const err = new Error("product_id is required");
    err.error_code = "PRODUCT_ID_REQUIRED";
    err.preserve_message = true;
    throw err;
  }

  const effectiveInput = rawSelectedImageIds === null ? [] : rawSelectedImageIds;
  const normalizedIds = validateSelectedImageIdsSyntax_(effectiveInput, normId);

  const targetRow = findProductRow(sheet, normId);
  const driveFolderUrl = String(sheet.getRange(targetRow, 30).getValue() || "").trim();

  if (normalizedIds.length > 0 && !options.skipDriveValidation) {
    getValidatedProductDriveImages_(normId, driveFolderUrl, normalizedIds, {
      metadata_only: true
    });
  }

  const selSheet = getOrCreateProductAiImageSelectionsSheet_();
  const lastRow = selSheet.getLastRow();
  const nowIso = new Date().toISOString();
  const serialized = normalizedIds.join(",");

  let existingRowIndex = -1;
  if (lastRow >= 2) {
    const rows = selSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || "").trim() === normId) {
        existingRowIndex = i + 2;
        break;
      }
    }
  }

  if (existingRowIndex !== -1) {
    selSheet.getRange(existingRowIndex, 2).setValue(serialized);
    selSheet.getRange(existingRowIndex, 3).setValue(nowIso);
  } else {
    selSheet.appendRow([normId, serialized, nowIso]);
  }

  return {
    product_id: normId,
    selected_image_ids: normalizedIds,
    updated_at: nowIso
  };
}

/**
 * Driveから商品を対象とした画像を安全に取得し検証
 * クライアントまたはバッチ設定から selected_image_ids が指定されている場合、最大3枚まで選択可能。
 * 指定された画像IDが該当商品のDriveフォルダ内に実在し、削除されていないことをbackendで厳格に検証する。
 * 選択画像が後で削除された場合は SELECTED_IMAGE_DELETED を返し、別の画像へ黙って差し替えない。
 *
 * @param {string} productId
 * @param {string} driveFolderUrl
 * @param {Array<string>} [selectedImageIds] 解析対象画像ID一覧（最大3枚、任意）
 * @param {Object} [options]
 * @param {boolean} [options.selection_was_prevalidated] 保存済み・受付時検証済みの選択である場合true（欠損時は削除扱い）
 * @param {boolean} [options.metadata_only] trueの場合、Blob読込を行わず存在・所有・MIME検証のみ実施
 * @return {{ images: Array<{ mimeType: string, base64: string, fileId: string, fileName: string }>, imageIds: Array<string> }}
 */
function getValidatedProductDriveImages_(productId, driveFolderUrl, selectedImageIds, options) {
  options = options || {};
  if (!driveFolderUrl) {
    const err = new Error("Product drive_folder_url is empty for product: " + productId);
    err.error_code = "DRIVE_FOLDER_NOT_FOUND";
    err.preserve_message = true;
    throw err;
  }

  const folderId = extractDriveFolderId(driveFolderUrl);
  if (!folderId) {
    const err = new Error("Invalid drive_folder_url for product: " + productId);
    err.error_code = "INVALID_DRIVE_FOLDER_URL";
    err.preserve_message = true;
    throw err;
  }

  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const rawList = [];
  const fileIdMap = {};
  const trashedFileIdMap = {};
  const docFileIds = typeof getProductDocumentFileIds_ === "function" ? getProductDocumentFileIds_(productId) : new Set();

  while (files.hasNext()) {
    const file = files.next();
    if (docFileIds.has(file.getId())) continue;
    const mime = file.getMimeType();
    if (mime.startsWith("image/")) {
      if (typeof file.isTrashed === "function" && file.isTrashed()) {
        trashedFileIdMap[file.getId()] = file;
        continue;
      }
      rawList.push(file);
      fileIdMap[file.getId()] = file;
    }
  }

  // ファイル名昇順ソート (01_main_... を先頭にする)
  rawList.sort((a, b) => a.getName().localeCompare(b.getName(), "ja", { numeric: true }));

  let targetList = [];

  // 解析対象画像の選択指定がある場合 (指示8 & 一括生成の商品別選択対応)
  if (selectedImageIds !== undefined && selectedImageIds !== null) {
    if (!Array.isArray(selectedImageIds)) {
      validateSelectedImageIdsSyntax_(selectedImageIds, productId);
    }
    if (selectedImageIds.length > 0) {
      const normalizedIds = validateSelectedImageIdsSyntax_(selectedImageIds, productId);
      for (let i = 0; i < normalizedIds.length; i++) {
        const sId = normalizedIds[i];
        const matched = fileIdMap[sId];
        if (!matched) {
          if (trashedFileIdMap[sId] || options.selection_was_prevalidated) {
            const delErr = new Error(
              `Selected image ID '${sId}' for product ${productId} has been deleted or removed from Drive folder. Automatic substitution with another image is not allowed.`
            );
            delErr.error_code = "SELECTED_IMAGE_DELETED";
            delErr.preserve_message = true;
            throw delErr;
          }
          const err = new Error(
            `Selected image ID '${sId}' does not belong to product ${productId} drive folder.`
          );
          err.error_code = "INVALID_IMAGE_SELECTION";
          err.preserve_message = true;
          throw err;
        }
        targetList.push(matched);
      }
    } else {
      // 空配列 [] の場合は未選択扱い（先頭最大3枚）
      targetList = rawList.slice(0, AI_DRAFT_CONFIG.MAX_IMAGES);
    }
  } else {
    // 省略時は先頭最大3枚（既存動作維持）
    targetList = rawList.slice(0, AI_DRAFT_CONFIG.MAX_IMAGES);
  }

  if (options.metadata_only) {
    const checkedIds = [];
    for (let i = 0; i < targetList.length; i++) {
      const file = targetList[i];
      const mime = file.mimeType || (typeof file.getMimeType === "function" ? file.getMimeType() : "");
      if (AI_DRAFT_CONFIG.ALLOWED_MIME_TYPES.indexOf(mime) === -1) {
        const err = new Error(
          "Unsupported image MIME type '" + mime + "' in file: " + (file.name || file.getName())
        );
        err.error_code = "UNSUPPORTED_MIME_TYPE";
        err.preserve_message = true;
        throw err;
      }
      checkedIds.push(file.id || (typeof file.getId === "function" ? file.getId() : String(i)));
    }
    return { images: [], imageIds: checkedIds };
  }

  return validateDriveImagesData_(targetList, productId);
}

// ==================================================
// 5. プロンプト生成 & サニタイズ
// ==================================================

/**
 * AI出品ドラフト生成用システムインストラクション
 * @return {string}
 */
function buildAiDraftSystemInstruction_() {
  return [
    "You are an expert e-commerce catalog specialist and appraiser for high-end sneakers, streetwear, trading cards, and collectibles.",
    "Your objective is to inspect the provided product images and metadata, then generate natural, precise, and faithful listing draft candidates in Japanese and English.",
    "",
    "Strict Generation Rules:",
    "1. NO AUTHENTICITY APPRAISAL OR GUARANTEE TEXT IN LISTING:",
    "   - Items handled here are sourced via authenticated B2B brand auctions; do NOT judge authenticity and do NOT write sentences about authenticity, genuine guarantees, or appraisal in titles or descriptions (e.g., 'Authentic', 'Genuine', '100% Original', '正規品', '本物保証', '正規保証', '鑑定済み正規品').",
    "   - Preserve formal product names, brand names, card editions, and grading company grades (e.g., PSA 10, BGS 9.5) when they are part of the item's official title or grading record.",
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
    "     3) Condition and signs of wear visible in the photos. NEVER assert the condition of unphotographed areas (e.g., unseen back, interior, or tags). Do NOT write boilerplate phrases like 'クリーニング済み' in the description.",
    "     4) Spec block using ONLY '【サイズ】', '【素材】', '【原産国】', '【付属品】' — include ONLY items positively confirmed from physical garment tags, registered metadata, or reliable official specifications of a confirmed model. Include flat measurements (実寸) ONLY when actual measured data is provided; NEVER estimate measurements from photos or copy catalog size charts. Completely OMIT any unconfirmed '【...】' header/line (never write '不明', '未確認', or borrow example values).",
    "     5) Necessary notes (concise, only if needed) at the end of description_ja, and a small number (2–5) of relevant hashtags in hashtags_ja based strictly on confirmed attributes (do NOT duplicate hashtags inside description_ja).",
    "   - MISSING INFO HANDLING: Do NOT fabricate filler sentences or borrow example numbers, conditions, or wording when details are unconfirmed; simply omit unconfirmed items. Insufficient information (e.g., 1 front image with no tag visible) must NEVER cause generation failure.",
    "5. PRICE GROUNDING & TIERED PRICING PROPOSALS:",
    "   - Search specifically for market pricing in JPY for the identified product.",
    "   - Always propose a numeric price whenever pricing or market information is found. Price is a draft proposal for staff review before final approval.",
    "   - Tiered Priority:",
    "     1) Recent sold/completed transactions (成約参考): price_basis: 'recent_sold_provisional', propose numeric price.",
    "     2) Active listings of identical item (販売中参考): price_basis: 'active_listing_reference', propose numeric price. NEVER call active listings 'sold'.",
    "     3) Comparable market evidence / unknown transaction type (市場参考): price_basis: 'market_reference_proposal', propose numeric price.",
    "     4) AI estimation based on category/model (AI概算): price_basis: 'unverified_estimate', propose numeric price.",
    "   - Output price: null ONLY in exceptional cases where the product itself cannot be identified or absolutely no market reference exists anywhere.",
    "6. CONDITION CANDIDATE: Choose from: '新品・未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い'.",
    "   - APPAREL & SHOES (sneaker, apparel, fashion_goods): Evaluate based on post-cleaning appearance. Unless obvious scratches, prominent stains, or clear damage are visible in the photos, propose a good used condition ('目立った傷や汚れなし') and do NOT overly downgrade for minor signs of wear. Do NOT select '新品・未使用' without clear basis (such as unworn tags/packaging). Reflect obvious damage or prominent stains when visible ('やや傷や汚れあり' or '傷や汚れあり'). Never write 'クリーニング済み' in the description.",
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
 * 真贋・正規品保証に関する不要な文・語句を除去し、正式な商品名・ブランド名・PSAグレード等は維持する
 * @param {string} text
 * @param {Object} [options]
 * @return {{ text: string, stripped: boolean, removed_terms: Array<string> }}
 */
function stripAuthenticityGuaranteeText_(text, options) {
  options = options || {};
  const raw = String(text || "");
  if (!raw.trim()) {
    return { text: "", stripped: false, removed_terms: [] };
  }
  const detectedBefore = detectProhibitedWords_(raw);
  if (detectedBefore.length === 0) {
    return { text: raw.trim(), stripped: false, removed_terms: [] };
  }

  const isTitle = Boolean(options.isTitle);
  const isHashtags = Boolean(options.isHashtags);

  if (isHashtags) {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const kept = tokens.filter(tok => detectProhibitedWords_(tok).length === 0);
    return {
      text: kept.join(" ").trim(),
      stripped: true,
      removed_terms: detectedBefore
    };
  }

  const inlineCleaningRules = [
    /[\[【(（]\s*(?:100%\s*)?(?:国内\s*)?(?:確実\s*)?(?:正規品|本物保証|正規保証|真正品|真贋鑑定済(?:み)?|鑑定済(?:み)?正規品|100%\s*(?:authentic|genuine|original)|(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)|(?:authentic(?:ity)?|genuine)\s+(?:guaranteed|verified|certified))\s*[\]】)）]/gi,
    /(?:\b100%\s*|\bguaranteed\s+|\bcertified\s+|\bverified\s+)(?:100%\s*)?\b(?:authentic(?:ity)?|genuine|original)\b(?:\s+(?:guaranteed|product|item|pair|sneakers?|shoes?|apparel|card))?/gi,
    /\b(?:authentic(?:ity)?|genuine)\s+(?:guaranteed|verified|certified)\b/gi,
    /(?:100%\s*)?(?:国内\s*)?(?:確実\s*)?(?:正規品保証|本物保証|正規保証|真正品保証|真贋保証)(?:いたします|します|付き|済)?/g,
    /(?:真贋)?鑑定済(?:み)?(?:の)?(?:国内\s*)?(?:確実\s*)?(?:正規品|本物|真正品)/g,
    /(?:真贋鑑定済(?:み)?)/g,
    /(?:100%\s*)?(?:国内\s*)?(?:確実\s*)?(?:正規品|真正品)(?:です|になります|となります|を保証(?:します|いたします)?|につきご安心ください)?/g,
    /本物(?:です|になります|を保証(?:します|いたします)?)/g
  ];

  const cleanSegment = (seg) => {
    let s = seg;
    inlineCleaningRules.forEach(rx => {
      s = s.replace(rx, " ");
    });
    AI_DRAFT_CONFIG.PROHIBITED_PATTERNS.forEach(pat => {
      const globalPat = new RegExp(
        pat.source,
        pat.flags.indexOf("g") !== -1 ? pat.flags : pat.flags + "g"
      );
      s = s.replace(globalPat, " ");
    });
    s = s
      .replace(/\b(?:is|are|as|a|an)\s+(?:and\s+)?(?:is|are|in|with)\b/gi, " ")
      .replace(/^\s*(?:こちらは|本商品は|当商品は|商品は)\s*(?:、|,)?\s*(?:です|ます|。)*\s*$/g, "")
      .replace(/\(\s*\)|（\s*）|\[\s*\]|【\s*】/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/(?:^[\s、,。・\-/:：]+|[\s、,。・\-/:：]+$)/g, "")
      .trim();
    return s;
  };

  if (isTitle) {
    let cleanedTitle = cleanSegment(raw);
    if (!cleanedTitle) {
      cleanedTitle = raw;
      AI_DRAFT_CONFIG.PROHIBITED_PATTERNS.forEach(pat => {
        const globalPat = new RegExp(
          pat.source,
          pat.flags.indexOf("g") !== -1 ? pat.flags : pat.flags + "g"
        );
        cleanedTitle = cleanedTitle.replace(globalPat, "").trim();
      });
    }
    return {
      text: cleanedTitle || "商品ドラフト",
      stripped: true,
      removed_terms: detectedBefore
    };
  }

  const lines = raw.split(/\r?\n/);
  const cleanedLines = [];
  const pureAuthenticitySentenceRx =
    /^(?:こちらは|本商品は|当商品は|当店では|出品商品は|すべての商品は)?[^。.!！?？\n]*(?:正規品|本物保証|正規保証|真正品|真贋鑑定|鑑定済(?:み)?|100%\s*(?:authentic|genuine|original)|(?:guaranteed|certified|verified)\s+(?:100%\s*)?(?:authentic|genuine|original)|(?:authentic(?:ity)?|genuine)\s+(?:guaranteed|verified|certified))[^。.!！?？\n]*(?:保証(?:します|いたします|付き)?|鑑定済(?:み)?(?:です)?|ご安心(?:ください|下さい)|です|ます|となります|になります)\s*[。.!！?？]?$/i;

  for (let lIdx = 0; lIdx < lines.length; lIdx++) {
    const line = lines[lIdx];
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      cleanedLines.push("");
      continue;
    }
    if (detectProhibitedWords_(trimmedLine).length === 0) {
      cleanedLines.push(line);
      continue;
    }
    const parts = trimmedLine.split(/(?<=[。.!！?？])\s*/);
    const keptParts = [];
    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx].trim();
      if (!part) continue;
      if (detectProhibitedWords_(part).length === 0) {
        keptParts.push(part);
        continue;
      }
      if (pureAuthenticitySentenceRx.test(part)) {
        continue;
      }
      const cleanedPart = cleanSegment(part);
      if (
        cleanedPart &&
        cleanedPart.length >= 4 &&
        !/^(?:です|ます|となります|になります|。|\.)+$/.test(cleanedPart)
      ) {
        const needsPeriod =
          /[。.]$/.test(part) && !/[。.!！?？]$/.test(cleanedPart);
        keptParts.push(
          needsPeriod ? cleanedPart + (part.endsWith("。") ? "。" : ".") : cleanedPart
        );
      }
    }
    if (keptParts.length > 0) {
      cleanedLines.push(keptParts.join(" "));
    }
  }

  const joined = cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: joined,
    stripped: true,
    removed_terms: detectedBefore
  };
}

/**
 * 説明文等から「クリーニング済み」の定型表現を除去する
 * @param {string} text
 * @param {Object} [options]
 * @return {string}
 */
function stripCleaningBoilerplateText_(text, options) {
  options = options || {};
  const raw = String(text || "");
  if (!raw.trim()) return "";
  if (options.isHashtags) {
    return raw
      .split(/\s+/)
      .filter(tok => !/クリーニング済/i.test(tok))
      .join(" ")
      .trim();
  }
  const pureCleaningSentenceRx =
    /^(?:こちらは|本商品は|当商品は|出品にあたり)?\s*(?:専門業者にて|店舗にて|すでに|出品前に)?\s*(?:ホーム)?クリーニング済(?:み)?(?:の商品)?(?:です|となります|になります|となっております)?\s*[。.!！?？]?$/;
  const lines = raw.split(/\r?\n/);
  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      outLines.push("");
      continue;
    }
    if (!/クリーニング済(?:み)?/.test(trimmed)) {
      outLines.push(line);
      continue;
    }
    const parts = trimmed.split(/(?<=[。.!！?？])\s*/);
    const kept = [];
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j].trim();
      if (!part) continue;
      if (pureCleaningSentenceRx.test(part)) continue;
      const cleaned = part
        .replace(/[\[【(（]\s*(?:ホーム)?クリーニング済(?:み)?\s*[\]】)）]/g, "")
        .replace(/(?:専門業者にて|出品前に|すでに)?(?:ホーム)?クリーニング済(?:み)?(?:で(?:す|、)|のため(?:、)?|につき(?:、)?|の状態(?:で|です)?|の商品(?:です)?)/g, "")
        .replace(/(?:ホーム)?クリーニング済(?:み)?/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/(?:^[\s、,。・]+|[\s、,]+$)/g, "")
        .trim();
      if (cleaned && !/^(?:です|ます|。)+$/.test(cleaned)) {
        kept.push(cleaned);
      }
    }
    if (kept.length > 0) {
      outLines.push(kept.join(" "));
    }
  }
  return outLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * アパレル・靴（sneaker / apparel / fashion_goods または衣類相当）の condition 正規化
 * @param {string} rawCondition
 * @param {Object} [context]
 * @return {string}
 */
function normalizeApparelAndShoeCondition_(rawCondition, context) {
  context = context || {};
  const cond = String(rawCondition || "").trim();
  const cat = String(context.category || "").trim().toLowerCase();
  const titleJa = String(context.title_ja || "");
  const descJa = String(context.description_ja || "");
  const titleEn = String(context.title_en || "");
  const descEn = String(context.description_en || "");
  const combinedText = [titleJa, descJa, titleEn, descEn].join(" ");

  const isShoeOrApparel =
    cat === "sneaker" ||
    cat === "apparel" ||
    cat === "fashion_goods" ||
    ((!cat || cat === "other") &&
      /(?:Tシャツ|ロンT|シャツ|カットソー|スウェット|トレーナー|パーカー|フーディー|ニット|セーター|カーディガン|ベスト|ジャケット|コート|ブルゾン|ダウン|パンツ|デニム|ジーンズ|スラックス|ショーツ|スカート|ワンピース|スニーカー|シューズ|ブーツ|\bt-?shirt\b|\btee\b|\bsweatshirt\b|\bhoodie\b|\bsweater\b|\bcardigan\b|\bjacket\b|\bcoat\b|\bpants\b|\bjeans\b|\bdenim\b|\bsneakers?\b|\bshoes?\b)/i.test(
        combinedText
      ));

  if (!isShoeOrApparel) {
    return cond;
  }

  const negatedDamageRx =
    /(?:目立つ|顕著な|大きな|ひどい|気になる|特筆すべき)?(?:傷|キズ|汚れ|ダメージ|シミ|破れ|ほつれ|色褪せ|変色|加水分解|ソールの減り)(?:や(?:傷|キズ|汚れ|ダメージ|シミ|破れ|ほつれ))*(?:は|も)?(?:なく|見当たらず|見受けられず|ございません|ありません|ない|なし)/g;
  const textWithoutNegatedDamage = combinedText.replace(negatedDamageRx, " ");

  const severeDamageRx =
    /(?:大きな(?:傷|汚れ|ダメージ|破れ|穴|シミ)|著しい(?:傷|汚れ|ダメージ|使用感|劣化)|全体的に(?:状態が悪い|汚れ|傷|ダメージ)|加水分解|ソール(?:の)?剥がれ|破れ(?:あり|があり|が見受けられ)|穴あき|\bheavily\s+worn\b|\bsevere\s+damage\b)/i;
  const obviousDamageOrStainRx =
    /(?:目立つ(?:傷|キズ|汚れ|シミ|ダメージ|擦れ|スレ|色褪せ|変色)|顕著な(?:傷|汚れ|シミ|ダメージ|擦れ)|はっきり(?:とした)?(?:汚れ|シミ|傷|ダメージ)|汚れ(?:や傷)?が(?:あり|目立ち|見受けられ)|シミが(?:あり|見受けられ)|傷が(?:あり|目立ち|見受けられ)|擦れが(?:あり|目立ち)|ヒールドラッグ|ソールの(?:大幅な)?減り|\bobvious\s+(?:stain|damage|scuff|scratch)\b|\bprominent\s+stain\b|\bvisible\s+stain\b|\bnoticeable\s+(?:stain|damage|wear|scuff)\b)/i;
  const hasExplicitNewUnusedBasis =
    /(?:新品(?:タグ付|・未使用|未使用)|タグ付き(?:未使用|新品)|未使用品|未着用|試着のみ|デッドストック|\bbrand\s+new\b|\bdeadstock\b|\bunworn\b|\bwith\s+original\s+tags\b|\bnew\s+with\s+tags\b|\bNWT\b)/i.test(
      combinedText
    );
  const hasUsedIndication =
    /(?:多少の使用感|若干の使用感|わずかな使用感|軽微な使用感|使用感|中古品|ユーズド|古着|着用感|\bpre-?owned\b|\bused\b|\bgently\s+used\b|\blightly\s+worn\b)/i.test(
      combinedText
    );
  const minorWearOnlyRx =
    /(?:多少の使用感|若干の使用感|わずかな使用感|軽微な(?:使用感|擦れ|スレ|汚れ)|目立たない程度の|着用に伴う(?:若干の|多少の)?|微細な)/i;

  if (cond === "新品・未使用" && !hasExplicitNewUnusedBasis) {
    return "目立った傷や汚れなし";
  }

  if (cond === "未使用に近い" && hasUsedIndication && !hasExplicitNewUnusedBasis) {
    return "目立った傷や汚れなし";
  }

  if (
    (cond === "やや傷や汚れあり" || cond === "傷や汚れあり") &&
    !obviousDamageOrStainRx.test(textWithoutNegatedDamage) &&
    !severeDamageRx.test(textWithoutNegatedDamage)
  ) {
    return "目立った傷や汚れなし";
  }

  if (
    (cond === "目立った傷や汚れなし" || cond === "未使用に近い") &&
    !minorWearOnlyRx.test(textWithoutNegatedDamage)
  ) {
    if (severeDamageRx.test(textWithoutNegatedDamage)) {
      return "傷や汚れあり";
    }
    if (obviousDamageOrStainRx.test(textWithoutNegatedDamage)) {
      return "やや傷や汚れあり";
    }
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

  const explicitStatus = String(
    rawCostInput.cost_status || rawCostInput.costStatus || ""
  ).trim().toLowerCase();
  if (explicitStatus === "lookup_failed" || rawCostInput.cost_lookup_failed === true) {
    return {
      has_confirmed_links: false,
      confirmed_link_count: 0,
      confirmed_tax_included_cost: null,
      reference_allocated_total: null,
      effective_cost_amount: null,
      all_tax_confirmed: false,
      cost_source: "lookup_failed",
      cost_status: "lookup_failed",
      cost_lookup_error:
        String(rawCostInput.cost_lookup_error || rawCostInput.costLookupError || "").trim() ||
        "documents-relay lookup failed"
    };
  }
  if (explicitStatus === "no_cost") {
    return emptySummary;
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
 * 候補オブジェクトに概算原価への最低上乗せ率（既定30%・下限 = 概算原価 × 1.30 を価格単位で切り上げ）を反映し、
 * Web相場と比較して価格提案を決定する
 * - 原価上乗せ下限価格 P_floor = ceilPriceByPolicy_(概算原価 × (1 + minCostMarkupRate))
 * - 相場価格 P_market >= P_floor なら P_market を採用、そうでなければ P_floor を採用
 * - 既存の粗利率 (min_gross_margin_rate) と混同しないよう、原価への上乗せ率（×1.30 等）・原価比上乗せ率を price_note / cost_calculation に明記
 * - 原価未照合または税額未確定の場合は概算であることとスタッフ最終判断である旨を price_note に明記
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
    const rawMarginFloor = Math.round((costAmount / marginDivisor) * 1e6) / 1e6;
    floorPrice = ceilPriceByPolicy_(rawMarginFloor);
    const costLabel = costSummary.all_tax_confirmed
      ? `確定税込原価（${costAmount}円）`
      : `参考配賦原価（${costAmount}円・税額未確定のため概算）`;

    if (marketPrice !== null && floorPrice !== null && marketPrice >= floorPrice) {
      // 相場価格が最低粗利率下限価格以上のため相場価格を採用
      adoptedPrice = marketPrice;
      decisionSource = "market_above_gross_margin_floor";
      const actualMarginPct = Math.round(((marketPrice - costAmount) / marketPrice) * 1000) / 10;
      const costComparisonNote = costSummary.all_tax_confirmed
        ? `【最低粗利率照合】${costLabel}に対する最低粗利率${marginPct}%の下限価格（${floorPrice}円）を${marketPriceDesc}が上回るため、${adoptedMarketDesc}（${marketPrice}円・粗利率${actualMarginPct}%）を採用しました（原価に基づく提案・最終判断はスタッフが行います）。`
        : `【最低粗利率照合（概算）】${costLabel}に対する最低粗利率${marginPct}%の下限価格（${floorPrice}円・概算）を${marketPriceDesc}が上回るため、${adoptedMarketDesc}（${marketPrice}円・粗利率${actualMarginPct}%）を採用しました（原価・税額未確定のため概算・最終判断はスタッフが行います）。`;

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

      const actualMarginPct = Math.round(((floorPrice - costAmount) / floorPrice) * 1000) / 10;
      const unconfirmedCaveat = costSummary.all_tax_confirmed
        ? "原価に基づく提案であり、最終判断はスタッフが行います。"
        : "原価・税額が未確定のため概算での提案であり、最終判断はスタッフが行います。";

      const floorNote = (marketPrice !== null)
        ? `【最低粗利率下限価格採用${costSummary.all_tax_confirmed ? "" : "（概算）"}】${marketPriceDesc}が${costLabel}に対する最低粗利率${marginPct}%の下限価格（${floorPrice}円）を下回るため、下限価格（${floorPrice}円・粗利率${actualMarginPct}%）を提案します。${unconfirmedCaveat}`
        : `【最低粗利率下限価格採用（相場未確認${costSummary.all_tax_confirmed ? "" : "・概算"}）】有効な個別商品のWeb相場が未確認のため、${costLabel}に対する最低粗利率${marginPct}%の下限価格（${floorPrice}円・粗利率${actualMarginPct}%）を相場未確認の価格案として提案します。${unconfirmedCaveat}`;

      candidate.price_note = existingNote ? `${floorNote} [価格根拠確認メモ: ${existingNote}]` : floorNote;
    }
  } else {
    // 仕入原価未取得（lookup_failed）または原価なし（no_cost）商品:
    // - 確定原価がないため価格下限は計算せず（0円原価の補完もしない）、相場情報がある場合は相場に基づく価格案を作る
    // - 有効な相場がなく価格未設定(null)の場合は未設定のままスタッフ判断に委ねる
    const isLookupFailed = costSummary.cost_status === "lookup_failed";
    decisionSource = isLookupFailed ? "market_cost_lookup_failed" : "market_unmatched";
    if (candidate.needs_review.indexOf("price") === -1) {
      candidate.needs_review.push("price");
    }
    if (marketPrice === null) {
      const unmatchedNoPriceNote = isLookupFailed
        ? "【価格未設定（相場未確認・原価未取得）】有効な個別商品のWeb相場が未確認であり、仕入原価も未取得（通信タイムアウト等）のため価格は未設定です。スタッフの判断で価格を設定してください。"
        : "【価格未設定（相場未確認・原価未照合）】有効な個別商品のWeb相場が未確認であり、仕入原価も未照合のため価格は未設定です。スタッフの判断で価格を設定してください。";
      if (existingNote.indexOf("原価未照合") === -1 && existingNote.indexOf("原価未取得") === -1 && existingNote.indexOf("仕入原価が未確定") === -1) {
        candidate.price_note = existingNote ? `${existingNote} ${unmatchedNoPriceNote}` : unmatchedNoPriceNote;
      }
    } else {
      const unmatchedNote = isLookupFailed
        ? (isUngroundedAiEstimate
            ? "【原価未取得（概算）】仕入原価が未取得かつWeb相場も未確認のためAI概算による参考価格提案です。価格下限は未適用のため、最終判断はスタッフが行います。"
            : "【原価未取得（相場参照）】仕入原価が未取得のため価格下限は適用せず、Web相場参照値に基づく価格提案です。最終判断はスタッフが行います。")
        : (isUngroundedAiEstimate
            ? "【原価未照合（概算）】仕入原価が未確定（未照合）かつWeb相場も未確認のためAI概算による参考価格提案です。最終判断はスタッフが行います。"
            : "【原価未照合（概算）】仕入原価が未確定（未照合）のためWeb相場参照値に基づく概算価格提案です。最終判断はスタッフが行います。");
      if (existingNote.indexOf("原価未照合") === -1 && existingNote.indexOf("原価未取得") === -1 && existingNote.indexOf("仕入原価が未確定") === -1) {
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
    min_cost_markup_rate: minGrossMarginRate,
    min_gross_margin_rate: minGrossMarginRate,
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
 * 候補レスポンスのバリデーション
 * 自動置換（「公式仕様」等への置換で新しい断定を作ること）は行わず、
 * 禁止語が検知された場合は候補検証エラー（PROHIBITED_WORDS_DETECTED）としてフェイルクローズにする。
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

  let titleJa = String(rawCandidate.title_ja || "").trim();
  let descJa = String(rawCandidate.description_ja || "").trim();
  let titleEn = String(rawCandidate.title_en || "").trim();
  let descEn = String(rawCandidate.description_en || "").trim();
  let condition = String(rawCandidate.condition || "").trim();
  let hashtags = String(rawCandidate.hashtags_ja || "").trim();

  if (!titleJa) {
    const err = new Error("[AI Draft] LLM candidate is missing required 'title_ja'.");
    err.error_code = "MISSING_TITLE_JA";
    throw err;
  }

  // 真贋や真贋保証に関する不要な文・表現が含まれた場合は、それだけで失敗にせず当該文・語句を除去して保存する
  // また「クリーニング済み」の自動記載も除去する
  titleJa = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(titleJa, { isTitle: true }).text
  );
  descJa = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(descJa).text
  );
  titleEn = stripAuthenticityGuaranteeText_(titleEn, { isTitle: true }).text;
  descEn = stripAuthenticityGuaranteeText_(descEn).text;
  hashtags = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(hashtags, { isHashtags: true }).text,
    { isHashtags: true }
  );

  if (!descJa) {
    descJa = titleJa;
  }
  if (!titleEn) {
    titleEn = titleJa;
  }
  if (!descEn) {
    descEn = titleEn;
  }

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

  condition = normalizeApparelAndShoeCondition_(condition, {
    category: normCategory,
    title_ja: titleJa,
    description_ja: descJa,
    title_en: titleEn,
    description_en: descEn
  });

  // ポケカ固有属性の抽出とサニタイズ
  let pokeData = null;
  const hasBackImage = Boolean(options.has_back_image);

  let finalCondition = condition;
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
    pokemon_card: pokeData
  };
}

/**
 * AI出品ドラフト生成専用のモデル名を取得
 * 1. Script Properties の "AI_DRAFT_MODEL" が設定されていればそれを優先
 * 2. なければ AI_DRAFT_CONFIG.DEFAULT_MODEL ("gemini-3.8-flash") を適用
 * (※既存翻訳用の共有 LLM_MODEL は変更せず、影響を与えません)
 * @return {string}
 */
function getAiDraftModelName_() {
  const customModel = PropertiesService
    .getScriptProperties()
    .getProperty(AI_DRAFT_CONFIG.MODEL_PROPERTY);
  const trimmed = String(customModel || "").trim();
  // 移行期モデル (gemini-3.5-flash-lite) が Script Property に残存している場合、
  // 承認済み方針 (gemini-3.8-flash 必須) に従って gemini-3.8-flash を返却しプロパティも自己修復
  if (trimmed === "gemini-3.5-flash-lite") {
    try {
      PropertiesService.getScriptProperties().setProperty(AI_DRAFT_CONFIG.MODEL_PROPERTY, AI_DRAFT_CONFIG.DEFAULT_MODEL);
    } catch (_) {}
    return AI_DRAFT_CONFIG.DEFAULT_MODEL;
  }
  return trimmed || AI_DRAFT_CONFIG.DEFAULT_MODEL;
}

/**
 * AI出品ドラフト生成専用の予備モデル名を取得
 * 1. Script Properties の "AI_DRAFT_FALLBACK_MODEL" が設定されていればそれを優先
 * 2. なければ AI_DRAFT_CONFIG.FALLBACK_MODEL ("gemini-3.5-flash-lite") を適用
 * @return {string}
 */
function getAiDraftFallbackModelName_() {
  const customFallback = PropertiesService
    .getScriptProperties()
    .getProperty(AI_DRAFT_CONFIG.FALLBACK_MODEL_PROPERTY);
  return String(customFallback || "").trim() || AI_DRAFT_CONFIG.FALLBACK_MODEL;
}

/**
 * AI出品ドラフトモデル設定を確認・取得する
 * Script Properties に AI_DRAFT_MODEL が設定されている場合はその値を確認。
 * 翻訳用 LLM_MODEL は一切変更せず、現在の状態をログ出力・返却する。
 * @return {{ai_draft_model: string, ai_draft_fallback_model: string, llm_translation_model: string}}
 */
function checkAiDraftModelSetting_() {
  const props = PropertiesService.getScriptProperties();
  const rawAiDraft = props.getProperty(AI_DRAFT_CONFIG.MODEL_PROPERTY);
  const rawFallback = props.getProperty(AI_DRAFT_CONFIG.FALLBACK_MODEL_PROPERTY);
  const rawTranslation = props.getProperty(LLM_TRANSLATION_CONFIG.MODEL_PROPERTY);

  // もし Script Properties の AI_DRAFT_MODEL に旧モデル (gemini-3.5-flash-lite等) が設定されていた場合、
  // メインモデル指示 (gemini-3.8-flash) と整合させるため更新
  if (rawAiDraft && rawAiDraft !== AI_DRAFT_CONFIG.DEFAULT_MODEL) {
    console.warn(`[AI Draft Setting] Script Property '${AI_DRAFT_CONFIG.MODEL_PROPERTY}' was '${rawAiDraft}'. Updating to '${AI_DRAFT_CONFIG.DEFAULT_MODEL}'.`);
    props.setProperty(AI_DRAFT_CONFIG.MODEL_PROPERTY, AI_DRAFT_CONFIG.DEFAULT_MODEL);
  }

  const rawSearch = props.getProperty(AI_DRAFT_CONFIG.ENABLE_SEARCH_GROUNDING_PROPERTY);
  if (rawSearch !== "true") {
    props.setProperty(AI_DRAFT_CONFIG.ENABLE_SEARCH_GROUNDING_PROPERTY, "true");
  }
  const rawMode = props.getProperty(AI_DRAFT_CONFIG.SEARCH_GROUNDING_MODE_PROPERTY);
  if (rawMode !== "two_stage") {
    props.setProperty(AI_DRAFT_CONFIG.SEARCH_GROUNDING_MODE_PROPERTY, "two_stage");
  }

  const effectiveMain = getAiDraftModelName_();
  const effectiveFallback = getAiDraftFallbackModelName_();
  const effectiveTrans = getLlmModelName_();

  console.log("[AI Draft Model Setting Check]");
  console.log("  AI_DRAFT_MODEL (Script Property): " + (rawAiDraft ? `'${rawAiDraft}'` : "(未設定 / DEFAULT適用)"));
  console.log("  AI_DRAFT_FALLBACK_MODEL (Script Property): " + (rawFallback ? `'${rawFallback}'` : "(未設定 / FALLBACK適用)"));
  console.log("  LLM_MODEL (翻訳用・未変更): " + (rawTranslation ? `'${rawTranslation}'` : "(未設定 / デフォルト適用)"));
  console.log("  適用中 AI メインモデル: '" + effectiveMain + "'");
  console.log("  適用中 AI 予備モデル: '" + effectiveFallback + "'");
  console.log("  適用中 翻訳モデル: '" + effectiveTrans + "'");

  return {
    ai_draft_model: effectiveMain,
    ai_draft_fallback_model: effectiveFallback,
    llm_translation_model: effectiveTrans
  };
}

/**
 * 検索グラウンディング機能が有効化されているか判定 (Web検索必須方針のため既定はtrue)
 * @return {boolean}
 */
function isAiDraftSearchGroundingEnabled_() {
  const prop = PropertiesService
    .getScriptProperties()
    .getProperty(AI_DRAFT_CONFIG.ENABLE_SEARCH_GROUNDING_PROPERTY);
  if (prop === null || prop === undefined || String(prop).trim() === "") {
    return AI_DRAFT_CONFIG.DEFAULT_SEARCH_GROUNDING_ENABLED; // true
  }
  return String(prop || "").trim().toLowerCase() !== "false" && prop !== "0";
}

/**
 * 検索グラウンディングの実行モードを取得 (既定: "two_stage")
 * @return {string}
 */
function getAiDraftSearchGroundingMode_() {
  const prop = PropertiesService
    .getScriptProperties()
    .getProperty(AI_DRAFT_CONFIG.SEARCH_GROUNDING_MODE_PROPERTY);
  const normalized = String(prop || "").trim().toLowerCase();
  if (normalized === "two_stage" || normalized === "single") {
    return normalized;
  }
  return AI_DRAFT_CONFIG.DEFAULT_SEARCH_GROUNDING_MODE; // "two_stage"
}

/**
 * Gemini マルチモーダル API を呼び出して構造化ドラフト候補を取得
 * 主モデルで503が継続した場合に一度だけ固定予備モデル (gemini-3.5-flash-lite) へ自動切替
 * @param {Array<Object>} images
 * @param {Object} productMeta
 * @param {string} [overrideModel] 指定モデル名 (単体検証用、省略時は getAiDraftModelName_())
 * @return {Object}
 */
function callGeminiMultimodalAiDraft_(images, productMeta, overrideModel, options) {
  options = options || {};
  const apiKey = getLlmApiKey_();
  const primaryModel = String(overrideModel || "").trim() || getAiDraftModelName_();
  // overrideModel が明示指定された単体検証時は予備モデルへの切替を行わない
  const isDedicatedOverride = Boolean(overrideModel && overrideModel !== getAiDraftModelName_());
  const fallbackModel = isDedicatedOverride ? null : getAiDraftFallbackModelName_();

  const existingSku = String(productMeta.sneakerSku || "").trim();
  const safeExistingSku = /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingSku) ? "" : existingSku;

  const promptText = [
    "Analyze the attached product images and the following metadata to generate listing draft candidates:",
    `- Product ID: ${productMeta.productId}`,
    `- Existing Category: ${productMeta.category || "Unspecified"}`,
    `- Existing Brand: ${productMeta.brand || "Unspecified"}`,
    `- Existing Name: ${productMeta.productName || "Unspecified"}`,
    `- Existing SKU: ${safeExistingSku || "Unspecified"}`,
    "",
    "Note on SKU: Confirm the SKU strictly from the attached images. If not confirmed from images, output an empty string (\"\") for sku. Do NOT fill with 'TEST' or any placeholder.",
    "",
    "Follow all system instructions strictly. Return valid JSON."
  ].join("\n");

  const parts = [{ text: promptText }];

  images.forEach(img => {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    });
  });

  const payload = {
    contents: [{ role: "user", parts: parts }],
    systemInstruction: {
      parts: [{ text: buildAiDraftSystemInstruction_() }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: buildAiDraftResponseSchema_(),
      temperature: 0.2,
      maxOutputTokens: 2048
    }
  };

  const requestOptions = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-goog-api-key": apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const retryableStatuses = [429, 500, 502, 503, 504];
  const initialDelayMs = 1500;
  const maxElapsedLimitMs = 45000; // 90秒/Web App上限を考慮した全体の最大許容所要時間 (45秒)
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
    const isFallback = (mIdx > 0);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent`;
    const maxModelAttempts = isFallback ? 1 : 2; // 主モデルは初回+再試行1回、予備モデルは1回

    if (isFallback) {
      console.warn(`[AI Draft] 主モデル '${primaryModel}' で再試行可能エラーが継続したため、予備モデル '${currentModel}' へ一度だけ切り替えます。`);
    }

    let modelSuccess = false;

    for (let attempt = 0; attempt < maxModelAttempts; attempt++) {
      const elapsedSoFar = Date.now() - callStartTime;
      if (elapsedSoFar >= maxElapsedLimitMs) {
        console.warn(`[AI Draft] 実行制限時間に接近 (${elapsedSoFar}ms経過)。追加呼出しを中止します。`);
        break;
      }

      let response;
      let statusCode = 0;
      let bodyText = "";

      try {
        response = UrlFetchApp.fetch(endpoint, requestOptions);
        statusCode = response.getResponseCode();
        bodyText = response.getContentText();
      } catch (netErr) {
        lastStatusCode = 0;
        console.error(`[AI Draft] 通信例外 (${currentModel}, 試行 ${attempt + 1}/${maxModelAttempts}): ${netErr.message}`);
        const elapsedAfter = Date.now() - callStartTime;
        if (attempt + 1 < maxModelAttempts && elapsedAfter + initialDelayMs < maxElapsedLimitMs) {
          Utilities.sleep(initialDelayMs);
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
        } catch (pErr) {
          console.error(`[AI Draft] JSONパース失敗 (${currentModel}): ${pErr.message}`);
          break;
        }
      }

      // エラー詳細パース
      let errorDetails = { code: statusCode, status: "UNKNOWN", message: "" };
      try {
        const errJson = JSON.parse(bodyText);
        if (errJson && errJson.error) {
          errorDetails.code = errJson.error.code || statusCode;
          errorDetails.status = errJson.error.status || "UNKNOWN";
          errorDetails.message = String(errJson.error.message || "").replace(/key=[^&\s]+/gi, "key=[REDACTED]");
        }
      } catch (_) {
        errorDetails.message = bodyText.substring(0, 300);
      }

      const totalElapsed = Date.now() - callStartTime;
      console.warn(
        `[AI Draft] LLM HTTPエラー (${currentModel}, 試行 ${attempt + 1}/${maxModelAttempts}, 経過 ${totalElapsed}ms, HTTP ${statusCode}): ` +
        `code=${errorDetails.code}, status='${errorDetails.status}', message='${errorDetails.message}'`
      );

      // リトライ判定 (503 等の retryableStatuses かつ 実行制限時間内)
      if (retryableStatuses.includes(statusCode) && attempt + 1 < maxModelAttempts) {
        const waitMs = initialDelayMs * (attempt + 1);
        if (totalElapsed + waitMs < maxElapsedLimitMs) {
          console.warn(`[AI Draft] HTTP ${statusCode} は再試行可能です。${waitMs}ms待機後に再試行します...`);
          Utilities.sleep(waitMs);
          continue;
        }
      }

      // 非リトライ可能、または回数上限到達
      break;
    }

    if (modelSuccess) {
      break; // いずれかのモデルで成功したらモデルループ終了
    }
  }

  if (!parsed) {
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = lastStatusCode ? `LLM_HTTP_ERROR_${lastStatusCode}` : "LLM_COMMUNICATION_FAILED";
    throw err;
  }

  const candidate = parsed.candidates && parsed.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    console.error("[AI Draft] Empty content returned by LLM");
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = "EMPTY_LLM_RESPONSE";
    throw err;
  }

  const nonThoughtParts = candidate.content.parts.filter(p => !p.thought && typeof p.text === "string" && p.text.trim().length > 0);
  const rawText = nonThoughtParts.length > 0
    ? nonThoughtParts.map(p => p.text).join("")
    : candidate.content.parts.filter(p => typeof p.text === "string").map(p => p.text).join("");

  let rawJson;
  try {
    rawJson = JSON.parse(rawText);
  } catch (jErr) {
    console.error("[AI Draft] Failed to parse candidate structure from LLM output: " + rawText.substring(0, 200));
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = "STRUCTURED_PARSE_FAILED";
    throw err;
  }

  const sanitized = validateAndSanitizeDraftCandidate_(rawJson, {
    image_count: images.length,
    has_back_image: Boolean(options && options.has_back_image),
    productMeta: productMeta
  });
  sanitized.actual_model_name = actuallyUsedModel;
  return sanitized;
}

// ==================================================
// 5.5 検索グラウンディング (Google Search Grounding) 連携モジュール
// ==================================================

/**
 * Gemini API レスポンスの groundingMetadata から安全に検索証跡を抽出
 * @param {Object} candidateObj APIレスポンスの candidate オブジェクト
 * @return {{search_executed: boolean, queries: Array<string>, sources: Array<{url: string, title: string}>}}
 */
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

/**
 * 1回方式: Google Search tool と responseSchema を同一リクエストで実行
 *
 * @param {Array<Object>} images
 * @param {Object} productMeta
 * @param {string} modelName
 * @param {Object} [options]
 * @return {{success: boolean, candidate?: Object, grounding?: Object, is_schema_unsupported?: boolean, status_code?: number, error_code?: string, error_message?: string}}
 */
function callGeminiSingleRequestSearchGrounding_(images, productMeta, modelName, options) {
  options = options || {};
  const apiKey = getLlmApiKey_();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;

  const existingSku = String(productMeta.sneakerSku || "").trim();
  const safeExistingSku = /^(?:test|test[\s_-]?sku|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingSku) ? "" : existingSku;

  const ignoreIdentity = Boolean(options.ignore_existing_identity);
  const metaName = ignoreIdentity ? "Unspecified (diagnose from visual features)" : (productMeta.productName || "Unspecified");
  const metaSku = ignoreIdentity ? "Unspecified (diagnose from visual features)" : (safeExistingSku || "Unspecified");

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
    "- STRICT SKU PROTECTION: Output an empty string (\"\") for sku unless directly legible on a label/tag image.",
    "Return valid JSON adhering to the response schema."
  ].join("\n");

  const parts = [{ text: promptText }];
  images.forEach(img => {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64
      }
    });
  });

  const payload = {
    contents: [{ role: "user", parts: parts }],
    tools: [{ google_search: {} }],
    systemInstruction: {
      parts: [{ text: buildSearchGroundingSystemInstruction_() }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: buildAiDraftResponseSchema_(),
      temperature: 0.2,
      maxOutputTokens: 2048
    }
  };

  let response;
  let statusCode = 0;
  let bodyText = "";

  try {
    response = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    statusCode = response.getResponseCode();
    bodyText = response.getContentText();
  } catch (netErr) {
    const err = new Error(`[AI Draft Single Grounding] Network exception: ${netErr.message}`);
    err.error_code = "LLM_COMMUNICATION_FAILED";
    throw err;
  }

  if (statusCode === 200) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (jErr) {
      console.error("[AI Draft Single Grounding] JSON parse failure: " + jErr.message);
      return { success: false, status_code: 200, error_code: "STRUCTURED_PARSE_FAILED", error_message: jErr.message };
    }

    const candObj = parsed.candidates && parsed.candidates[0];
    if (!candObj || !candObj.content || !candObj.content.parts || candObj.content.parts.length === 0) {
      return { success: false, status_code: 200, error_code: "EMPTY_LLM_RESPONSE", error_message: "Empty candidate parts" };
    }

    const nonThought = candObj.content.parts.filter(p => !p.thought && typeof p.text === "string" && p.text.trim().length > 0);
    const rawText = nonThought.length > 0
      ? nonThought.map(p => p.text).join("")
      : candObj.content.parts.filter(p => typeof p.text === "string").map(p => p.text).join("");

    let rawJson;
    try {
      rawJson = JSON.parse(rawText);
    } catch (sErr) {
      console.error("[AI Draft Single Grounding] Structured JSON parse failed: " + rawText.substring(0, 200));
      return { success: false, status_code: 200, error_code: "STRUCTURED_PARSE_FAILED", error_message: sErr.message };
    }

    const sanitized = validateAndSanitizeDraftCandidate_(rawJson, {
      image_count: images.length,
      has_back_image: Boolean(options && options.has_back_image),
      productMeta: productMeta
    });
    sanitized.actual_model_name = modelName;

    const grounding = extractGroundingMetadata_(candObj);
    if (!grounding.search_executed) {
      return {
        success: false,
        status_code: 200,
        error_code: "SEARCH_GROUNDING_NOT_EXECUTED",
        error_message: "Web search was not executed by model (0 search queries generated)",
        grounding: grounding
      };
    }
    if (grounding.sources.length === 0) {
      return {
        success: false,
        status_code: 200,
        error_code: "SEARCH_GROUNDING_NOT_EXECUTED",
        error_message: "Search queries generated but 0 grounding sources returned (unconfirmed match)",
        grounding: grounding
      };
    }
    return {
      success: true,
      status_code: 200,
      candidate: sanitized,
      grounding: grounding
    };
  }

  // 非200応答の解析
  let errDetail = { code: statusCode, status: "UNKNOWN", message: "" };
  try {
    const errJson = JSON.parse(bodyText);
    if (errJson && errJson.error) {
      errDetail.code = errJson.error.code || statusCode;
      errDetail.status = errJson.error.status || "UNKNOWN";
      errDetail.message = String(errJson.error.message || "").replace(/key=[^&\s]+/gi, "key=[REDACTED]");
    }
  } catch (_) {
    errDetail.message = bodyText.substring(0, 300);
  }

  // 429 や 5xx は一時エラー（クォータ・通信エラー）であり、「1回方式が非対応」の証拠ではない
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
    const err = new Error(`[AI Draft Single Grounding] Transient error HTTP ${statusCode}: ${errDetail.message}`);
    err.error_code = `LLM_HTTP_ERROR_${statusCode}`;
    err.status_code = statusCode;
    err.error_details = errDetail;
    throw err;
  }

  // 400 (INVALID_ARGUMENT 等): tools と responseSchema の併用制限・スキーマ不適合判定
  // 注意: 原因不明の一般的な 400 (プロンプト不正・画像不正等) をスキーマ非互換と誤判定して隠蔽しないよう、
  // 明示的な tools/schema 併用非互換シグネチャに厳格に一致した場合のみ判定する
  const schemaConflictPatterns = [
    /tools?\s*(?:are\s*)?not\s*supported\s*with\s*(?:responseSchema|response_schema|structured\s*output|responseMimeType|response_mime_type)/i,
    /(?:responseSchema|response_schema|structured\s*output)\s*(?:is\s*)?not\s*supported\s*with\s*tools?/i,
    /cannot\s*use\s*tools?\s*with\s*(?:responseSchema|structured\s*output)/i,
    /google_?search\s*(?:is\s*)?not\s*supported\s*with\s*(?:responseSchema|json)/i,
    /tool\s*use\s*is\s*not\s*supported\s*in\s*json\s*mode/i
  ];
  const isSchemaUnsupported = schemaConflictPatterns.some(pat => pat.test(errDetail.message));

  return {
    success: false,
    status_code: statusCode,
    is_schema_unsupported: isSchemaUnsupported,
    error_code: `LLM_HTTP_ERROR_${statusCode}`,
    error_message: errDetail.message,
    error_details: errDetail
  };
}

/**
 * 2段階方式:
 * Stage A: tools (google_search) + 自由形式テキストで検索＆画像照合
 * Stage B: Stage A の特定根拠を元に responseSchema 付きで構造化JSON生成 (toolsなし)
 *
 * @param {Array<Object>} images
 * @param {Object} productMeta
 * @param {string} modelName
 * @param {Object} [options]
 * @return {{success: boolean, candidate: Object, grounding: Object, stage_a_text: string, stage_a_elapsed_ms: number, stage_b_elapsed_ms: number, stage_a_finish_reason: string, stage_a_usage: Object, stage_b_usage: Object}}
 */
function callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options) {
  options = options || {};
  const apiKey = getLlmApiKey_();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;

  // プロンプト浄化: 既存の商品名やSKUをモデル入力から排除し、
  // 画像から自律的に特徴・文字を観察して検索させる (スタッフ入力のSKU・価格・サイズを保護)
  const safeBrand = String(productMeta.brand || "").trim();
  const safeCategory = String(productMeta.category || "").trim();

  // --------------------------------------------------
  // Pre-Stage: 画像先行カテゴリー判定 (Prior Category Detection)
  // --------------------------------------------------
  const priorClass = options.prior_classification || classifyCategoryPriorFromImages_(images, productMeta, modelName, options);
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
    "You are an expert product authenticator, catalog specialist, and market appraiser.",
    "Carefully examine the attached product images. Do NOT make assumptions based on brand alone.",
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
    stageARes = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(stageAPayload),
      muteHttpExceptions: true
    });
    stageACode = stageARes.getResponseCode();
    stageABody = stageARes.getContentText();
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
    dedicatedSearchResult = fetchDedicatedPriceSearch_(queryContext, apiKey, modelName);
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
    stageBRes = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(stageBPayload),
      muteHttpExceptions: true
    });
    stageBCode = stageBRes.getResponseCode();
    stageBBody = stageBRes.getContentText();
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
function callGeminiMultimodalAiDraftWithSearch_(images, productMeta, overrideModel, options) {
  options = options || {};
  const modelName = String(overrideModel || "").trim() || getAiDraftModelName_();
  const mode = String(options.search_mode || "").trim() || getAiDraftSearchGroundingMode_();

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
    const singleResult = callGeminiSingleRequestSearchGrounding_(images, productMeta, modelName, options);
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
      singleResult = callGeminiSingleRequestSearchGrounding_(images, productMeta, modelName, options);
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
        const twoStageResult = callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options);
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
    const twoStageResult = callGeminiTwoStageSearchGrounding_(images, productMeta, modelName, options);
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

// ==================================================
// 6. ドラフト取得・版管理ヘルパー
// ==================================================

/**
 * product_ai_drafts シートから該当 product_id の最新レコードを取得
 * @param {string} productId
 * @return {Object|null}
 */
function getLatestProductAiDraft_(productId) {
  const normId = String(productId || "").trim();
  if (!normId) return null;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const draftSheet = spreadsheet.getSheetByName(AI_DRAFT_CONFIG.SHEET_NAME);

  if (!draftSheet) return null;

  const lastRow = draftSheet.getLastRow();
  const lastCol = draftSheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return null;

  const headers = draftSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const pIdIdx = headers.indexOf("product_id");
  if (pIdIdx === -1) return null;

  const rows = draftSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (String(row[pIdIdx] || "").trim() === normId) {
      const obj = {};
      headers.forEach((h, colIdx) => {
        obj[h] = row[colIdx];
      });
      return {
        row_number: i + 2,
        draft_id: String(obj.draft_id || "").trim(),
        product_id: String(obj.product_id || "").trim(),
        draft_version: Number(obj.draft_version || 1),
        review_status: String(obj.review_status || "pending_review").trim(),
        candidate_title_ja: String(obj.candidate_title_ja || "").trim(),
        candidate_hashtags_ja: String(obj.candidate_hashtags_ja || "").trim(),
        candidate_description_ja: String(obj.candidate_description_ja || "").trim(),
        candidate_title_en: String(obj.candidate_title_en || "").trim(),
        candidate_description_en: String(obj.candidate_description_en || "").trim(),
        candidate_condition: String(obj.candidate_condition || "").trim(),
        candidate_price: (obj.candidate_price === "" || obj.candidate_price === null || obj.candidate_price === undefined)
          ? null
          : (Number.isFinite(Number(obj.candidate_price)) && Number(obj.candidate_price) > 0 ? Math.floor(Number(obj.candidate_price)) : null),
        candidate_category: String(obj.candidate_category || "").trim(),
        candidate_brand: String(obj.candidate_brand || "").trim(),
        candidate_sku: String(obj.candidate_sku || "").trim(),
        candidate_size: String(obj.candidate_size || "").trim(),
        source_fingerprint: String(obj.source_fingerprint || "").trim(),
        source_image_fingerprint: String(obj.source_image_fingerprint || "").trim(),
        confirmed_fingerprint: String(obj.confirmed_fingerprint || "").trim(),
        source_image_ids: String(obj.source_image_ids || "").trim(),
        model_name: String(obj.model_name || "").trim(),
        generated_at: obj.generated_at instanceof Date ? obj.generated_at.toISOString() : String(obj.generated_at || ""),
        confirmed_at: obj.confirmed_at instanceof Date ? obj.confirmed_at.toISOString() : String(obj.confirmed_at || ""),
        confirmed_by: String(obj.confirmed_by || "").trim(),
        last_confirmation_attempt_id: String(obj.last_confirmation_attempt_id || "").trim(),
        last_confirmation_payload_hash: String(obj.last_confirmation_payload_hash || "").trim(),
        search_grounding_enabled: String(obj.search_grounding_enabled || "").toLowerCase() === "true",
        search_grounding_mode: String(obj.search_grounding_mode || "").trim(),
        search_executed: String(obj.search_executed || "").toLowerCase() === "true",
        search_queries: String(obj.search_queries || "").trim() ? String(obj.search_queries).split(",").map(q => q.trim()).filter(Boolean) : [],
        candidate_price_basis: String(obj.candidate_price_basis || "").trim(),
        candidate_price_note: String(obj.candidate_price_note || "").trim(),
        candidate_sku_source: String(obj.candidate_sku_source || "").trim(),
        candidate: {
          title_ja: String(obj.candidate_title_ja || "").trim(),
          hashtags_ja: String(obj.candidate_hashtags_ja || "").trim(),
          description_ja: String(obj.candidate_description_ja || "").trim(),
          title_en: String(obj.candidate_title_en || "").trim(),
          description_en: String(obj.candidate_description_en || "").trim(),
          condition: String(obj.candidate_condition || "").trim(),
          price: (obj.candidate_price === "" || obj.candidate_price === null || obj.candidate_price === undefined)
            ? null
            : (Number.isFinite(Number(obj.candidate_price)) && Number(obj.candidate_price) > 0 ? Math.floor(Number(obj.candidate_price)) : null),
          price_note: String(obj.candidate_price_note || "").trim() || "AIによる概算価格です",
          price_basis: String(obj.candidate_price_basis || "").trim(),
          category: String(obj.candidate_category || "").trim(),
          brand: String(obj.candidate_brand || "").trim(),
          sku: String(obj.candidate_sku || "").trim(),
          sku_source: String(obj.candidate_sku_source || "").trim(),
          size: String(obj.candidate_size || "").trim(),
          search_grounding: {
            enabled: String(obj.search_grounding_enabled || "").toLowerCase() === "true",
            mode_used: String(obj.search_grounding_mode || "").trim(),
            search_executed: String(obj.search_executed || "").toLowerCase() === "true",
            queries: String(obj.search_queries || "").trim() ? String(obj.search_queries).split(",").map(q => q.trim()).filter(Boolean) : []
          }
        }
      };
    }
  }

  return null;
}

// ==================================================
// 7. メイン処理: AIドラフト生成 (generate_ai_product_draft)
// ==================================================

/**
 * AI生成候補オブジェクトを商品マスター本票、英文翻訳、ポケカ属性へ下書き反映し、確定指紋を算出
 * (手動確定を経ずに下書きへ安全に反映)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート (Sheets[0])
 * @param {number} targetRow 対象商品の行番号
 * @param {string} productId 商品ID
 * @param {Object} candidate AI生成候補オブジェクト
 * @return {{ confirmedFingerprint: string }}
 */
function applyCandidateToProduct_(sheet, targetRow, productId, candidate) {
  candidate = candidate || {};
  const maxCols = (typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 43)
    ? Math.max(sheet.getLastColumn(), 43)
    : Math.max(sheet.getLastColumn(), 40);
  const currentRow = sheet.getRange(targetRow, 1, 1, maxCols).getValues()[0];
  const normCat = normalizeCategoryValue_(candidate.category);
  const existingCat = normalizeCategoryValue_(currentRow[2]);
  const effectiveCat = existingCat || normCat;

  // 1. 商品マスター本票 (Sheets[0]) の更新

  // 商品名 (E列: 5)
  if (candidate.title_ja) {
    sheet.getRange(targetRow, 5).setValue(String(candidate.title_ja).trim());
  }

  // 状態 (F列: 6)
  // 要件: 本票F列（状態）にA/B/Cを書き込まない（F列は従来商品の日本語状態区分用。ポケカの正式な状態は pokemon_card.card_condition）
  // またスタッフが既に入力した状態（condition）は上書きせず保持する
  if (effectiveCat !== "pokemon_card") {
    const existingCond = String(currentRow[5] || "").trim();
    const hasValidExistingCond = Boolean(existingCond) && AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(existingCond) !== -1;
    if (!hasValidExistingCond && candidate.condition && AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(candidate.condition) !== -1) {
      sheet.getRange(targetRow, 6).setValue(candidate.condition);
    }
  }

  // 予定販売価格 (H列: 8)
  // 要件: スタッフ入力済み価格を上書きしない
  // AI生成による下書き反映: candidate.price が正の整数で、本票価格が未設定の場合に直接書き込む (price_evidence_verified の制限を解除)
  const existingPrice = Number(currentRow[7]);
  const isPriceSet = Number.isSafeInteger(existingPrice) && existingPrice > 0;
  if (!isPriceSet) {
    if (candidate.price !== null && candidate.price !== undefined && candidate.price !== "") {
      const numPrice = Number(candidate.price);
      if (Number.isSafeInteger(numPrice) && numPrice > 0) {
        sheet.getRange(targetRow, 8).setValue(numPrice);
      }
    }
  }

  // 説明文 (J列: 10)
  let fullDesc = String(candidate.description_ja || "").trim();
  const hashtags = String(candidate.hashtags_ja || "").trim();
  if (hashtags && fullDesc.indexOf(hashtags) === -1) {
    fullDesc = fullDesc ? fullDesc + "\n\n" + hashtags : hashtags;
  }
  if (fullDesc) {
    sheet.getRange(targetRow, 10).setValue(fullDesc);
  }

  // カテゴリ (C列: 3): 既存商品カテゴリの上書きを防止
  if (!existingCat && normCat) {
    sheet.getRange(targetRow, 3).setValue(normCat);
  }

  // ブランド (D列: 4)
  const existingBrand = String(currentRow[3] || "").trim();
  const safeExistingBrand = /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingBrand) ? "" : existingBrand;
  if (!safeExistingBrand) {
    const normBrand = normalizeBrandValue_(candidate.brand, effectiveCat);
    if (normBrand) {
      sheet.getRange(targetRow, 4).setValue(normBrand);
    }
  } else if (effectiveCat === "pokemon_card" && (safeExistingBrand === "Pokémon" || safeExistingBrand === "Pokemon" || safeExistingBrand === "ポケモン")) {
    sheet.getRange(targetRow, 4).setValue("Pokemon Card Game");
  }

  // スニーカー属性 (L列: 12, M列: 13): スニーカー以外のカテゴリ（ポケカ、ジュエリー、アパレル、小物等）への誤書き込みを防止
  const isNonSneakerCategory = ["pokemon_card", "jewelry", "apparel", "fashion_goods", "other"].includes(effectiveCat);
  if (!isNonSneakerCategory) {
    const existingSku = String(currentRow[11] || "").trim();
    if (!existingSku) {
      if (candidate.sku !== undefined && candidate.sku !== null && String(candidate.sku).trim() !== "") {
        sheet.getRange(targetRow, 12).setValue(String(candidate.sku).trim());
      }
    }

    const existingSize = String(currentRow[12] || "").trim();
    if (!existingSize) {
      if (candidate.size !== undefined && candidate.size !== null && String(candidate.size).trim() !== "") {
        sheet.getRange(targetRow, 13).setValue(String(candidate.size).trim());
      }
    }
  }

  // 新カテゴリ (apparel, fashion_goods) 属性の反映 (AP: 42=size, AQ: 43=official_sku)
  // 要件: スタッフ入力済みの値は上書きせず保護する。サブカテゴリはAI推論候補に存在しないため推測で埋めない
  const isApparelOrFashionCat = (effectiveCat === "apparel" || effectiveCat === "fashion_goods");
  if (isApparelOrFashionCat && sheet.getMaxColumns() >= 43) {
    const existingFashionSize = String(currentRow[41] || "").trim();
    if (!existingFashionSize && candidate.size !== undefined && candidate.size !== null && String(candidate.size).trim() !== "") {
      sheet.getRange(targetRow, 42).setValue(String(candidate.size).trim());
    }

    const existingFashionSku = String(currentRow[42] || "").trim();
    if (!existingFashionSku && candidate.sku !== undefined && candidate.sku !== null && String(candidate.sku).trim() !== "") {
      sheet.getRange(targetRow, 43).setValue(String(candidate.sku).trim());
    }
  }

  // AN列 (40列目: ai_draft_flag)
  sheet.getRange(targetRow, AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN).setValue(AI_DRAFT_CONFIG.FLAG_VALUE);

  // 2. 英文翻訳シートへの反映 (translation_status: "approved")
  const transTitle = String(candidate.title_en || "").trim();
  const transDesc = String(candidate.description_en || "").trim();
  if (transTitle || transDesc) {
    saveConfirmedProductTranslation_(productId, {
      translated_title: transTitle,
      translated_description: transDesc,
      condition: candidate.condition || String(currentRow[5] || ""),
      box: currentRow[14] || "",
      accessories: currentRow[15] || ""
    });
  }

  // 3. ポケカ固有属性 (category === "pokemon_card")
  if (effectiveCat === "pokemon_card") {
    const existingPoke = safeGetPokemonCard_(productId);
    if (!existingPoke) {
      const pokePayload = (candidate.pokemon_card && typeof candidate.pokemon_card === "object")
        ? Object.assign({}, candidate.pokemon_card)
        : {
            card_name: String(candidate.title_ja || currentRow[4] || "").trim(),
            card_condition: "A",
            language: "Japanese",
            grading_status: "ungraded"
          };
      // 未鑑定ポケカで card_condition が未設定の場合はデフォルト A
      if (pokePayload.grading_status !== "graded") {
        const condUpper = String(pokePayload.card_condition || "").trim().toUpperCase();
        pokePayload.card_condition = ["A", "B", "C"].includes(condUpper) ? condUpper : "A";
      } else {
        pokePayload.card_condition = "";
      }
      savePokemonCardByProductId(productId, pokePayload);
    } else if (candidate.pokemon_card && typeof candidate.pokemon_card === "object") {
      // 指摘5対応: スタッフ入力済み属性の保護 (空欄・プレースホルダー以外の既存プロパティを保持)
      const mergedPoke = Object.assign({}, existingPoke);
      const newPoke = candidate.pokemon_card;
      Object.keys(newPoke).forEach(k => {
        const existingVal = String(existingPoke[k] || "").trim();
        const isPlaceholder = /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingVal);
        if (!existingVal || isPlaceholder) {
          mergedPoke[k] = newPoke[k];
        }
      });
      // 未鑑定ポケカで card_condition の既存値が保護対象でない場合は A/B/C を担保
      if (mergedPoke.grading_status !== "graded") {
        const existingVal = String(existingPoke.card_condition || "").trim();
        const isPlaceholder = /^(?:test|dummy|sample|n\/?a|unknown|none|null|undefined|-)$/i.test(existingVal);
        if (!existingVal || isPlaceholder) {
          const newCondUpper = String(newPoke.card_condition || "").trim().toUpperCase();
          mergedPoke.card_condition = ["A", "B", "C"].includes(newCondUpper) ? newCondUpper : "A";
        }
      } else {
        mergedPoke.card_condition = "";
      }
      savePokemonCardByProductId(productId, mergedPoke);
    }
  }

  // 4. 再読取り検証 (Comprehensive Re-read verification)
  const verifyRow = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 16)).getValues()[0];
  if (candidate.title_ja && String(verifyRow[4] || "").trim() !== String(candidate.title_ja).trim()) {
    const err = new Error("Re-read verification failed: product_name does not match saved value.");
    err.error_code = "RE_READ_VERIFICATION_FAILED";
    throw err;
  }

  // 5. 確定指紋の計算
  const confirmedFingerprint = computeConfirmedProductFingerprint_(sheet, targetRow, productId);

  return { confirmedFingerprint: confirmedFingerprint };
}

/**
 * 既存の pending_review ドラフトから商品下書きへ自動反映し、確定指紋を算出してドラフトを確定
 * (中断回復用)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート (Sheets[0])
 * @param {string} productId 商品ID
 * @param {Object} latestDraft 既存ドラフトオブジェクト
 * @return {Object} { success: boolean, model_name: string }
 */
/**
 * ドラフト生成後、スタッフによる手動編集が行われたかどうかを厳格に判定する
 * （途中保存・中断状態からの安全な復旧をサポートするため、自分自身が部分反映した項目はスタッフ編集と誤認しない）
 * 
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {number} targetRow 対象行番号
 * @param {string} productId 商品ID
 * @param {Object} latestDraft 最新ドラフトオブジェクト
 * @return {{ isModifiedByStaff: boolean, reason: string }}
 */
function checkStaffModificationAgainstDraft_(sheet, targetRow, productId, latestDraft) {
  if (!latestDraft || !latestDraft.source_fingerprint) {
    return { isModifiedByStaff: false, reason: "" };
  }

  const currentFp = computeProductSourceFingerprint_(sheet, targetRow, productId);
  if (currentFp === latestDraft.source_fingerprint) {
    // 生成前の指紋と完全一致していれば変更なし
    return { isModifiedByStaff: false, reason: "" };
  }

  const readColCount = (typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 43)
    ? Math.max(sheet.getLastColumn(), 43)
    : Math.max(sheet.getLastColumn(), 40);
  const rowVals = sheet.getRange(targetRow, 1, 1, readColCount).getValues()[0];

  // 1. 画像指紋のチェック (スタッフが画像を追加・変更・削除した場合は変更ありと判定)
  const driveFolderUrl = String(rowVals[29] || "").trim();
  const currentImgFp = computeImageFingerprintFromFolderUrl_(driveFolderUrl);
  if (latestDraft.source_image_fingerprint && currentImgFp !== latestDraft.source_image_fingerprint) {
    return { isModifiedByStaff: true, reason: "Product images were modified or updated." };
  }

  // 2. 本票の各フィールドについて、初期状態または候補値（candidate）以外の値が手動入力されていないか照合
  const candidate = latestDraft.candidate || {
    title_ja: latestDraft.candidate_title_ja,
    hashtags_ja: latestDraft.candidate_hashtags_ja,
    description_ja: latestDraft.candidate_description_ja,
    condition: latestDraft.candidate_condition,
    price: latestDraft.candidate_price,
    category: latestDraft.candidate_category,
    brand: latestDraft.candidate_brand,
    sku: latestDraft.candidate_sku,
    size: latestDraft.candidate_size
  };

  const normCat = normalizeCategoryValue_(candidate.category);
  let expectedDesc = String(candidate.description_ja || "").trim();
  const hashtags = String(candidate.hashtags_ja || "").trim();
  if (hashtags && expectedDesc.indexOf(hashtags) === -1) {
    expectedDesc = expectedDesc ? expectedDesc + "\n\n" + hashtags : hashtags;
  }

  // 商品名 (E列: 5, index 4): 空欄 または candidate.title_ja
  const currentTitle = String(rowVals[4] || "").trim();
  if (currentTitle && currentTitle !== String(candidate.title_ja || "").trim()) {
    return { isModifiedByStaff: true, reason: `product_name was manually edited to '${currentTitle}'` };
  }

  // 状態 (F列: 6, index 5): 空欄 または candidate.condition
  const currentCond = String(rowVals[5] || "").trim();
  if (currentCond && currentCond !== String(candidate.condition || "").trim()) {
    return { isModifiedByStaff: true, reason: `condition was manually edited to '${currentCond}'` };
  }

  // 説明文 (J列: 10, index 9): 空欄 または expectedDesc
  const currentDesc = String(rowVals[9] || "").trim();
  if (currentDesc && currentDesc !== expectedDesc) {
    return { isModifiedByStaff: true, reason: "description was manually edited" };
  }

  // カテゴリ (C列: 3, index 2): 空欄 または normCat
  const currentCat = normalizeCategoryValue_(rowVals[2]);
  if (currentCat && currentCat !== normCat) {
    return { isModifiedByStaff: true, reason: `category was manually edited to '${currentCat}'` };
  }

  // ブランド (D列: 4, index 3): 空欄 または candidate.brand
  const currentBrand = String(rowVals[3] || "").trim();
  const normExpectedBrand = normalizeBrandValue_(candidate.brand, normCat);
  const normCurrentBrand = normalizeBrandValue_(currentBrand, normCat);
  if (
    currentBrand &&
    currentBrand !== String(candidate.brand || "").trim() &&
    currentBrand !== normExpectedBrand &&
    normCurrentBrand !== normExpectedBrand
  ) {
    return { isModifiedByStaff: true, reason: `brand was manually edited to '${currentBrand}'` };
  }

  const effectiveCatForCheck = currentCat || normCat;
  if (!effectiveCatForCheck || effectiveCatForCheck === "sneaker") {
    // スニーカーSKU (L列: 12, index 11): 空欄 または candidate.sku
    const currentSku = String(rowVals[11] || "").trim();
    if (currentSku && currentSku !== String(candidate.sku || "").trim()) {
      return { isModifiedByStaff: true, reason: `sneaker_sku was manually edited to '${currentSku}'` };
    }

    // スニーカーサイズ (M列: 13, index 12): 空欄 または candidate.size
    const currentSize = String(rowVals[12] || "").trim();
    if (currentSize && currentSize !== String(candidate.size || "").trim()) {
      return { isModifiedByStaff: true, reason: `sneaker_size was manually edited to '${currentSize}'` };
    }
  } else if ((effectiveCatForCheck === "apparel" || effectiveCatForCheck === "fashion_goods") && rowVals.length >= 43) {
    // アパレル・ファッション小物 サイズ (AP列: 42, index 41) / 公式品番 (AQ列: 43, index 42)
    const currentFashionSize = String(rowVals[41] || "").trim();
    if (currentFashionSize && currentFashionSize !== String(candidate.size || "").trim()) {
      return { isModifiedByStaff: true, reason: `size was manually edited to '${currentFashionSize}'` };
    }
    const currentFashionSku = String(rowVals[42] || "").trim();
    if (currentFashionSku && currentFashionSku !== String(candidate.sku || "").trim()) {
      return { isModifiedByStaff: true, reason: `official_sku was manually edited to '${currentFashionSku}'` };
    }
  }

  // 販売予定価格 (H列: 8, index 7): 空欄/0 または candidate.price
  const currentPrice = Number(rowVals[7]);
  if (Number.isSafeInteger(currentPrice) && currentPrice > 0) {
    const candPrice = Number(candidate.price);
    if (!Number.isSafeInteger(candPrice) || currentPrice !== candPrice) {
      return { isModifiedByStaff: true, reason: `planned_sale_price was manually edited to ${currentPrice}` };
    }
  }

  // すべてが空欄または候補値の部分反映であれば、スタッフ編集ではなく前回の反映中断と判定
  return { isModifiedByStaff: false, reason: "" };
}

/**
 * 商品下書き自動反映（Auto-Apply）が本票・関連データ・確定指紋まで完全に行われたかを検証する
 * （Fail-Closed: 途中の保存失敗や一部項目未反映を検知し completed を防ぐ）
 * 
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート (Sheets[0])
 * @param {number} targetRow 対象行番号
 * @param {string} productId 商品ID
 * @param {Object} latestDraft 最新ドラフトオブジェクト
 * @return {{ success: boolean, confirmedFingerprint: string }}
 * @throws {Error} 不整合や未保存がある場合は error_code 付きの例外をスロー
 */
function verifyProductDraftReflectionCompleted_(sheet, targetRow, productId, latestDraft) {
  if (!latestDraft) {
    const err = new Error(`Verification failed: No AI draft found for ${productId}.`);
    err.error_code = "AI_DRAFT_NOT_FOUND";
    throw err;
  }

  const candidate = latestDraft.candidate || {
    title_ja: latestDraft.candidate_title_ja,
    hashtags_ja: latestDraft.candidate_hashtags_ja,
    description_ja: latestDraft.candidate_description_ja,
    title_en: latestDraft.candidate_title_en,
    description_en: latestDraft.candidate_description_en,
    condition: latestDraft.candidate_condition,
    price: latestDraft.candidate_price,
    category: latestDraft.candidate_category,
    brand: latestDraft.candidate_brand,
    sku: latestDraft.candidate_sku,
    size: latestDraft.candidate_size
  };

  const readColCount = (typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 43)
    ? Math.max(sheet.getLastColumn(), 43)
    : Math.max(sheet.getLastColumn(), 40);
  const rowVals = sheet.getRange(targetRow, 1, 1, readColCount).getValues()[0];

  // 1. 本票の基本情報 (Sheets[0])
  // 1.1 商品名 (E列: 5, index 4) - 必須かつ空欄不可
  const currentTitle = String(rowVals[4] || "").trim();
  const expectedTitle = String(candidate.title_ja || "").trim();
  if (!currentTitle || (expectedTitle && currentTitle !== expectedTitle)) {
    const err = new Error(`Verification failed: product_name '${currentTitle}' does not match candidate '${expectedTitle}' for ${productId}.`);
    err.error_code = "PRODUCT_NAME_NOT_REFLECTED";
    throw err;
  }

  // 1.2 状態 (F列: 6, index 5)
  // 要件: ポケカは本票F列にA/B/Cを書き込まないため、ポケカ以外のカテゴリで検証（スタッフが事前入力した有効な状態が保持されている場合も許可）
  const normCatEarly = normalizeCategoryValue_(candidate.category) || normalizeCategoryValue_(rowVals[2]);
  if (normCatEarly !== "pokemon_card" && candidate.condition && AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(candidate.condition) !== -1) {
    const currentCond = String(rowVals[5] || "").trim();
    if (!currentCond || AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(currentCond) === -1) {
      const err = new Error(`Verification failed: condition '${currentCond}' does not match '${candidate.condition}' for ${productId}.`);
      err.error_code = "CONDITION_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.3 説明文 (J列: 10, index 9)
  let expectedDesc = String(candidate.description_ja || "").trim();
  const hashtags = String(candidate.hashtags_ja || "").trim();
  if (hashtags && expectedDesc.indexOf(hashtags) === -1) {
    expectedDesc = expectedDesc ? expectedDesc + "\n\n" + hashtags : hashtags;
  }
  if (expectedDesc) {
    const currentDesc = String(rowVals[9] || "").trim();
    if (currentDesc !== expectedDesc) {
      const err = new Error(`Verification failed: description does not match expected full description for ${productId}.`);
      err.error_code = "DESCRIPTION_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.4 カテゴリ (C列: 3, index 2)
  const normCat = normalizeCategoryValue_(candidate.category);
  if (normCat) {
    const currentCat = normalizeCategoryValue_(rowVals[2]);
    if (currentCat !== normCat) {
      const err = new Error(`Verification failed: category '${currentCat}' does not match '${normCat}' for ${productId}.`);
      err.error_code = "CATEGORY_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.5 ブランド (D列: 4, index 3)
  if (candidate.brand !== undefined && candidate.brand !== null && String(candidate.brand).trim() !== "") {
    const currentBrand = String(rowVals[3] || "").trim();
    const normBrand = normalizeBrandValue_(candidate.brand, normCat);
    const expectedBrand = normBrand || String(candidate.brand).trim();
    if (currentBrand !== expectedBrand && currentBrand !== String(candidate.brand).trim()) {
      const err = new Error(`Verification failed: brand '${currentBrand}' does not match '${expectedBrand}' for ${productId}.`);
      err.error_code = "BRAND_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.6 販売予定価格 (H列: 8, index 7)
  // 要件: スタッフ入力を保持する項目は保持後の値と照合。判断不能なAI価格nullは空欄/0を許可
  // 数値価格案がある場合は本票H列へ書き込まれ、正の整数価格が存在することを検証
  const currentPrice = Number(rowVals[7]);
  const numCandPrice = Number(candidate.price);
  if (Number.isSafeInteger(numCandPrice) && numCandPrice > 0) {
    if (!Number.isSafeInteger(currentPrice) || currentPrice <= 0) {
      const err = new Error(`Verification failed: planned_sale_price is not set for ${productId}.`);
      err.error_code = "PRICE_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.7 サイズ検証 (sneaker: M列 13 / index 12, apparel・fashion_goods: AP列 42 / index 41)
  // 要件: サイズ空欄は許可。候補またはスタッフ入力があれば対応する列に保持されていること
  const effectiveCatForSize = normCat || normalizeCategoryValue_(rowVals[2]);
  const candSize = String(candidate.size || "").trim();
  if (!effectiveCatForSize || effectiveCatForSize === "sneaker") {
    const currentSize = String(rowVals[12] || "").trim();
    if (candSize && !currentSize) {
      const err = new Error(`Verification failed: sneaker_size '${candSize}' is missing in sheet for ${productId}.`);
      err.error_code = "SIZE_NOT_REFLECTED";
      throw err;
    }
  } else if ((effectiveCatForSize === "apparel" || effectiveCatForSize === "fashion_goods") && rowVals.length >= 42) {
    const currentFashionSize = String(rowVals[41] || "").trim();
    if (candSize && !currentFashionSize) {
      const err = new Error(`Verification failed: apparel/fashion_goods size '${candSize}' is missing in AP column for ${productId}.`);
      err.error_code = "SIZE_NOT_REFLECTED";
      throw err;
    }
  }

  // 1.8 AN列 (40列目, index 39: ai_draft_flag)
  const currentFlag = String(rowVals[AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN - 1] || "").trim();
  if (currentFlag !== AI_DRAFT_CONFIG.FLAG_VALUE) {
    const err = new Error(`Verification failed: ai_draft_flag '${currentFlag}' is not '${AI_DRAFT_CONFIG.FLAG_VALUE}' for ${productId}.`);
    err.error_code = "AI_FLAG_NOT_REFLECTED";
    throw err;
  }

  // 2. 関連データ: 英文翻訳 (product_translations)
  const transTitle = String(candidate.title_en || "").trim();
  const transDesc = String(candidate.description_en || "").trim();
  if (transTitle || transDesc) {
    const trans = safeGetProductTranslation_(productId);
    if (!trans) {
      const err = new Error(`Verification failed: translation record missing for ${productId}.`);
      err.error_code = "TRANSLATION_RECORD_MISSING";
      throw err;
    }
    if (trans.translation_status !== "approved") {
      const err = new Error(`Verification failed: translation_status '${trans.translation_status}' is not approved for ${productId}.`);
      err.error_code = "TRANSLATION_NOT_APPROVED";
      throw err;
    }
    if (transTitle && trans.translated_title !== transTitle) {
      const err = new Error(`Verification failed: translated_title does not match candidate for ${productId}.`);
      err.error_code = "TRANSLATION_TITLE_MISMATCH";
      throw err;
    }
  }

  // 3. 関連データ: ポケモンカード (pokemon_cards)
  const effectiveCat = normCat || String(rowVals[2] || "").trim();
  if (effectiveCat === "pokemon_card") {
    const poke = safeGetPokemonCard_(productId);
    if (!poke) {
      const err = new Error(`Verification failed: pokemon_card record missing for ${productId}.`);
      err.error_code = "POKEMON_CARD_RECORD_MISSING";
      throw err;
    }
  }

  // 4. 確定指紋とドラフトステータス (product_ai_drafts)
  const currentFp = computeConfirmedProductFingerprint_(sheet, targetRow, productId);
  if (!currentFp) {
    const err = new Error(`Verification failed: failed to compute confirmed fingerprint for ${productId}.`);
    err.error_code = "CONFIRMED_FINGERPRINT_EMPTY";
    throw err;
  }

  if (latestDraft.review_status !== "confirmed") {
    const err = new Error(`Verification failed: review_status '${latestDraft.review_status}' is not confirmed for ${productId}.`);
    err.error_code = "DRAFT_NOT_CONFIRMED";
    throw err;
  }

  if (!latestDraft.confirmed_fingerprint || latestDraft.confirmed_fingerprint !== currentFp) {
    const err = new Error(`Verification failed: confirmed_fingerprint mismatch for ${productId}.`);
    err.error_code = "CONFIRMED_FINGERPRINT_MISMATCH";
    throw err;
  }

  return { success: true, confirmedFingerprint: currentFp };
}

/**
 * 既存の pending_review ドラフトから商品下書きへ自動反映し、確定指紋を算出してドラフトを確定
 * (中断回復用)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート (Sheets[0])
 * @param {string} productId 商品ID
 * @param {Object} latestDraft 既存ドラフトオブジェクト
 * @param {Object} [options]
 * @param {Function} [options.ownership_check] ScriptLock 保持中に呼び出される所有権検証。例外で書込み中止
 * @return {Object} { success: boolean, model_name: string }
 */
function applyExistingAiDraftToProductRecord_(sheet, productId, latestDraft, options) {
  options = options || {};
  const ownershipCheck = typeof options.ownership_check === "function" ? options.ownership_check : null;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);

    // 1) 呼出し元 (バッチワーカー) の所有権・リースをロック内で確認
    if (ownershipCheck) {
      ownershipCheck({ phase: "recovery_commit", draft_id: latestDraft && latestDraft.draft_id });
    }

    // 2) ロック外で読んだ候補が現在も最新ドラフトであることを再確認 (より新しい候補を古い候補で上書きしない)
    const freshDraft = getLatestProductAiDraft_(productId);
    if (!latestDraft || !freshDraft || freshDraft.draft_id !== latestDraft.draft_id) {
      const err = new Error("AI draft for " + productId + " was superseded by a newer draft; recovery aborted.");
      err.error_code = "AI_DRAFT_SUPERSEDED";
      throw err;
    }
    latestDraft = freshDraft;

    // 2.1) 検索グラウンディング有効かつ実検索未実行 (search_executed: false) の候補の保護 (Fail-Closed)
    // スタッフによる手動確定（handleConfirmAiProductDraft）以外の自動反映・confirmed化経路を完全遮断
    if (latestDraft && latestDraft.search_grounding_enabled && !latestDraft.search_executed) {
      const err = new Error(`Cannot auto-apply unsearched AI draft ${latestDraft.draft_id} for ${productId}. Staff review is required.`);
      err.error_code = "UNSEARCHED_DRAFT_CANNOT_AUTO_APPLY";
      throw err;
    }

    // 3) 同一商品の別生成 (単品生成等) が有効な実行ロックを保持していれば反映しない
    if (isAiDraftExecutionInProgress_(productId)) {
      const err = new Error("AI draft generation already in progress for product " + productId);
      err.error_code = "GENERATION_ALREADY_IN_PROGRESS";
      throw err;
    }

    const targetRow = findProductRow(sheet, productId);
    const currentRow = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];

    const currentPublishStatus = String(currentRow[31] || "draft").trim();
    const currentRecordStatus = String(currentRow[33] || "active").trim();
    if (currentPublishStatus !== "draft" || currentRecordStatus !== "active") {
      const err = new Error("Product state changed (must remain active draft).");
      err.error_code = "PRODUCT_STATE_CHANGED_DURING_GENERATION";
      throw err;
    }

    const modCheck = checkStaffModificationAgainstDraft_(sheet, targetRow, productId, latestDraft);
    if (modCheck.isModifiedByStaff) {
      const err = new Error("Product images or attributes were modified by staff while generating draft: " + modCheck.reason);
      err.error_code = "SOURCE_MODIFIED_DURING_GENERATION";
      throw err;
    }

    const candidate = latestDraft.candidate || {
      title_ja: latestDraft.candidate_title_ja,
      hashtags_ja: latestDraft.candidate_hashtags_ja,
      description_ja: latestDraft.candidate_description_ja,
      title_en: latestDraft.candidate_title_en,
      description_en: latestDraft.candidate_description_en,
      condition: latestDraft.candidate_condition,
      price: latestDraft.candidate_price,
      price_evidence_verified: (latestDraft.price_evidence_verified !== undefined)
        ? Boolean(latestDraft.price_evidence_verified)
        : (latestDraft.candidate_price !== null && latestDraft.candidate_price !== undefined && latestDraft.candidate_price !== ""),
      category: latestDraft.candidate_category,
      brand: latestDraft.candidate_brand,
      sku: latestDraft.candidate_sku,
      size: latestDraft.candidate_size
    };
    if (candidate && candidate.price_evidence_verified === undefined) {
      candidate.price_evidence_verified = (latestDraft.price_evidence_verified !== undefined)
        ? Boolean(latestDraft.price_evidence_verified)
        : (latestDraft.candidate_price !== null && latestDraft.candidate_price !== undefined && latestDraft.candidate_price !== "");
    }

    const applyRes = applyCandidateToProduct_(sheet, targetRow, productId, candidate);

    const draftSheet = getOrCreateProductAiDraftsSheet_();
    const draftHeaders = draftSheet.getRange(1, 1, 1, draftSheet.getLastColumn()).getValues()[0].map(h => String(h || "").trim());

    function setDraftCell_(colName, val) {
      const colIdx = draftHeaders.indexOf(colName);
      if (colIdx !== -1) {
        draftSheet.getRange(latestDraft.row_number, colIdx + 1).setValue(val);
      }
    }

    setDraftCell_("confirmed_fingerprint", applyRes.confirmedFingerprint);
    setDraftCell_("confirmed_at", new Date().toISOString());
    setDraftCell_("confirmed_by", "ai_batch_worker");
    setDraftCell_("review_status", "confirmed");

    clearProductCache_(productId);
    clearProductTranslationCache_(productId);
    try {
      CacheService.getScriptCache().remove("prod_aidraft_" + productId);
    } catch (_) {}

    return { success: true, model_name: latestDraft.model_name };
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}


/**
 * 単品AI出品ドラフト生成 共通内部処理 (executeSingleAiProductDraftCore_)
 * 単品生成および一括バッチワーカーの双方が共通で再利用する
 * 
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {string} productId 商品ID
 * @param {Object} [options]
 * @param {boolean} [options.force_regenerate=false]
 * @param {string} [options.model_name]
 * @param {Array<string>} [options.selected_image_ids]
 * @param {Function} [options.ownership_check] ScriptLock 保持中に呼び出される所有権検証 ({ phase, draft_id, draft_version, model_name })。例外で書込み中止
 * @return {Object} 成功時は { success: true, draft_id, product_id, draft_version, review_status, model_name, candidate, source_fingerprint }
 * @throws {Error} 失敗時は error_code 付きの例外をスロー
 */
function executeSingleAiProductDraftCore_(sheet, productId, options) {
  options = options || {};
  productId = String(productId || "").trim();
  const forceRegenerate = Boolean(options.force_regenerate);
  const autoApply = options.auto_apply !== undefined ? Boolean(options.auto_apply) : false;
  const confirmedBy = String(options.confirmed_by || "ai_batch_worker").trim();
  const ownershipCheck = typeof options.ownership_check === "function" ? options.ownership_check : null;

  if (!productId) {
    const err = new Error("product_id is required");
    err.error_code = "PRODUCT_ID_REQUIRED";
    throw err;
  }

  ensureAiDraftColumns_(sheet);

  const lock = LockService.getScriptLock();
  let executionId = "";
  let driveFolderUrl = "";
  let sourceFingerprint = "";
  let sourceImageFingerprint = "";
  let productMeta = {};
  let targetRow = -1;
  let nextVersion = 1;

  try {
    lock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);

    targetRow = findProductRow(sheet, productId);
    const row = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];

    const publishStatus = String(row[31] || "draft").trim();
    const recordStatus = String(row[33] || "active").trim();

    if (publishStatus === "published") {
      const err = new Error("Cannot generate AI draft for already published product: " + productId);
      err.error_code = "PUBLISHED_PRODUCT_NOT_ALLOWED";
      throw err;
    }

    if (recordStatus !== "active") {
      const err = new Error("Cannot generate AI draft for inactive/archived product: " + productId);
      err.error_code = "INACTIVE_PRODUCT_NOT_ALLOWED";
      throw err;
    }

    const latestDraft = getLatestProductAiDraft_(productId);
    if (latestDraft) {
      if (latestDraft.review_status === "confirmed" && !forceRegenerate) {
        const err = new Error("A confirmed AI draft already exists. Use force_regenerate: true to overwrite.");
        err.error_code = "CONFIRMED_DRAFT_EXISTS";
        throw err;
      }
      nextVersion = latestDraft.draft_version + 1;
    }

    // バッチワーカー等の呼出し元所有権を検証 (失効済みワーカーは商品側へ一切書き込まない)
    if (ownershipCheck) {
      ownershipCheck({ phase: "prepare" });
    }

    executionId = acquireAiDraftExecutionLock_(productId);

    // 本票 AN列 (40列目) に "ai_managed" を刻印
    sheet.getRange(targetRow, AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN).setValue(AI_DRAFT_CONFIG.FLAG_VALUE);

    driveFolderUrl = String(row[29] || "").trim();
    sourceImageFingerprint = computeImageFingerprintFromFolderUrl_(driveFolderUrl);
    sourceFingerprint = computeProductSourceFingerprint_(sheet, targetRow, productId);

    productMeta = {
      productId: productId,
      category: String(row[2] || "").trim(),
      brand: String(row[3] || "").trim(),
      productName: String(row[4] || "").trim(),
      sneakerSku: String(row[11] || "").trim()
    };
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }

  // 外部通信 (Drive画像取得 ＋ Gemini API呼び出し) はロックフリーで実行
  let validatedImages;
  let candidate;

  const requestedModel = String(options.model_name || "").trim();

  try {
    validatedImages = getValidatedProductDriveImages_(productId, driveFolderUrl, options.selected_image_ids, {
      selection_was_prevalidated: Boolean(options.selection_was_prevalidated)
    });
    const useSearchGrounding = options.enable_search_grounding !== undefined
      ? Boolean(options.enable_search_grounding)
      : isAiDraftSearchGroundingEnabled_();

    if (useSearchGrounding) {
      // 既存の誤認名が検索を誘導する問題への対処:
      // force_regenerate: true 時は、現在の誤認名をリセットして推論し直す意図であるため、
      // 明示的に指定されない限りデフォルトで ignore_existing_identity: true として客観評価する
      const searchOptions = Object.assign({}, options);
      if (searchOptions.ignore_existing_identity === undefined && forceRegenerate) {
        searchOptions.ignore_existing_identity = true;
      }
      candidate = callGeminiMultimodalAiDraftWithSearch_(validatedImages.images, productMeta, requestedModel, searchOptions);
    } else {
      candidate = callGeminiMultimodalAiDraft_(validatedImages.images, productMeta, requestedModel);
    }

    // 照合済み商品の概算原価への最低上乗せ率（既定30% = ×1.30）および未照合時の概算根拠注記を反映
    if (
      candidate &&
      (options.product_cost !== undefined || options.min_cost_markup_rate !== undefined || options.apply_cost_floor === true)
    ) {
      applyCostFloorToCandidate_(candidate, options.product_cost, options.min_cost_markup_rate);
    }
  } catch (extError) {
    releaseAiDraftExecutionLock_(productId, executionId);
    console.error("[AI Draft] Generation external failure for " + productId + ":", extError.message);
    const preserveMsg = Boolean(extError && extError.preserve_message);
    const safeMsg = preserveMsg && extError.message ? extError.message : AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE;
    const err = new Error(safeMsg);
    err.error_code = extError.error_code || "LLM_GENERATION_FAILED";
    err.user_message = safeMsg;
    if (preserveMsg) {
      err.preserve_message = true;
    }
    throw err;
  }

  // 保存処理直前に短時間ロックを取得し、実行ID・行照合・状態・指紋の変更検知照合
  try {
    lock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);

    if (!verifyAiDraftExecutionLock_(productId, executionId)) {
      const err = new Error("Execution lock expired or was superseded by another process.");
      err.error_code = "STALE_EXECUTION_DISCARDED";
      throw err;
    }

    // 指示6: product_id から行を再検索して B列 ID を照合
    const reFoundRow = findProductRow(sheet, productId);
    const currentRow = sheet.getRange(reFoundRow, 1, 1, Math.max(sheet.getLastColumn(), 40)).getValues()[0];
    const columnBId = String(currentRow[1] || "").trim();

    if (columnBId !== productId) {
      releaseAiDraftExecutionLock_(productId, executionId);
      const err = new Error("Re-searched product row ID mismatch: expected '" + productId + "', found '" + columnBId + "'");
      err.error_code = "PRODUCT_ROW_MISMATCH";
      throw err;
    }

    const currentPublishStatus = String(currentRow[31] || "draft").trim();
    const currentRecordStatus = String(currentRow[33] || "active").trim();

    // 指示7: draft + active 限定
    if (currentPublishStatus !== "draft" || currentRecordStatus !== "active") {
      releaseAiDraftExecutionLock_(productId, executionId);
      const err = new Error("Product state changed (must remain active draft) while generating draft.");
      err.error_code = "PRODUCT_STATE_CHANGED_DURING_GENERATION";
      throw err;
    }

    const currentFingerprint = computeProductSourceFingerprint_(sheet, reFoundRow, productId);
    if (currentFingerprint !== sourceFingerprint) {
      releaseAiDraftExecutionLock_(productId, executionId);
      const err = new Error("Product images or attributes were modified while generating draft.");
      err.error_code = "SOURCE_MODIFIED_DURING_GENERATION";
      throw err;
    }

    const draftId = "DRFT_" + productId + "_" + Date.now();
    const generatedAtIso = new Date().toISOString();
    const actuallyUsedModel = (candidate && candidate.actual_model_name) ? candidate.actual_model_name : (requestedModel || getAiDraftModelName_());

    // 候補・本票・関連データへの書込み前に、同一ロック内で呼出し元の所有権を最終確認
    // (バッチワーカーの場合はここでアイテムへ draft_id を予約し、回収時の対応付けに使用する)
    if (ownershipCheck) {
      ownershipCheck({
        phase: "commit",
        draft_id: draftId,
        draft_version: nextVersion,
        model_name: actuallyUsedModel
      });
    }

    const draftSheet = getOrCreateProductAiDraftsSheet_();
    const existingDraft = getLatestProductAiDraft_(productId);
    if (existingDraft && existingDraft.review_status === "pending_review") {
      draftSheet.getRange(existingDraft.row_number, 4).setValue("stale");
    }

    let finalReviewStatus = "pending_review";
    let confirmedFingerprint = "";
    let confirmedAtIso = "";
    let finalConfirmedBy = "";

    // 自動反映オプションが有効な場合、本票・英文翻訳・ポケカ属性へ下書き反映し確定
    // レビュー指摘2: 検索グラウンディング有効時に search_executed: false (実検索未実行) の場合は
    // 検索成功として扱わず、自動反映経路へ流さない (pending_review のまま留める)
    let shouldAutoApply = autoApply;
    if (autoApply) {
      if (candidate) {
        if (candidate.search_grounding && candidate.search_grounding.enabled) {
          if (!candidate.search_grounding.search_executed) {
            console.warn(`[AI Draft] search_executed is false for ${productId}. 自動反映をスキップし pending_review に留めます。`);
            shouldAutoApply = false;
          }
        }
        // 要件: identity_status === "confident" を本票ドラフト自動反映の必須条件から除外
        // サイズ・箱ラベル・SKUが未確認 (candidate / ambiguous 等) であっても、
        // 生成された商品名、説明、カテゴリ、ブランドなどの有用な値は商品ドラフト本票へ下書き反映する
        // 不明なサイズは空欄で構わず、要確認項目 (needs_review) はドラフト側に保持される
        // 数値価格案があり販売予定価格が未入力なら、本票H列へ直接反映する。スタッフ入力済み価格は上書きせず保護する
        if (candidate.price !== null && candidate.price !== undefined && candidate.price !== "") {
          const numP = Number(candidate.price);
          if (Number.isSafeInteger(numP) && numP > 0) {
            console.log(`[AI Draft] Candidate price ${numP} will be reflected to product sheet (H column) if unset for ${productId}.`);
          }
        } else {
          console.log(`[AI Draft] Price is null for ${productId}. Product attributes will be reflected while price column remains empty for manual staff entry.`);
        }
      }
    }

    if (shouldAutoApply) {
      const applyRes = applyCandidateToProduct_(sheet, reFoundRow, productId, candidate);
      finalReviewStatus = "confirmed";
      confirmedFingerprint = applyRes.confirmedFingerprint;
      confirmedAtIso = generatedAtIso;
      finalConfirmedBy = confirmedBy;
    }

    const searchGroundingInfo = candidate.search_grounding || {};
    const searchEnabled = Boolean(searchGroundingInfo.enabled);
    const searchModeUsed = String(searchGroundingInfo.mode_used || "");
    const searchExecuted = Boolean(searchGroundingInfo.search_executed);
    const searchQueriesStr = Array.isArray(searchGroundingInfo.queries) ? searchGroundingInfo.queries.join(", ") : "";

    const recordMap = {
      draft_id: draftId,
      product_id: productId,
      draft_version: nextVersion,
      review_status: finalReviewStatus,
      candidate_title_ja: candidate.title_ja,
      candidate_hashtags_ja: candidate.hashtags_ja,
      candidate_description_ja: candidate.description_ja,
      candidate_title_en: candidate.title_en,
      candidate_description_en: candidate.description_en,
      candidate_condition: candidate.condition,
      candidate_price: candidate.price !== null ? candidate.price : "",
      candidate_category: candidate.category,
      candidate_brand: candidate.brand,
      candidate_sku: candidate.sku,
      candidate_size: candidate.size,
      source_fingerprint: sourceFingerprint,
      source_image_fingerprint: sourceImageFingerprint,
      confirmed_fingerprint: confirmedFingerprint,
      source_image_ids: validatedImages.imageIds.join(","),
      model_name: actuallyUsedModel,
      generated_at: generatedAtIso,
      confirmed_at: confirmedAtIso,
      confirmed_by: finalConfirmedBy,
      search_grounding_enabled: searchEnabled ? "true" : "false",
      search_grounding_mode: searchModeUsed,
      search_executed: searchExecuted ? "true" : "false",
      search_queries: searchQueriesStr,
      search_sources_count: searchGroundingInfo.sources_count !== undefined ? searchGroundingInfo.sources_count : (searchGroundingInfo.sources ? searchGroundingInfo.sources.length : 0),
      search_queries_count: searchGroundingInfo.queries_count !== undefined ? searchGroundingInfo.queries_count : (searchGroundingInfo.queries ? searchGroundingInfo.queries.length : 0),
      stage_a_elapsed_ms: searchGroundingInfo.stage_a_elapsed_ms || 0,
      stage_b_elapsed_ms: searchGroundingInfo.stage_b_elapsed_ms || 0,
      search_total_elapsed_ms: searchGroundingInfo.search_total_elapsed_ms || 0,
      search_finish_reason: searchGroundingInfo.search_finish_reason || "",
      search_tokens_json: searchGroundingInfo.search_tokens_json || "",
      candidate_price_basis: candidate.price_basis || "",
      candidate_price_note: candidate.price_note || "",
      candidate_sku_source: candidate.sku_source || ""
    };

    const draftHeaders = draftSheet.getRange(1, 1, 1, draftSheet.getLastColumn()).getValues()[0].map(h => String(h || "").trim());
    const newRecordRow = draftHeaders.map(h => (recordMap[h] !== undefined ? recordMap[h] : ""));

    draftSheet.appendRow(newRecordRow);

    try {
      CacheService.getScriptCache().remove("prod_aidraft_" + productId);
      clearProductCache_(productId);
      if (shouldAutoApply) {
        clearProductTranslationCache_(productId);
      }
    } catch (_) {}

    releaseAiDraftExecutionLock_(productId, executionId);

    return {
      success: true,
      draft_id: draftId,
      product_id: productId,
      draft_version: nextVersion,
      review_status: finalReviewStatus,
      model_name: actuallyUsedModel,
      candidate: {
        title_ja: candidate.title_ja,
        hashtags_ja: candidate.hashtags_ja,
        description_ja: candidate.description_ja,
        title_en: candidate.title_en,
        description_en: candidate.description_en,
        condition: candidate.condition,
        price: candidate.price,
        price_note: candidate.price_note,
        price_basis: candidate.price_basis || "",
        category: candidate.category,
        brand: candidate.brand,
        sku: candidate.sku,
        sku_source: candidate.sku_source || "",
        inferred_sku_from_search: candidate.inferred_sku_from_search || "",
        size: candidate.size,
        needs_review: candidate.needs_review || [],
        identity_status: candidate.identity_status || "",
        search_grounding: candidate.search_grounding || null,
        cost_calculation: candidate.cost_calculation || null
      },
      source_fingerprint: sourceFingerprint,
      confirmed_fingerprint: confirmedFingerprint,
      auto_applied: shouldAutoApply
    };
  } finally {
    releaseAiDraftExecutionLock_(productId, executionId);
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

/**
 * 既存 draft 商品を対象とした AIドラフト生成処理 (Web Appエンドポイントハンドラ)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {Object} data リクエストデータ
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGenerateAiProductDraft(sheet, data) {
  try {
    const productId = String(data.product_id || "").trim();
    const explicitSelected = data.selected_image_ids !== undefined ? data.selected_image_ids : data.ai_selected_image_ids;
    let effectiveSelected = explicitSelected;
    let selectionWasPrevalidated = false;
    if (effectiveSelected === undefined && productId) {
      const savedSelected = getProductAiSelectedImageIds_(productId);
      if (savedSelected.length > 0) {
        effectiveSelected = savedSelected;
        selectionWasPrevalidated = true;
      }
    }
    const explicitCost = data.product_cost !== undefined
      ? data.product_cost
      : (data.product_costs && typeof data.product_costs === "object" && productId ? data.product_costs[productId] : undefined);
    validateLegacyGrossMarginRateIfPresent_(data.min_gross_margin_rate);
    const rawMarkupRate = data.min_cost_markup_rate !== undefined ? data.min_cost_markup_rate : data.min_markup_rate;
    const minCostMarkupRate = validateMinCostMarkupRateInput_(rawMarkupRate, true);
    const result = executeSingleAiProductDraftCore_(sheet, data.product_id, {
      force_regenerate: Boolean(data.force_regenerate),
      model_name: data.model_name,
      selected_image_ids: effectiveSelected,
      selection_was_prevalidated: selectionWasPrevalidated,
      product_cost: explicitCost,
      min_cost_markup_rate: minCostMarkupRate,
      apply_cost_floor: true
    });
    return jsonResponse(result);
  } catch (err) {
    console.error("[AI Draft] handleGenerateAiProductDraft error:", err.message);
    return jsonResponse({
      success: false,
      error_code: err.error_code || "LLM_GENERATION_FAILED",
      message: err.user_message || err.message || AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE
    });
  }
}

// ==================================================
// 8. メイン処理: スタッフ確認・確定 (confirm_ai_product_draft)
// ==================================================

/**
 * スタッフによる確認・修正内容を確定し、本票・英文シート・ドラフト履歴を整合更新
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {Object} data リクエストデータ
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleConfirmAiProductDraft(sheet, data) {
  const productId = String(data.product_id || "").trim();
  const draftId = String(data.draft_id || "").trim();
  const draftVersion = Number(data.draft_version || 0);
  const staffId = String(data.staff_id || "unauthenticated_staff").trim();
  const confirmationAttemptId = String(data.confirmation_attempt_id || (data.confirmed_data && data.confirmed_data.confirmation_attempt_id) || "").trim();
  const confirmedData = data.confirmed_data;

  if (!productId || !draftId || !draftVersion || !confirmedData || typeof confirmedData !== "object") {
    return jsonResponse({
      success: false,
      error_code: "INVALID_CONFIRMATION_PAYLOAD",
      message: "product_id, draft_id, draft_version, and confirmed_data are required"
    });
  }

  const productName = stripCleaningBoilerplateText_(
    stripAuthenticityGuaranteeText_(
      String(confirmedData.product_name || confirmedData.title_ja || "").trim(),
      { isTitle: true }
    ).text
  );
  const rawPrice = confirmedData.planned_sale_price !== undefined ? confirmedData.planned_sale_price : confirmedData.price;
  const plannedSalePrice = Number(rawPrice);
  let condition = String(confirmedData.condition || "").trim();
  const upperConfirmCond = condition.toUpperCase();
  if (["A", "B", "C"].includes(upperConfirmCond)) {
    condition = (upperConfirmCond === "A") ? "目立った傷や汚れなし" : (upperConfirmCond === "B" ? "やや傷や汚れあり" : "傷や汚れあり");
    if (!confirmedData.pokemon_card || typeof confirmedData.pokemon_card !== "object") {
      confirmedData.pokemon_card = {};
    }
    if (!confirmedData.pokemon_card.card_condition) {
      confirmedData.pokemon_card.card_condition = upperConfirmCond;
    }
  }
  const transTitle = stripAuthenticityGuaranteeText_(
    String(confirmedData.translated_title || confirmedData.title_en || "").trim(),
    { isTitle: true }
  ).text;
  const transDesc = stripAuthenticityGuaranteeText_(
    String(confirmedData.translated_description || confirmedData.description_en || "").trim()
  ).text;
  if (confirmedData.description !== undefined) {
    confirmedData.description = stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(String(confirmedData.description || "").trim()).text
    );
  }
  if (confirmedData.hashtags_ja !== undefined) {
    confirmedData.hashtags_ja = stripCleaningBoilerplateText_(
      stripAuthenticityGuaranteeText_(String(confirmedData.hashtags_ja || "").trim(), { isHashtags: true }).text,
      { isHashtags: true }
    );
  }
  confirmedData.product_name = productName;
  confirmedData.translated_title = transTitle;
  confirmedData.translated_description = transDesc;
  const rawSize = confirmedData.sneaker_size !== undefined ? confirmedData.sneaker_size : confirmedData.size;
  const rawSku = confirmedData.sneaker_sku !== undefined ? confirmedData.sneaker_sku : confirmedData.sku;

  if (!productName) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_NAME_REQUIRED",
      message: "product_name is required for confirmation"
    });
  }

  if (!Number.isSafeInteger(plannedSalePrice) || plannedSalePrice <= 0) {
    return jsonResponse({
      success: false,
      error_code: "VALID_SALE_PRICE_REQUIRED",
      message: "planned_sale_price must be a positive integer confirmed by staff"
    });
  }

  if (!condition) {
    return jsonResponse({
      success: false,
      error_code: "CONDITION_REQUIRED",
      message: "condition is required for confirmation"
    });
  }

  // 指示7: condition の許可値検証
  if (AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.indexOf(condition) === -1) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_CONDITION_VALUE",
      message: `condition '${condition}' is not allowed. Must be one of: ${AI_DRAFT_CONFIG.ALLOWED_CONDITIONS.join(", ")}`
    });
  }

  // 指示1: 確認要求内容のハッシュ計算
  const currentPayloadHash = computeConfirmationPayloadHash_(confirmedData);

  // 指示4: category の既存仕様正規コード値への検証・正規化
  let normalizedCat = "";
  if (confirmedData.category !== undefined) {
    normalizedCat = normalizeCategoryValue_(confirmedData.category);
    if (!normalizedCat) {
      return jsonResponse({
        success: false,
        error_code: "INVALID_CATEGORY_VALUE",
        message: `category '${confirmedData.category}' is not allowed. Must be one of: ${AI_DRAFT_CONFIG.ALLOWED_CATEGORIES.join(", ")}`
      });
    }
  }

  // 指示7: pokemon_card 属性の検証
  if (normalizedCat === "pokemon_card" && confirmedData.pokemon_card !== undefined) {
    if (!confirmedData.pokemon_card || typeof confirmedData.pokemon_card !== "object" || Array.isArray(confirmedData.pokemon_card)) {
      return jsonResponse({
        success: false,
        error_code: "INVALID_POKEMON_CARD_PAYLOAD",
        message: "pokemon_card must be an object for pokemon_card category"
      });
    }
  }

  if (!transTitle || !transDesc) {
    return jsonResponse({
      success: false,
      error_code: "TRANSLATED_CONTENT_REQUIRED",
      message: "translated_title and translated_description are required for confirmation"
    });
  }

  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(AI_DRAFT_CONFIG.LOCK_TIMEOUT_MS);

    // 指示6: product_id から行を再検索して B列 ID を照合
    const targetRow = findProductRow(sheet, productId);
    // 既存商品マスターの基本項目（1〜40列）を安全に読み取る（シートが43列未満でも範囲外アクセスを起こさない）
    const baseColCount = Math.min(sheet.getMaxColumns ? sheet.getMaxColumns() : 40, 40);
    const row = sheet.getRange(targetRow, 1, 1, baseColCount).getValues()[0];
    const columnBId = String(row[1] || "").trim();

    if (columnBId !== productId) {
      return jsonResponse({
        success: false,
        error_code: "PRODUCT_ROW_MISMATCH",
        message: `Re-searched product row ID mismatch: expected '${productId}', found '${columnBId}'`
      });
    }

    const currentPublishStatus = String(row[31] || "draft").trim();
    const currentRecordStatus = String(row[33] || "active").trim();

    // 指示7: draft + active 限定
    if (currentPublishStatus !== "draft" || currentRecordStatus !== "active") {
      return jsonResponse({
        success: false,
        error_code: "INVALID_PRODUCT_STATE_FOR_CONFIRMATION",
        message: "Only active draft products can be confirmed"
      });
    }


    const latestDraft = getLatestProductAiDraft_(productId);
    if (!latestDraft) {
      return jsonResponse({
        success: false,
        error_code: "NO_DRAFT_RECORD_FOUND",
        message: "No AI draft record found for product: " + productId
      });
    }

    if (latestDraft.draft_id !== draftId || latestDraft.draft_version !== draftVersion) {
      return jsonResponse({
        success: false,
        error_code: "DRAFT_VERSION_MISMATCH",
        message: "Draft version mismatch: candidate was updated by another process"
      });
    }

    const isReconfirming = (latestDraft.review_status === "confirmed");

    // 指示1: 同一attempt ID・同一内容の再送だけ成功扱いとし、内容やattempt IDが異なる要求を冪等再送として成功させない
    if (isReconfirming) {
      const currentConfirmedFp = computeConfirmedProductFingerprint_(sheet, targetRow, productId);
      const isAttemptMatch = Boolean(confirmationAttemptId && confirmationAttemptId === latestDraft.last_confirmation_attempt_id);
      const isPayloadMatch = Boolean(latestDraft.last_confirmation_payload_hash && latestDraft.last_confirmation_payload_hash === currentPayloadHash);
      const isFingerprintMatch = Boolean(latestDraft.confirmed_fingerprint && latestDraft.confirmed_fingerprint === currentConfirmedFp);

      if (isAttemptMatch && isPayloadMatch && isFingerprintMatch) {
        return jsonResponse({
          success: true,
          product_id: productId,
          draft_id: draftId,
          draft_version: draftVersion,
          review_status: "confirmed",
          publish_status: "draft",
          is_idempotent_replay: true,
          message: "Confirmation already completed (idempotent replay)."
        });
      }

      if (isAttemptMatch && !isPayloadMatch) {
        return jsonResponse({
          success: false,
          error_code: "DRAFT_ALREADY_CONFIRMED_WITH_DIFFERENT_DATA",
          message: "Draft was already confirmed with different data for this attempt ID."
        });
      }

      // 同一内容・同一指紋で attempt_id だけ変えた再送は拒絶
      if (!isAttemptMatch && isPayloadMatch && isFingerprintMatch) {
        return jsonResponse({
          success: false,
          error_code: "INVALID_IDEMPOTENT_REPLAY_ATTEMPT",
          message: "Draft was already confirmed. Same payload with different attempt_id is rejected."
        });
      }

      // ここに到達した場合は「変更後の再確認（サイズ追加入力など確定内容の変更・指紋更新）」
      console.log(`[AI Draft] Re-confirming confirmed draft for ${productId} with new attempt_id ${confirmationAttemptId}`);
    }

    if (!isReconfirming && latestDraft.review_status !== "pending_review") {
      return jsonResponse({
        success: false,
        error_code: "DRAFT_NOT_IN_PENDING_STATUS",
        message: "Draft status is '" + latestDraft.review_status + "', expected 'pending_review'"
      });
    }

    // 画像指紋の一致検証
    const driveFolderUrl = String(row[29] || "").trim();
    const currentImageFingerprint = computeImageFingerprintFromFolderUrl_(driveFolderUrl);
    if (latestDraft.source_image_fingerprint && latestDraft.source_image_fingerprint !== currentImageFingerprint) {
      return jsonResponse({
        success: false,
        error_code: "IMAGE_FINGERPRINT_MISMATCH",
        message: "Drive images were modified before confirmation. Re-generation required."
      });
    }

    // ハッシュタグと説明文の統合
    let fullDescription = String(confirmedData.description || "").trim();
    const hashtags = String(confirmedData.hashtags_ja || "").trim();
    if (hashtags && fullDescription.indexOf(hashtags) === -1) {
      fullDescription = fullDescription ? fullDescription + "\n\n" + hashtags : hashtags;
    }
    const effectiveCategory = normalizedCat || String(row[2] || "").trim();

    // 指示3 & 要件2: 初回確認の属性変更検知 & 自分の途中保存再試行との区別 (pending_review時のみ)
    // 途中失敗後、別スタッフが説明文・カテゴリ・SKU・サイズ・ポケカ属性・英文を変更した場合も、再試行で上書きしない
    // 取得例外を catch で無視せず Fail-Closed とし、保存段階 (Stage) に応じて自分の途中保存と他者変更を区別
    if (!isReconfirming) {
      const currentSourceFingerprint = computeProductSourceFingerprint_(sheet, targetRow, productId);
      if (latestDraft.source_fingerprint && latestDraft.source_fingerprint !== currentSourceFingerprint) {
      // 1) attempt_id の厳格照合 (未指定または他スタッフの attempt_id は即座に拒絶)
      if (!confirmationAttemptId || confirmationAttemptId !== latestDraft.last_confirmation_attempt_id) {
        return jsonResponse({
          success: false,
          error_code: "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER",
          message: "Product attributes or translations were modified by another user since draft generation. Re-generation required."
        });
      }

      // 2) 要求内容ハッシュの照合 (同一 attempt_id でも確定要求内容が改変されていたら拒絶)
      if (latestDraft.last_confirmation_payload_hash && latestDraft.last_confirmation_payload_hash !== currentPayloadHash) {
        return jsonResponse({
          success: false,
          error_code: "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER",
          message: "Confirmation payload changed since initial attempt. Concurrent modification detected."
        });
      }


      // 3) 現在の保存段階（Stage）の分析と他者競合変更の検知
      const currentName = String(row[4] || "").trim();
      const currentCond = String(row[5] || "").trim();
      const currentPrice = Number(row[7]);
      const currentDesc = String(row[9] || "").trim();
      const currentCat = String(row[2] || "").trim();
      const currentBrand = String(row[3] || "").trim();
      const currentSku = String(row[11] || "").trim();
      const currentSize = String(row[12] || "").trim();

      // 各項目の確定値一致判定
      const isNameMatch = (currentName === productName);
      const isCondMatch = (currentCond === condition);
      const isPriceMatch = (currentPrice === plannedSalePrice);
      const isDescMatch = (confirmedData.description === undefined && confirmedData.hashtags_ja === undefined || currentDesc === fullDescription);
      const isCatMatch = (!normalizedCat || currentCat === normalizedCat);
      const isBrandMatch = (confirmedData.brand === undefined || currentBrand === String(confirmedData.brand || "").trim());
      const isSkuMatch = (confirmedData.sneaker_sku === undefined || currentSku === String(confirmedData.sneaker_sku || "").trim());
      const isSizeMatch = (confirmedData.sneaker_size === undefined || currentSize === String(confirmedData.sneaker_size || "").trim());

      const isMainFullyConfirmed = (
        isNameMatch && isCondMatch && isPriceMatch && isDescMatch &&
        isCatMatch && isBrandMatch && isSkuMatch && isSizeMatch
      );

      // ポケカ情報の読取 (読取例外は catch で無視せず Fail-Closed)
      const currentPoke = (effectiveCategory === "pokemon_card") ? safeGetPokemonCard_(productId) : null;
      let isPokeConfirmed = false;
      let isPokeAtInitialState = false;

      if (effectiveCategory === "pokemon_card") {
        if (confirmedData.pokemon_card && typeof confirmedData.pokemon_card === "object") {
          if (currentPoke) {
            const expPoke = confirmedData.pokemon_card;
            const pokeCheckFields = [
              "card_name", "set_name", "card_number", "rarity",
              "language", "grading_status", "grader", "grade",
              "certification_number", "card_condition"
            ];
            let match = true;
            for (let i = 0; i < pokeCheckFields.length; i++) {
              const f = pokeCheckFields[i];
              if (expPoke[f] !== undefined && String(expPoke[f] || "").trim() !== String(currentPoke[f] || "").trim()) {
                match = false;
                break;
              }
            }
            isPokeConfirmed = match;
          }
        } else {
          isPokeConfirmed = true;
        }

        // ケース2対応: ポケカ未保存と他スタッフ変更の区別
        if (!isPokeConfirmed) {
          if (!currentPoke) {
            // レコード未登録（初期状態のまま未保存）
            isPokeAtInitialState = true;
          } else {
            // レコードが存在する場合: ドラフト生成日時以前の作成・更新であれば初期状態のまま未保存
            const pokeTime = currentPoke.updated_at || currentPoke.created_at;
            const draftTime = latestDraft.generated_at;
            if (pokeTime && draftTime) {
              const pokeMs = new Date(pokeTime).getTime();
              const draftMs = new Date(draftTime).getTime();
              if (!isNaN(pokeMs) && !isNaN(draftMs) && pokeMs <= draftMs) {
                isPokeAtInitialState = true;
              }
            }
          }
        }
      } else {
        isPokeConfirmed = true;
        isPokeAtInitialState = true;
      }

      // 英文翻訳の読取 (読取例外は catch で無視せず Fail-Closed)
      const currentTrans = safeGetProductTranslation_(productId);
      let isTransConfirmed = false;
      let isTransAtInitialState = false;

      if (currentTrans && currentTrans.translation_status === "approved") {
        if (String(currentTrans.translated_title || "").trim() === transTitle &&
            String(currentTrans.translated_description || "").trim() === transDesc) {
          isTransConfirmed = true;
        }
      }

      // ケース3対応: 元から承認済み英文がある商品の、英文更新前失敗からの復旧
      if (!isTransConfirmed) {
        if (!currentTrans) {
          isTransAtInitialState = true;
        } else if (currentTrans.translation_status !== "approved") {
          // draft ステータスの未承認翻訳なら未保存・初期状態
          isTransAtInitialState = true;
        } else {
          // approved の英文が存在する場合 (元から承認済み英文があった商品):
          // ドラフト生成日時以前の生成であれば「元の承認済み英文」のまま未更新
          const transTime = currentTrans.generated_at;
          const draftTime = latestDraft.generated_at;
          if (transTime && draftTime) {
            const transMs = new Date(transTime).getTime();
            const draftMs = new Date(draftTime).getTime();
            if (!isNaN(transMs) && !isNaN(draftMs) && transMs <= draftMs) {
              isTransAtInitialState = true;
            }
          }
        }
      }

      // ケース1対応: セル単位の書込み途中で落ちた場合（先頭から連続して一部セルのみ確定値）
      // コア4項目（商品名、状態、価格、説明文）の順次書込みプレフィックス検証
      let isMainPartialInProgress = false;
      if (!isMainFullyConfirmed) {
        const coreSeq = [isNameMatch, isCondMatch, isPriceMatch, isDescMatch];
        let firstFalseIdx = -1;
        for (let i = 0; i < coreSeq.length; i++) {
          if (!coreSeq[i]) {
            firstFalseIdx = i;
            break;
          }
        }

        if (firstFalseIdx > 0) {
          let hasTrueAfterFalse = false;
          for (let i = firstFalseIdx + 1; i < coreSeq.length; i++) {
            if (coreSeq[i]) {
              hasTrueAfterFalse = true;
              break;
            }
          }

          if (!hasTrueAfterFalse && (isPokeAtInitialState || !currentPoke) && (isTransAtInitialState || !currentTrans)) {
            if (firstFalseIdx < 3 || confirmedData.description !== undefined) {
              isMainPartialInProgress = true;
            }
          }
        }
      }

      const isMainConfirmed = isMainFullyConfirmed || isMainPartialInProgress;

      // 保存段階の妥当性評価:
      // Stage 3: 本票完了 ＋ ポケカ完了 ＋ 英文完了
      // Stage 2: 本票完了 ＋ ポケカ完了 ＋ 英文は初期状態（未保存）
      // Stage 1: 本票完了（またはセル書込み途中） ＋ ポケカは初期状態（未保存） ＋ 英文は初期状態（未保存）
      let isValidPartialStage = false;

      if (isMainConfirmed) {
        if (isPokeConfirmed && isTransConfirmed) {
          // Stage 3 (英文保存まで完了)
          isValidPartialStage = true;
        } else if (isPokeConfirmed && (isTransAtInitialState || isTransConfirmed)) {
          // Stage 2 (ポケカ保存まで完了、英文保存前)
          isValidPartialStage = true;
        } else if ((isPokeAtInitialState || isPokeConfirmed) && (isTransAtInitialState || isTransConfirmed)) {
          // Stage 1 (本票のみ完了またはセル書込み途中、ポケカ・英文保存前)
          isValidPartialStage = true;
        }
      }

      if (!isValidPartialStage) {
        return jsonResponse({
          success: false,
          error_code: "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER",
          message: "Product attributes, translations, or pokemon cards were modified by another staff since partial confirmation. Concurrent edit detected."
        });
      }

      console.log(`[AI Draft] Resuming validated partial confirmation retry (stage verified) for ${productId} with attempt_id ${confirmationAttemptId}`);
    }
  }

    // カテゴリ変更制約: 登録後のカテゴリ変更は厳格に禁止 (登録後カテゴリ不変原則)
    // 通常の既存 other 商品に新しいAIドラフトを生成・確定するケースでも、登録後のカテゴリ変更は CATEGORY_CANNOT_BE_CHANGED で拒絶する
    // ※現行データには通常手動登録商品とAI先行仮商品を確実に判別する作成元情報が存在しないため、推測による特例昇格は作らず Fail-Closed とする
    // （本票カテゴリが未設定・空欄 !existingCatInSheet の新規下書き商品のみ初回カテゴリ決定を許可）
    const existingCatInSheet = String(row[2] || "").trim();
    const canPromoteToFashion = false;

    if (existingCatInSheet && normalizedCat && normalizedCat !== existingCatInSheet && !canPromoteToFashion) {
      return jsonResponse({
        success: false,
        error_code: "CATEGORY_CANNOT_BE_CHANGED",
        message: `product category cannot be changed after creation (current: '${existingCatInSheet}', requested: '${normalizedCat}')`
      });
    }

    let finalCategoryToSet = "";
    if (!existingCatInSheet && normalizedCat) {
      finalCategoryToSet = normalizedCat;
    }

    // 確定後の実効カテゴリ (C列に反映されるカテゴリを優先)
    const effectiveCategoryAfterSet = finalCategoryToSet || existingCatInSheet || normalizedCat;
    const isApparelOrFashionCat = (effectiveCategoryAfterSet === "apparel" || effectiveCategoryAfterSet === "fashion_goods");

    // 要件1: 43列未満のシートを先に43列読み取らない・書かない
    // アパレル／ファッション小物のAIドラフト確定で、確定先が apparel / fashion_goods なら物理列数を確認する。
    // 43列未満の場合は本票への書き込み前に INSUFFICIENT_SHEET_COLUMNS を返し、43列目までの読取・書込を行わない。
    if (isApparelOrFashionCat) {
      if (typeof assertProductSheetColumnCount_ === "function") {
        try {
          assertProductSheetColumnCount_(sheet);
        } catch (colErr) {
          return jsonResponse({
            success: false,
            error_code: colErr.error_code || "INSUFFICIENT_SHEET_COLUMNS",
            message: colErr.message || "Product sheet column count insufficient (found < 43, required: 43)"
          });
        }
      } else if (sheet && typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() < 43) {
        return jsonResponse({
          success: false,
          error_code: "INSUFFICIENT_SHEET_COLUMNS",
          message: `Product sheet column count insufficient for ${effectiveCategoryAfterSet} (found: ${sheet.getMaxColumns()}, required: 43). Please ensure columns AO, AP, AQ exist.`
        });
      }

      // シートが43列以上あることが確認された場合のみ、新列（41〜43列）の既存値を安全に読み取る
      if (sheet && typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 43) {
        const extraCols = sheet.getRange(targetRow, 41, 1, 3).getValues()[0];
        row[40] = extraCols[0]; // 41列目 (AO: subcategory)
        row[41] = extraCols[1]; // 42列目 (AP: size)
        row[42] = extraCols[2]; // 43列目 (AQ: official_sku)
      }
    }

    // ------------------------------------------
    // 段階的保存と再読取り整合性検証
    // ------------------------------------------

    const draftSheet = getOrCreateProductAiDraftsSheet_();
    const draftHeaders = draftSheet.getRange(1, 1, 1, draftSheet.getLastColumn()).getValues()[0].map(h => String(h || "").trim());

    function setDraftCell_(colName, val) {
      const colIdx = draftHeaders.indexOf(colName);
      if (colIdx !== -1) {
        draftSheet.getRange(latestDraft.row_number, colIdx + 1).setValue(val);
      }
    }

    // 初回・再試行の attempt_id および payload_hash をドラフト行に記録 (指示1)
    if (confirmationAttemptId) {
      setDraftCell_("last_confirmation_attempt_id", confirmationAttemptId);
    }
    if (currentPayloadHash) {
      setDraftCell_("last_confirmation_payload_hash", currentPayloadHash);
    }

    // 1) 商品マスター本票 (Sheets[0]) の更新
    sheet.getRange(targetRow, 5).setValue(productName);           // E: product_name
    sheet.getRange(targetRow, 6).setValue(condition);             // F: condition
    sheet.getRange(targetRow, 8).setValue(plannedSalePrice);      // H: planned_sale_price
    sheet.getRange(targetRow, 10).setValue(fullDescription);      // J: description

    if (finalCategoryToSet) {
      sheet.getRange(targetRow, 3).setValue(finalCategoryToSet);       // C: category
    }

    if (confirmedData.brand !== undefined) {
      const normBrand = normalizeBrandValue_(confirmedData.brand, effectiveCategoryAfterSet);
      sheet.getRange(targetRow, 4).setValue(normBrand || String(confirmedData.brand || ""));       // D: brand
    }

    // スニーカー属性の更新: スニーカー以外のカテゴリ（ポケカ、ジュエリー、アパレル、小物等）への誤書き込みを防止
    const isNonSneakerCat = ["pokemon_card", "jewelry", "apparel", "fashion_goods", "other"].includes(effectiveCategoryAfterSet);
    if (!isNonSneakerCat) {
      if (rawSku !== undefined) {
        sheet.getRange(targetRow, 12).setValue(String(rawSku || "")); // L: sneaker_sku
      }
      if (rawSize !== undefined) {
        sheet.getRange(targetRow, 13).setValue(rawSize);               // M: sneaker_size
      }
    }

    // 2) ポケモンカード固有属性の保存
    if (effectiveCategoryAfterSet === "pokemon_card" && confirmedData.pokemon_card && typeof confirmedData.pokemon_card === "object") {
      savePokemonCardByProductId(productId, confirmedData.pokemon_card);
    }

    // 2-2) アパレル・ファッション小物固有属性の保存 (41: subcategory, 42: size, 43: official_sku)
    // 要件2: スタッフが入力したサイズ・公式品番を守る。既存商品のサイズ(AP列)と公式品番(AQ列)に値があればAI候補で上書きせず保護、空欄のみ補完する。
    // サブカテゴリはスタッフが明示的に送った値だけ保存し、推測で埋めない。
    let effectiveSavedSize = "";
    let effectiveSavedSku = "";

    if (isApparelOrFashionCat && sheet.getMaxColumns() >= 43) {
      // 41: subcategory (スタッフが明示的に送った値のみ保存。AI推測値では埋めない)
      const explicitSubcat = confirmedData.subcategory !== undefined ? confirmedData.subcategory : (confirmedData.sub_category !== undefined ? confirmedData.sub_category : undefined);
      if (explicitSubcat !== undefined && explicitSubcat !== null && String(explicitSubcat).trim() !== "") {
        sheet.getRange(targetRow, 41).setValue(String(explicitSubcat).trim());
      }

      // 42: size (スタッフ入力済みの既存値AP列があればAI候補で上書きせず保護、空欄時のみ補完保存)
      const existingSizeInSheet = String(row[41] || "").trim();
      if (existingSizeInSheet) {
        effectiveSavedSize = existingSizeInSheet;
      } else {
        const confirmedSize = rawSize !== undefined ? rawSize : confirmedData.size;
        if (confirmedSize !== undefined && confirmedSize !== null && String(confirmedSize).trim() !== "") {
          sheet.getRange(targetRow, 42).setValue(String(confirmedSize).trim());
          effectiveSavedSize = String(confirmedSize).trim();
        }
      }

      // 43: official_sku (スタッフ入力済みの既存値AQ列があればAI候補で上書きせず保護、空欄時のみ補完保存)
      const existingSkuInSheet = String(row[42] || "").trim();
      if (existingSkuInSheet) {
        effectiveSavedSku = existingSkuInSheet;
      } else {
        const confirmedOfficialSku = confirmedData.official_sku !== undefined ? confirmedData.official_sku : (rawSku !== undefined ? rawSku : confirmedData.sku);
        if (confirmedOfficialSku !== undefined && confirmedOfficialSku !== null && String(confirmedOfficialSku).trim() !== "") {
          sheet.getRange(targetRow, 43).setValue(String(confirmedOfficialSku).trim());
          effectiveSavedSku = String(confirmedOfficialSku).trim();
        }
      }
    }

    // 3) スタッフ修正済み英文を保存 (重複追記防止: 既存レコードの最新化または追記)
    // 指示4: 英文の箱・付属品は本票の値から保存するか、既存値を保持する
    const rawBox = confirmedData.box !== undefined ? confirmedData.box : (confirmedData.sneaker_box !== undefined ? confirmedData.sneaker_box : row[14]);
    const rawAccessories = confirmedData.accessories !== undefined ? confirmedData.accessories : (confirmedData.sneaker_accessories !== undefined ? confirmedData.sneaker_accessories : row[15]);

    saveConfirmedProductTranslation_(productId, {
      translated_title: transTitle,
      translated_description: transDesc,
      condition: condition,
      box: rawBox,
      accessories: rawAccessories
    });

    // 4) 再読取りによる全確認対象項目の厳格な整合性検証 (Comprehensive Re-read validation)
    const verifyRow = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 16)).getValues()[0];
    const savedName = String(verifyRow[4] || "").trim();
    const savedCond = String(verifyRow[5] || "").trim();
    const savedPrice = Number(verifyRow[7]);
    const savedDesc = String(verifyRow[9] || "").trim();

    if (savedName !== productName) {
      const err = new Error("Re-read verification failed: product_name does not match saved value.");
      err.error_code = "RE_READ_VERIFICATION_FAILED";
      throw err;
    }
    if (savedCond !== condition) {
      const err = new Error("Re-read verification failed: condition does not match saved value.");
      err.error_code = "RE_READ_VERIFICATION_FAILED";
      throw err;
    }
    if (savedPrice !== plannedSalePrice) {
      const err = new Error("Re-read verification failed: planned_sale_price does not match saved value.");
      err.error_code = "RE_READ_VERIFICATION_FAILED";
      throw err;
    }
    if (savedDesc !== fullDescription) {
      const err = new Error("Re-read verification failed: description does not match saved value.");
      err.error_code = "RE_READ_VERIFICATION_FAILED";
      throw err;
    }

    if (normalizedCat) {
      const savedCat = String(verifyRow[2] || "").trim();
      const expectedCat = finalCategoryToSet || existingCatInSheet || normalizedCat;
      if (savedCat !== expectedCat) {
        const err = new Error("Re-read verification failed: category does not match normalized saved value.");
        err.error_code = "RE_READ_VERIFICATION_FAILED";
        throw err;
      }
    }

    if (confirmedData.brand !== undefined) {
      const savedBrand = String(verifyRow[3] || "").trim();
      if (savedBrand !== String(confirmedData.brand || "").trim()) {
        const err = new Error("Re-read verification failed: brand does not match saved value.");
        err.error_code = "RE_READ_VERIFICATION_FAILED";
        throw err;
      }
    }

    // スニーカー属性の再読取検証 (sneakerカテゴリ限定)
    if (effectiveCategoryAfterSet === "sneaker") {
      if (rawSku !== undefined) {
        const savedSku = String(verifyRow[11] || "").trim();
        if (savedSku !== String(rawSku || "").trim()) {
          const err = new Error("Re-read verification failed: sneaker_sku does not match saved value.");
          err.error_code = "RE_READ_VERIFICATION_FAILED";
          throw err;
        }
      }

      if (rawSize !== undefined) {
        const savedSize = String(verifyRow[12] || "").trim();
        if (savedSize !== String(rawSize || "").trim()) {
          const err = new Error("Re-read verification failed: sneaker_size does not match saved value.");
          err.error_code = "RE_READ_VERIFICATION_FAILED";
          throw err;
        }
      }
    }

    // アパレル・ファッション小物属性の再読取検証 (apparel / fashion_goods 限定)
    if (isApparelOrFashionCat && sheet.getMaxColumns() >= 43) {
      const explicitSubcat = confirmedData.subcategory !== undefined ? confirmedData.subcategory : (confirmedData.sub_category !== undefined ? confirmedData.sub_category : undefined);
      if (explicitSubcat !== undefined && explicitSubcat !== null && String(explicitSubcat).trim() !== "") {
        const savedSubcat = String(verifyRow[40] || "").trim();
        if (savedSubcat !== String(explicitSubcat).trim()) {
          const err = new Error("Re-read verification failed: apparel_fashion_subcategory does not match saved value.");
          err.error_code = "RE_READ_VERIFICATION_FAILED";
          throw err;
        }
      }

      if (effectiveSavedSize) {
        const savedFashionSize = String(verifyRow[41] || "").trim();
        if (savedFashionSize !== effectiveSavedSize) {
          const err = new Error("Re-read verification failed: apparel_fashion_size does not match saved value.");
          err.error_code = "RE_READ_VERIFICATION_FAILED";
          throw err;
        }
      }

      if (effectiveSavedSku) {
        const savedFashionSku = String(verifyRow[42] || "").trim();
        if (savedFashionSku !== effectiveSavedSku) {
          const err = new Error("Re-read verification failed: apparel_fashion_sku does not match saved value.");
          err.error_code = "RE_READ_VERIFICATION_FAILED";
          throw err;
        }
      }
    }

    // 指示4: ポケモンカードの全確認対象10属性の再読取検証
    if (effectiveCategory === "pokemon_card" && confirmedData.pokemon_card && typeof confirmedData.pokemon_card === "object") {
      const reReadPoke = getPokemonCardByProductId(productId);
      if (!reReadPoke) {
        const err = new Error("Re-read verification failed: pokemon_card record not found after save.");
        err.error_code = "RE_READ_VERIFICATION_FAILED";
        throw err;
      }
      const expPoke = confirmedData.pokemon_card;
      const pokeCheckFields = [
        "card_name", "set_name", "card_number", "rarity",
        "language", "grading_status", "grader", "grade",
        "certification_number", "card_condition"
      ];
      for (let i = 0; i < pokeCheckFields.length; i++) {
        const f = pokeCheckFields[i];
        if (expPoke[f] !== undefined) {
          const expVal = String(expPoke[f] || "").trim();
          const actVal = String(reReadPoke[f] || "").trim();
          if (expVal !== actVal) {
            const err = new Error(`Re-read verification failed: pokemon_card field '${f}' mismatch (expected '${expVal}', got '${actVal}').`);
            err.error_code = "RE_READ_VERIFICATION_FAILED";
            throw err;
          }
        }
      }
    }

    // 英文翻訳の再読取検証
    const reReadTrans = getProductTranslation(productId);
    if (!reReadTrans ||
        reReadTrans.translation_status !== "approved" ||
        reReadTrans.translated_title !== transTitle ||
        reReadTrans.translated_description !== transDesc) {
      const err = new Error("Re-read verification failed: product translation does not match saved approved content.");
      err.error_code = "RE_READ_VERIFICATION_FAILED";
      throw err;
    }

    // 5) スタッフ確定後の新指紋 (confirmed_fingerprint) を計算
    const confirmedFingerprint = computeConfirmedProductFingerprint_(sheet, targetRow, productId);

    // 指示4: 証跡・確定指紋を先に保存してから、最後に review_status = "confirmed" を確定
    setDraftCell_("confirmed_fingerprint", confirmedFingerprint);
    setDraftCell_("confirmed_at", new Date().toISOString());
    setDraftCell_("confirmed_by", staffId);
    if (confirmationAttemptId) {
      setDraftCell_("last_confirmation_attempt_id", confirmationAttemptId);
    }
    if (currentPayloadHash) {
      setDraftCell_("last_confirmation_payload_hash", currentPayloadHash);
    }

    // 最後に review_status を確定
    setDraftCell_("review_status", "confirmed");

    clearProductCache_(productId);
    clearProductTranslationCache_(productId);
    try {
      CacheService.getScriptCache().remove("prod_aidraft_" + productId);
    } catch (_) {}

    return jsonResponse({
      success: true,
      product_id: productId,
      draft_id: draftId,
      draft_version: draftVersion,
      review_status: "confirmed",
      publish_status: "draft",
      message: "AI draft confirmed and saved successfully. Product is ready for publication."
    });

  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

/**
 * スタッフ確認済み英文を product_translations に安全に保存（重複追記防止）
 * @param {string} productId
 * @param {Object} data
 */
function saveConfirmedProductTranslation_(productId, data) {
  const normId = String(productId || "").trim();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const transSheet = spreadsheet.getSheetByName(LLM_TRANSLATION_CONFIG.SHEET_NAME);

  const fixedAttrs = translateFixedAttributes({
    condition: data.condition,
    box: data.box || "",
    accessories: data.accessories || ""
  });

  // 指示4: 英文の箱・付属品は本票の値から保存するか、既存値を保持する
  let existingTrans = null;
  try {
    existingTrans = getProductTranslation(normId);
  } catch (_) {}

  const finalCondition = fixedAttrs.translated_condition || (existingTrans && existingTrans.translated_condition) || "";
  const finalBox = fixedAttrs.translated_box || (existingTrans && existingTrans.translated_box) || "";
  const finalAccessories = fixedAttrs.translated_accessories || (existingTrans && existingTrans.translated_accessories) || "";

  const recordMap = {
    product_id: normId,
    locale: "en",
    translated_title: String(data.translated_title || "").trim(),
    translated_description: String(data.translated_description || "").trim(),
    translated_condition: finalCondition,
    translated_box: finalBox,
    translated_accessories: finalAccessories,
    translation_status: "approved",
    generated_at: new Date().toISOString()
  };

  if (!transSheet) {
    saveProductTranslation(normId, recordMap, { translation_status: "approved" });
    return;
  }

  const lastRow = transSheet.getLastRow();
  const lastCol = transSheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) {
    saveProductTranslation(normId, recordMap, { translation_status: "approved" });
    return;
  }

  const headers = transSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const pIdIdx = headers.indexOf("product_id");
  const localeIdx = headers.indexOf("locale");

  let existingApprovedRow = -1;
  const rows = transSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (String(row[pIdIdx] || "").trim() === normId && (localeIdx === -1 || String(row[localeIdx] || "en").trim() === "en")) {
      existingApprovedRow = i + 2;
      break;
    }
  }

  // 既存レコードがあればその行を上書き更新（重複追記防止）
  if (existingApprovedRow !== -1) {
    headers.forEach((h, colIdx) => {
      if (recordMap[h] !== undefined) {
        transSheet.getRange(existingApprovedRow, colIdx + 1).setValue(recordMap[h]);
      }
    });
  } else {
    saveProductTranslation(normId, recordMap, { translation_status: "approved" });
  }

  try {
    if (typeof clearProductTranslationCache_ === "function") {
      clearProductTranslationCache_(normId);
    } else {
      CacheService.getScriptCache().remove("prod_trans_" + normId);
    }
  } catch (_) {}
}

// ==================================================
// 9. 確認解除フック
// ==================================================

/**
 * 商品画像変更等により、既存の確認済みドラフトを stale (失効) に差し戻す
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {string} productId
 * @param {string} reason
 */
function invalidateAiDraftConfirmationIfExists_(sheet, productId, reason) {
  const normId = String(productId || "").trim();
  if (!normId) return;

  try {
    const latestDraft = getLatestProductAiDraft_(normId);
    if (latestDraft && latestDraft.review_status === "confirmed") {
      const draftSheet = getOrCreateProductAiDraftsSheet_();
      draftSheet.getRange(latestDraft.row_number, 4).setValue("stale");
      console.log(`[AI Draft] Confirmation invalidated for ${normId}: ${reason}`);
      try {
        CacheService.getScriptCache().remove("prod_aidraft_" + normId);
      } catch (_) {}
    }
  } catch (err) {
    console.warn("invalidateAiDraftConfirmationIfExists_ error for " + normId + ":", err);
  }
}

// ==================================================
// 10. 販売開始ゲート（Fail-Closed 共通判定）
// ==================================================

/**
 * 商品が公開可能（販売開始可能）であるかを厳格に検証するゲート関数
 *
 * 判定ルール:
 * 1. 通常商品 (AN列 ai_draft_flag が空): 既存通り無条件通過 (後方互換100%維持)
 * 2. AI対象商品 (AN列 ai_draft_flag === 'ai_managed'):
 *    - 履歴取得失敗時: 例外スロー (Fail-Closed)
 *    - 履歴欠損時: 例外スロー (Fail-Closed)
 *    - review_status !== 'confirmed': 例外スロー (Fail-Closed)
 *    - confirmed_fingerprint 未登録時: 例外スロー (Fail-Closed)
 *    - 確認後確定内容指紋の不一致 (確認後に画像・価格・属性・英文が改ざんされた): 例外スロー (Fail-Closed)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 商品マスターシート
 * @param {number} targetRow 行番号
 * @param {string} productId 商品ID
 * @return {boolean}
 */
function assertProductPublishable_(sheet, targetRow, productId) {
  // 1. スニーカーカテゴリの場合、サイズ必須 (公開・Square販売反映の直前で共通検証)
  // C列 (3): category, M列 (13): sneaker_size
  const categoryRaw = sheet.getRange(targetRow, 3).getValue();
  const normalizedCategory = normalizeCategoryValue_(categoryRaw);
  if (normalizedCategory === "sneaker") {
    const sizeVal = String(sheet.getRange(targetRow, 13).getValue() || "").trim();
    if (!sizeVal) {
      const sizeErr = new Error(
        "[Publish Gate Blocked] Product " + productId +
        " is a sneaker but has no sneaker_size specified. Size is required before publishing or reflecting to Square."
      );
      sizeErr.error_code = "SNEAKER_SIZE_REQUIRED";
      throw sizeErr;
    }
  }

  const flagCol = AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN;
  const maxCol = sheet.getLastColumn();

  let aiDraftFlag = "";
  if (maxCol >= flagCol) {
    aiDraftFlag = String(sheet.getRange(targetRow, flagCol).getValue() || "").trim();
  }

  // 2. 通常商品は通過 (スニーカーサイズ検証通過後)
  if (!aiDraftFlag) {
    return true;
  }

  // 2. AI対象商品の厳格検証
  if (aiDraftFlag === AI_DRAFT_CONFIG.FLAG_VALUE) {
    let latestDraft = null;
    try {
      latestDraft = getLatestProductAiDraft_(productId);
    } catch (fetchErr) {
      const err = new Error(
        "[Publish Gate Blocked] Failed to retrieve AI draft records for product " +
        productId + ": " + fetchErr.message
      );
      err.error_code = "AI_DRAFT_HISTORY_FETCH_FAILED";
      throw err;
    }

    if (!latestDraft) {
      const err = new Error(
        "[Publish Gate Blocked] Product " + productId +
        " is marked as AI managed but has no AI draft records found (Fail-Closed)."
      );
      err.error_code = "AI_DRAFT_HISTORY_MISSING";
      throw err;
    }

    if (latestDraft.review_status !== "confirmed") {
      const err = new Error(
        "[Publish Gate Blocked] Product " + productId +
        " is an unconfirmed AI draft (review_status: '" +
        latestDraft.review_status +
        "'). Staff confirmation is required before publishing."
      );
      err.error_code = "AI_DRAFT_UNCONFIRMED";
      throw err;
    }

    if (!latestDraft.confirmed_fingerprint) {
      const err = new Error(
        "[Publish Gate Blocked] Product " + productId +
        " has no confirmed fingerprint recorded (Fail-Closed)."
      );
      err.error_code = "AI_DRAFT_CONFIRMED_FINGERPRINT_MISSING";
      throw err;
    }

    // 確認後確定内容指紋の照合（確認後に画像・価格・属性・ポケカ・英文のいずれかが変更されたかを完全検知）
    const currentConfirmedFingerprint = computeConfirmedProductFingerprint_(sheet, targetRow, productId);
    if (latestDraft.confirmed_fingerprint !== currentConfirmedFingerprint) {
      let detailMsg = "attributes, images, or translations were modified after staff confirmation";

      // 差分診断: sneaker_size が確定保存時の空欄から変更されたケースを検出
      try {
        const readColCount = (typeof sheet.getMaxColumns === "function" && sheet.getMaxColumns() >= 43)
    ? Math.max(sheet.getLastColumn(), 43)
    : Math.max(sheet.getLastColumn(), 40);
  const rowVals = sheet.getRange(targetRow, 1, 1, readColCount).getValues()[0];
        const curCat = normalizeCategoryValue_(rowVals[2]);
        const curSize = String(rowVals[12] || "").trim();
        if (curCat === "sneaker" && curSize) {
          const cat = String(rowVals[2] || "").trim();
          const brand = String(rowVals[3] || "").trim();
          const pName = String(rowVals[4] || "").trim();
          const cond = String(rowVals[5] || "").trim();
          const price = String(rowVals[7] || "").trim();
          const desc = String(rowVals[9] || "").trim();
          const notes = String(rowVals[10] || "").trim();
          const sku = String(rowVals[11] || "").trim();
          const colorway = String(rowVals[13] || "").trim();
          const box = String(rowVals[14] || "").trim();
          const acc = String(rowVals[15] || "").trim();
          const trans = safeGetProductTranslation_(productId);
          const transStr = (trans && trans.translation_status === "approved") ? [
            trans.translated_title || "",
            trans.translated_description || "",
            trans.translated_condition || "",
            trans.translated_box || "",
            trans.translated_accessories || "",
            trans.translation_status || ""
          ].join(",") : "";
          const driveFolderUrl = String(rowVals[29] || "").trim();
          const imgFp = computeImageFingerprintFromFolderUrl_(driveFolderUrl);
          const subcat = String(rowVals[40] || "").trim();
          const fSize = String(rowVals[41] || "").trim();
          const fSku = String(rowVals[42] || "").trim();
          const emptySizeCombined = [
            productId, cat, brand, pName, cond, price, desc, notes,
            sku, "", colorway, box, acc, subcat, fSize, fSku, "", transStr, imgFp
          ].join("::");
          const emptyDigest = Utilities.computeDigest(
            Utilities.DigestAlgorithm.SHA_256,
            emptySizeCombined,
            Utilities.Charset.UTF_8
          );
          const emptySizeFp = emptyDigest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");

          if (emptySizeFp === latestDraft.confirmed_fingerprint) {
            detailMsg = `sneaker_size was updated to '${curSize}' after initial empty confirmation without re-confirmation`;
          }
        }
      } catch (_) {}

      console.warn(`[Publish Gate Blocked] Product ${productId}: ${detailMsg}. Saved fp: ${latestDraft.confirmed_fingerprint}, current fp: ${currentConfirmedFingerprint}`);

      const err = new Error(
        `[Publish Gate Blocked] Product ${productId} ${detailMsg}. Re-confirmation required before publishing.`
      );
      err.error_code = "AI_DRAFT_MODIFIED_AFTER_CONFIRMATION";
      throw err;
    }

    const rawSalePrice = sheet.getRange(targetRow, 8).getValue();
    const strSalePrice = String(rawSalePrice === null || rawSalePrice === undefined ? "" : rawSalePrice).trim();
    const numericSalePrice = Number(rawSalePrice);
    if (!strSalePrice || (Number.isFinite(numericSalePrice) && numericSalePrice <= 0)) {
      const priceErr = new Error(
        "[Publish Gate Blocked] Product " + productId +
        " has no valid planned_sale_price set. Staff must confirm and enter a positive sale price before publishing."
      );
      priceErr.error_code = "SALE_PRICE_REQUIRED_FOR_PUBLISH";
      throw priceErr;
    }

    return true;
  }

  const unknownErr = new Error(
    "[Publish Gate Blocked] Unknown ai_draft_flag '" + aiDraftFlag + "' for product " + productId
  );
  unknownErr.error_code = "AI_DRAFT_UNKNOWN_FLAG";
  throw unknownErr;
}

// ==================================================
// 12. AI一括出品ドラフト管理 (Batch Generation)
// ==================================================

/**
 * AI一括出品ドラフト定数設定
 */
const AI_BATCH_CONFIG = {
  JOBS_SHEET_NAME: "ai_batch_jobs",
  ITEMS_SHEET_NAME: "ai_batch_items",
  MAX_ITEMS_PER_BATCH: 20,
  MAX_ITEMS_PER_RUN: 3,
  MAX_EXECUTION_TIME_MS: 240000, // 約4分 (240秒)
  ESTIMATED_ITEM_TIME_MS: 60000, // 2段階方式を考慮し1アイテム推定60秒 (240秒手前で安全に中断)
  LOCK_TIMEOUT_MS: 5000,
  LEASE_TTL_MS: 300000, // 5分 (300秒)
  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: 60000, // 1分
  MAX_STORED_RETRY_REQUESTS: 50,
  MODEL_NAME_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  // 再試行対象とする構造化エラーコード (callGeminiMultimodalAiDraft_ が実際に返す値)
  TRANSIENT_ERROR_CODES: [
    "LLM_HTTP_ERROR_429",
    "LLM_HTTP_ERROR_500",
    "LLM_HTTP_ERROR_502",
    "LLM_HTTP_ERROR_503",
    "LLM_HTTP_ERROR_504",
    "LLM_COMMUNICATION_FAILED"
  ],
  // 既存12列の後ろに追加列を配置 (既存列の位置・保存済みデータとの互換性を維持)
  JOB_HEADERS: [
    "batch_id",
    "request_id",
    "status",
    "total_count",
    "completed_count",
    "failed_count",
    "processing_count",
    "created_at",
    "updated_at",
    "completed_at",
    "worker_execution_id",
    "lease_expires_at",
    "force_regenerate",
    "model_name",
    "retry_requests",
    "min_gross_margin_rate",
    "product_costs_json",
    "min_cost_markup_rate"
  ],
  ITEM_HEADERS: [
    "batch_id",
    "product_id",
    "item_index",
    "status",
    "draft_id",
    "draft_version",
    "model_name",
    "error_code",
    "error_message",
    "retry_count",
    "next_retry_at",
    "worker_execution_id",
    "lease_expires_at",
    "created_at",
    "updated_at",
    "selected_image_ids"
  ]
};

/**
 * ai_batch_jobs シートを取得または作成
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateAiBatchJobsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(AI_BATCH_CONFIG.JOBS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AI_BATCH_CONFIG.JOBS_SHEET_NAME);
    sheet.appendRow(AI_BATCH_CONFIG.JOB_HEADERS);
    sheet.setFrozenRows(1);
  }
  ensureAiBatchJobColumns_(sheet);
  return sheet;
}

/**
 * 既存 ai_batch_jobs シートに不足している追加列ヘッダーを末尾へ追記 (既存列は移動しない)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureAiBatchJobColumns_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return;
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  let nextCol = lastCol + 1;
  AI_BATCH_CONFIG.JOB_HEADERS.forEach(h => {
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, nextCol).setValue(h);
      headers.push(h);
      nextCol++;
    }
  });
}

/**
 * ai_batch_jobs のヘッダー名から 0始まり列インデックスのマップを取得
 * @param {GoogleAppsScript.Spreadsheet.Sheet} jobsSheet
 * @return {Object<string, number>}
 */
function getAiBatchJobHeaderIndex_(jobsSheet) {
  const lastCol = jobsSheet.getLastColumn();
  const headers = lastCol > 0
    ? jobsSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim())
    : [];
  const map = {};
  headers.forEach((h, i) => {
    if (h && map[h] === undefined) map[h] = i;
  });
  return map;
}

/**
 * シート保存値を boolean へ正規化 (TRUE / "true" / 1)
 * @param {*} v
 * @return {boolean}
 */
function normalizeSheetBoolean_(v) {
  if (v === true) return true;
  const s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
  return s === "true" || s === "1";
}

/**
 * バッチ単位の生成オプション (force_regenerate / model_name) を取得 (排他ロック内で呼び出す)
 * 追加列が存在しない旧データは既定値 (false / "") として扱う
 * @param {string} batchId
 * @return {{ force_regenerate: boolean, model_name: string }}
 */
function getAiBatchJobOptions_(batchId) {
  const result = {
    force_regenerate: false,
    model_name: "",
    min_cost_markup_rate: AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE,
    product_costs: {},
    has_cost_options: false
  };
  const jobsSheet = getOrCreateAiBatchJobsSheet_();
  const lastRow = jobsSheet.getLastRow();
  if (lastRow <= 1) return result;
  const idx = getAiBatchJobHeaderIndex_(jobsSheet);
  const rows = jobsSheet.getRange(2, 1, lastRow - 1, jobsSheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === batchId) {
      if (idx.force_regenerate !== undefined) {
        result.force_regenerate = normalizeSheetBoolean_(rows[i][idx.force_regenerate]);
      }
      if (idx.model_name !== undefined) {
        result.model_name = String(rows[i][idx.model_name] || "").trim();
      }
      if (idx.min_cost_markup_rate !== undefined) {
        const rawMarkup = rows[i][idx.min_cost_markup_rate];
        if (rawMarkup !== "" && rawMarkup !== null && rawMarkup !== undefined) {
          result.min_cost_markup_rate = normalizeMinCostMarkupRate_(rawMarkup);
          result.has_cost_options = true;
        }
      }
      if (idx.product_costs_json !== undefined) {
        const rawJson = String(rows[i][idx.product_costs_json] || "").trim();
        if (rawJson) {
          result.has_cost_options = true;
          try {
            const parsed = JSON.parse(rawJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              result.product_costs = parsed;
            }
          } catch (_) {
            result.product_costs = {};
          }
        }
      }
      break;
    }
  }
  return result;
}

/**
 * ワーカーがバッチアイテムの所有権を保持しているか検証 (必ず ScriptLock 内で呼び出す)
 * - 行の batch_id / product_id 一致、status=processing、worker_execution_id 一致、リース期限内
 * 不一致時は BATCH_ITEM_OWNERSHIP_LOST をスローし、呼出し元の書込みを中止させる
 * @param {Object} claimedItem
 */
function assertBatchItemOwnership_(claimedItem) {
  const itemsSheet = getOrCreateAiBatchItemsSheet_();
  const colCount = Math.max(itemsSheet.getLastColumn(), 15);
  const row = itemsSheet.getRange(claimedItem.rowIndex, 1, 1, colCount).getValues()[0];
  const leaseStr = String(row[12] || "").trim();
  const leaseTime = leaseStr ? new Date(leaseStr).getTime() : NaN;
  let reason = "";
  if (String(row[0] || "").trim() !== claimedItem.batchId || String(row[1] || "").trim() !== claimedItem.productId) {
    reason = "item row mismatch";
  } else if (String(row[3] || "").trim() !== "processing") {
    reason = "item status is '" + String(row[3] || "").trim() + "'";
  } else if (String(row[11] || "").trim() !== claimedItem.workerExecutionId) {
    reason = "worker_execution_id superseded";
  } else if (!Number.isFinite(leaseTime) || leaseTime <= Date.now()) {
    reason = "lease expired";
  }
  if (reason) {
    const err = new Error("Batch item ownership lost for " + claimedItem.productId + ": " + reason);
    err.error_code = "BATCH_ITEM_OWNERSHIP_LOST";
    throw err;
  }
}

/**
 * 候補保存直前に、バッチアイテムへ対応する draft_id を記録 (必ず ScriptLock 内・所有権検証後に呼び出す)
 * 中断後の回収時に「このアイテムが生成した候補」だけを識別するために使用する
 * @param {Object} claimedItem
 * @param {{ draft_id: string, draft_version: number, model_name: string }} info
 */
function reserveBatchItemDraft_(claimedItem, info) {
  const itemsSheet = getOrCreateAiBatchItemsSheet_();
  itemsSheet.getRange(claimedItem.rowIndex, 5).setValue(info.draft_id || "");
  itemsSheet.getRange(claimedItem.rowIndex, 6).setValue(info.draft_version || "");
  itemsSheet.getRange(claimedItem.rowIndex, 7).setValue(info.model_name || "");
  itemsSheet.getRange(claimedItem.rowIndex, 15).setValue(new Date().toISOString());
}

/**
 * product_ai_drafts に指定 draft_id の行が存在するか確認
 * @param {string} productId
 * @param {string} draftId
 * @return {boolean}
 */
function productAiDraftExists_(productId, draftId) {
  const normId = String(productId || "").trim();
  const normDraftId = String(draftId || "").trim();
  if (!normId || !normDraftId) return false;
  const draftSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AI_DRAFT_CONFIG.SHEET_NAME);
  if (!draftSheet) return false;
  const lastRow = draftSheet.getLastRow();
  const lastCol = draftSheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return false;
  const headers = draftSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const dIdx = headers.indexOf("draft_id");
  const pIdx = headers.indexOf("product_id");
  if (dIdx === -1 || pIdx === -1) return false;
  const rows = draftSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][dIdx] || "").trim() === normDraftId && String(rows[i][pIdx] || "").trim() === normId) {
      return true;
    }
  }
  return false;
}

/**
 * ai_batch_items シートを取得または作成
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
/**
 * 既存 ai_batch_items シートに不足している追加列ヘッダーを末尾へ追記 (既存列は移動しない)
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureAiBatchItemColumns_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return;
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  let nextCol = lastCol + 1;
  AI_BATCH_CONFIG.ITEM_HEADERS.forEach(h => {
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, nextCol).setValue(h);
      headers.push(h);
      nextCol++;
    }
  });
}

/**
 * ai_batch_items のヘッダー名から 0始まり列インデックスのマップを取得
 * @param {GoogleAppsScript.Spreadsheet.Sheet} itemsSheet
 * @return {Object<string, number>}
 */
function getAiBatchItemHeaderIndex_(itemsSheet) {
  const lastCol = itemsSheet.getLastColumn();
  const headers = lastCol > 0
    ? itemsSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim())
    : [];
  const map = {};
  headers.forEach((h, i) => {
    if (h && map[h] === undefined) map[h] = i;
  });
  return map;
}

function getOrCreateAiBatchItemsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(AI_BATCH_CONFIG.ITEMS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AI_BATCH_CONFIG.ITEMS_SHEET_NAME);
    sheet.appendRow(AI_BATCH_CONFIG.ITEM_HEADERS);
    sheet.setFrozenRows(1);
  }
  ensureAiBatchItemColumns_(sheet);
  return sheet;
}

/**
 * リクエストペイロードから商品ごとの明示指定 selected_image_ids マップを抽出
 * 対応形式:
 * 1) data.selected_image_ids_by_product: { "TMP-000001": ["id1", "id2"] } (別名: product_selected_image_ids, selected_images_by_product)
 * 2) data.items / data.products: [{ product_id: "TMP-000001", selected_image_ids: ["id1", "id2"] }]
 * @param {Object} data
 * @return {{ hasExplicitMap: Object<string, boolean>, explicitIdsMap: Object<string, *> }}
 */
function extractBatchExplicitSelectedImages_(data) {
  const hasExplicitMap = {};
  const explicitIdsMap = {};
  if (!data || typeof data !== "object") {
    return { hasExplicitMap: hasExplicitMap, explicitIdsMap: explicitIdsMap };
  }

  const byProductObj =
    (data.selected_image_ids_by_product && typeof data.selected_image_ids_by_product === "object" && !Array.isArray(data.selected_image_ids_by_product))
      ? data.selected_image_ids_by_product
      : (data.product_selected_image_ids && typeof data.product_selected_image_ids === "object" && !Array.isArray(data.product_selected_image_ids))
        ? data.product_selected_image_ids
        : (data.selected_images_by_product && typeof data.selected_images_by_product === "object" && !Array.isArray(data.selected_images_by_product))
          ? data.selected_images_by_product
          : null;

  if (byProductObj) {
    Object.keys(byProductObj).forEach(k => {
      const pid = String(k || "").trim();
      if (pid && byProductObj[k] !== undefined) {
        hasExplicitMap[pid] = true;
        explicitIdsMap[pid] = byProductObj[k];
      }
    });
  }

  const itemArray = Array.isArray(data.items)
    ? data.items
    : (Array.isArray(data.products) ? data.products : []);
  for (let i = 0; i < itemArray.length; i++) {
    const entry = itemArray[i];
    if (!entry || typeof entry !== "object") continue;
    const pid = String(entry.product_id || "").trim();
    if (!pid) continue;
    const rawSel = entry.selected_image_ids !== undefined ? entry.selected_image_ids : entry.ai_selected_image_ids;
    if (rawSel !== undefined) {
      hasExplicitMap[pid] = true;
      explicitIdsMap[pid] = rawSel;
    }
  }

  return { hasExplicitMap: hasExplicitMap, explicitIdsMap: explicitIdsMap };
}

/**
 * リクエストペイロードから商品ごとの原価データ (product_costs) と最低原価上乗せ率 (min_cost_markup_rate) を抽出・正規化
 * - 既存の min_gross_margin_rate (粗利率) と意味を混同しないよう、min_cost_markup_rate (別名: min_markup_rate, 既定0.30 = 概算原価への30%上乗せ) を使用する
 * 対応形式:
 * 1) data.product_costs / data.product_costs_by_product: { "TMP-000001": { links: [...] } | { confirmed_tax_included_cost, ... } | 4000 }
 * 2) data.items / data.products: [{ product_id: "TMP-000001", product_cost: { links: [...] } }]
 * @param {Object} data
 * @param {Array<string>} productIds
 * @return {{ minCostMarkupRate: number, costMarkupMultiplier: number, hasCostInput: boolean, costSummaryByProduct: Object<string, Object> }}
 */
function extractBatchProductCosts_(data, productIds) {
  validateLegacyGrossMarginRateIfPresent_(data && data.min_gross_margin_rate);
  const rawMarkup = (data && data.min_cost_markup_rate !== undefined)
    ? data.min_cost_markup_rate
    : (data && data.min_markup_rate !== undefined ? data.min_markup_rate : undefined);
  const minCostMarkupRate = validateMinCostMarkupRateInput_(rawMarkup, true);
  const grossMarginDivisor = Math.round((1 - minCostMarkupRate) * 1000000) / 1000000;
  const costSummaryByProduct = {};
  let hasCostInput = Boolean(
    data && (
      data.min_cost_markup_rate !== undefined ||
      data.min_markup_rate !== undefined ||
      data.product_costs !== undefined ||
      data.product_costs_by_product !== undefined
    )
  );

  const rawMap = {};
  if (data && typeof data === "object") {
    const byProd = (data.product_costs && typeof data.product_costs === "object" && !Array.isArray(data.product_costs))
      ? data.product_costs
      : ((data.product_costs_by_product && typeof data.product_costs_by_product === "object" && !Array.isArray(data.product_costs_by_product))
        ? data.product_costs_by_product
        : null);
    if (byProd) {
      Object.keys(byProd).forEach(k => {
        const pid = String(k || "").trim();
        if (pid && byProd[k] !== undefined) {
          rawMap[pid] = byProd[k];
        }
      });
    }

    const itemArray = Array.isArray(data.items)
      ? data.items
      : (Array.isArray(data.products) ? data.products : []);
    for (let i = 0; i < itemArray.length; i++) {
      const entry = itemArray[i];
      if (!entry || typeof entry !== "object") continue;
      const pid = String(entry.product_id || "").trim();
      if (!pid) continue;
      const itemCost = entry.product_cost !== undefined ? entry.product_cost : entry.cost;
      if (itemCost !== undefined) {
        hasCostInput = true;
        rawMap[pid] = itemCost;
      }
    }
  }

  const targetIds = Array.isArray(productIds) ? productIds : Object.keys(rawMap);
  for (let i = 0; i < targetIds.length; i++) {
    const pid = String(targetIds[i] || "").trim();
    if (!pid) continue;
    costSummaryByProduct[pid] = computeProductCostSummaryFromInput_(rawMap[pid]);
  }

  return {
    minCostMarkupRate: minCostMarkupRate,
    grossMarginDivisor: grossMarginDivisor,
    hasCostInput: hasCostInput,
    costSummaryByProduct: costSummaryByProduct
  };
}

/**
 * 一括ドラフト生成ジョブの受付 (create_ai_product_draft_batch)
 * @param {Object} data リクエストデータ
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleCreateAiProductDraftBatch(data) {
  const requestId = String(data.request_id || "").trim();
  if (!requestId) {
    return jsonResponse({
      success: false,
      error_code: "REQUEST_ID_REQUIRED",
      message: "request_id is required for batch creation"
    });
  }

  let rawProductIds = Array.isArray(data.product_ids) ? data.product_ids.slice() : [];
  if (rawProductIds.length === 0 && Array.isArray(data.items)) {
    rawProductIds = data.items.map(it => (it && typeof it === "object") ? it.product_id : "");
  }
  const seenIds = new Set();
  const productIds = [];
  for (let i = 0; i < rawProductIds.length; i++) {
    const pid = String(rawProductIds[i] || "").trim();
    if (pid && !seenIds.has(pid)) {
      seenIds.add(pid);
      productIds.push(pid);
    }
  }

  if (productIds.length === 0) {
    return jsonResponse({
      success: false,
      error_code: "EMPTY_PRODUCT_IDS",
      message: "product_ids must contain at least one valid product ID"
    });
  }

  if (productIds.length > AI_BATCH_CONFIG.MAX_ITEMS_PER_BATCH) {
    return jsonResponse({
      success: false,
      error_code: "MAX_BATCH_SIZE_EXCEEDED",
      message: "Maximum batch size is " + AI_BATCH_CONFIG.MAX_ITEMS_PER_BATCH + " products (received " + productIds.length + ")"
    });
  }

  const forceRegenerate = data.force_regenerate === true || String(data.force_regenerate || "").trim().toLowerCase() === "true";
  const modelName = String(data.model_name || "").trim();
  if (modelName && !AI_BATCH_CONFIG.MODEL_NAME_PATTERN.test(modelName)) {
    return jsonResponse({
      success: false,
      error_code: "INVALID_MODEL_NAME",
      message: "model_name has an invalid format"
    });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(AI_BATCH_CONFIG.LOCK_TIMEOUT_MS);
    const jobsSheet = getOrCreateAiBatchJobsSheet_();
    const lastJobRow = jobsSheet.getLastRow();

    // 冪等性チェック: 同一 request_id の既存バッチを返却
    if (lastJobRow > 1) {
      const reuseJobIdx = getAiBatchJobHeaderIndex_(jobsSheet);
      const jobRows = jobsSheet.getRange(2, 1, lastJobRow - 1, jobsSheet.getLastColumn()).getValues();
      for (let i = 0; i < jobRows.length; i++) {
        if (String(jobRows[i][1] || "").trim() === requestId) {
          const reuseBatchCostInfo = extractBatchProductCosts_(data, productIds);
          let savedCosts = null;
          if (reuseJobIdx.product_costs_json !== undefined) {
            const rawSavedJson = String(jobRows[i][reuseJobIdx.product_costs_json] || "").trim();
            if (rawSavedJson) {
              try {
                savedCosts = JSON.parse(rawSavedJson);
              } catch (_) {}
            }
          }
          return jsonResponse({
            success: true,
            batch_id: String(jobRows[i][0] || "").trim(),
            request_id: requestId,
            status: String(jobRows[i][2] || "").trim(),
            total_count: Number(jobRows[i][3] || 0),
            is_reused: true,
            created_at: String(jobRows[i][7] || "").trim(),
            pricing_rule: "gross_margin_floor",
            min_cost_markup_rate: reuseBatchCostInfo.minCostMarkupRate,
            min_gross_margin_rate: reuseBatchCostInfo.minCostMarkupRate,
            gross_margin_divisor: reuseBatchCostInfo.grossMarginDivisor,
            product_costs_by_product: reuseBatchCostInfo.costSummaryByProduct,
            saved_product_costs_by_product: savedCosts
          });
        }
      }
    }

    // 商品ごとの解析対象画像選択 (selected_image_ids) の検証と引き継ぎ
    // 1) リクエストで明示指定された場合: 構文・上限3枚・重複なし・対象商品のDrive画像所有を検証し保存
    // 2) リクエストで未指定の場合: 商品ごとに保存済みの選択 (product_ai_image_selections) を引き継ぐ
    // 3) いずれもない場合: 空配列 [] (ワーカー実行時に先頭最大3枚を使用)
    const explicitInfo = extractBatchExplicitSelectedImages_(data);
    const savedSelectionsMap = getProductAiSelectedImagesMap_();
    const resolvedSelectedByProduct = {};
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const mainSheet = ss ? ss.getSheets()[0] : null;

    // productIds に含まれない商品IDへの不正な明示指定も検証
    const explicitPids = Object.keys(explicitInfo.hasExplicitMap);
    for (let k = 0; k < explicitPids.length; k++) {
      const exPid = explicitPids[k];
      if (!seenIds.has(exPid)) {
        const rawEx = explicitInfo.explicitIdsMap[exPid];
        validateSelectedImageIdsSyntax_(rawEx === null ? [] : rawEx, exPid);
      }
    }

    for (let i = 0; i < productIds.length; i++) {
      const pid = productIds[i];
      if (explicitInfo.hasExplicitMap[pid]) {
        const rawSel = explicitInfo.explicitIdsMap[pid];
        const effectiveSel = rawSel === null ? [] : rawSel;
        const normalizedSel = validateSelectedImageIdsSyntax_(effectiveSel, pid);
        if (normalizedSel.length > 0) {
          if (!mainSheet) {
            const sheetErr = new Error("Product master sheet not available for validating selected_image_ids of " + pid);
            sheetErr.error_code = "PRODUCT_SHEET_NOT_FOUND";
            throw sheetErr;
          }
          let pRow = -1;
          try {
            pRow = findProductRow(mainSheet, pid);
          } catch (_) {
            const nfErr = new Error("Product not found: " + pid);
            nfErr.error_code = "PRODUCT_NOT_FOUND";
            nfErr.preserve_message = true;
            throw nfErr;
          }
          const driveFolderUrl = String(mainSheet.getRange(pRow, 30).getValue() || "").trim();
          getValidatedProductDriveImages_(pid, driveFolderUrl, normalizedSel, {
            metadata_only: true
          });
        }
        if (mainSheet) {
          try {
            saveProductAiSelectedImageIds_(mainSheet, pid, normalizedSel, { skipDriveValidation: true });
          } catch (_) {}
        }
        resolvedSelectedByProduct[pid] = normalizedSel;
      } else {
        const inherited = savedSelectionsMap[pid] || [];
        if (inherited.length > 0) {
          resolvedSelectedByProduct[pid] = validateSelectedImageIdsSyntax_(inherited, pid);
        } else {
          resolvedSelectedByProduct[pid] = [];
        }
      }
    }

    const batchCostInfo = extractBatchProductCosts_(data, productIds);

    const nowIso = new Date().toISOString();
    const batchId = "BAT_" + Utilities.formatDate(new Date(), "GMT+9", "yyyyMMdd_HHmmss") + "_" + Math.random().toString(36).substring(2, 7);

    // ai_batch_jobs に新規ジョブ行追加 (既存12列 + ヘッダー名で特定した追加列)
    const jobRow = [
      batchId,
      requestId,
      "queued",
      productIds.length,
      0, // completed_count
      0, // failed_count
      0, // processing_count
      nowIso,
      nowIso,
      "", // completed_at
      "", // worker_execution_id
      ""  // lease_expires_at
    ];
    const jobIdx = getAiBatchJobHeaderIndex_(jobsSheet);
    const setJobField = (name, val) => {
      const idx = jobIdx[name];
      if (idx === undefined) return;
      while (jobRow.length <= idx) jobRow.push("");
      jobRow[idx] = val;
    };
    setJobField("force_regenerate", forceRegenerate);
    setJobField("model_name", modelName);
    setJobField("retry_requests", "");
    setJobField("min_cost_markup_rate", batchCostInfo.minCostMarkupRate);
    setJobField("product_costs_json", batchCostInfo.hasCostInput ? JSON.stringify(batchCostInfo.costSummaryByProduct) : "");
    jobsSheet.appendRow(jobRow);

    // ai_batch_items に各商品行を追加 (16列目 selected_image_ids に商品ごとの選択IDを記録)
    const itemsSheet = getOrCreateAiBatchItemsSheet_();
    const itemIdxMap = getAiBatchItemHeaderIndex_(itemsSheet);
    const selectedColIdx = itemIdxMap.selected_image_ids !== undefined ? itemIdxMap.selected_image_ids : 15;
    const newItems = [];
    for (let i = 0; i < productIds.length; i++) {
      const pid = productIds[i];
      const selIds = resolvedSelectedByProduct[pid] || [];
      const itemRow = [
        batchId,
        pid,
        i + 1,
        "pending",
        "", // draft_id
        "", // draft_version
        "", // model_name
        "", // error_code
        "", // error_message
        0,  // retry_count
        "", // next_retry_at
        "", // worker_execution_id
        "", // lease_expires_at
        nowIso,
        nowIso
      ];
      while (itemRow.length <= selectedColIdx) itemRow.push("");
      itemRow[selectedColIdx] = selIds.join(",");
      newItems.push(itemRow);
    }
    itemsSheet.getRange(itemsSheet.getLastRow() + 1, 1, newItems.length, newItems[0].length).setValues(newItems);

    ensureAiBatchTrigger();

    return jsonResponse({
      success: true,
      batch_id: batchId,
      request_id: requestId,
      status: "queued",
      total_count: productIds.length,
      is_reused: false,
      created_at: nowIso,
      selected_image_ids_by_product: resolvedSelectedByProduct,
      pricing_rule: "gross_margin_floor",
      min_cost_markup_rate: batchCostInfo.minCostMarkupRate,
      min_gross_margin_rate: batchCostInfo.minCostMarkupRate,
      gross_margin_divisor: batchCostInfo.grossMarginDivisor,
      product_costs_by_product: batchCostInfo.costSummaryByProduct
    });

  } catch (err) {
    console.error("[AI Batch] Failed to create batch:", err.message);
    return jsonResponse({
      success: false,
      error_code: err.error_code || "BATCH_CREATION_FAILED",
      message: err.message
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

/**
 * 一括ドラフト生成ジョブの進捗取得 (get_ai_product_draft_batch)
 * @param {Object} data リクエストデータまたはGETパラメータ
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetAiProductDraftBatch(data) {
  let batchId = String(data.batch_id || "").trim();
  if (!batchId) {
    return jsonResponse({
      success: false,
      error_code: "BATCH_ID_REQUIRED",
      message: "batch_id is required"
    });
  }

  const jobsSheet = getOrCreateAiBatchJobsSheet_();
  const lastJobRow = jobsSheet.getLastRow();
  const itemsSheet = getOrCreateAiBatchItemsSheet_();
  const lastItemRow = itemsSheet.getLastRow();

  // batch_id が "latest" の場合、最新バッチを再利用 (確認用バッチの不要な重複作成を防止)
  if (batchId === "latest" && lastJobRow > 1) {
    const lastRowValues = jobsSheet.getRange(lastJobRow, 1, 1, jobsSheet.getLastColumn()).getValues()[0];
    batchId = String(lastRowValues[0] || "").trim();
  } else if (batchId.indexOf("by_product:") === 0 && lastItemRow > 1) {
    const targetPid = batchId.substring("by_product:".length).trim();
    if (targetPid) {
      const allItems = itemsSheet.getRange(2, 1, lastItemRow - 1, 2).getValues();
      for (let k = allItems.length - 1; k >= 0; k--) {
        if (String(allItems[k][1] || "").trim() === targetPid) {
          batchId = String(allItems[k][0] || "").trim();
          break;
        }
      }
    }
  }

  if (lastJobRow <= 1) {
    return jsonResponse({
      success: false,
      error_code: "BATCH_NOT_FOUND",
      message: "Batch not found: " + batchId
    });
  }

  const jobIdx = getAiBatchJobHeaderIndex_(jobsSheet);
  const jobRows = jobsSheet.getRange(2, 1, lastJobRow - 1, jobsSheet.getLastColumn()).getValues();
  let targetJob = null;
  for (let i = 0; i < jobRows.length; i++) {
    if (String(jobRows[i][0] || "").trim() === batchId) {
      let savedMinMarkup = AI_DRAFT_CONFIG.DEFAULT_MIN_COST_MARKUP_RATE;
      const rawMarkupIdx = jobIdx.min_cost_markup_rate !== undefined
        ? jobIdx.min_cost_markup_rate
        : jobIdx.min_gross_margin_rate;
      if (rawMarkupIdx !== undefined) {
        const parsedRate = Number(jobRows[i][rawMarkupIdx]);
        if (Number.isFinite(parsedRate) && parsedRate > 0 && parsedRate < 1) {
          savedMinMarkup = Math.round(parsedRate * 10000) / 10000;
        }
      }
      let savedProductCosts = null;
      if (jobIdx.product_costs_json !== undefined) {
        const rawJson = String(jobRows[i][jobIdx.product_costs_json] || "").trim();
        if (rawJson) {
          try {
            savedProductCosts = JSON.parse(rawJson);
          } catch (_) {}
        }
      }
      targetJob = {
        batch_id: String(jobRows[i][0] || "").trim(),
        request_id: String(jobRows[i][1] || "").trim(),
        status: String(jobRows[i][2] || "").trim(),
        total_count: Number(jobRows[i][3] || 0),
        completed_count: Number(jobRows[i][4] || 0),
        failed_count: Number(jobRows[i][5] || 0),
        processing_count: Number(jobRows[i][6] || 0),
        created_at: String(jobRows[i][7] || "").trim(),
        updated_at: String(jobRows[i][8] || "").trim(),
        completed_at: String(jobRows[i][9] || "").trim() || null,
        pricing_rule: "gross_margin_floor",
        min_cost_markup_rate: savedMinMarkup,
        min_gross_margin_rate: savedMinMarkup,
        gross_margin_divisor: Math.round((1 - savedMinMarkup) * 1000000) / 1000000,
        product_costs_by_product: savedProductCosts
      };
      break;
    }
  }

  if (!targetJob) {
    return jsonResponse({
      success: false,
      error_code: "BATCH_NOT_FOUND",
      message: "Batch not found: " + batchId
    });
  }

  const items = [];

  if (lastItemRow > 1) {
    const itemIdxMap = getAiBatchItemHeaderIndex_(itemsSheet);
    const selectedColIdx = itemIdxMap.selected_image_ids !== undefined ? itemIdxMap.selected_image_ids : 15;
    const itemRows = itemsSheet.getRange(2, 1, lastItemRow - 1, itemsSheet.getLastColumn()).getValues();
    for (let i = 0; i < itemRows.length; i++) {
      if (String(itemRows[i][0] || "").trim() === batchId) {
        const rawDraftVer = itemRows[i][5];
        const draftVerNum = (rawDraftVer !== "" && rawDraftVer !== null && rawDraftVer !== undefined) ? Number(rawDraftVer) : null;
        const selectedIds = parseStoredSelectedImageIds_(itemRows[i][selectedColIdx]);
        items.push({
          product_id: String(itemRows[i][1] || "").trim(),
          status: String(itemRows[i][3] || "").trim(),
          draft_id: String(itemRows[i][4] || "").trim() || null,
          draft_version: draftVerNum,
          model_name: String(itemRows[i][6] || "").trim() || null,
          error_code: String(itemRows[i][7] || "").trim() || null,
          error_message: String(itemRows[i][8] || "").trim() || null,
          retry_count: Number(itemRows[i][9] || 0),
          selected_image_ids: selectedIds
        });
      }
    }
  }

  return jsonResponse({
    success: true,
    batch_id: targetJob.batch_id,
    request_id: targetJob.request_id,
    status: targetJob.status,
    total_count: targetJob.total_count,
    completed_count: targetJob.completed_count,
    failed_count: targetJob.failed_count,
    processing_count: targetJob.processing_count,
    created_at: targetJob.created_at,
    updated_at: targetJob.updated_at,
    completed_at: targetJob.completed_at,
    pricing_rule: targetJob.pricing_rule,
    min_cost_markup_rate: targetJob.min_cost_markup_rate,
    min_gross_margin_rate: targetJob.min_gross_margin_rate,
    gross_margin_divisor: targetJob.gross_margin_divisor,
    product_costs_by_product: targetJob.product_costs_by_product,
    items: items
  });
}

/**
 * 失敗商品のみ再試行 (retry_ai_product_draft_batch)
 * @param {Object} data リクエストデータ
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRetryAiProductDraftBatch(data) {
  const batchId = String(data.batch_id || "").trim();
  if (!batchId) {
    return jsonResponse({
      success: false,
      error_code: "BATCH_ID_REQUIRED",
      message: "batch_id is required"
    });
  }

  const retryRequestId = String(data.request_id || "").trim();
  if (!retryRequestId) {
    return jsonResponse({
      success: false,
      error_code: "REQUEST_ID_REQUIRED",
      message: "request_id is required for batch retry"
    });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(AI_BATCH_CONFIG.LOCK_TIMEOUT_MS);
    const jobsSheet = getOrCreateAiBatchJobsSheet_();
    const lastJobRow = jobsSheet.getLastRow();
    if (lastJobRow <= 1) {
      return jsonResponse({
        success: false,
        error_code: "BATCH_NOT_FOUND",
        message: "Batch not found: " + batchId
      });
    }

    const jobIdx = getAiBatchJobHeaderIndex_(jobsSheet);
    const jobRows = jobsSheet.getRange(2, 1, lastJobRow - 1, jobsSheet.getLastColumn()).getValues();
    let jobRowIndex = -1;
    let targetJob = null;
    let retryRequests = {};
    for (let i = 0; i < jobRows.length; i++) {
      if (String(jobRows[i][0] || "").trim() === batchId) {
        jobRowIndex = i + 2;
        targetJob = {
          batch_id: String(jobRows[i][0]),
          status: String(jobRows[i][2]),
          total_count: Number(jobRows[i][3] || 0),
          completed_count: Number(jobRows[i][4] || 0),
          failed_count: Number(jobRows[i][5] || 0)
        };
        if (jobIdx.retry_requests !== undefined) {
          const raw = String(jobRows[i][jobIdx.retry_requests] || "").trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) retryRequests = parsed;
            } catch (_) {
              retryRequests = {};
            }
          }
        }
        break;
      }
    }

    if (!targetJob) {
      return jsonResponse({
        success: false,
        error_code: "BATCH_NOT_FOUND",
        message: "Batch not found: " + batchId
      });
    }

    // 冪等性: 同一 retry request_id の再送は再試行を重複登録せず、初回応答を返却
    if (Object.prototype.hasOwnProperty.call(retryRequests, retryRequestId)) {
      const prev = retryRequests[retryRequestId] || {};
      const reused = Object.assign({}, prev.response || {}, {
        batch_id: batchId,
        request_id: retryRequestId,
        is_reused: true
      });
      return jsonResponse(reused);
    }

    const itemsSheet = getOrCreateAiBatchItemsSheet_();
    const lastItemRow = itemsSheet.getLastRow();
    let retriedCount = 0;
    const nowIso = new Date().toISOString();

    if (lastItemRow > 1) {
      const itemRows = itemsSheet.getRange(2, 1, lastItemRow - 1, itemsSheet.getLastColumn()).getValues();
      for (let i = 0; i < itemRows.length; i++) {
        if (String(itemRows[i][0] || "").trim() === batchId) {
          const itemStatus = String(itemRows[i][3] || "").trim();
          if (itemStatus === "failed") {
            const rIdx = i + 2;
            const itemErrorCode = String(itemRows[i][7] || "").trim();
            // 検索未実行・未達成 (SEARCH_GROUNDING_NOT_EXECUTED 等) で失敗したアイテムのみ、
            // 過去の未検索候補の回収を避け、新しい推論 (Gemini呼出し) を実行させるため
            // draft_id / draft_version / model_name をクリアして pending に戻す。
            // ※その他の失敗（保存後通信断や反映例外等）は従来どおり紐付けを保持し、
            // 次回ワーカー実行時の中断回収で既存候補を照合・回収できるようにする。
            itemsSheet.getRange(rIdx, 4).setValue("pending");
            const isSearchOrImageSelectionFailure = itemErrorCode === "SEARCH_GROUNDING_NOT_EXECUTED" ||
              itemErrorCode === "SEARCH_GROUNDING_NO_SOURCES" ||
              itemErrorCode === "STAGE_A_MAX_TOKENS" ||
              itemErrorCode === "STAGE_A_EMPTY_RESPONSE" ||
              itemErrorCode === "SELECTED_IMAGE_DELETED" ||
              itemErrorCode === "INVALID_IMAGE_SELECTION" ||
              itemErrorCode === "DUPLICATE_SELECTED_IMAGE_ID" ||
              itemErrorCode === "IMAGE_COUNT_EXCEEDED" ||
              itemErrorCode.startsWith("SEARCH_") ||
              itemErrorCode.startsWith("STAGE_A_");
            if (isSearchOrImageSelectionFailure) {
              itemsSheet.getRange(rIdx, 5).setValue(""); // draft_id クリア
              itemsSheet.getRange(rIdx, 6).setValue(""); // draft_version クリア
              itemsSheet.getRange(rIdx, 7).setValue(""); // model_name クリア
            }
            itemsSheet.getRange(rIdx, 8).setValue(""); // error_code
            itemsSheet.getRange(rIdx, 9).setValue(""); // error_message
            itemsSheet.getRange(rIdx, 10).setValue(0); // retry_count
            itemsSheet.getRange(rIdx, 11).setValue(""); // next_retry_at
            itemsSheet.getRange(rIdx, 12).setValue(""); // worker_execution_id
            itemsSheet.getRange(rIdx, 13).setValue(""); // lease_expires_at
            itemsSheet.getRange(rIdx, 15).setValue(nowIso);
            retriedCount++;
          }
        }
      }
    }

    let response;
    if (retriedCount > 0) {
      jobsSheet.getRange(jobRowIndex, 3).setValue("queued");
      jobsSheet.getRange(jobRowIndex, 6).setValue(0); // failed_count reset
      jobsSheet.getRange(jobRowIndex, 9).setValue(nowIso);
      jobsSheet.getRange(jobRowIndex, 10).setValue(""); // completed_at reset
      response = {
        success: true,
        batch_id: batchId,
        request_id: retryRequestId,
        status: "queued",
        total_count: targetJob.total_count,
        retried_count: retriedCount,
        completed_count: targetJob.completed_count,
        failed_count: 0,
        is_reused: false,
        updated_at: nowIso
      };
    } else {
      // 契約: 失敗商品がない場合は NO_FAILED_ITEMS (バッチステータスは変更しない)
      response = {
        success: false,
        error_code: "NO_FAILED_ITEMS",
        message: "No failed items to retry in batch: " + batchId,
        batch_id: batchId,
        request_id: retryRequestId,
        status: targetJob.status,
        total_count: targetJob.total_count,
        retried_count: 0,
        completed_count: targetJob.completed_count,
        failed_count: targetJob.failed_count,
        is_reused: false,
        updated_at: nowIso
      };
    }

    // 処理済み retry request_id と応答を記録 (古いものから上限件数で切り詰め)
    if (jobIdx.retry_requests !== undefined) {
      retryRequests[retryRequestId] = { processed_at: nowIso, response: response };
      const keys = Object.keys(retryRequests).sort((a, b) =>
        String((retryRequests[a] || {}).processed_at || "").localeCompare(String((retryRequests[b] || {}).processed_at || ""))
      );
      while (keys.length > AI_BATCH_CONFIG.MAX_STORED_RETRY_REQUESTS) {
        delete retryRequests[keys.shift()];
      }
      jobsSheet.getRange(jobRowIndex, jobIdx.retry_requests + 1).setValue(JSON.stringify(retryRequests));
    }

    if (retriedCount > 0) {
      ensureAiBatchTrigger();
    }

    return jsonResponse(response);

  } catch (err) {
    console.error("[AI Batch] Failed to retry batch:", err.message);
    return jsonResponse({
      success: false,
      error_code: "BATCH_RETRY_FAILED",
      message: err.message
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

/**
 * 一時的通信障害 (429, 5xx, 通信例外) を構造化エラーコードのみで判定
 * - callGeminiMultimodalAiDraft_ が実際に返すコード (LLM_HTTP_ERROR_<status>, LLM_COMMUNICATION_FAILED) を対象とする
 * - message は安全な固定文言 (SAFE_LLM_ERROR_MESSAGE) に置換されるため判定に使用しない
 * @param {Error|Object} err
 * @return {boolean}
 */
function isTransientLlmError_(err) {
  if (!err) return false;
  const code = String(err.error_code || err.errorCode || "").trim();
  if (!code) return false;
  return AI_BATCH_CONFIG.TRANSIENT_ERROR_CODES.indexOf(code) !== -1;
}

/**
 * 親バッチのステータスを更新 (排他ロック内で実行)
 * @param {string} batchId
 * @param {string} newStatus
 */
function updateBatchJobStatus_(batchId, newStatus) {
  const jobsSheet = getOrCreateAiBatchJobsSheet_();
  const lastRow = jobsSheet.getLastRow();
  if (lastRow <= 1) return;
  const rows = jobsSheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === batchId) {
      const curStatus = String(rows[i][2] || "").trim();
      if (curStatus !== newStatus && curStatus !== "completed" && curStatus !== "failed") {
        jobsSheet.getRange(i + 2, 3).setValue(newStatus);
        jobsSheet.getRange(i + 2, 9).setValue(new Date().toISOString());
      }
      break;
    }
  }
}

/**
 * 親バッチの集計値および最終ステータスを再計算 (排他ロック内で実行)
 * @param {string} batchId
 */
function recomputeBatchJobSummary_(batchId) {
  const itemsSheet = getOrCreateAiBatchItemsSheet_();
  const lastItemRow = itemsSheet.getLastRow();
  if (lastItemRow <= 1) return;

  const itemRows = itemsSheet.getRange(2, 1, lastItemRow - 1, itemsSheet.getLastColumn()).getValues();
  let total = 0;
  let completed = 0;
  let failed = 0;
  let processing = 0;
  let pending = 0;

  for (let i = 0; i < itemRows.length; i++) {
    if (String(itemRows[i][0] || "").trim() === batchId) {
      total++;
      const st = String(itemRows[i][3] || "").trim();
      if (st === "completed") completed++;
      else if (st === "failed") failed++;
      else if (st === "processing") processing++;
      else pending++;
    }
  }

  const jobsSheet = getOrCreateAiBatchJobsSheet_();
  const lastJobRow = jobsSheet.getLastRow();
  if (lastJobRow <= 1) return;

  const jobRows = jobsSheet.getRange(2, 1, lastJobRow - 1, jobsSheet.getLastColumn()).getValues();
  for (let j = 0; j < jobRows.length; j++) {
    if (String(jobRows[j][0] || "").trim() === batchId) {
      const rowIndex = j + 2;
      const nowIso = new Date().toISOString();
      let newBatchStatus = "processing";
      let completedAt = "";

      if (pending === 0 && processing === 0) {
        completedAt = nowIso;
        if (failed === 0) {
          newBatchStatus = "completed";
        } else if (completed === 0) {
          newBatchStatus = "failed";
        } else {
          newBatchStatus = "partially_failed";
        }
      } else if (completed === 0 && failed === 0 && processing === 0) {
        newBatchStatus = "queued";
      }

      jobsSheet.getRange(rowIndex, 3).setValue(newBatchStatus);
      jobsSheet.getRange(rowIndex, 4).setValue(total);
      jobsSheet.getRange(rowIndex, 5).setValue(completed);
      jobsSheet.getRange(rowIndex, 6).setValue(failed);
      jobsSheet.getRange(rowIndex, 7).setValue(processing);
      jobsSheet.getRange(rowIndex, 9).setValue(nowIso);
      if (completedAt) {
        jobsSheet.getRange(rowIndex, 10).setValue(completedAt);
      }
      break;
    }
  }
}

/**
 * 共有の時間主導型トリガーを1つだけ設置 (重複作成防止・重複削除)
 * @return {GoogleAppsScript.Script.Trigger|null}
 */
function ensureAiBatchTrigger() {
  const handler = "processAiBatchQueue";
  if (typeof ScriptApp === "undefined") {
    return null;
  }
  try {
    const triggers = ScriptApp.getProjectTriggers();
    let existingTrigger = null;
    let duplicateCount = 0;
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === handler) {
        if (!existingTrigger) {
          existingTrigger = triggers[i];
        } else {
          try {
            ScriptApp.deleteTrigger(triggers[i]);
            duplicateCount++;
          } catch (_) {}
        }
      }
    }
    if (duplicateCount > 0) {
      console.log(`[AI Batch] Removed ${duplicateCount} duplicate trigger(s) for ${handler}`);
    }
    if (existingTrigger) {
      return existingTrigger;
    }
    return ScriptApp.newTrigger(handler)
      .timeBased()
      .everyMinutes(1)
      .create();
  } catch (err) {
    console.warn("[AI Batch] ensureAiBatchTrigger warning:", err.message);
    return null;
  }
}

/**
 * AI一括生成キュー処理ワーカー (時間主導トリガーおよび手動実行から呼び出し)
 * 最大3件、約4分を目安に処理を行い、次件の通信時間余裕がなければ次回へ回す。
 * 
 * @return {{ processed_count: number }}
 */
function processAiBatchQueue() {
  const startTime = Date.now();
  let processedCount = 0;
  const lock = LockService.getScriptLock();
  let circuitBreakerTripped = false;

  while (processedCount < AI_BATCH_CONFIG.MAX_ITEMS_PER_RUN) {
    // 処理時間目安の確認: 次のアイテム通信余裕 (推定60秒) がなければ終了
    const elapsed = Date.now() - startTime;
    if (elapsed + AI_BATCH_CONFIG.ESTIMATED_ITEM_TIME_MS > AI_BATCH_CONFIG.MAX_EXECUTION_TIME_MS) {
      console.log(`[AI Batch Worker] Reached time guideline (elapsed: ${elapsed}ms). Yielding remaining items to next trigger.`);
      break;
    }

    let claimedItem = null;

    // 1. キューから対象アイテムを短時間排他ロックで確保 (Claim)
    try {
      lock.waitLock(AI_BATCH_CONFIG.LOCK_TIMEOUT_MS);
      const itemsSheet = getOrCreateAiBatchItemsSheet_();
      const lastRow = itemsSheet.getLastRow();
      if (lastRow <= 1) {
        break; // アイテムなし
      }

      const itemIdxMap = getAiBatchItemHeaderIndex_(itemsSheet);
      const selectedColIdx = itemIdxMap.selected_image_ids !== undefined ? itemIdxMap.selected_image_ids : 15;
      const itemRows = itemsSheet.getRange(2, 1, lastRow - 1, itemsSheet.getLastColumn()).getValues();
      const now = new Date();

      for (let i = 0; i < itemRows.length; i++) {
        const row = itemRows[i];
        const status = String(row[3] || "").trim();
        const nextRetryAtStr = String(row[10] || "").trim();
        const leaseExpiresAtStr = String(row[12] || "").trim();

        let isReady = false;
        if (status === "pending") {
          if (!nextRetryAtStr || new Date(nextRetryAtStr) <= now) {
            isReady = true;
          }
        } else if (status === "processing") {
          // 期限切れリース回収 (Stalled execution recovery)
          if (leaseExpiresAtStr && new Date(leaseExpiresAtStr) < now) {
            console.warn(`[AI Batch Worker] Reclaiming stalled item row ${i + 2} (${row[1]}) with expired lease ${leaseExpiresAtStr}`);
            isReady = true;
          }
        }

        if (isReady) {
          const rowIndex = i + 2;
          const workerExecutionId = "WRK_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
          const leaseExpiresAt = new Date(Date.now() + AI_BATCH_CONFIG.LEASE_TTL_MS).toISOString();
          const nowIso = now.toISOString();

          // アイテム行を processing に更新
          itemsSheet.getRange(rowIndex, 4).setValue("processing");
          itemsSheet.getRange(rowIndex, 12).setValue(workerExecutionId);
          itemsSheet.getRange(rowIndex, 13).setValue(leaseExpiresAt);
          itemsSheet.getRange(rowIndex, 15).setValue(nowIso);

          // 親バッチのステータス更新 (queued -> processing)
          updateBatchJobStatus_(String(row[0] || "").trim(), "processing");

          claimedItem = {
            rowIndex: rowIndex,
            batchId: String(row[0] || "").trim(),
            productId: String(row[1] || "").trim(),
            itemIndex: Number(row[2] || 0),
            linkedDraftId: String(row[4] || "").trim(),
            currentRetryCount: Number(row[9] || 0),
            createdAt: String(row[13] || ""),
            workerExecutionId: workerExecutionId,
            selectedImageIds: parseStoredSelectedImageIds_(row[selectedColIdx]),
            jobOptions: getAiBatchJobOptions_(String(row[0] || "").trim())
          };
          break;
        }
      }
    } catch (lockErr) {
      console.error("[AI Batch Worker] Failed to acquire lock for claiming item:", lockErr.message);
      break;
    } finally {
      try {
        lock.releaseLock();
      } catch (_) {}
    }

    if (!claimedItem) {
      // 処理対象アイテムなし
      break;
    }

    // 2. 外部通信 (Drive画像取得・LLM呼び出し) はロックフリーで実行
    console.log(`[AI Batch Worker] Processing item ${claimedItem.productId} (batch: ${claimedItem.batchId}, exec: ${claimedItem.workerExecutionId})`);
    let itemResult = null;

    // 候補・本票・関連データへの保存直前 (ScriptLock 保持中) に呼ばれる所有権検証
    // commit 時はアイテムへ draft_id を予約し、中断後の回収対象をこのアイテムの候補に限定する
    const ownershipCheck = (info) => {
      assertBatchItemOwnership_(claimedItem);
      if (info && info.phase === "commit" && info.draft_id) {
        reserveBatchItemDraft_(claimedItem, info);
      }
    };

    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const mainSheet = ss.getSheets()[0];
      const pRow = findProductRow(mainSheet, claimedItem.productId);

      if (pRow <= 0) {
        const pNotFoundErr = new Error(`Product not found in main sheet: ${claimedItem.productId}`);
        pNotFoundErr.error_code = "PRODUCT_NOT_FOUND";
        throw pNotFoundErr;
      }

      // 2.1 このアイテムが予約・保存した候補の回収 (Interruption Recovery)
      //     「最新ドラフトが存在する」だけでは流用せず、アイテムの draft_id と一致する候補のみを対象とする
      let recoveredDraft = null;
      let shouldGenerate = true;

      if (claimedItem.linkedDraftId) {
        const latestDraft = getLatestProductAiDraft_(claimedItem.productId);
        if (latestDraft && latestDraft.draft_id === claimedItem.linkedDraftId) {
          shouldGenerate = false;

          // 未検索ドラフトの保護: 検索グラウンディング有効かつ実検索未実行 (search_executed: false) の場合、
          // 再生成を行わずに候補を pending_review で安全に保持しつつ、
          // 本票未反映のまま completed となるのを防ぐため SEARCH_GROUNDING_NOT_EXECUTED で failed とする
          const isSearchGroundingUnsearched = Boolean(
            latestDraft.search_grounding_enabled && !latestDraft.search_executed
          );

          if (isSearchGroundingUnsearched) {
            console.log(`[AI Batch Worker] Interruption recovery: ${claimedItem.productId} draft ${latestDraft.draft_id} is unsearched (search_executed: false). Marking batch item as failed with SEARCH_GROUNDING_NOT_EXECUTED, keeping draft in pending_review.`);
            const unsearchedErr = new Error(`Search grounding was enabled but search was not executed for ${claimedItem.productId}.`);
            unsearchedErr.error_code = "SEARCH_GROUNDING_NOT_EXECUTED";
            unsearchedErr.draft_id = latestDraft.draft_id;
            unsearchedErr.draft_version = latestDraft.draft_version;
            unsearchedErr.model_name = latestDraft.model_name;
            throw unsearchedErr;
          } else {
            let isAlreadyCompleted = false;
            try {
              verifyProductDraftReflectionCompleted_(mainSheet, pRow, claimedItem.productId, latestDraft);
              isAlreadyCompleted = true;
              recoveredDraft = latestDraft;
              console.log(`[AI Batch Worker] Interruption recovery: ${claimedItem.productId} draft ${latestDraft.draft_id} is already fully reflected.`);
            } catch (_) {
              isAlreadyCompleted = false;
            }

            if (!isAlreadyCompleted) {
              console.log(`[AI Batch Worker] Interruption recovery: applying item draft ${latestDraft.draft_id} for ${claimedItem.productId}...`);
              const applyRes = applyExistingAiDraftToProductRecord_(mainSheet, claimedItem.productId, latestDraft, {
                ownership_check: ownershipCheck
              });
              if (applyRes && applyRes.success) {
                const afterApply = getLatestProductAiDraft_(claimedItem.productId);
                if (!afterApply || afterApply.draft_id !== claimedItem.linkedDraftId) {
                  const supErr = new Error(`AI draft for ${claimedItem.productId} was superseded after recovery apply.`);
                  supErr.error_code = "AI_DRAFT_SUPERSEDED";
                  throw supErr;
                }
                // 反映直後の完全性を再検証 (Fail-Closed)
                verifyProductDraftReflectionCompleted_(mainSheet, pRow, claimedItem.productId, afterApply);
                recoveredDraft = afterApply;
              }
            }
          }
        } else if (productAiDraftExists_(claimedItem.productId, claimedItem.linkedDraftId)) {
          // このアイテムの候補より新しい候補が存在する: 古い候補で上書きも、再生成による上書きもしない
          const supErr = new Error(`AI draft ${claimedItem.linkedDraftId} for ${claimedItem.productId} was superseded by a newer draft.`);
          supErr.error_code = "AI_DRAFT_SUPERSEDED";
          throw supErr;
        }
        // 予約済み draft_id の候補が未保存 (保存前に中断) の場合は通常生成へ進む
      }

      if (recoveredDraft) {
        itemResult = {
          success: true,
          draft_id: recoveredDraft.draft_id,
          draft_version: recoveredDraft.draft_version,
          model_name: recoveredDraft.model_name,
          auto_applied: (recoveredDraft.review_status || recoveredDraft.status) === "confirmed"
        };
      } else if (shouldGenerate) {
        const jobOptions = claimedItem.jobOptions || {};
        const itemSelectedIds = Array.isArray(claimedItem.selectedImageIds) && claimedItem.selectedImageIds.length > 0
          ? claimedItem.selectedImageIds
          : undefined;
        const itemCostSummary = (jobOptions.product_costs && typeof jobOptions.product_costs === "object")
          ? jobOptions.product_costs[claimedItem.productId]
          : undefined;
        const draftRes = executeSingleAiProductDraftCore_(mainSheet, claimedItem.productId, {
          force_regenerate: Boolean(jobOptions.force_regenerate),
          model_name: jobOptions.model_name || "",
          selected_image_ids: itemSelectedIds,
          selection_was_prevalidated: Boolean(itemSelectedIds),
          product_cost: itemCostSummary,
          min_cost_markup_rate: jobOptions.min_cost_markup_rate,
          apply_cost_floor: true,
          auto_apply: true,
          confirmed_by: "ai_batch_worker",
          ownership_check: ownershipCheck
        });
        // 通常生成後の完全性検証 (Fail-Closed): 生成した draft_id と一致する候補で検証
        const newlyCreatedDraft = getLatestProductAiDraft_(claimedItem.productId);
        if (!newlyCreatedDraft || newlyCreatedDraft.draft_id !== draftRes.draft_id) {
          const nfErr = new Error(`Generated AI draft ${draftRes.draft_id} for ${claimedItem.productId} is not the latest draft.`);
          nfErr.error_code = newlyCreatedDraft ? "AI_DRAFT_SUPERSEDED" : "AI_DRAFT_NOT_FOUND";
          throw nfErr;
        }

        const isUnsearchedDraft = Boolean(
          newlyCreatedDraft.search_grounding_enabled && !newlyCreatedDraft.search_executed
        );

        if (isUnsearchedDraft) {
          console.log(`[AI Batch Worker] Product ${claimedItem.productId} draft ${draftRes.draft_id} generated without search execution (search_executed: false). Marking batch item as failed with SEARCH_GROUNDING_NOT_EXECUTED, keeping draft in pending_review.`);
          const unsearchedErr = new Error(`Search grounding was enabled but search was not executed for ${claimedItem.productId}.`);
          unsearchedErr.error_code = "SEARCH_GROUNDING_NOT_EXECUTED";
          unsearchedErr.draft_id = draftRes.draft_id;
          unsearchedErr.draft_version = draftRes.draft_version;
          unsearchedErr.model_name = draftRes.model_name;
          throw unsearchedErr;
        } else {
          // 通常生成の完全性検証 (Fail-Closed): 本票反映・確定が未完了なら例外スロー
          verifyProductDraftReflectionCompleted_(mainSheet, pRow, claimedItem.productId, newlyCreatedDraft);
        }

        itemResult = {
          success: true,
          draft_id: draftRes.draft_id,
          draft_version: draftRes.draft_version,
          model_name: draftRes.model_name,
          auto_applied: true
        };
      } else {
        const recErr = new Error(`Recovery of AI draft ${claimedItem.linkedDraftId} for ${claimedItem.productId} did not complete.`);
        recErr.error_code = "AI_DRAFT_RECOVERY_FAILED";
        throw recErr;
      }
    } catch (procErr) {
      console.error(`[AI Batch Worker] Processing error for ${claimedItem.productId}:`, procErr.error_code || "", procErr.message);
      itemResult = {
        success: false,
        error: procErr
      };
    }

    // 3. 処理結果を短時間排他ロックで保存 (Save & Fencing)
    try {
      lock.waitLock(AI_BATCH_CONFIG.LOCK_TIMEOUT_MS);
      const itemsSheet = getOrCreateAiBatchItemsSheet_();
      const currentRow = itemsSheet.getRange(claimedItem.rowIndex, 1, 1, itemsSheet.getLastColumn()).getValues()[0];
      const currentExecId = String(currentRow[11] || "").trim();
      const currentStatus = String(currentRow[3] || "").trim();
      const ownershipLost = !itemResult.success &&
        String(itemResult.error && itemResult.error.error_code || "") === "BATCH_ITEM_OWNERSHIP_LOST";

      // Fencing check: 所有権喪失・他ワーカー回収・状態変更時は、新しいワーカーの結果・状態を変更しない
      if (ownershipLost || currentExecId !== claimedItem.workerExecutionId || currentStatus !== "processing") {
        console.warn(`[AI Batch Worker] Fencing: discarding result for ${claimedItem.productId} (exec ${claimedItem.workerExecutionId}, current exec ${currentExecId}, status ${currentStatus}, ownership_lost=${ownershipLost}).`);
      } else {
        const nowIso = new Date().toISOString();
        if (itemResult.success) {
          itemsSheet.getRange(claimedItem.rowIndex, 4).setValue("completed");
          itemsSheet.getRange(claimedItem.rowIndex, 5).setValue(itemResult.draft_id);
          itemsSheet.getRange(claimedItem.rowIndex, 6).setValue(itemResult.draft_version);
          itemsSheet.getRange(claimedItem.rowIndex, 7).setValue(itemResult.model_name || "");
          itemsSheet.getRange(claimedItem.rowIndex, 8).setValue("");
          itemsSheet.getRange(claimedItem.rowIndex, 9).setValue("");
          itemsSheet.getRange(claimedItem.rowIndex, 11).setValue("");
          itemsSheet.getRange(claimedItem.rowIndex, 15).setValue(nowIso);
        } else {
          const isRateLimited = Boolean(
            itemResult.error && (itemResult.error.error_code === "LLM_HTTP_ERROR_429" || itemResult.error.status_code === 429)
          );
          const isTransient = isTransientLlmError_(itemResult.error);
          if (isTransient && claimedItem.currentRetryCount < AI_BATCH_CONFIG.MAX_RETRIES) {
            const nextRetryCount = claimedItem.currentRetryCount + 1;
            const nextRetryAt = new Date(Date.now() + AI_BATCH_CONFIG.RETRY_BACKOFF_MS * nextRetryCount).toISOString();
            itemsSheet.getRange(claimedItem.rowIndex, 4).setValue("pending");
            itemsSheet.getRange(claimedItem.rowIndex, 8).setValue(itemResult.error.error_code || "TEMPORARY_ERROR");
            itemsSheet.getRange(claimedItem.rowIndex, 9).setValue(itemResult.error.message || "Temporary error");
            itemsSheet.getRange(claimedItem.rowIndex, 10).setValue(nextRetryCount);
            itemsSheet.getRange(claimedItem.rowIndex, 11).setValue(nextRetryAt);
            itemsSheet.getRange(claimedItem.rowIndex, 15).setValue(nowIso);
          } else {
            itemsSheet.getRange(claimedItem.rowIndex, 4).setValue("failed");
            if (itemResult.error && itemResult.error.draft_id) {
              itemsSheet.getRange(claimedItem.rowIndex, 5).setValue(itemResult.error.draft_id);
              itemsSheet.getRange(claimedItem.rowIndex, 6).setValue(itemResult.error.draft_version || "");
              itemsSheet.getRange(claimedItem.rowIndex, 7).setValue(itemResult.error.model_name || "");
            }
            itemsSheet.getRange(claimedItem.rowIndex, 8).setValue(itemResult.error.error_code || "GENERATION_FAILED");
            itemsSheet.getRange(claimedItem.rowIndex, 9).setValue(itemResult.error.message || "Failed to generate draft");
            itemsSheet.getRange(claimedItem.rowIndex, 11).setValue("");
            itemsSheet.getRange(claimedItem.rowIndex, 15).setValue(nowIso);
          }

          if (isRateLimited) {
            console.warn(`[AI Batch Worker] Circuit breaker tripped by HTTP 429 for ${claimedItem.productId}. Yielding worker run immediately to allow quota reset.`);
            circuitBreakerTripped = true;
          }
        }

        // 親バッチ集計 & ステータス更新
        recomputeBatchJobSummary_(claimedItem.batchId);
      }
    } catch (saveErr) {
      console.error(`[AI Batch Worker] Failed to save result for ${claimedItem.productId}:`, saveErr.message);
    } finally {
      try {
        lock.releaseLock();
      } catch (_) {}
    }

    processedCount++;

    if (circuitBreakerTripped) {
      break;
    }
  }

  console.log(`[AI Batch Worker] Finished run. Total processed in this run: ${processedCount}`);
  return { processed_count: processedCount };
}

// ==================================================
// 13. Cloud Run + Supabase 正本移行用 下流互換ミラー & 同期ブリッジ
// ==================================================

/**
 * Cloud Run (`bis-ec-products-api`) との内部同期認証検証
 * - Script Properties に `PRODUCTS_API_INTERNAL_SECRET` が設定されている場合は `internal_sync_token` 一致（または管理者認証）を必須とする
 * - 未設定時は管理者認証または Cloud Run 内部同期ソース識別子 (`internal_sync_source === "bis-ec-products-api"`) を確認する
 * @param {Object} data
 * @param {Object} [propService]
 * @return {boolean}
 */
function verifyInternalSyncBridge_(data, propService) {
  if (!data || typeof data !== "object") return false;
  if (typeof verifyAdminAccess_ === "function" && verifyAdminAccess_(data, propService)) {
    return true;
  }
  try {
    const props = propService || PropertiesService.getScriptProperties();
    const expectedSecret = String(props.getProperty("PRODUCTS_API_INTERNAL_SECRET") || "").trim();
    if (expectedSecret) {
      const providedToken = String(data.internal_sync_token || "").trim();
      return providedToken.length > 0 && providedToken === expectedSecret;
    }
    return String(data.internal_sync_source || "").trim() === "bis-ec-products-api";
  } catch (err) {
    console.error("[Internal Sync Auth] Exception during verification (Fail-Closed):", err);
    return false;
  }
}

/**
 * product_ai_drafts シートの1行オブジェクトを getLatestProductAiDraft_ と同一構造へ整形
 * @param {Object} obj
 * @param {number} rowNumber
 * @return {Object}
 */
function formatProductAiDraftRowObject_(obj, rowNumber) {
  const parsedPrice = (obj.candidate_price === "" || obj.candidate_price === null || obj.candidate_price === undefined)
    ? null
    : (Number.isFinite(Number(obj.candidate_price)) && Number(obj.candidate_price) > 0 ? Math.floor(Number(obj.candidate_price)) : null);
  const queries = String(obj.search_queries || "").trim()
    ? String(obj.search_queries).split(",").map(q => q.trim()).filter(Boolean)
    : [];
  const sgEnabled = String(obj.search_grounding_enabled || "").toLowerCase() === "true";
  const sgExecuted = String(obj.search_executed || "").toLowerCase() === "true";
  const sgMode = String(obj.search_grounding_mode || "").trim();

  return {
    row_number: rowNumber,
    draft_id: String(obj.draft_id || "").trim(),
    product_id: String(obj.product_id || "").trim(),
    draft_version: Number(obj.draft_version || 1),
    review_status: String(obj.review_status || "pending_review").trim(),
    candidate_title_ja: String(obj.candidate_title_ja || "").trim(),
    candidate_hashtags_ja: String(obj.candidate_hashtags_ja || "").trim(),
    candidate_description_ja: String(obj.candidate_description_ja || "").trim(),
    candidate_title_en: String(obj.candidate_title_en || "").trim(),
    candidate_description_en: String(obj.candidate_description_en || "").trim(),
    candidate_condition: String(obj.candidate_condition || "").trim(),
    candidate_price: parsedPrice,
    candidate_category: String(obj.candidate_category || "").trim(),
    candidate_brand: String(obj.candidate_brand || "").trim(),
    candidate_sku: String(obj.candidate_sku || "").trim(),
    candidate_size: String(obj.candidate_size || "").trim(),
    source_fingerprint: String(obj.source_fingerprint || "").trim(),
    source_image_fingerprint: String(obj.source_image_fingerprint || "").trim(),
    confirmed_fingerprint: String(obj.confirmed_fingerprint || "").trim(),
    source_image_ids: String(obj.source_image_ids || "").trim(),
    model_name: String(obj.model_name || "").trim(),
    generated_at: obj.generated_at instanceof Date ? obj.generated_at.toISOString() : String(obj.generated_at || ""),
    confirmed_at: obj.confirmed_at instanceof Date ? obj.confirmed_at.toISOString() : String(obj.confirmed_at || ""),
    confirmed_by: String(obj.confirmed_by || "").trim(),
    last_confirmation_attempt_id: String(obj.last_confirmation_attempt_id || "").trim(),
    last_confirmation_payload_hash: String(obj.last_confirmation_payload_hash || "").trim(),
    search_grounding_enabled: sgEnabled,
    search_grounding_mode: sgMode,
    search_executed: sgExecuted,
    search_queries: queries,
    candidate_price_basis: String(obj.candidate_price_basis || "").trim(),
    candidate_price_note: String(obj.candidate_price_note || "").trim(),
    candidate_sku_source: String(obj.candidate_sku_source || "").trim(),
    candidate: {
      title_ja: String(obj.candidate_title_ja || "").trim(),
      hashtags_ja: String(obj.candidate_hashtags_ja || "").trim(),
      description_ja: String(obj.candidate_description_ja || "").trim(),
      title_en: String(obj.candidate_title_en || "").trim(),
      description_en: String(obj.candidate_description_en || "").trim(),
      condition: String(obj.candidate_condition || "").trim(),
      price: parsedPrice,
      price_note: String(obj.candidate_price_note || "").trim() || "AIによる概算価格です",
      price_basis: String(obj.candidate_price_basis || "").trim(),
      category: String(obj.candidate_category || "").trim(),
      brand: String(obj.candidate_brand || "").trim(),
      sku: String(obj.candidate_sku || "").trim(),
      sku_source: String(obj.candidate_sku_source || "").trim(),
      size: String(obj.candidate_size || "").trim(),
      search_grounding: {
        enabled: sgEnabled,
        mode_used: sgMode,
        search_executed: sgExecuted,
        queries: queries
      }
    }
  };
}

/**
 * Cloud Run + Supabase 正本で確定した AI下書き生成・確定状態を Google Sheets 側へミラー保存
 * - 対象は Square未連携の draft / active 商品に厳格限定（公開済み・Square連携済みは 409 相当エラーで遮断）
 * - 生成時 (`pending_review`): AN列 `ai_draft_flag = "ai_managed"` と `product_ai_drafts` 行を保存し、未確認公開を `assertProductPublishable_` で確実にブロック
 * - 確定時 (`confirmed`): 本票属性（初期カテゴリ設定含む）・英文翻訳 (`approved`)・ポケカ属性・AN列を更新した上で、
 *   GAS側 `computeConfirmedProductFingerprint_` で確定指紋を算出して `product_ai_drafts` に記録し、後続の Square公開ゲートと 100% 整合させる
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @param {Object} [opts]
 */
function handleMirrorAiProductDraftState_(sheet, data, opts) {
  const propService = opts && opts.propService;
  if (!verifyInternalSyncBridge_(data, propService)) {
    return jsonResponse({
      success: false,
      error_code: "UNAUTHORIZED_INTERNAL_SYNC",
      message: "Internal sync authentication required"
    });
  }

  const productId = String(data && data.product_id || "").trim();
  if (!productId) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_ID_REQUIRED",
      message: "product_id is required"
    });
  }

  const draftRecord = data && data.draft_record;
  if (!draftRecord || typeof draftRecord !== "object" || !String(draftRecord.draft_id || "").trim()) {
    return jsonResponse({
      success: false,
      error_code: "DRAFT_RECORD_REQUIRED",
      message: "draft_record with draft_id is required"
    });
  }

  let targetRow;
  try {
    targetRow = findProductRow(sheet, productId);
  } catch (_) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_NOT_FOUND",
      message: "Product not found: " + productId
    });
  }

  const maxSheetCols = typeof sheet.getMaxColumns === "function" ? sheet.getMaxColumns() : 44;
  const maxReadCols = Math.max(sheet.getLastColumn(), Math.min(maxSheetCols, 44));
  const currentRow = sheet.getRange(targetRow, 1, 1, maxReadCols).getValues()[0];
  const publishStatus = String(currentRow[31] || "draft").trim() || "draft";
  const recordStatus = String(currentRow[33] || "active").trim() || "active";
  const hasSquareLink =
    String(currentRow[34] || "").trim() !== "" ||
    String(currentRow[35] || "").trim() !== "" ||
    String(currentRow[36] || "").trim() !== "" ||
    String(currentRow[37] || "").trim() !== "";

  if (publishStatus !== "draft") {
    return jsonResponse({
      success: false,
      error_code: "PUBLISHED_PRODUCT_NOT_ALLOWED",
      message: "Only draft products can be mirrored via mirror_ai_product_draft_state"
    });
  }
  if (recordStatus !== "active") {
    return jsonResponse({
      success: false,
      error_code: "INACTIVE_PRODUCT_NOT_ALLOWED",
      message: "Only active draft products can be mirrored via mirror_ai_product_draft_state"
    });
  }
  if (hasSquareLink) {
    return jsonResponse({
      success: false,
      error_code: "SQUARE_LINKED_PRODUCT_NOT_ALLOWED",
      message: "Square-linked products cannot be modified via mirror_ai_product_draft_state"
    });
  }

  ensureAiDraftColumns_(sheet);

  if (Array.isArray(data.selected_image_ids) && typeof saveProductAiSelectedImageIds_ === "function") {
    saveProductAiSelectedImageIds_(sheet, productId, data.selected_image_ids);
  }

  const reviewStatus = String(draftRecord.review_status || "pending_review").trim();
  const applyConfirmed = Boolean(data.apply_confirmed_product && data.confirmed_product && typeof data.confirmed_product === "object");

  if (applyConfirmed) {
    const cp = data.confirmed_product;
    const existingCat = normalizeCategoryValue_(currentRow[2]);
    const incomingCat = normalizeCategoryValue_(cp.category);
    if (existingCat && incomingCat && existingCat !== incomingCat) {
      return jsonResponse({
        success: false,
        error_code: "CATEGORY_CANNOT_BE_CHANGED",
        message: `Existing category '${existingCat}' cannot be changed to '${incomingCat}'`
      });
    }
    const effectiveCat = existingCat || incomingCat;
    if (!existingCat && incomingCat) {
      sheet.getRange(targetRow, 3).setValue(incomingCat);
    }

    if (cp.brand !== undefined) {
      sheet.getRange(targetRow, 4).setValue(String(cp.brand || "").trim());
    }
    if (cp.product_name !== undefined) {
      sheet.getRange(targetRow, 5).setValue(String(cp.product_name || "").trim());
    }
    if (effectiveCat === "pokemon_card") {
      sheet.getRange(targetRow, 6).setValue("");
    } else if (cp.condition !== undefined) {
      sheet.getRange(targetRow, 6).setValue(String(cp.condition || "").trim());
    }
    if (cp.planned_sale_price !== undefined && cp.planned_sale_price !== null && cp.planned_sale_price !== "") {
      const pNum = Number(cp.planned_sale_price);
      if (Number.isSafeInteger(pNum) && pNum > 0) {
        sheet.getRange(targetRow, 8).setValue(pNum);
      }
    }
    if (cp.description !== undefined) {
      sheet.getRange(targetRow, 10).setValue(String(cp.description || ""));
    }
    if (cp.notes !== undefined) {
      sheet.getRange(targetRow, 11).setValue(String(cp.notes || ""));
    }

    if (effectiveCat === "sneaker") {
      if (cp.sneaker_sku !== undefined) {
        sheet.getRange(targetRow, 12).setValue(String(cp.sneaker_sku || "").trim());
      }
      if (cp.sneaker_size !== undefined) {
        sheet.getRange(targetRow, 13).setValue(String(cp.sneaker_size || "").trim());
      }
      if (cp.sneaker_colorway !== undefined) {
        sheet.getRange(targetRow, 14).setValue(String(cp.sneaker_colorway || "").trim());
      }
      if (cp.sneaker_box !== undefined) {
        sheet.getRange(targetRow, 15).setValue(String(cp.sneaker_box || "").trim());
      }
      if (cp.sneaker_accessories !== undefined) {
        sheet.getRange(targetRow, 16).setValue(String(cp.sneaker_accessories || "").trim());
      }
    } else if (effectiveCat === "apparel" || effectiveCat === "fashion_goods") {
      if (typeof ensureExtendedProductColumns_ === "function") {
        ensureExtendedProductColumns_(sheet);
      } else if (sheet.getMaxColumns() < 43) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), 43 - sheet.getMaxColumns());
      }
      if (cp.subcategory !== undefined) {
        sheet.getRange(targetRow, 41).setValue(String(cp.subcategory || "").trim());
      }
      if (cp.size !== undefined) {
        sheet.getRange(targetRow, 42).setValue(String(cp.size || "").trim());
      }
      if (cp.official_sku !== undefined) {
        sheet.getRange(targetRow, 43).setValue(String(cp.official_sku || "").trim());
      }
    }

    if (data.translation && typeof data.translation === "object") {
      const refreshedRow = sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), 16)).getValues()[0];
      saveConfirmedProductTranslation_(productId, {
        translated_title: String(data.translation.translated_title || "").trim(),
        translated_description: String(data.translation.translated_description || "").trim(),
        condition: data.translation.condition !== undefined ? data.translation.condition : String(refreshedRow[5] || ""),
        box: data.translation.box !== undefined ? data.translation.box : String(refreshedRow[14] || ""),
        accessories: data.translation.accessories !== undefined ? data.translation.accessories : String(refreshedRow[15] || "")
      });
    }

    if (effectiveCat === "pokemon_card" && data.pokemon_card && typeof data.pokemon_card === "object") {
      savePokemonCardByProductId(productId, data.pokemon_card);
    }
  }

  // AN列 (40列目): ai_draft_flag = "ai_managed"
  sheet.getRange(targetRow, AI_DRAFT_CONFIG.AI_DRAFT_FLAG_COLUMN).setValue(AI_DRAFT_CONFIG.FLAG_VALUE);

  let gasConfirmedFingerprint = String(draftRecord.confirmed_fingerprint || "").trim();
  if (reviewStatus === "confirmed") {
    gasConfirmedFingerprint = computeConfirmedProductFingerprint_(sheet, targetRow, productId);
  }

  const draftSheet = getOrCreateProductAiDraftsSheet_();
  const lastRow = draftSheet.getLastRow();
  const lastCol = draftSheet.getLastColumn();
  const headers = draftSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  const draftIdIdx = headers.indexOf("draft_id");
  const prodIdIdx = headers.indexOf("product_id");
  const statusIdx = headers.indexOf("review_status");

  const targetDraftId = String(draftRecord.draft_id || "").trim();
  const sourceImageIdsStr = Array.isArray(draftRecord.source_image_ids)
    ? draftRecord.source_image_ids.join(",")
    : String(draftRecord.source_image_ids || "").trim();
  const searchQueriesStr = Array.isArray(draftRecord.search_queries)
    ? draftRecord.search_queries.join(", ")
    : String(draftRecord.search_queries || "").trim();

  const cellValueByHeader = {
    draft_id: targetDraftId,
    product_id: productId,
    draft_version: Number(draftRecord.draft_version || 1),
    review_status: reviewStatus,
    candidate_title_ja: String(draftRecord.candidate_title_ja || ""),
    candidate_hashtags_ja: String(draftRecord.candidate_hashtags_ja || ""),
    candidate_description_ja: String(draftRecord.candidate_description_ja || ""),
    candidate_title_en: String(draftRecord.candidate_title_en || ""),
    candidate_description_en: String(draftRecord.candidate_description_en || ""),
    candidate_condition: String(draftRecord.candidate_condition || ""),
    candidate_price: (draftRecord.candidate_price === null || draftRecord.candidate_price === undefined || draftRecord.candidate_price === "")
      ? ""
      : Number(draftRecord.candidate_price),
    candidate_category: String(draftRecord.candidate_category || ""),
    candidate_brand: String(draftRecord.candidate_brand || ""),
    candidate_sku: String(draftRecord.candidate_sku || ""),
    candidate_size: String(draftRecord.candidate_size || ""),
    source_fingerprint: String(draftRecord.source_fingerprint || ""),
    source_image_fingerprint: String(draftRecord.source_image_fingerprint || ""),
    confirmed_fingerprint: gasConfirmedFingerprint,
    source_image_ids: sourceImageIdsStr,
    model_name: String(draftRecord.model_name || ""),
    generated_at: String(draftRecord.generated_at || new Date().toISOString()),
    confirmed_at: String(draftRecord.confirmed_at || ""),
    confirmed_by: String(draftRecord.confirmed_by || ""),
    last_confirmation_attempt_id: String(draftRecord.last_confirmation_attempt_id || ""),
    last_confirmation_payload_hash: String(draftRecord.last_confirmation_payload_hash || ""),
    search_grounding_enabled: Boolean(draftRecord.search_grounding_enabled),
    search_grounding_mode: String(draftRecord.search_grounding_mode || ""),
    search_executed: Boolean(draftRecord.search_executed),
    search_queries: searchQueriesStr,
    candidate_price_basis: String(draftRecord.candidate_price_basis || ""),
    candidate_price_note: String(draftRecord.candidate_price_note || ""),
    candidate_sku_source: String(draftRecord.candidate_sku_source || "")
  };

  let existingDraftRowIndex = -1;
  if (lastRow >= 2 && draftIdIdx !== -1 && prodIdIdx !== -1) {
    const rows = draftSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (let i = 0; i < rows.length; i++) {
      const rPid = String(rows[i][prodIdIdx] || "").trim();
      const rDid = String(rows[i][draftIdIdx] || "").trim();
      if (rDid === targetDraftId) {
        existingDraftRowIndex = i + 2;
      } else if (rPid === productId && statusIdx !== -1 && String(rows[i][statusIdx] || "").trim() === "pending_review") {
        draftSheet.getRange(i + 2, statusIdx + 1).setValue("stale");
      }
    }
  }

  const alignedRow = headers.map(h => Object.prototype.hasOwnProperty.call(cellValueByHeader, h) ? cellValueByHeader[h] : "");
  if (existingDraftRowIndex > 0) {
    draftSheet.getRange(existingDraftRowIndex, 1, 1, lastCol).setValues([alignedRow]);
  } else {
    draftSheet.appendRow(alignedRow);
  }

  if (typeof clearProductCache_ === "function") {
    clearProductCache_(productId);
  }
  if (typeof clearProductTranslationCache_ === "function") {
    clearProductTranslationCache_(productId);
  }
  try {
    CacheService.getScriptCache().remove("prod_aidraft_" + productId);
  } catch (_) {}

  return jsonResponse({
    success: true,
    version: "mirror-ai-product-draft-v1",
    product_id: productId,
    draft_id: targetDraftId,
    draft_version: Number(draftRecord.draft_version || 1),
    review_status: reviewStatus,
    confirmed_fingerprint: gasConfirmedFingerprint
  });
}

/**
 * Cloud Run + Supabase 同期・バックフィル用の AI下書き取得ハンドラ
 * - `all_latest: true` で全商品の最新ドラフト＋`ai_draft_flag`を一括取得
 * - `product_id` または `product_ids` 指定で対象商品の最新ドラフト＋`ai_draft_flag`を取得
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} data
 * @param {Object} [opts]
 */
function handleGetAiProductDraftsForSync_(sheet, data, opts) {
  const propService = opts && opts.propService;
  if (!verifyInternalSyncBridge_(data, propService)) {
    return jsonResponse({
      success: false,
      error_code: "UNAUTHORIZED_INTERNAL_SYNC",
      message: "Internal sync authentication required"
    });
  }

  const allLatest = Boolean(data && data.all_latest);
  const singleProductId = String(data && data.product_id || "").trim();
  const targetIdSet = new Set();
  if (singleProductId) targetIdSet.add(singleProductId);
  if (Array.isArray(data && data.product_ids)) {
    data.product_ids.forEach(pid => {
      const s = String(pid || "").trim();
      if (s) targetIdSet.add(s);
    });
  }

  if (!allLatest && targetIdSet.size === 0) {
    return jsonResponse({
      success: false,
      error_code: "PRODUCT_ID_REQUIRED",
      message: "product_id, product_ids, or all_latest=true is required"
    });
  }

  const flagMap = {};
  const prodLastRow = sheet.getLastRow();
  const prodLastCol = sheet.getLastColumn();
  if (prodLastRow >= 2 && prodLastCol >= 2) {
    const readCols = Math.min(prodLastCol, Math.max(prodLastCol, 40));
    const prodRows = sheet.getRange(2, 1, prodLastRow - 1, readCols).getValues();
    for (let i = 0; i < prodRows.length; i++) {
      const pid = String(prodRows[i][1] || "").trim();
      if (!pid) continue;
      if (!allLatest && !targetIdSet.has(pid)) continue;
      flagMap[pid] = prodLastCol >= 40 ? String(prodRows[i][39] || "").trim() : "";
    }
  }

  const latestByProduct = {};
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const draftSheet = spreadsheet.getSheetByName(AI_DRAFT_CONFIG.SHEET_NAME);
  if (draftSheet && draftSheet.getLastRow() >= 2 && draftSheet.getLastColumn() >= 1) {
    const dLastRow = draftSheet.getLastRow();
    const dLastCol = draftSheet.getLastColumn();
    const headers = draftSheet.getRange(1, 1, 1, dLastCol).getValues()[0].map(h => String(h || "").trim());
    const pIdIdx = headers.indexOf("product_id");
    if (pIdIdx !== -1) {
      const dRows = draftSheet.getRange(2, 1, dLastRow - 1, dLastCol).getValues();
      for (let i = dRows.length - 1; i >= 0; i--) {
        const pid = String(dRows[i][pIdIdx] || "").trim();
        if (!pid || latestByProduct[pid]) continue;
        if (!allLatest && !targetIdSet.has(pid)) continue;
        const obj = {};
        headers.forEach((h, cIdx) => {
          obj[h] = dRows[i][cIdx];
        });
        latestByProduct[pid] = formatProductAiDraftRowObject_(obj, i + 2);
      }
    }
  }

  const pidsToEmit = allLatest
    ? Array.from(new Set(Object.keys(latestByProduct).concat(
        Object.keys(flagMap).filter(pid => Boolean(flagMap[pid]))
      )))
    : Array.from(targetIdSet);

  const items = pidsToEmit.map(pid => ({
    product_id: pid,
    ai_draft_flag: flagMap[pid] || "",
    latest_ai_draft: latestByProduct[pid] || null
  }));

  return jsonResponse({
    success: true,
    version: "ai-product-drafts-sync-v1",
    items: items,
    ...(singleProductId ? {
      product_id: singleProductId,
      ai_draft_flag: flagMap[singleProductId] || "",
      latest_ai_draft: latestByProduct[singleProductId] || null
    } : {})
  });
}


