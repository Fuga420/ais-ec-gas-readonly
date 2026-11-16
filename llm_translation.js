// ==================================================
// 越境EC向けLLM英語商品説明生成MVP
// ファイル名: llm_translation.js
// ==================================================

/**
 * 定数定義
 */
const LLM_TRANSLATION_CONFIG = {
  API_KEY_PROPERTY: "LLM_API_KEY",
  MODEL_PROPERTY: "LLM_MODEL",
  DEFAULT_MODEL: "gemini-2.5-flash",
  SHEET_NAME: "product_translations",
  DEFAULT_LOCALE: "en",
  DEFAULT_STATUS: "draft",
  MAX_RETRIES: 3,
  INITIAL_RETRY_DELAY_MS: 2000,
  RETRYABLE_STATUS_CODES: [429, 500, 502, 503, 504],
  HEADERS: [
    "product_id",
    "locale",
    "translated_title",
    "translated_description",
    "translated_condition",
    "translated_box",
    "translated_accessories",
    "translation_status",
    "generated_at"
  ]
};

/**
 * 固定項目翻訳用辞書定義
 */
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


// ==================================================
// 1. 設定・APIキー取得
// ==================================================

/**
 * Script Properties から Gemini / LLM APIキーを取得
 * @return {string} APIキー
 */
function getLlmApiKey_() {
  const apiKey = PropertiesService
    .getScriptProperties()
    .getProperty(LLM_TRANSLATION_CONFIG.API_KEY_PROPERTY);

  const trimmed = String(apiKey || "").trim();

  if (!trimmed) {
    throw new Error(
      `[LLM Translation] API key not found. Please set '${LLM_TRANSLATION_CONFIG.API_KEY_PROPERTY}' in Project Settings > Script Properties.`
    );
  }

  return trimmed;
}

/**
 * 使用するLLMモデル名を取得（Script Propertiesで上書き可能）
 * @return {string} モデル名
 */
function getLlmModelName_() {
  const model = PropertiesService
    .getScriptProperties()
    .getProperty(LLM_TRANSLATION_CONFIG.MODEL_PROPERTY);

  return String(model || "").trim() || LLM_TRANSLATION_CONFIG.DEFAULT_MODEL;
}


// ==================================================
// 2. 固定項目辞書翻訳ヘルパー
// ==================================================

/**
 * 固定項目（商品状態、箱の有無、付属品）を辞書に基づいて英語に変換
 * 辞書にない値はそのまま出力
 * @param {Object} productData
 * @return {Object} { translated_condition: string, translated_box: string, translated_accessories: string }
 */
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


// ==================================================
// 3. プロンプト生成 & ルール定義
// ==================================================

/**
 * 越境EC向け翻訳・整形用システムインストラクション（生成ルール）を生成
 * @return {string} System Instruction
 */
function buildTranslationSystemInstruction_() {
  return [
    "You are an expert cross-border e-commerce copywriter and translator specializing in listing products on international marketplaces (e.g., eBay, Shopify, Amazon).",
    "Your objective is to translate and optimize Japanese product data into natural, engaging, and professional English suitable for global buyers.",
    "",
    "Strict Generation Rules:",
    "1. Fact Preservation: NEVER add, invent, or hallucinate facts that are not present in the source data.",
    "2. Condition Accuracy: NEVER exaggerate or embellish the condition of the item. Flaws, wear, scratches, or used conditions must be described faithfully and accurately without sugarcoating.",
    "3. Exact Identifiers: NEVER alter, translate, or modify brand names, model names, or SKU numbers. Keep them exact.",
    "4. Sneaker Size Conversion (US Men's): When sneaker size is provided in centimeters (cm) (e.g., 28.0cm, 28cm), automatically convert it to Men's US size based on the brand's standard size chart (e.g., NIKE 28.0cm -> US 10). In both the translated title and description, ALWAYS use the US size notation (e.g., 'Size: US 10' or 'US 10') and NEVER use centimeter (cm) notation.",
    "5. Fixed Attributes Consistency: If standardized translations for Condition, Box, or Accessories are provided, use those standard terms in the description to maintain consistency.",
    "6. Unknown Information: If any information is missing, unspecified, or unclear in the source data, do NOT guess or assume. Leave it as-is or omit it.",
    "7. Tone & Style: Clear, professional, concise, and appealing to international buyers.",
    "8. Output Format: You must output ONLY a valid JSON object matching the requested schema with 'translated_title' and 'translated_description'."
  ].join("\n");
}

/**
 * 日本語の商品元データをプロンプトテキストにフォーマット
 * @param {Object} productData
 * @param {Object} [fixedAttributes] 辞書翻訳済みの固定項目
 * @return {string} User Prompt
 */
function buildTranslationUserPrompt_(productData, fixedAttributes) {
  if (!productData || typeof productData !== "object") {
    throw new Error("[LLM Translation] productData must be a valid object.");
  }

  const fixed = fixedAttributes || {};
  const lines = [
    "Please translate and optimize the following Japanese product details into English according to the system instructions:",
    ""
  ];

  // 主要項目のマッピングと整形
  const labelMap = {
    product_id: "Product ID",
    product_name: "Original Product Name (Title)",
    brand: "Brand",
    category: "Category",
    condition: "Condition",
    description: "Original Description",
    notes: "Notes",
    sneaker_sku: "SKU",
    sneaker_size: "Size (Sneaker)",
    sneaker_colorway: "Colorway",
    sneaker_box: "Box Included",
    sneaker_accessories: "Accessories",
    sneaker_release_year: "Release Year",
    jewelry_type: "Jewelry Type",
    jewelry_material: "Material",
    carat: "Carat",
    jewelry_size: "Size (Jewelry)",
    weight_g: "Weight (g)"
  };

  const processedKeys = new Set();

  // 主要項目を順序立てて出力
  Object.keys(labelMap).forEach(key => {
    if (productData[key] !== undefined && productData[key] !== null && String(productData[key]).trim() !== "") {
      let valStr = String(productData[key]).trim();

      // 辞書訳がある場合は標準訳を補足として併記
      if (key === "condition" && fixed.translated_condition) {
        valStr += ` (Standard Translation: ${fixed.translated_condition})`;
      } else if (key === "sneaker_box" && fixed.translated_box) {
        valStr += ` (Standard Translation: ${fixed.translated_box})`;
      } else if (key === "sneaker_accessories" && fixed.translated_accessories) {
        valStr += ` (Standard Translation: ${fixed.translated_accessories})`;
      }

      lines.push(`- ${labelMap[key]}: ${valStr}`);
      processedKeys.add(key);
    }
  });

  // その他の任意項目（未マッピングの追加プロパティ）を出力
  Object.keys(productData).forEach(key => {
    if (!processedKeys.has(key) && productData[key] !== undefined && productData[key] !== null && String(productData[key]).trim() !== "") {
      lines.push(`- ${key}: ${String(productData[key]).trim()}`);
    }
  });

  lines.push("");
  lines.push("Generate the 'translated_title' and 'translated_description' strictly adhering to all rules.");

  return lines.join("\n");
}


// ==================================================
// 3. Gemini API 呼び出し (構造化JSON)
// ==================================================

/**
 * Gemini generateContent API を呼び出し、構造化JSONを取得
 * @param {string} prompt ユーザープロンプト
 * @param {string} systemInstruction システムインストラクション
 * @return {Object} { translated_title: string, translated_description: string }
 */
function callGeminiGenerateContent_(prompt, systemInstruction) {
  const apiKey = getLlmApiKey_();
  const model = getLlmModelName_();

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          translated_title: {
            type: "STRING",
            description: "Cross-border EC optimized English title"
          },
          translated_description: {
            type: "STRING",
            description: "Natural and faithful English product description"
          }
        },
        required: ["translated_title", "translated_description"]
      },
      temperature: 0.2
    }
  };

  const requestOptions = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const maxRetries = LLM_TRANSLATION_CONFIG.MAX_RETRIES;
  const initialDelayMs = LLM_TRANSLATION_CONFIG.INITIAL_RETRY_DELAY_MS;
  const retryableStatuses = LLM_TRANSLATION_CONFIG.RETRYABLE_STATUS_CODES;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    let responseCode = 0;
    let responseBody = "";

    try {
      response = UrlFetchApp.fetch(endpoint, requestOptions);
      responseCode = response.getResponseCode();
      responseBody = response.getContentText();
    } catch (networkError) {
      lastError = networkError;
      if (attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 500);
        const waitMs = initialDelayMs * Math.pow(2, attempt) + jitter;
        Logger.log(
          `[LLM Translation] Network error: ${networkError.message}. Retrying in ${waitMs}ms (Attempt ${attempt + 1}/${maxRetries})...`
        );
        Utilities.sleep(waitMs);
        continue;
      }
      throw new Error(
        `[LLM Translation] Gemini API request failed due to network error after ${maxRetries} retries: ${networkError.message}`
      );
    }

    // 200 OK: 正常終了
    if (responseCode === 200) {
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(responseBody);
      } catch (parseError) {
        throw new Error(
          `[LLM Translation] Failed to parse Gemini API response as JSON: ${parseError.message}`
        );
      }

      const candidate = parsedResponse.candidates && parsedResponse.candidates[0];
      if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
        throw new Error(
          `[LLM Translation] No content candidate returned by Gemini API: ${responseBody}`
        );
      }

      const rawText = candidate.content.parts[0].text;
      let result;
      try {
        result = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(
          `[LLM Translation] Failed to parse generated content text into structured JSON: ${rawText}`
        );
      }

      if (typeof result.translated_title !== "string" || typeof result.translated_description !== "string") {
        throw new Error(
          "[LLM Translation] Generated JSON is missing required keys ('translated_title', 'translated_description')."
        );
      }

      return {
        translated_title: result.translated_title.trim(),
        translated_description: result.translated_description.trim()
      };
    }

    // 一時的エラー（503, 429など）の場合はリトライ
    if (retryableStatuses.indexOf(responseCode) !== -1) {
      lastError = new Error(
        `[LLM Translation] Gemini API request failed with status ${responseCode}: ${responseBody}`
      );

      if (attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 500);
        const waitMs = initialDelayMs * Math.pow(2, attempt) + jitter;
        Logger.log(
          `[LLM Translation] Transient error (HTTP ${responseCode}). Retrying in ${waitMs}ms (Attempt ${attempt + 1}/${maxRetries})...`
        );
        Utilities.sleep(waitMs);
        continue;
      }
    } else {
      // 400 Bad Request, 403 Forbidden などの恒常的エラーはリトライせず即座に例外
      throw new Error(
        `[LLM Translation] Gemini API request failed with non-retryable status ${responseCode}: ${responseBody}`
      );
    }
  }

  throw lastError || new Error(
    `[LLM Translation] Gemini API request failed after ${maxRetries} retries.`
  );
}


// ==================================================
// 4. メイン翻訳生成関数
// ==================================================

/**
 * 日本語の商品元データを受け取り、越境EC向けの自然な英語タイトル・説明文を生成
 * @param {Object} productData 商品元データ (product_name, description, condition, brand, etc.)
 * @return {Object} { translated_title: string, translated_description: string }
 */
function generateEnglishProductDescription(productData) {
  if (!productData || typeof productData !== "object") {
    throw new Error("[LLM Translation] productData must be an object.");
  }

  // 固定項目の辞書翻訳
  const fixedAttrs = translateFixedAttributes(productData);

  const systemInstruction = buildTranslationSystemInstruction_();
  const userPrompt = buildTranslationUserPrompt_(productData, fixedAttrs);

  const llmResult = callGeminiGenerateContent_(userPrompt, systemInstruction);

  return {
    translated_title: llmResult.translated_title,
    translated_description: llmResult.translated_description,
    translated_condition: fixedAttrs.translated_condition,
    translated_box: fixedAttrs.translated_box,
    translated_accessories: fixedAttrs.translated_accessories
  };
}


// ==================================================
// 5. スプレッドシート保存処理
// ==================================================

/**
 * product_translations シートを取得、存在しない場合は作成してヘッダーを設定
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateProductTranslationsSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = LLM_TRANSLATION_CONFIG.SHEET_NAME;
  const expectedHeaders = LLM_TRANSLATION_CONFIG.HEADERS;

  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }

  // 既存シートのヘッダーが空の場合は初期設定
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    return sheet;
  }

  // 既存ヘッダーに新カラムが不足している場合は末尾に追加
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
 * 生成された翻訳結果を product_translations シートの末尾行に保存
 * @param {string|number} productId 対象商品ID
 * @param {Object} translationResult { translated_title, translated_description, translated_condition, translated_box, translated_accessories }
 * @param {Object} [options] オプション (locale, translation_status, generated_at など)
 * @return {Object} 保存されたレコード情報
 */
function saveProductTranslation(productId, translationResult, options) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    throw new Error("[LLM Translation] productId is required to save translation.");
  }

  if (!translationResult || typeof translationResult !== "object") {
    throw new Error("[LLM Translation] translationResult must be an object.");
  }

  const title = String(translationResult.translated_title || "").trim();
  const description = String(translationResult.translated_description || "").trim();

  if (!title) {
    throw new Error("[LLM Translation] translated_title is required.");
  }

  const opts = options || {};
  const locale = String(opts.locale || LLM_TRANSLATION_CONFIG.DEFAULT_LOCALE).trim();
  const translationStatus = String(opts.translation_status || LLM_TRANSLATION_CONFIG.DEFAULT_STATUS).trim();
  const generatedAt = opts.generated_at ? String(opts.generated_at).trim() : new Date().toISOString();

  const sheet = getOrCreateProductTranslationsSheet_();

  // ヘッダー行を読み取り、列順を柔軟に対応
  const lastColumn = Math.max(sheet.getLastColumn(), LLM_TRANSLATION_CONFIG.HEADERS.length);
  const headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

  const recordMap = {
    product_id: normalizedProductId,
    locale: locale,
    translated_title: title,
    translated_description: description,
    translated_condition: String(translationResult.translated_condition || "").trim(),
    translated_box: String(translationResult.translated_box || "").trim(),
    translated_accessories: String(translationResult.translated_accessories || "").trim(),
    translation_status: translationStatus,
    generated_at: generatedAt
  };

  // シートのヘッダーに合わせた行データを作成
  let rowData = [];
  let headerMatched = false;

  for (let col = 0; col < headerValues.length; col++) {
    const colName = String(headerValues[col] || "").trim();
    if (Object.prototype.hasOwnProperty.call(recordMap, colName)) {
      rowData.push(recordMap[colName]);
      headerMatched = true;
    } else {
      rowData.push("");
    }
  }

  // もしヘッダー行が一致しなかった場合（異常時フォールバック）は標準順序で追加
  if (!headerMatched) {
    rowData = [
      recordMap.product_id,
      recordMap.locale,
      recordMap.translated_title,
      recordMap.translated_description,
      recordMap.translated_condition,
      recordMap.translated_box,
      recordMap.translated_accessories,
      recordMap.translation_status,
      recordMap.generated_at
    ];
  }

  sheet.appendRow(rowData);

  try {
    if (typeof clearProductTranslationCache_ === "function") {
      clearProductTranslationCache_(normalizedProductId);
    } else {
      CacheService.getScriptCache().remove("prod_trans_" + normalizedProductId);
    }
  } catch (_) {}

  return {
    success: true,
    saved_row: sheet.getLastRow(),
    data: recordMap
  };
}

/**
 * 商品データから翻訳を生成し、スプレッドシートに保存する一括実行関数
 * @param {Object} productData 商品元データ (product_id 必須)
 * @return {Object} 生成および保存結果
 */
function generateAndSaveProductTranslation(productData) {
  if (!productData || typeof productData !== "object") {
    throw new Error("[LLM Translation] productData must be an object.");
  }

  const productId = productData.product_id || productData.id;
  if (!productId) {
    throw new Error("[LLM Translation] product_id is required in productData.");
  }

  // 1. LLMによる英語商品説明生成
  const translationResult = generateEnglishProductDescription(productData);

  // 2. スプレッドシートへの保存 (status: "draft", locale: "en", generated_at: ISO timestamp)
  const saveResult = saveProductTranslation(productId, translationResult);

  return {
    success: true,
    product_id: String(productId).trim(),
    translation: translationResult,
    save_result: saveResult
  };
}


// ==================================================
// 6. テスト・動作確認用関数
// ==================================================

/**
 * 動作確認用テスト関数
 * GASエディタから実行して動作をテストできます。
 */
function testGenerateEnglishProductDescription() {
  const sampleProduct = {
    product_id: "TEST-001",
    product_name: "ナイキ エアジョーダン 1 レトロ ハイ OG シカゴ 2015 28.0cm 箱あり",
    brand: "NIKE",
    category: "スニーカー",
    condition: "中古 (美中古・ソールに若干の汚れあり、アッパー履きジワ小)",
    description: "2015年発売のオリジナルカラー。数回着用のみで全体的に状態は良好です。黒タグ、替え紐付属。",
    sneaker_sku: "555088-101",
    sneaker_size: "28.0",
    sneaker_box: "あり",
    sneaker_accessories: "黒タグ、替え紐",
    sneaker_release_year: "2015"
  };

  Logger.log("--- テスト開始: 英語商品説明生成 ---");
  Logger.log("入力データ: " + JSON.stringify(sampleProduct, null, 2));

  try {
    const result = generateAndSaveProductTranslation(sampleProduct);
    Logger.log("--- 実行成功 ---");
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    Logger.log("--- エラー発生 ---");
    Logger.log(error.message);
    throw error;
  }
}

