// ==================================================
// 包括的ローカル単体テストハーネス (GAS非依存・外部通信ゼロ)
// ファイル名: scratch/run_local_tests.js
// ==================================================
const fs = require('fs');
const vm = require('vm');

const llmDraftCode = fs.readFileSync('./llm_product_draft.js', 'utf8');
const mainCode = fs.readFileSync('./コード.js', 'utf8');
const llmTransCode = fs.readFileSync('./llm_translation.js', 'utf8');
const pokeCode = fs.readFileSync('./pokemon_cards.js', 'utf8');
const testsCode = fs.readFileSync('./tests.js', 'utf8');

// モック環境構築
let mockScriptProperties = {};
let mockCacheStore = {};

const sandbox = {
  console: console,
  Utilities: {
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    base64Decode: (str) => Buffer.from(str, 'base64'),
    newBlob: (bytes, mime, name) => ({
      name: name,
      mime: mime,
      bytes: bytes,
      getBytes: () => bytes,
      getContentType: () => mime,
      getName: () => name
    }),
    getUuid: () => 'uuid-' + Math.random().toString(36).substring(2, 9),
    computeDigest: (algorithm, str) => {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(str, 'utf8').digest();
      return Array.from(hash).map(b => (b > 127 ? b - 256 : b));
    },
    formatDate: (date, tz, fmt) => {
      const d = date instanceof Date ? date : new Date(date);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  },
  ContentService: {
    createTextOutput: (text) => ({
      setMimeType: () => ({
        getContent: () => text
      }),
      getContent: () => text
    }),
    MimeType: { JSON: "application/json" }
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => mockScriptProperties[key] || null,
      getProperties: () => Object.assign({}, mockScriptProperties),
      setProperty: (key, val) => { mockScriptProperties[key] = String(val); },
      deleteProperty: (key) => { delete mockScriptProperties[key]; }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (key) => mockCacheStore[key] || null,
      put: (key, val, sec) => { mockCacheStore[key] = String(val); },
      remove: (key) => { delete mockCacheStore[key]; },
      removeAll: (keys) => {
        if (Array.isArray(keys)) {
          keys.forEach(k => delete mockCacheStore[k]);
        }
      }
    })
  },
  DriveApp: {
    getFolderById: (id) => ({
      getFiles: () => ({
        hasNext: () => false,
        next: () => null
      })
    })
  },
  LockService: {
    getScriptLock: () => ({
      waitLock: () => true,
      releaseLock: () => true
    })
  },
  extractDriveFolderId: (url) => {
    const m = String(url).match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  },
  jsonResponse: (obj) => ({
    getContent: () => JSON.stringify(obj),
    data: obj
  }),
  findProductRow: (sheet, productId) => 2,
  translateFixedAttributes: (attrs) => ({
    translated_condition: "Excellent",
    translated_box: "Original Box Included",
    translated_accessories: "Extra Laces"
  }),
  saveProductTranslation: (productId, recordMap, opts) => ({ success: true }),
  clearProductCache_: (pid) => {},
  getLlmModelName_: () => "gemini-2.5-flash",
  ScriptApp: {
    getProjectTriggers: () => (sandbox._mockTriggers || []),
    newTrigger: (handler) => ({
      timeBased: () => ({
        everyMinutes: (m) => ({
          create: () => {
            if (!sandbox._mockTriggers) sandbox._mockTriggers = [];
            const trg = {
              getHandlerFunction: () => handler,
              getUniqueId: () => "mock-trigger-" + Math.random().toString(36).substring(2, 7)
            };
            sandbox._mockTriggers.push(trg);
            return trg;
          }
        })
      })
    }),
    deleteTrigger: (trg) => {
      if (sandbox._mockTriggers) {
        sandbox._mockTriggers = sandbox._mockTriggers.filter(t => t !== trg && t.getUniqueId() !== (trg && trg.getUniqueId && trg.getUniqueId()));
      }
    }
  }
};
sandbox._mockTriggers = [];

vm.createContext(sandbox);

// コードをロード
vm.runInContext(llmTransCode, sandbox);
vm.runInContext(pokeCode, sandbox);
vm.runInContext(llmDraftCode, sandbox);
vm.runInContext(mainCode, sandbox);
vm.runInContext(testsCode, sandbox);

const AI_DRAFT_CONFIG = vm.runInContext("AI_DRAFT_CONFIG", sandbox);
const validateAndSanitizeDraftCandidate_ = vm.runInContext("validateAndSanitizeDraftCandidate_", sandbox);
const validateDriveImagesData_ = vm.runInContext("validateDriveImagesData_", sandbox);
const acquireAiDraftExecutionLock_ = vm.runInContext("acquireAiDraftExecutionLock_", sandbox);
const releaseAiDraftExecutionLock_ = vm.runInContext("releaseAiDraftExecutionLock_", sandbox);
const verifyAiDraftExecutionLock_ = vm.runInContext("verifyAiDraftExecutionLock_", sandbox);
const assertProductPublishable_ = vm.runInContext("assertProductPublishable_", sandbox);
const computeConfirmedProductFingerprint_ = vm.runInContext("computeConfirmedProductFingerprint_", sandbox);
const computeProductSourceFingerprint_ = vm.runInContext("computeProductSourceFingerprint_", sandbox);
const computeConfirmationPayloadHash_ = vm.runInContext("computeConfirmationPayloadHash_", sandbox);
const normalizeCategoryValue_ = vm.runInContext("normalizeCategoryValue_", sandbox);
const handleConfirmAiProductDraft = vm.runInContext("handleConfirmAiProductDraft", sandbox);
const saveConfirmedProductTranslation_ = vm.runInContext("saveConfirmedProductTranslation_", sandbox);
const getProductTranslation = vm.runInContext("getProductTranslation", sandbox);
const verifyAdminAccess_ = vm.runInContext("verifyAdminAccess_", sandbox);
const buildProductDetail = vm.runInContext("buildProductDetail", sandbox);
const AI_BATCH_CONFIG = vm.runInContext("AI_BATCH_CONFIG", sandbox);
const handleCreateAiProductDraftBatch = vm.runInContext("handleCreateAiProductDraftBatch", sandbox);
const handleGetAiProductDraftBatch = vm.runInContext("handleGetAiProductDraftBatch", sandbox);
const handleRetryAiProductDraftBatch = vm.runInContext("handleRetryAiProductDraftBatch", sandbox);
const ensureAiBatchTrigger = vm.runInContext("ensureAiBatchTrigger", sandbox);
const processAiBatchQueue = vm.runInContext("processAiBatchQueue", sandbox);
const executeSingleAiProductDraftCore_ = vm.runInContext("executeSingleAiProductDraftCore_", sandbox);

sandbox.AI_BATCH_CONFIG = AI_BATCH_CONFIG;
sandbox.handleCreateAiProductDraftBatch = handleCreateAiProductDraftBatch;
sandbox.handleGetAiProductDraftBatch = handleGetAiProductDraftBatch;
sandbox.handleRetryAiProductDraftBatch = handleRetryAiProductDraftBatch;
sandbox.ensureAiBatchTrigger = ensureAiBatchTrigger;
sandbox.processAiBatchQueue = processAiBatchQueue;
sandbox.executeSingleAiProductDraftCore_ = executeSingleAiProductDraftCore_;

const originalComputeImageFp = sandbox.computeImageFingerprintFromFolderUrl_;
const originalGetLatestProductAiDraft = sandbox.getLatestProductAiDraft_;
const originalComputeConfirmedFp = sandbox.computeConfirmedProductFingerprint_;
const originalGetOrCreateDraftsSheet = sandbox.getOrCreateProductAiDraftsSheet_; // Section 29 で実装へ戻すため退避
const originalVerifyReflection = sandbox.verifyProductDraftReflectionCompleted_;
const originalFindProductRow = vm.runInContext("findProductRow", sandbox);
const originalGetValidatedProductDriveImages = sandbox.getValidatedProductDriveImages_;
const originalComputeProductSourceFp = sandbox.computeProductSourceFingerprint_;
const originalGetOrCreateBatchJobsSheet = sandbox.getOrCreateAiBatchJobsSheet_;
const originalGetOrCreateBatchItemsSheet = sandbox.getOrCreateAiBatchItemsSheet_;

let total = 0;
let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  total++;
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name} - ${detail || ''}`);
  }
}

console.log("=== 包括的ローカル単体テスト開始 (全修正要件網羅) ===");

// --------------------------------------------------
// 1. 生成元指紋と確定指紋の分離 & 確認後変更検知 (全確認対象項目)
// --------------------------------------------------
(() => {
  const baseRow = [
    new Date(), "TMP-TEST-001", "スニーカー", "NIKE", "エアジョーダン1", "目立った傷や汚れなし",
    10000, 25000, "A-1", "説明文\n\n#NIKE #AJ1", "特記事項なし",
    "555088-101", "28.0", "Chicago", "あり", "黒タグ", "2015",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/drive/folders/mock_folder_1", "https://img.com/1.jpg",
    "draft", "in_stock", "active", "item_1", "var_1", "link_1", "https://checkout.com", 1,
    "ai_managed"
  ];

  function createMockSheet(row) {
    return {
      getLastColumn: () => 40,
      getRange: (r, c, numR, numC) => ({
        getValues: () => [row],
        getValue: () => row[c - 1]
      })
    };
  }

  sandbox.getPokemonCardByProductId = () => null;
  sandbox.getProductTranslation = () => ({
    translated_title: "Nike Air Jordan 1",
    translated_description: "English description",
    translated_condition: "Excellent",
    translation_status: "approved"
  });
  sandbox.computeImageFingerprintFromFolderUrl_ = (url) => "img_fp_initial_hash";

  const sheet1 = createMockSheet([...baseRow]);
  const fpOriginal = computeConfirmedProductFingerprint_(sheet1, 2, "TMP-TEST-001");

  // 1) 説明文改ざん
  const rowDescModified = [...baseRow];
  rowDescModified[9] = "説明文がスタッフ確認後に改ざんされた";
  const fpDescMod = computeConfirmedProductFingerprint_(createMockSheet(rowDescModified), 2, "TMP-TEST-001");
  assert("1-1. 確認後説明文変更で指紋が変化する", fpOriginal !== fpDescMod);

  // 2) 価格改ざん
  const rowPriceModified = [...baseRow];
  rowPriceModified[7] = 99999;
  const fpPriceMod = computeConfirmedProductFingerprint_(createMockSheet(rowPriceModified), 2, "TMP-TEST-001");
  assert("1-2. 確認後価格変更で指紋が変化する", fpOriginal !== fpPriceMod);

  // 3) 状態改ざん
  const rowCondModified = [...baseRow];
  rowCondModified[5] = "新品・未使用";
  const fpCondMod = computeConfirmedProductFingerprint_(createMockSheet(rowCondModified), 2, "TMP-TEST-001");
  assert("1-3. 確認後状態変更で指紋が変化する", fpOriginal !== fpCondMod);

  // 4) 英文翻訳改ざん
  sandbox.getProductTranslation = () => ({
    translated_title: "Modified English Title",
    translated_description: "English description",
    translated_condition: "Excellent",
    translation_status: "approved"
  });
  const fpTransMod = computeConfirmedProductFingerprint_(sheet1, 2, "TMP-TEST-001");
  assert("1-4. 確認後英文変更で指紋が変化する", fpOriginal !== fpTransMod);
  sandbox.getProductTranslation = () => ({
    translated_title: "Nike Air Jordan 1",
    translated_description: "English description",
    translated_condition: "Excellent",
    translation_status: "approved"
  });

  // 5) ポケカ属性変更
  const pokeRow = [...baseRow];
  pokeRow[2] = "pokemon_card";
  sandbox.getPokemonCardByProductId = () => ({ card_name: "ピカチュウ", card_condition: "NM" });
  const fpPoke1 = computeConfirmedProductFingerprint_(createMockSheet(pokeRow), 2, "TMP-TEST-001");
  sandbox.getPokemonCardByProductId = () => ({ card_name: "リザードン", card_condition: "NM" });
  const fpPoke2 = computeConfirmedProductFingerprint_(createMockSheet(pokeRow), 2, "TMP-TEST-001");
  assert("1-5. ポケカ属性変更で指紋が変化する", fpPoke1 !== fpPoke2);
  sandbox.getPokemonCardByProductId = () => null;

  // 6) 画像差し替え
  sandbox.computeImageFingerprintFromFolderUrl_ = (url) => "img_fp_changed_hash";
  const fpImgMod = computeConfirmedProductFingerprint_(sheet1, 2, "TMP-TEST-001");
  assert("1-6. 確認後画像変更で指紋が変化する", fpOriginal !== fpImgMod);
  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
})();

// --------------------------------------------------
// 2. 排他ロック & Superseded Release Protection テスト
// --------------------------------------------------
(() => {
  const pid = "TEST-LOCK-001";
  releaseAiDraftExecutionLock_(pid);

  const exec1 = acquireAiDraftExecutionLock_(pid);
  assert("2-1. 実行IDロックが取得できる", typeof exec1 === "string" && exec1.startsWith("EXEC_"));

  let doubleAcquireBlocked = false;
  try {
    acquireAiDraftExecutionLock_(pid);
  } catch (err) {
    if (err.message.indexOf("already in progress") !== -1) doubleAcquireBlocked = true;
  }
  assert("2-2. 実行中の同一商品への二重実行は拒絶される", doubleAcquireBlocked);

  // Superseded Lock Release Protection
  mockScriptProperties["AI_GEN_LOCK_" + pid] = JSON.stringify({
    execution_id: "EXEC_NEW_SUPERSEDED",
    started_at: Date.now()
  });

  releaseAiDraftExecutionLock_(pid, exec1);
  const stillActive = verifyAiDraftExecutionLock_(pid, "EXEC_NEW_SUPERSEDED");
  assert("2-3. 古い実行IDのfinallyが新実行IDを消さない (Superseded Release Protection)", stillActive === true);

  releaseAiDraftExecutionLock_(pid, "EXEC_NEW_SUPERSEDED");
  assert("2-4. 新実行IDでの解放は正常に削除される", !verifyAiDraftExecutionLock_(pid, "EXEC_NEW_SUPERSEDED"));
})();

// --------------------------------------------------
// 3. Drive画像バリデーション
// --------------------------------------------------
(() => {
  const dummyBlob = { getBytes: () => [1, 2, 3] };

  // 1) 0枚拒否
  let zeroBlocked = false;
  try {
    validateDriveImagesData_([], "TMP-001");
  } catch (err) {
    if (err.error_code === "NO_IMAGES_FOUND") zeroBlocked = true;
  }
  assert("3-1. 画像0枚を拒絶する (NO_IMAGES_FOUND)", zeroBlocked);

  // 2) 4枚（上限超）拒否
  const fourImages = [
    { name: "1.jpg", mimeType: "image/jpeg", size: 100, getBlob: () => dummyBlob },
    { name: "2.jpg", mimeType: "image/jpeg", size: 100, getBlob: () => dummyBlob },
    { name: "3.jpg", mimeType: "image/jpeg", size: 100, getBlob: () => dummyBlob },
    { name: "4.jpg", mimeType: "image/jpeg", size: 100, getBlob: () => dummyBlob }
  ];
  let maxBlocked = false;
  try {
    validateDriveImagesData_(fourImages, "TMP-001");
  } catch (err) {
    if (err.error_code === "IMAGE_COUNT_EXCEEDED") maxBlocked = true;
  }
  assert("3-2. 画像4枚 (上限3枚超過) を拒絶する (IMAGE_COUNT_EXCEEDED)", maxBlocked);

  // 3) 不正MIME (PDF等) 拒否
  const pdfImage = [
    { name: "doc.pdf", mimeType: "application/pdf", size: 500, getBlob: () => dummyBlob }
  ];
  let mimeBlocked = false;
  try {
    validateDriveImagesData_(pdfImage, "TMP-001");
  } catch (err) {
    if (err.error_code === "UNSUPPORTED_MIME_TYPE") mimeBlocked = true;
  }
  assert("3-3. 不正MIMEタイプ (PDF) を拒絶する (UNSUPPORTED_MIME_TYPE)", mimeBlocked);

  // 4) 容量超過 (10MB超) 拒否
  const hugeImage = [
    { name: "huge.jpg", mimeType: "image/jpeg", size: 11 * 1024 * 1024, getBlob: () => dummyBlob }
  ];
  let sizeBlocked = false;
  try {
    validateDriveImagesData_(hugeImage, "TMP-001");
  } catch (err) {
    if (err.error_code === "IMAGE_SIZE_EXCEEDED") sizeBlocked = true;
  }
  assert("3-4. 容量超過 (10MB超) を拒絶する (IMAGE_SIZE_EXCEEDED)", sizeBlocked);

  // 5) 正常2枚画像
  const validImages = [
    { name: "1.jpg", mimeType: "image/jpeg", size: 500000, getBlob: () => dummyBlob },
    { name: "2.png", mimeType: "image/png", size: 300000, getBlob: () => dummyBlob }
  ];
  const validRes = validateDriveImagesData_(validImages, "TMP-001");
  assert("3-5. 正常な画像 (2枚, JPEG/PNG) は通過する", validRes.images.length === 2);
})();

// --------------------------------------------------
// 4. 指示1 (改訂版): 真贋保証表現の自動除去 & 生成継続 (PROHIBITED_WORDS_DETECTEDで止めない)
// --------------------------------------------------
(() => {
  // 4-1. 100% Authentic 等の保証主張は除去しつつ、Vans Authentic 44 DX 等の正式商品名は保持する
  const authRes = validateAndSanitizeDraftCandidate_({
    title_ja: "Vans Authentic 44 DX 確実正規品",
    description_ja: "Vans Authentic 44 DX です。真贋鑑定済み・本物保証いたします。",
    title_en: "100% Authentic Vans Authentic 44 DX",
    description_en: "Vans Authentic 44 DX. Guaranteed authentic pair.",
    condition: "目立った傷や汚れなし"
  });
  assert(
    "4-1. 保証・鑑定主張を自動除去しつつ正式商品名 'Vans Authentic 44 DX' を保持する",
    authRes.title_ja === "Vans Authentic 44 DX" &&
    authRes.title_en === "Vans Authentic 44 DX" &&
    authRes.description_ja.indexOf("Vans Authentic 44 DX") !== -1 &&
    authRes.description_ja.indexOf("本物保証") === -1 &&
    authRes.description_en.indexOf("Vans Authentic 44 DX") !== -1 &&
    !/guaranteed\s+authentic/i.test(authRes.description_en)
  );

  // 4-2. 確実正規品 / 本物保証 の文が除去され有用な説明文が残る
  const guaranteeRes = validateAndSanitizeDraftCandidate_({
    title_ja: "ナイキ エアジョーダン 1 確実正規品",
    description_ja: "本物保証いたします。数回着用の美品です。",
    title_en: "Nike Shoes",
    description_en: "Normal desc",
    condition: "目立った傷や汚れなし"
  });
  assert(
    "4-2. '確実正規品'/'本物保証' を自動除去し残りのタイトル・説明文を保存する",
    guaranteeRes.title_ja === "ナイキ エアジョーダン 1" &&
    guaranteeRes.description_ja.indexOf("本物保証") === -1 &&
    guaranteeRes.description_ja.indexOf("数回着用の美品です") !== -1
  );

  // 4-3. 100% Original / PSA10・正式名称の保護・クリーニング済み定型句の除去
  const origRes = validateAndSanitizeDraftCandidate_({
    title_ja: "ポケモンカード ナンジャモ SAR [PSA10] 鑑定品 本物保証",
    description_ja: "PSA10鑑定品です。クリーニング済みです。状態良好なカードです。",
    title_en: "Pokemon Card Iono SAR [PSA10]",
    description_en: "100% original vintage card. Great condition.",
    condition: "A",
    category: "pokemon_card",
    grade: "PSA10"
  });
  assert(
    "4-3. '100% original'/'本物保証'/'クリーニング済み' を除去しつつ正式名称・[PSA10]を保持する",
    origRes.title_ja.indexOf("[PSA10]") !== -1 &&
    origRes.title_ja.indexOf("本物保証") === -1 &&
    origRes.description_ja.indexOf("クリーニング済み") === -1 &&
    origRes.description_en.toLowerCase().indexOf("100% original") === -1 &&
    origRes.description_en.indexOf("Great condition") !== -1
  );

  // 禁止語なしの正常候補: candidate_price は常に null に強制される
  const cleanCand = {
    title_ja: "ナイキ エアジョーダン 1 ハイ OG シカゴ",
    hashtags_ja: "#NIKE #AirJordan1",
    description_ja: "2015年発売の人気モデル。数回着用のみで状態良好です。",
    title_en: "Nike Air Jordan 1 High OG Chicago",
    description_en: "Pre-owned in excellent condition with original box.",
    condition: "目立った傷や汚れなし",
    price: 35000 // LLMからの価格提案
  };
  const cleanResult = validateAndSanitizeDraftCandidate_(cleanCand);
  assert("4-4. 正常候補は通過し、正の安全な整数価格(35000)と固定文言が保持される", cleanResult.price === 35000 && cleanResult.title_ja.indexOf("シカゴ") !== -1 && cleanResult.price_note === "AIによる概算価格です");

  // 4-5. 判断不能時は null と固定文言が返る
  const nullCand = { ...cleanCand, price: null };
  const nullResult = validateAndSanitizeDraftCandidate_(nullCand);
  assert("4-5. 判断不能時は price: null と固定文言が保持される", nullResult.price === null && nullResult.price_note === "AIによる概算価格です");

  // 4-6. 不正値（負数・0・非数値）は安全に null へサニタイズ
  const negResult = validateAndSanitizeDraftCandidate_({ ...cleanCand, price: -5000 });
  const zeroResult = validateAndSanitizeDraftCandidate_({ ...cleanCand, price: 0 });
  const strInvalid = validateAndSanitizeDraftCandidate_({ ...cleanCand, price: "不明" });
  assert("4-6. 不正価格は安全に null へサニタイズされる", negResult.price === null && zeroResult.price === null && strInvalid.price === null);

  // 4-7. 文字列数値 ("28,000円") や小数は安全な整数へ丸め
  const strValid = validateAndSanitizeDraftCandidate_({ ...cleanCand, price: "28,000円" });
  const floatValid = validateAndSanitizeDraftCandidate_({ ...cleanCand, price: 15000.7 });
  assert("4-7. カンマ付き文字列や小数は安全な整数へ変換される", strValid.price === 28000 && floatValid.price === 15001);
})();

// --------------------------------------------------
// 5. 指示5: 販売開始ゲートの Fail-Closed 判定 & 明確な error_code
// --------------------------------------------------
(() => {
  // 5-1. 通常商品 (AN列空) は通過
  const normalSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({ getValue: () => (c === 40 ? "" : "val") })
  };
  const normalRes = assertProductPublishable_(normalSheet, 2, "NORM-001");
  assert("5-1. 通常商品は無条件通過 (後方互換100%)", normalRes === true);

  // 5-2. AI対象商品でドラフト履歴欠損: error_code = AI_DRAFT_HISTORY_MISSING
  const aiSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({ getValue: () => (c === 40 ? "ai_managed" : "val") })
  };
  sandbox.getLatestProductAiDraft_ = () => null;
  let histMissingCode = "";
  try {
    assertProductPublishable_(aiSheet, 2, "AI-MISSING-001");
  } catch (err) {
    histMissingCode = err.error_code;
  }
  assert("5-2. 履歴欠損時は Fail-Closed (AI_DRAFT_HISTORY_MISSING)", histMissingCode === "AI_DRAFT_HISTORY_MISSING");

  // 5-3. AI対象商品で未確認 (pending_review): error_code = AI_DRAFT_UNCONFIRMED
  sandbox.getLatestProductAiDraft_ = () => ({ review_status: "pending_review" });
  let unconfirmedCode = "";
  try {
    assertProductPublishable_(aiSheet, 2, "AI-UNCONF-001");
  } catch (err) {
    unconfirmedCode = err.error_code;
  }
  assert("5-3. 未確認商品は公開拒否 (AI_DRAFT_UNCONFIRMED)", unconfirmedCode === "AI_DRAFT_UNCONFIRMED");

  // 5-4. AI対象商品で確定指紋未登録: error_code = AI_DRAFT_CONFIRMED_FINGERPRINT_MISSING
  sandbox.getLatestProductAiDraft_ = () => ({ review_status: "confirmed", confirmed_fingerprint: "" });
  let noFpCode = "";
  try {
    assertProductPublishable_(aiSheet, 2, "AI-NOFP-001");
  } catch (err) {
    noFpCode = err.error_code;
  }
  assert("5-4. 確定指紋未登録は拒否 (AI_DRAFT_CONFIRMED_FINGERPRINT_MISSING)", noFpCode === "AI_DRAFT_CONFIRMED_FINGERPRINT_MISSING");

  // 5-5. 確認後に属性が改ざんされた場合: error_code = AI_DRAFT_MODIFIED_AFTER_CONFIRMATION
  sandbox.getLatestProductAiDraft_ = () => ({
    review_status: "confirmed",
    confirmed_fingerprint: "original_hash_value"
  });
  sandbox.computeConfirmedProductFingerprint_ = () => "modified_hash_value";
  let modifiedCode = "";
  try {
    assertProductPublishable_(aiSheet, 2, "AI-MOD-001");
  } catch (err) {
    modifiedCode = err.error_code;
  }
  assert("5-5. 確認後変更検知で拒絶 (AI_DRAFT_MODIFIED_AFTER_CONFIRMATION)", modifiedCode === "AI_DRAFT_MODIFIED_AFTER_CONFIRMATION");
})();

// --------------------------------------------------
// 6. 指示2 & 指示4 & 指示5: 途中失敗シミュレーションと安全な再試行 & 全確認項目の再読取検証 & 他者変更遮断
// --------------------------------------------------
(() => {
  // モックシート状態
  const productRowData = [
    new Date(), "TMP-RETRY-001", "スニーカー", "NIKE", "元の商品名", "目立った傷や汚れなし",
    10000, 20000, "A-1", "元の説明文", "特記事項なし",
    "555088-101", "28.0", "Chicago", "あり", "黒タグ", "2015",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/drive/folders/mock_folder_1", "https://img.com/1.jpg",
    "draft", "in_stock", "active", "item_1", "var_1", "link_1", "https://checkout.com", 1,
    "ai_managed"
  ];

  let currentDraftStatus = "pending_review";
  const mockDraftRecord = {
    row_number: 2,
    draft_id: "DRFT_001",
    product_id: "TMP-RETRY-001",
    draft_version: 1,
    review_status: currentDraftStatus,
    source_fingerprint: "initial_source_fp",
    source_image_fingerprint: "img_fp_valid_123",
    confirmed_fingerprint: "",
    last_confirmation_attempt_id: ""
  };

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: (r, c, numR, numC) => ({
      getValues: () => [productRowData],
      getValue: () => productRowData[c - 1],
      setValue: (val) => { productRowData[c - 1] = val; }
    })
  };

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c, numR, numC) => {
      if (r === 1) {
        return {
          getValues: () => [AI_DRAFT_CONFIG.HEADERS]
        };
      }
      return {
        setValue: (val) => {
          const headerName = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (headerName) mockDraftRecord[headerName] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...mockDraftRecord });
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_valid_123";
  sandbox.computeConfirmedProductFingerprint_ = () => "confirmed_fp_valid_999";
  sandbox.findProductRow = () => 2;

  let translationSaved = null;
  sandbox.saveConfirmedProductTranslation_ = (pid, tData) => {
    translationSaved = tData;
  };
  sandbox.getProductTranslation = () => ({
    product_id: "TMP-RETRY-001",
    translated_title: "Nike Air Jordan 1",
    translated_description: "Confirmed English Description",
    translation_status: "approved"
  });

  const confirmPayload = {
    product_id: "TMP-RETRY-001",
    draft_id: "DRFT_001",
    draft_version: 1,
    staff_id: "staff_aij",
    confirmation_attempt_id: "ATTEMPT_SESSION_001",
    confirmed_data: {
      product_name: "確定済みエアジョーダン1",
      planned_sale_price: 28000,
      condition: "目立った傷や汚れなし",
      description: "確定済み日本語説明文",
      hashtags_ja: "#NIKE #AJ1",
      translated_title: "Nike Air Jordan 1",
      translated_description: "Confirmed English Description",
      category: "スニーカー",
      brand: "NIKE",
      sneaker_sku: "555088-101",
      sneaker_size: "28.0"
    }
  };

  // 1) 途中失敗シミュレーション: 本票更新後に意図的に例外が発生
  // 本票の各項目が確定要求値に書き換わったが、review_status は pending_review のまま
  productRowData[2] = "sneaker";
  productRowData[3] = "NIKE";
  productRowData[4] = "確定済みエアジョーダン1";
  productRowData[5] = "目立った傷や汚れなし";
  productRowData[7] = 28000;
  productRowData[9] = "確定済み日本語説明文\n\n#NIKE #AJ1";
  productRowData[11] = "555088-101";
  productRowData[12] = "28.0";
  mockDraftRecord.review_status = "pending_review";
  mockDraftRecord.last_confirmation_attempt_id = "ATTEMPT_SESSION_001"; // 自身の途中保存attempt_idを記録
  mockDraftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(confirmPayload.confirmed_data); // 自身の要求ハッシュを記録

  // この時点での公開ゲート判定 -> pending_review なので拒否 (Fail-Closed)
  let gateBlockedDuringFailure = false;
  try {
    assertProductPublishable_(mockProductSheet, 2, "TMP-RETRY-001");
  } catch (gateErr) {
    if (gateErr.error_code === "AI_DRAFT_UNCONFIRMED") gateBlockedDuringFailure = true;
  }
  assert("6-1. 途中失敗状態（本票更新後・確認未了）では公開ゲートが確実に拒絶する (Fail-Closed)", gateBlockedDuringFailure);

  // 2) 他スタッフによる競合変更の遮断テスト: attempt_id が異なる（または未指定）場合は拒絶
  const otherStaffPayload = {
    ...confirmPayload,
    confirmation_attempt_id: "ATTEMPT_OTHER_STAFF_999"
  };
  const otherStaffRes = handleConfirmAiProductDraft(mockProductSheet, otherStaffPayload);
  const parsedOther = JSON.parse(otherStaffRes.getContent());
  assert("6-2. 他スタッフによる属性競合変更は遮断される (SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER)", parsedOther.success === false && parsedOther.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 3) 自身の途中保存からの再試行: attempt_id が一致していれば安全に再試行を受け入れる
  const retryResult = handleConfirmAiProductDraft(mockProductSheet, confirmPayload);
  const parsedRetry = JSON.parse(retryResult.getContent());

  assert("6-3. 自身の同一 attempt_id による再試行は成功する", parsedRetry.success === true);
  assert("6-4. 再試行成功後に review_status が 'confirmed' に到達する", mockDraftRecord.review_status === "confirmed");
  assert("6-5. 再読取り検証により本票の全値が確定データと完全一致している", productRowData[4] === "確定済みエアジョーダン1" && productRowData[7] === 28000);

  // 4) 再読取り整合性検証のテスト (保存値と確定値の不一致で拒絶)
  mockDraftRecord.review_status = "pending_review";
  let hasWritten = false;
  const brokenSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => {
        if (!hasWritten) {
          return [[new Date(), "TMP-RETRY-001", "sneaker", "NIKE", "確定済みエアジョーダン1", "目立った傷や汚れなし", 0, 28000, "", "確定済み日本語説明文\n\n#NIKE #AJ1", "", "555088-101", "28.0"]];
        } else {
          // 本票書込み後の再読取り検証時に意図的に価格が書き換わっている状態をシミュレート
          return [[new Date(), "TMP-RETRY-001", "sneaker", "NIKE", "確定済みエアジョーダン1", "目立った傷や汚れなし", 0, 99999, "", "確定済み日本語説明文\n\n#NIKE #AJ1", "", "555088-101", "28.0"]];
        }
      },
      getValue: () => "sneaker",
      setValue: () => {
        hasWritten = true;
      }
    })
  };
  let reReadFailed = false;
  try {
    const resBroken = handleConfirmAiProductDraft(brokenSheet, confirmPayload);
    const parsedBroken = JSON.parse(resBroken.getContent());
    if (parsedBroken.error_code === "RE_READ_VERIFICATION_FAILED") reReadFailed = true;
  } catch (reReadErr) {
    if (reReadErr.error_code === "RE_READ_VERIFICATION_FAILED") reReadFailed = true;
  }
  assert("6-6. 保存値と確定値の不整合検知で confirmed に進ませない (RE_READ_VERIFICATION_FAILED)", reReadFailed);
  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
})();

// --------------------------------------------------
// 7. 指示3: 複数 en 翻訳履歴における最新英文取得とキャッシュクリア
// --------------------------------------------------
(() => {
  const normId = "TMP-TRANS-MULTIPLE-001";

  // product_translations シートに複数の en レコードが存在するモック
  let transSheetRows = [
    [normId, "en", "Old Draft Title", "Old Draft Desc", "Good", "", "", "draft", "2026-09-01T00:00:00Z"],
    [normId, "en", "Old Approved Title", "Old Approved Desc", "Excellent", "", "", "approved", "2026-09-15T00:00:00Z"]
  ];

  const mockTransSheet = {
    getLastRow: () => transSheetRows.length + 1,
    getLastColumn: () => 9,
    getRange: (r, c, numR, numC) => {
      if (r === 1 && numR === 1) {
        return {
          getValues: () => [[
            "product_id", "locale", "translated_title", "translated_description",
            "translated_condition", "translated_box", "translated_accessories",
            "translation_status", "generated_at"
          ]]
        };
      }
      return {
        getValues: () => transSheetRows,
        setValue: (val) => {
          transSheetRows[r - 2][c - 1] = val;
        }
      };
    }
  };

  const mockSpreadsheet = {
    getSheetByName: (name) => (name === "product_translations" ? mockTransSheet : null)
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => mockSpreadsheet
  };

  // キャッシュに古いデータを入れておく
  mockCacheStore["prod_trans_" + normId] = JSON.stringify({
    product_id: normId,
    translated_title: "Stale Cached Title"
  });

  // スタッフによる最新英文の保存実行
  saveConfirmedProductTranslation_(normId, {
    translated_title: "Staff Confirmed Final Title",
    translated_description: "Staff Confirmed Final Description",
    condition: "目立った傷や汚れなし"
  });

  // 1) キャッシュがクリアされているか確認
  assert("7-1. スタッフ確認英文保存時に翻訳キャッシュがクリアされる", mockCacheStore["prod_trans_" + normId] === undefined);

  // 2) getProductTranslation を呼んだとき、最新の approved レコード（Staff Confirmed Final Title）が返るか
  const fetchedTrans = getProductTranslation(normId);
  assert("7-2. 複数のen履歴がある場合でも最新の確認後英文が返る", fetchedTrans !== null && fetchedTrans.translated_title === "Staff Confirmed Final Title" && fetchedTrans.translation_status === "approved");
})();

// --------------------------------------------------
// 8. 優先修正1&2: 管理者認証 verifyAdminAccess_ (Fail-Closed) & 公開APIへの情報非漏洩
// --------------------------------------------------
(() => {
  // 1) ADMIN_API_KEY 未設定時 (Fail-Closed)
  delete mockScriptProperties["ADMIN_API_KEY"];
  assert("8-1. ADMIN_API_KEY未設定時: mode=admin は遮断 (Fail-Closed)", verifyAdminAccess_({ mode: "admin" }) === false);
  assert("8-2. ADMIN_API_KEY未設定時: mode=public は一般公開扱い", verifyAdminAccess_({ mode: "public" }) === false);
  assert("8-3. ADMIN_API_KEY未設定時: mode未指定は一般公開扱い", verifyAdminAccess_({}) === false);

  // 2) ADMIN_API_KEY 取得例外時 (Fail-Closed)
  const mockThrowingProps = {
    getProperty: () => { throw new Error("storage failure"); }
  };
  assert("8-4. ADMIN_API_KEY取得例外時: Fail-Closed で遮断", verifyAdminAccess_({ mode: "admin", admin_key: "secret" }, mockThrowingProps) === false);

  // 3) ADMIN_API_KEY 設定時 (厳格検証)
  mockScriptProperties["ADMIN_API_KEY"] = "super_secret_token_xyz";
  assert("8-5. ADMIN_API_KEY設定時: mode=admin のみ (トークンなし) は拒否", verifyAdminAccess_({ mode: "admin" }) === false);
  assert("8-6. ADMIN_API_KEY設定時: 誤った admin_key は拒否", verifyAdminAccess_({ mode: "admin", admin_key: "wrong_key" }) === false);
  assert("8-7. ADMIN_API_KEY設定時: 正しい admin_key は承認", verifyAdminAccess_({ mode: "admin", admin_key: "super_secret_token_xyz" }) === true);
  assert("8-8. ADMIN_API_KEY設定時: token パラメータでの提供も承認", verifyAdminAccess_({ mode: "admin", token: "super_secret_token_xyz" }) === true);
  delete mockScriptProperties["ADMIN_API_KEY"];

  // 4) buildProductDetail による公開APIへの情報漏洩防止
  const sampleRow = [
    new Date(), "TMP-DETAIL-001", "スニーカー", "NIKE", "テストスニーカー", "目立った傷や汚れなし",
    10000, 20000, "A-1", "説明文", "特記事項",
    "555088-101", "28.0", "Chicago", "あり", "黒タグ", "2015",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/drive/folders/mock_folder_1", "https://img.com/1.jpg",
    "draft", "in_stock", "active", "item_1", "var_1", "link_1", "https://checkout.com", 1,
    "ai_managed" // 40列目
  ];

  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_SECRET_001",
    review_status: "confirmed",
    candidate_price: null,
    confirmed_by: "staff_secret"
  });

  // 管理者認証あり (isAdmin = true, hasAdminAuth = true) の場合
  const adminDetail = buildProductDetail(sampleRow, true, true);
  assert("8-9. 管理者認証ありでは ai_draft_flag と latest_ai_draft が返る", adminDetail.ai_draft_flag === "ai_managed" && adminDetail.latest_ai_draft !== undefined);

  // キー未認証の管理者モード (isAdmin = true, hasAdminAuth = false) の場合: 要件1の検証
  const adminDetailNoAuth = buildProductDetail(sampleRow, true, false);
  assert("8-9b. キー未認証の管理者モードでは latest_ai_draft が返らない (要件1)", adminDetailNoAuth.latest_ai_draft === undefined && adminDetailNoAuth.ai_draft_flag === undefined);

  // 一般公開 (isAdmin = false) の場合
  const publicDetail = buildProductDetail(sampleRow, false);
  assert("8-10. 一般公開モードでは ai_draft_flag が含まれない (情報漏洩防止)", publicDetail.ai_draft_flag === undefined);
  assert("8-11. 一般公開モードでは ai_review_status が含まれない (情報漏洩防止)", publicDetail.ai_review_status === undefined);
  assert("8-12. 一般公開モードでは latest_ai_draft が含まれない (情報漏洩防止)", publicDetail.latest_ai_draft === undefined);
})();

// --------------------------------------------------
// 9. 優先修正4: 同一確認要求の再送（冪等性）ハンドリング
// --------------------------------------------------
(() => {
  const confirmedDraftRecord = {
    row_number: 2,
    draft_id: "DRFT_IDEM_001",
    product_id: "TMP-IDEM-001",
    draft_version: 1,
    review_status: "confirmed",
    confirmed_fingerprint: "idem_confirmed_hash_123",
    last_confirmation_attempt_id: "ATTEMPT_IDEM_001"
  };

  const idemConfirmedData = {
    product_name: "確定スニーカー",
    planned_sale_price: 20000,
    condition: "目立った傷や汚れなし",
    translated_title: "Confirmed Sneaker",
    translated_description: "Description"
  };
  confirmedDraftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(idemConfirmedData);

  const mockSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [[
        new Date(), "TMP-IDEM-001", "sneaker", "NIKE", "確定スニーカー", "目立った傷や汚れなし",
        10000, 20000, "A-1", "説明文", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };

  sandbox.getLatestProductAiDraft_ = () => ({ ...confirmedDraftRecord });
  sandbox.computeConfirmedProductFingerprint_ = () => "idem_confirmed_hash_123";
  sandbox.findProductRow = () => 2;

  const res = handleConfirmAiProductDraft(mockSheet, {
    product_id: "TMP-IDEM-001",
    draft_id: "DRFT_IDEM_001",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_IDEM_001",
    confirmed_data: idemConfirmedData
  });

  const parsed = JSON.parse(res.getContent());
  assert("9-1. 同一確認要求の再送時に成功かつ is_idempotent_replay: true が返る", parsed.success === true && parsed.is_idempotent_replay === true);
})();

// --------------------------------------------------
// 10. 優先修正8: 解析対象画像の選択（最大3枚）とbackend検証
// --------------------------------------------------
(() => {
  const mockFolder = {
    getFiles: () => {
      let idx = 0;
      const files = [
        { getId: () => "img_001", getName: () => "01_main.jpg", getMimeType: () => "image/jpeg", getSize: () => 1000, getBlob: () => ({ getBytes: () => [1,2,3] }) },
        { getId: () => "img_002", getName: () => "02_side.jpg", getMimeType: () => "image/jpeg", getSize: () => 1000, getBlob: () => ({ getBytes: () => [1,2,3] }) },
        { getId: () => "img_003", getName: () => "03_box.jpg", getMimeType: () => "image/jpeg", getSize: () => 1000, getBlob: () => ({ getBytes: () => [1,2,3] }) },
        { getId: () => "img_004", getName: () => "04_tag.jpg", getMimeType: () => "image/jpeg", getSize: () => 1000, getBlob: () => ({ getBytes: () => [1,2,3] }) }
      ];
      return {
        hasNext: () => idx < files.length,
        next: () => files[idx++]
      };
    }
  };

  sandbox.DriveApp.getFolderById = () => mockFolder;
  const getValidatedProductDriveImages_ = vm.runInContext("getValidatedProductDriveImages_", sandbox);

  // 10-1: 存在する画像IDを2枚指定して選択
  const resValid = getValidatedProductDriveImages_("TMP-001", "https://drive.google.com/drive/folders/f1", ["img_002", "img_004"]);
  assert("10-1. 存在する画像IDを2枚選択して取得できる", resValid.images.length === 2 && resValid.imageIds[0] === "img_002" && resValid.imageIds[1] === "img_004");

  // 10-2: フォルダに存在しない画像IDを指定した場合は拒絶
  let invalidSelectionBlocked = false;
  try {
    getValidatedProductDriveImages_("TMP-001", "https://drive.google.com/drive/folders/f1", ["img_UNKNOWN_999"]);
  } catch (err) {
    if (err.error_code === "INVALID_IMAGE_SELECTION") invalidSelectionBlocked = true;
  }
  assert("10-2. フォルダに存在しない画像ID指定は INVALID_IMAGE_SELECTION で拒絶", invalidSelectionBlocked);

  // 10-3: 4枚選択（上限3枚超過）は拒絶
  let countExceeded = false;
  try {
    getValidatedProductDriveImages_("TMP-001", "https://drive.google.com/drive/folders/f1", ["img_001", "img_002", "img_003", "img_004"]);
  } catch (err) {
    if (err.error_code === "IMAGE_COUNT_EXCEEDED") countExceeded = true;
  }
  assert("10-3. 選択画像が4枚以上の場合 IMAGE_COUNT_EXCEEDED で拒絶", countExceeded);
})();

// --------------------------------------------------
// 11. 優先修正3: 取得例外・欠損時の Fail-Closed 検証 (read_error握り潰し廃止)
// --------------------------------------------------
(() => {
  // 11-1: Drive取得失敗時は例外スロー
  let driveFailClosed = false;
  sandbox.computeImageFingerprintFromFolderUrl_ = vm.runInContext("computeImageFingerprintFromFolderUrl_", sandbox);
  sandbox.getProductTranslation = () => ({ translation_status: "approved" });
  sandbox.DriveApp.getFolderById = () => { throw new Error("Permission Denied"); };
  const driveFailRow = new Array(40).fill("");
  driveFailRow[29] = "https://drive.google.com/drive/folders/folder_err_123";
  try {
    computeConfirmedProductFingerprint_({
      getLastColumn: () => 40,
      getRange: () => ({ getValues: () => [driveFailRow] })
    }, 2, "TMP-DRIVE-FAIL");
  } catch (err) {
    if (err.error_code === "DRIVE_FOLDER_ACCESS_FAILED") driveFailClosed = true;
  }
  assert("11-1. Driveフォルダ取得失敗時は Fail-Closed (DRIVE_FOLDER_ACCESS_FAILED)", driveFailClosed);

  // 11-2: 英文取得失敗時は例外スロー
  sandbox.DriveApp.getFolderById = () => ({ getFiles: () => ({ hasNext: () => false }) });
  sandbox.getProductTranslation = () => { throw new Error("Translation Sheet Error"); };
  let transFailClosed = false;
  try {
    computeConfirmedProductFingerprint_({
      getLastColumn: () => 40,
      getRange: () => ({ getValues: () => [new Array(40).fill("")] })
    }, 2, "TMP-TRANS-FAIL");
  } catch (err) {
    if (err.error_code === "TRANSLATION_READ_FAILED") transFailClosed = true;
  }
  assert("11-2. 英文翻訳取得失敗時は Fail-Closed (TRANSLATION_READ_FAILED)", transFailClosed);

  // 11-3: ポケカ情報取得失敗時は例外スロー
  sandbox.getProductTranslation = () => ({ translation_status: "approved" });
  sandbox.getPokemonCardByProductId = () => { throw new Error("Pokemon Sheet Error"); };
  let pokeFailClosed = false;
  const pokeRow = new Array(40).fill("");
  pokeRow[2] = "pokemon_card";
  try {
    computeConfirmedProductFingerprint_({
      getLastColumn: () => 40,
      getRange: () => ({ getValues: () => [pokeRow] })
    }, 2, "TMP-POKE-FAIL");
  } catch (err) {
    if (err.error_code === "POKEMON_CARD_READ_FAILED") pokeFailClosed = true;
  }
  assert("11-3. ポケカ情報取得失敗時は Fail-Closed (POKEMON_CARD_READ_FAILED)", pokeFailClosed);
})();

// --------------------------------------------------
// 12. 優先修正7: 確定バリデーション (condition, category, size)
// --------------------------------------------------
(() => {
  const dummySheet = {
    getLastColumn: () => 40,
    getRange: () => ({ getValues: () => [new Array(40).fill("")] })
  };

  // 12-1: 不正 condition 拒絶
  const resBadCond = handleConfirmAiProductDraft(dummySheet, {
    product_id: "TMP-V-001",
    draft_id: "D1",
    draft_version: 1,
    confirmed_data: {
      product_name: "Name",
      planned_sale_price: 1000,
      condition: "超美品", // 不正
      translated_title: "Title",
      translated_description: "Desc"
    }
  });
  const parsedBadCond = JSON.parse(resBadCond.getContent());
  assert("12-1. 不正 condition 値は INVALID_CONDITION_VALUE で拒絶", parsedBadCond.error_code === "INVALID_CONDITION_VALUE");

  // 12-2: 不正 category 拒絶
  const resBadCat = handleConfirmAiProductDraft(dummySheet, {
    product_id: "TMP-V-001",
    draft_id: "D1",
    draft_version: 1,
    confirmed_data: {
      product_name: "Name",
      planned_sale_price: 1000,
      condition: "新品・未使用",
      category: "unsupported_jewelry", // 不正
      translated_title: "Title",
      translated_description: "Desc"
    }
  });
  const parsedBadCat = JSON.parse(resBadCat.getContent());
  assert("12-2. 不正 category 値は INVALID_CATEGORY_VALUE で拒絶", parsedBadCat.error_code === "INVALID_CATEGORY_VALUE");

  // 12-3: スニーカーで size 未指定でも confirm_ai_product_draft のバリデーションは通過 (SNEAKER_SIZE_REQUIRED なし)
  const resEmptySize = handleConfirmAiProductDraft(dummySheet, {
    product_id: "TMP-V-001",
    draft_id: "D1",
    draft_version: 1,
    confirmed_data: {
      product_name: "Name",
      planned_sale_price: 1000,
      condition: "新品・未使用",
      category: "sneaker",
      sneaker_size: "", // 空
      translated_title: "Title",
      translated_description: "Desc"
    }
  });
  const parsedEmptySize = JSON.parse(resEmptySize.getContent());
  assert("12-3. confirm_ai_product_draft ではスニーカーのサイズ空欄が許可される (SNEAKER_SIZE_REQUIREDなし)", parsedEmptySize.error_code !== "SNEAKER_SIZE_REQUIRED");

  // 12-4: 公開ゲート (assertProductPublishable_) ではスニーカーのサイズ未指定が SNEAKER_SIZE_REQUIRED で拒絶
  let gateBlockedOnSize = false;
  try {
    assertProductPublishable_({
      getLastColumn: () => 40,
      getRange: (r, c) => ({
        getValue: () => (c === 3 ? "sneaker" : (c === 13 ? "" : (c === 40 ? "" : "val")))
      })
    }, 2, "TMP-SNEAKER-NOSIZE");
  } catch (err) {
    if (err.error_code === "SNEAKER_SIZE_REQUIRED") gateBlockedOnSize = true;
  }
  assert("12-4. 公開ゲートではスニーカーのサイズ未指定が SNEAKER_SIZE_REQUIRED で拒絶される", gateBlockedOnSize);

  // 12-5: サイズ入力済みのスニーカーは公開ゲートのサイズ検証を通過
  const sizeAllowed = assertProductPublishable_({
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValue: () => (c === 3 ? "sneaker" : (c === 13 ? "27.5cm" : (c === 40 ? "" : "val")))
    })
  }, 2, "TMP-SNEAKER-WITHSIZE");
  assert("12-5. サイズ入力済みのスニーカーは公開ゲートのサイズ検証を通過する", sizeAllowed === true);
})();

// --------------------------------------------------
// 13. 指摘1回帰テスト: attempt ID または要求内容が異なる場合の再送拒絶
// --------------------------------------------------
(() => {
  const confirmedDraftRecord = {
    row_number: 2,
    draft_id: "DRFT_REGR_001",
    draft_version: 1,
    review_status: "confirmed",
    confirmed_fingerprint: "confirmed_regr_hash_123",
    last_confirmation_attempt_id: "ATTEMPT_REGR_001"
  };

  const baseConfirmedData = {
    product_name: "エアフォース1",
    planned_sale_price: 15000,
    condition: "新品・未使用",
    translated_title: "Air Force 1",
    translated_description: "Classic sneaker",
    category: "sneaker"
  };
  confirmedDraftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(baseConfirmedData);

  const mockSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [[
        new Date(), "TMP-REGR-001", "sneaker", "NIKE", "エアフォース1", "新品・未使用",
        10000, 15000, "A-1", "説明文", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };

  sandbox.getLatestProductAiDraft_ = () => ({ ...confirmedDraftRecord });
  sandbox.computeConfirmedProductFingerprint_ = () => "confirmed_regr_hash_123";
  sandbox.findProductRow = () => 2;

  // 13-1: attempt ID が異なる場合は拒絶
  const resDiffAttempt = handleConfirmAiProductDraft(mockSheet, {
    product_id: "TMP-REGR-001",
    draft_id: "DRFT_REGR_001",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_DIFFERENT_999",
    confirmed_data: baseConfirmedData
  });
  const parsedDiffAttempt = JSON.parse(resDiffAttempt.getContent());
  assert("13-1. attempt ID が異なる再送要求は拒絶される", parsedDiffAttempt.success === false && parsedDiffAttempt.error_code === "INVALID_IDEMPOTENT_REPLAY_ATTEMPT");

  // 13-2: 要求内容 (価格) が異なる場合は拒絶
  const resDiffPrice = handleConfirmAiProductDraft(mockSheet, {
    product_id: "TMP-REGR-001",
    draft_id: "DRFT_REGR_001",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_REGR_001",
    confirmed_data: {
      ...baseConfirmedData,
      planned_sale_price: 99999
    }
  });
  const parsedDiffPrice = JSON.parse(resDiffPrice.getContent());
  assert("13-2. 要求内容 (価格) が異なる再送要求は拒絶される", parsedDiffPrice.success === false && parsedDiffPrice.error_code === "DRAFT_ALREADY_CONFIRMED_WITH_DIFFERENT_DATA");

  // 13-3: 要求内容 (商品名) が異なる場合は拒絶
  const resDiffName = handleConfirmAiProductDraft(mockSheet, {
    product_id: "TMP-REGR-001",
    draft_id: "DRFT_REGR_001",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_REGR_001",
    confirmed_data: {
      ...baseConfirmedData,
      product_name: "全然違う商品名"
    }
  });
  const parsedDiffName = JSON.parse(resDiffName.getContent());
  assert("13-3. 要求内容 (商品名) が異なる再送要求は拒絶される", parsedDiffName.success === false && parsedDiffName.error_code === "DRAFT_ALREADY_CONFIRMED_WITH_DIFFERENT_DATA");
})();

// --------------------------------------------------
// 14. 指摘2回帰テスト: releaseAiDraftExecutionLock_ の読取・ID照合・削除のScriptLock保護と競合安全性
// --------------------------------------------------
(() => {
  const pid = "TEST-LOCK-R2";
  mockScriptProperties = {};

  // プロセスAがロックを取得
  const execA = acquireAiDraftExecutionLock_(pid);

  // プロセスBが新ロックを取得 (タイムアウト等で新実行が発行された状況をシミュレート)
  const execB = "EXEC_" + pid + "_NEW_PROCESS_B";
  mockScriptProperties["AI_GEN_LOCK_" + pid] = JSON.stringify({
    execution_id: execB,
    started_at: Date.now()
  });

  // プロセスAが通信失敗等の finally で古い execA を解放しようとする
  releaseAiDraftExecutionLock_(pid, execA);

  // プロセスBのロックが保持されていることを検証
  const currentLock = JSON.parse(mockScriptProperties["AI_GEN_LOCK_" + pid] || "{}");
  assert("14-1. 古い実行IDの解放処理が新実行IDのロックを誤って消さない", currentLock.execution_id === execB);

  // プロセスBの正しい execution_id で解放すると削除される
  releaseAiDraftExecutionLock_(pid, execB);
  assert("14-2. 正しい実行IDでの解放処理は正常に削除される", mockScriptProperties["AI_GEN_LOCK_" + pid] === undefined);
})();

// --------------------------------------------------
// 15. 指摘3回帰テスト: 生成元指紋不一致時、同一 attempt ID でも本票値が不整合なら拒絶
// --------------------------------------------------
(() => {
  const testPid = "TMP-ATTR-REGR-001";
  const validData = {
    product_name: "確認用スニーカー",
    planned_sale_price: 30000,
    condition: "目立った傷や汚れなし",
    translated_title: "Title",
    translated_description: "Desc",
    category: "sneaker"
  };

  const draftRec = {
    row_number: 2,
    draft_id: "DRFT_A01",
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "original_fp_old",
    source_image_fingerprint: "img_fp_same",
    last_confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    last_confirmation_payload_hash: computeConfirmationPayloadHash_(validData)
  };

  sandbox.getLatestProductAiDraft_ = () => ({ ...draftRec });
  sandbox.computeProductSourceFingerprint_ = () => "modified_fp_by_someone";
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_same";
  sandbox.findProductRow = () => 2;

  // 他スタッフが価格を 99999 に変更していた本票
  const sheetModifiedPrice = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [[
        new Date(), testPid, "sneaker", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 99999, "", "説明", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };

  const resModPrice = handleConfirmAiProductDraft(sheetModifiedPrice, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: validData
  });
  const parsedModPrice = JSON.parse(resModPrice.getContent());
  assert("15-1. 同一 attempt ID でも本票の価格が書き換えられていたら遮断される", parsedModPrice.success === false && parsedModPrice.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 同一 attempt ID だが要求内容のハッシュが異なっていた場合
  const sheetValidState = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [[
        new Date(), testPid, "sneaker", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "説明", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };

  const resDiffPayload = handleConfirmAiProductDraft(sheetValidState, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: {
      ...validData,
      product_name: "改ざんされた商品名"
    }
  });
  const parsedDiffPayload = JSON.parse(resDiffPayload.getContent());
  assert("15-2. 同一 attempt ID でも要求内容が改変されていたら遮断される", parsedDiffPayload.success === false && parsedDiffPayload.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 15-3: 別スタッフが説明文を変更した場合
  const sheetModDesc = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [[
        new Date(), testPid, "sneaker", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "別スタッフが書き換えた説明文", "", "SKU-TEST", "27.5", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };
  const resModDesc = handleConfirmAiProductDraft(sheetModDesc, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: validData
  });
  const parsedModDesc = JSON.parse(resModDesc.getContent());
  assert("15-3. 同一 attempt ID でも本票の説明文が別スタッフに変更されていたら遮断される", parsedModDesc.success === false && parsedModDesc.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 15-4: 別スタッフがカテゴリを変更した場合
  const sheetModCat = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [[
        new Date(), testPid, "apparel", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "説明", "", "SKU-TEST", "27.5", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };
  const resModCat = handleConfirmAiProductDraft(sheetModCat, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: validData
  });
  const parsedModCat = JSON.parse(resModCat.getContent());
  assert("15-4. 同一 attempt ID でも本票のカテゴリが別スタッフに変更されていたら遮断される", parsedModCat.success === false && parsedModCat.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 15-5: 別スタッフがSKUを変更した場合
  const sheetModSku = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [[
        new Date(), testPid, "sneaker", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "説明", "", "DIFFERENT-SKU", "27.5", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };
  const resModSku = handleConfirmAiProductDraft(sheetModSku, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: { ...validData, sneaker_sku: "SKU-TEST" }
  });
  const parsedModSku = JSON.parse(resModSku.getContent());
  assert("15-5. 同一 attempt ID でも本票のSKUが別スタッフに変更されていたら遮断される", parsedModSku.success === false && parsedModSku.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 15-6: 別スタッフがサイズを変更した場合
  const sheetModSize = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [[
        new Date(), testPid, "sneaker", "NIKE", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "説明", "", "SKU-TEST", "29.0", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };
  const resModSize = handleConfirmAiProductDraft(sheetModSize, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: { ...validData, sneaker_size: "27.5" }
  });
  const parsedModSize = JSON.parse(resModSize.getContent());
  assert("15-6. 同一 attempt ID でも本票のサイズが別スタッフに変更されていたら遮断される", parsedModSize.success === false && parsedModSize.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 15-7: 別スタッフがポケカ属性を変更した場合
  sandbox.getPokemonCardByProductId = () => ({
    card_name: "ミュウツー（別スタッフ更新）",
    set_name: "Base Set",
    card_number: "001",
    rarity: "★",
    card_condition: "NM"
  });
  const sheetPokeState = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [[
        new Date(), testPid, "pokemon_card", "Pokemon", "確認用スニーカー", "目立った傷や汚れなし",
        0, 30000, "", "説明", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
      ]],
      getValue: () => "draft"
    })
  };
  const resModPoke = handleConfirmAiProductDraft(sheetPokeState, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: {
      ...validData,
      category: "pokemon_card",
      pokemon_card: {
        card_name: "リザードン",
        set_name: "Base Set",
        card_number: "001",
        rarity: "★",
        card_condition: "NM"
      }
    }
  });
  const parsedModPoke = JSON.parse(resModPoke.getContent());
  assert("15-7. 同一 attempt ID でもポケカ属性が別スタッフに変更されていたら遮断される", parsedModPoke.success === false && parsedModPoke.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");
  sandbox.getPokemonCardByProductId = () => null;

  // 15-8: 別スタッフが英文翻訳を変更した場合
  sandbox.getProductTranslation = () => ({
    product_id: testPid,
    translated_title: "Other Staff Modified Title",
    translated_description: "English desc",
    translation_status: "approved"
  });
  const resModTrans = handleConfirmAiProductDraft(sheetValidState, {
    product_id: testPid,
    draft_id: "DRFT_A01",
    draft_version: 1,
    staff_id: "staff_1",
    confirmation_attempt_id: "ATTEMPT_SAME_SESSION",
    confirmed_data: validData
  });
  const parsedModTrans = JSON.parse(resModTrans.getContent());
  assert("15-8. 同一 attempt ID でも英文翻訳が別スタッフに変更されていたら遮断される", parsedModTrans.success === false && parsedModTrans.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");
  sandbox.getProductTranslation = () => null;
})();

// --------------------------------------------------
// 16. 指摘4回帰テスト: カテゴリ正規化とポケカ10属性・英文箱付属品
// --------------------------------------------------
(() => {
  // 16-1: カテゴリ正規化
  assert("16-1. カテゴリ 'スニーカー' は正規化値 'sneaker' に変換される", normalizeCategoryValue_("スニーカー") === "sneaker");
  assert("16-2. カテゴリ 'ポケモンカード' は正規化値 'pokemon_card' に変換される", normalizeCategoryValue_("ポケモンカード") === "pokemon_card");
  assert("16-3. カテゴリ 'アパレル' は正規化値 'apparel' に変換される", normalizeCategoryValue_("アパレル") === "apparel");
  assert("16-4. 未許可カテゴリは空文字になる", normalizeCategoryValue_("時計") === "");

  // 16-5: ポケカ全10属性の再読取検証
  sandbox.savePokemonCardByProductId = () => ({ success: true });
  sandbox.getPokemonCardByProductId = () => ({
    product_id: "TMP-POKE-001",
    card_name: "リザードン",
    set_name: "第一弾拡張パック",
    card_number: "006/102",
    rarity: "★",
    language: "Japanese",
    grading_status: "graded",
    grader: "PSA",
    grade: "10",
    certification_number: "12345678",
    card_condition: "Gem Mint"
  });

  const pokeRowData = [
    new Date(), "TMP-POKE-001", "pokemon_card", "Pokemon", "リザードン", "目立った傷や汚れなし",
    0, 500000, "", "説明", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
  ];

  const pokeSheet = {
    getLastColumn: () => 40,
    getRange: (r, c, numR, numC) => ({
      getValues: () => [pokeRowData],
      getValue: () => pokeRowData[c - 1],
      setValue: (val) => { pokeRowData[c - 1] = val; }
    })
  };

  const mockDraftRecord = {
    row_number: 2,
    draft_id: "D_POKE_01",
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "orig_fp",
    last_confirmation_attempt_id: "ATTEMPT_POKE_001"
  };

  const pokeDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c, numR, numC) => {
      if (r === 1) {
        return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      }
      return {
        setValue: (val) => {
          const headerName = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (headerName) mockDraftRecord[headerName] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => pokeDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...mockDraftRecord });
  sandbox.computeProductSourceFingerprint_ = () => "orig_fp";
  sandbox.computeConfirmedProductFingerprint_ = () => "confirmed_fp_poke";
  sandbox.getProductTranslation = (pid) => ({
    product_id: pid,
    translated_title: "Charizard",
    translated_description: "Charizard 1st Edition PSA 10",
    translated_condition: "Excellent",
    translation_status: "approved"
  });

  const pokePayload = {
    product_id: "TMP-POKE-001",
    draft_id: "D_POKE_01",
    draft_version: 1,
    staff_id: "staff_poke",
    confirmation_attempt_id: "ATTEMPT_POKE_001",
    confirmed_data: {
      product_name: "リザードン",
      planned_sale_price: 500000,
      condition: "目立った傷や汚れなし",
      category: "pokemon_card",
      translated_title: "Charizard",
      translated_description: "Charizard 1st Edition PSA 10",
      pokemon_card: {
        card_name: "リザードン",
        set_name: "第一弾拡張パック",
        card_number: "006/102",
        rarity: "★",
        language: "Japanese",
        grading_status: "graded",
        grader: "PSA",
        grade: "10",
        certification_number: "12345678",
        card_condition: "Gem Mint"
      }
    }
  };

  const pokeConfirmRes = handleConfirmAiProductDraft(pokeSheet, pokePayload);
  const parsedPokeConfirm = JSON.parse(pokeConfirmRes.getContent());
  assert("16-5. ポケカ全10属性の再読取り検証が正常に通過する", parsedPokeConfirm.success === true);

  // 16-6: 英文の箱・付属品の保持テスト
  let savedTransRecord = null;
  sandbox.saveProductTranslation = (pid, recordMap) => {
    savedTransRecord = recordMap;
  };
  sandbox.getProductTranslation = (pid) => ({
    product_id: pid,
    translated_title: "Prev Title",
    translated_description: "Prev Desc",
    translated_condition: "Like New",
    translated_box: "Preserved Original Box",
    translated_accessories: "Preserved Extra Laces",
    translation_status: "approved"
  });

  saveConfirmedProductTranslation_("TMP-TRANS-BOX-001", {
    translated_title: "New Title",
    translated_description: "New Desc",
    condition: "新品・未使用",
    box: "", // 空文字の場合
    accessories: "" // 空文字の場合
  });

  assert("16-6. 英文保存時に箱・付属品が空の場合は既存値が保持される", savedTransRecord !== null && savedTransRecord.translated_box === "Preserved Original Box" && savedTransRecord.translated_accessories === "Preserved Extra Laces");
})();

// --------------------------------------------------
// 17. 指摘5回帰テスト: 既存doGet全体の認証切り分け（既存管理画面への影響ゼロ）
// --------------------------------------------------
(() => {
  // 1) 既存 doGet で mode=admin (トークンなし) でも商品詳細が取得できること
  const sampleProductRow = [
    new Date(), "TMP-DOGET-001", "sneaker", "NIKE", "管理画面スニーカー", "目立った傷や汚れなし",
    10000, 20000, "A-1", "説明文", "", "SKU1", "28.0", "Col", "あり", "なし", "2020",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, "ai_managed"
  ];

  const mockSpreadsheet = {
    getSheets: () => [{
      getLastRow: () => 2,
      getLastColumn: () => 40,
      getMaxColumns: () => 40,
      getDataRange: () => ({ getValues: () => [sampleProductRow, sampleProductRow] }),
      getRange: (r, c, numR, numC) => ({
        getValues: () => {
          if (c === 2) return [["TMP-DOGET-001"]];
          return [sampleProductRow];
        }
      })
    }]
  };
  sandbox.SpreadsheetApp.getActiveSpreadsheet = () => mockSpreadsheet;
  sandbox.getProductTranslation = () => ({ translated_title: "Title" });

  const doGetFunc = sandbox.doGet;

  // 17-1. 一覧取得 (キーなし mode=admin): 既存互換で商品一覧が返り、latest_ai_draft等は含まれない
  const adminListRes = doGetFunc({
    parameter: {
      mode: "admin"
    }
  });
  const parsedAdminList = JSON.parse(adminListRes.getContent());
  const listHasNoAiDraft = parsedAdminList.products.every(p => p.latest_ai_draft === undefined && p.candidate_title_ja === undefined && p.confirmed_by === undefined);
  assert("17-1. 既存 doGet で mode=admin (キーなし) でも商品一覧が正常に返り、AI詳細は漏洩しない", parsedAdminList.success === true && parsedAdminList.products.length > 0 && listHasNoAiDraft);

  // 17-2. 詳細取得 (キーなし mode=admin): 商品詳細は取得できるが、latest_ai_draft・AI候補・確認者情報は返さない (要件1)
  const adminDetailNoKeyRes = doGetFunc({
    parameter: {
      mode: "admin",
      product_id: "TMP-DOGET-001"
    }
  });
  const parsedDetailNoKey = JSON.parse(adminDetailNoKeyRes.getContent());
  const noKeyProd = parsedDetailNoKey.product;
  const detailNoKeyProtected = (
    noKeyProd !== undefined &&
    noKeyProd.latest_ai_draft === undefined &&
    noKeyProd.candidate_title_ja === undefined &&
    noKeyProd.confirmed_by === undefined &&
    noKeyProd.product_name === "管理画面スニーカー" // 通常の商品情報は正常取得
  );
  assert("17-2. キーなし mode=admin で商品詳細を取得できても latest_ai_draft・AI候補・確認者情報は返さない", parsedDetailNoKey.success === true && detailNoKeyProtected);

  // 17-3. 詳細取得 (正しいキーあり mode=admin): 認証成功により latest_ai_draft が返る
  mockScriptProperties["ADMIN_API_KEY"] = "secret_admin_key_abc";
  const mockAiDraft = {
    draft_id: "D_001",
    review_status: "confirmed",
    candidate_title_ja: "AIタイトル",
    confirmed_by: "staff_01"
  };
  sandbox.getLatestProductAiDraft_ = () => mockAiDraft;

  const adminDetailWithKeyRes = doGetFunc({
    parameter: {
      mode: "admin",
      admin_key: "secret_admin_key_abc",
      product_id: "TMP-DOGET-001"
    }
  });
  const parsedDetailWithKey = JSON.parse(adminDetailWithKeyRes.getContent());
  const withKeyProd = parsedDetailWithKey.product;
  assert("17-3. 正しいキーあり mode=admin では latest_ai_draft と AIフラグが正常に付与される", parsedDetailWithKey.success === true && withKeyProd.latest_ai_draft !== undefined && withKeyProd.latest_ai_draft.candidate_title_ja === "AIタイトル");

  // 17-4. 一般公開詳細 (mode未指定): 公開商品のみ取得でき、AI情報は一切含まれない
  // サンプル行を公開中に設定
  sampleProductRow[31] = "published";
  const publicDetailRes = doGetFunc({
    parameter: {
      product_id: "TMP-DOGET-001"
    }
  });
  sampleProductRow[31] = "draft"; // 戻す
  const parsedPublicDetail = JSON.parse(publicDetailRes.getContent());
  const pubProd = parsedPublicDetail.product;
  assert("17-4. 一般公開詳細では AI情報 (latest_ai_draft, ai_draft_flag等) が一切漏洩しない", parsedPublicDetail.success === true && pubProd.latest_ai_draft === undefined && pubProd.ai_draft_flag === undefined);

  // 17-5. 専用AI取得 (キーなし): UNAUTHORIZED_ADMIN_ACCESS で遮断 (Fail-Closed)
  const aiDraftUnauthorizedRes = doGetFunc({
    parameter: {
      action: "get_ai_product_draft",
      mode: "admin",
      product_id: "TMP-DOGET-001"
    }
  });
  const parsedAiUnauthorized = JSON.parse(aiDraftUnauthorizedRes.getContent());
  assert("17-5. 専用AI取得はキーなし時に UNAUTHORIZED_ADMIN_ACCESS で遮断される", parsedAiUnauthorized.success === false && parsedAiUnauthorized.error_code === "UNAUTHORIZED_ADMIN_ACCESS");

  // 17-6. 専用AI取得 (正しいキーあり): latest_ai_draft が正常に返る
  const aiDraftAuthorizedRes = doGetFunc({
    parameter: {
      action: "get_ai_product_draft",
      mode: "admin",
      admin_key: "secret_admin_key_abc",
      product_id: "TMP-DOGET-001"
    }
  });
  const parsedAiAuthorized = JSON.parse(aiDraftAuthorizedRes.getContent());
  assert("17-6. 専用AI取得は正しいキーあり時に latest_ai_draft を正常に返却する", parsedAiAuthorized.success === true && parsedAiAuthorized.latest_ai_draft !== null && parsedAiAuthorized.latest_ai_draft.draft_id === "D_001");

  delete mockScriptProperties["ADMIN_API_KEY"];
})();

// --------------------------------------------------
// 19. 追加検証: ポケカ／英文の読取例外・レコード欠損
// --------------------------------------------------
(() => {
  const pid = "TMP-EXC-001";
  const rowData = [
    new Date(), pid, "pokemon_card", "Pokemon", "ピカチュウ", "目立った傷や汚れなし",
    1000, 2000, "A-1", "説明文\n\n#Poke", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [rowData],
      getValue: () => rowData[2],
      setValue: () => {}
    })
  };

  const mockDraft = {
    row_number: 2,
    draft_id: "D_EXC",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "src_fp",
    source_image_fingerprint: "img_fp"
  };

  sandbox.getLatestProductAiDraft_ = () => mockDraft;
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp";
  sandbox.findProductRow = () => 2;

  const validPayload = {
    product_id: pid,
    draft_id: "D_EXC",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_EXC_01",
    confirmed_data: {
      product_name: "確定ピカチュウ",
      planned_sale_price: 3000,
      condition: "目立った傷や汚れなし",
      description: "日本語説明文",
      translated_title: "Confirmed Pikachu",
      translated_description: "English description",
      category: "pokemon_card",
      pokemon_card: {
        card_name: "ピカチュウ",
        card_number: "001/025"
      }
    }
  };

  // 19-1. ポケカ読取例外時の Fail-Closed
  mockDraft.last_confirmation_attempt_id = "ATTEMPT_EXC_01";
  mockDraft.last_confirmation_payload_hash = computeConfirmationPayloadHash_(validPayload.confirmed_data);
  // 本票は確定値に更新済み状態
  rowData[4] = "確定ピカチュウ";
  rowData[7] = 3000,
  rowData[9] = "日本語説明文";

  vm.runInContext("getPokemonCardByProductId = function() { const e = new Error('Disk IO failure in pokemon sheet'); e.error_code = 'POKEMON_CARD_READ_FAILED'; throw e; };", sandbox);
  vm.runInContext("getProductTranslation = function() { return null; };", sandbox);

  let pokeExcCode = "";
  try {
    const res = handleConfirmAiProductDraft(mockProductSheet, validPayload);
    const parsed = JSON.parse(res.getContent());
    pokeExcCode = parsed.error_code;
  } catch (err) {
    pokeExcCode = err.error_code;
  }
  assert("19-1. ポケカ読取例外時は catch で握り潰さず Fail-Closed (POKEMON_CARD_READ_FAILED)", pokeExcCode === "POKEMON_CARD_READ_FAILED", `got ${pokeExcCode}`);

  // 19-2. 英文読取例外時の Fail-Closed
  vm.runInContext("getPokemonCardByProductId = function() { return { card_name: 'ピカチュウ', card_number: '001/025' }; };", sandbox);
  vm.runInContext("getProductTranslation = function() { const e = new Error('Database timeout in translation sheet'); e.error_code = 'TRANSLATION_READ_FAILED'; throw e; };", sandbox);

  let transExcCode = "";
  try {
    const res = handleConfirmAiProductDraft(mockProductSheet, validPayload);
    const parsed = JSON.parse(res.getContent());
    transExcCode = parsed.error_code;
  } catch (err) {
    transExcCode = err.error_code;
  }
  assert("19-2. 英文読取例外時は catch で握り潰さず Fail-Closed (TRANSLATION_READ_FAILED)", transExcCode === "TRANSLATION_READ_FAILED", `got ${transExcCode}`);

  // 19-3. ポケカレコード欠損 (null) 時に正常に新規登録として処理可能
  let mockPokeData = null;
  let mockTransData = null;
  sandbox.mockPokeData = mockPokeData;
  sandbox.mockTransData = mockTransData;
  vm.runInContext("getPokemonCardByProductId = function() { return mockPokeData; };", sandbox);
  vm.runInContext("getProductTranslation = function() { return mockTransData; };", sandbox);

  sandbox.savePokemonCardByProductId = (p, data) => {
    mockPokeData = data;
    sandbox.mockPokeData = mockPokeData;
  };
  sandbox.saveConfirmedProductTranslation_ = (p, data) => {
    mockTransData = {
      product_id: p,
      translated_title: data.translated_title,
      translated_description: data.translated_description,
      translation_status: "approved"
    };
    sandbox.mockTransData = mockTransData;
  };

  // ドラフト生成時の指紋と一致させる
  mockDraft.source_fingerprint = computeProductSourceFingerprint_(mockProductSheet, 2, pid);

  const resRecordMissing = handleConfirmAiProductDraft(mockProductSheet, validPayload);
  const parsedRecordMissing = JSON.parse(resRecordMissing.getContent());
  assert("19-3. ポケカ・英文レコード欠損時でもクラッシュせず正常に確認・保存できる", parsedRecordMissing.success === true && mockPokeData !== null && mockTransData !== null);

  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
})();

// --------------------------------------------------
// 20. 追加検証: 生成元指紋に含まれなかった項目だけの他スタッフ変更検知
// --------------------------------------------------
(() => {
  const pid = "TMP-FP-EXT-001";
  const rowData = [
    new Date(), pid, "sneaker", "NIKE", "オリジナルスニーカー", "目立った傷や汚れなし",
    10000, 20000, "A-1", "オリジナル説明文\n\n#NIKE", "", "555088-001", "27.5", "あり", "あり", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockSheet = {
    getLastColumn: () => 40,
    getRange: () => ({
      getValues: () => [rowData],
      getValue: () => rowData[2],
      setValue: () => {}
    })
  };

  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_static";
  vm.runInContext("getPokemonCardByProductId = function() { return null; };", sandbox);
  let mockTrans = {
    product_id: pid,
    translated_title: "Original Title",
    translated_description: "Original Description",
    translation_status: "approved"
  };
  sandbox.mockTrans = mockTrans;
  vm.runInContext("getProductTranslation = function() { return mockTrans; };", sandbox);

  // ドラフト生成時点の生成元指紋を計算
  const initialFp = computeProductSourceFingerprint_(mockSheet, 2, pid);

  // 20-1. 説明文 (description, J列) だけの変更検知
  rowData[9] = "別スタッフが書き換えた説明文";
  const fpAfterDescChange = computeProductSourceFingerprint_(mockSheet, 2, pid);
  assert("20-1. 説明文だけの変更で生成元指紋が変化する (他スタッフ変更検知)", fpAfterDescChange !== initialFp);
  rowData[9] = "オリジナル説明文\n\n#NIKE"; // 元に戻す

  // 20-2. 状態 (condition, F列) だけの変更検知
  rowData[5] = "やや傷や汚れあり";
  const fpAfterCondChange = computeProductSourceFingerprint_(mockSheet, 2, pid);
  assert("20-2. 状態だけの変更で生成元指紋が変化する (他スタッフ変更検知)", fpAfterCondChange !== initialFp);
  rowData[5] = "目立った傷や汚れなし"; // 元に戻す

  // 20-3. 価格 (planned_sale_price, H列) だけの変更検知
  rowData[7] = 35000;
  const fpAfterPriceChange = computeProductSourceFingerprint_(mockSheet, 2, pid);
  assert("20-3. 価格だけの変更で生成元指紋が変化する (他スタッフ変更検知)", fpAfterPriceChange !== initialFp);
  rowData[7] = 20000; // 元に戻す

  // 20-4. ポケカ属性だけの変更検知
  rowData[2] = "pokemon_card";
  let mockPokeCard = { card_name: "リザードン", grade: "PSA 10" };
  sandbox.mockPokeCard = mockPokeCard;
  vm.runInContext("getPokemonCardByProductId = function() { return mockPokeCard; };", sandbox);
  const initialPokeFp = computeProductSourceFingerprint_(mockSheet, 2, pid);

  mockPokeCard = { card_name: "リザードン", grade: "PSA 9" }; // 別スタッフがgradeを変更
  sandbox.mockPokeCard = mockPokeCard;
  const fpAfterPokeChange = computeProductSourceFingerprint_(mockSheet, 2, pid);
  assert("20-4. ポケカ属性だけの変更で生成元指紋が変化する (他スタッフ変更検知)", fpAfterPokeChange !== initialPokeFp);

  // 20-5. 英文翻訳だけの変更検知
  mockTrans = { translated_title: "Title A", translated_description: "Desc A", translation_status: "approved" };
  sandbox.mockTrans = mockTrans;
  const initialTransFp = computeProductSourceFingerprint_(mockSheet, 2, pid);

  mockTrans = { translated_title: "Title B (Other Staff)", translated_description: "Desc A", translation_status: "approved" };
  sandbox.mockTrans = mockTrans;
  const fpAfterTransChange = computeProductSourceFingerprint_(mockSheet, 2, pid);
  assert("20-5. 英文翻訳だけの変更で生成元指紋が変化する (他スタッフ変更検知)", fpAfterTransChange !== initialTransFp);

  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
})();

// --------------------------------------------------
// 21. 追加検証: 保存段階 (Stage) に応じた途中失敗シミュレーションと再試行区別
// --------------------------------------------------
(() => {
  const pid = "TMP-STAGE-001";
  let rowData = [
    new Date(), pid, "sneaker", "NIKE", "確定前スニーカー", "目立った傷や汚れなし",
    10000, 20000, "A-1", "確定前説明文", "", "555088-001", "27.0", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [rowData],
      getValue: () => rowData[c - 1],
      setValue: (val) => { rowData[c - 1] = val; }
    })
  };

  const draftRecord = {
    row_number: 2,
    draft_id: "D_STAGE",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "initial_src_fp",
    source_image_fingerprint: "img_fp_stage",
    last_confirmation_attempt_id: "ATTEMPT_STAGE_01"
  };

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c) => {
      if (r === 1) return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      return {
        setValue: (val) => {
          const h = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (h) draftRecord[h] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...draftRecord });
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_stage";
  sandbox.findProductRow = () => 2;
  vm.runInContext("getPokemonCardByProductId = function() { return null; };", sandbox);

  const payload = {
    product_id: pid,
    draft_id: "D_STAGE",
    draft_version: 1,
    staff_id: "staff_stage",
    confirmation_attempt_id: "ATTEMPT_STAGE_01",
    confirmed_data: {
      product_name: "確定済みスニーカー",
      planned_sale_price: 30000,
      condition: "目立った傷や汚れなし",
      description: "確定済み説明文",
      translated_title: "Confirmed Title",
      translated_description: "Confirmed Description",
      category: "sneaker",
      brand: "NIKE",
      sneaker_sku: "555088-001",
      sneaker_size: "27.0"
    }
  };

  draftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(payload.confirmed_data);

  // 21-1. Stage 1 (本票のみ完了、英文未完了) での途中失敗からの再試行
  rowData[4] = "確定済みスニーカー";
  rowData[7] = 30000;
  rowData[9] = "確定済み説明文";
  rowData[2] = "sneaker";
  // 英文はまだ古いドラフトのまま
  let mockStageTrans = {
    product_id: pid,
    translated_title: "Old Draft Title",
    translated_description: "Old Draft Description",
    translation_status: "draft"
  };
  sandbox.mockStageTrans = mockStageTrans;
  vm.runInContext("getProductTranslation = function() { return mockStageTrans; };", sandbox);
  sandbox.saveConfirmedProductTranslation_ = (p, data) => {
    mockStageTrans = {
      product_id: p,
      translated_title: data.translated_title,
      translated_description: data.translated_description,
      translation_status: "approved"
    };
    sandbox.mockStageTrans = mockStageTrans;
  };

  const retryStage1Res = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedStage1 = JSON.parse(retryStage1Res.getContent());
  assert("21-1. Stage 1 (本票完了・英文未完了) からの同一attempt再試行は成功する", parsedStage1.success === true && draftRecord.review_status === "confirmed");

  // 21-2. Stage 1 の後に別スタッフが別の英文を approved で保存していた場合の競合遮断
  draftRecord.review_status = "pending_review";
  mockStageTrans = {
    product_id: pid,
    translated_title: "Other Staff Approved Title",
    translated_description: "Other Staff Approved Description",
    translation_status: "approved"
  };
  sandbox.mockStageTrans = mockStageTrans;

  const conflictStage1Res = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedConflict = JSON.parse(conflictStage1Res.getContent());
  assert("21-2. Stage 1 後に他スタッフが英文を承認変更した場合は競合遮断 (SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER)", parsedConflict.success === false && parsedConflict.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  // 21-3. Stage 1 の後に別スタッフが本票の価格を変更していた場合の競合遮断
  draftRecord.review_status = "pending_review";
  rowData[7] = 99999; // 他スタッフによる価格書き換え
  mockStageTrans = null;
  sandbox.mockStageTrans = mockStageTrans;

  const conflictPriceRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedConflictPrice = JSON.parse(conflictPriceRes.getContent());
  assert("21-3. 途中失敗後に他スタッフが本票価格を変更した場合は競合遮断 (SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER)", parsedConflictPrice.success === false && parsedConflictPrice.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");

  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
})();

// --------------------------------------------------
// 22. 本票の各セル書込み途中で失敗した場合の復旧テスト
// --------------------------------------------------
(() => {
  const pid = "TMP-PARTIAL-CELL-001";
  let rowData = [
    new Date(), pid, "sneaker", "NIKE", "元の商品名", "目立った傷や汚れなし",
    10000, 20000, "A-1", "元の説明文", "", "555088-001", "27.0", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [rowData],
      getValue: () => rowData[c - 1],
      setValue: (val) => { rowData[c - 1] = val; }
    })
  };

  const draftRecord = {
    row_number: 2,
    draft_id: "D_PARTIAL",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "src_fp_partial",
    source_image_fingerprint: "img_fp_partial",
    last_confirmation_attempt_id: "ATTEMPT_PARTIAL_01"
  };

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c) => {
      if (r === 1) return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      return {
        setValue: (val) => {
          const h = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (h) draftRecord[h] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...draftRecord });
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_partial";
  sandbox.findProductRow = () => 2;
  vm.runInContext("getPokemonCardByProductId = function() { return null; };", sandbox);

  const payload = {
    product_id: pid,
    draft_id: "D_PARTIAL",
    draft_version: 1,
    staff_id: "staff_partial",
    confirmation_attempt_id: "ATTEMPT_PARTIAL_01",
    confirmed_data: {
      product_name: "確定済みスニーカー",
      planned_sale_price: 30000,
      condition: "新品・未使用",
      description: "確定済み説明文",
      translated_title: "Confirmed Title",
      translated_description: "Confirmed Description",
      category: "sneaker",
      brand: "NIKE",
      sneaker_sku: "555088-001",
      sneaker_size: "27.0"
    }
  };

  draftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(payload.confirmed_data);

  // シミュレーション: 本票の product_name (E列: 4) だけが確定値で書かれ、他セルを書く前にクラッシュした状態
  rowData[4] = "確定済みスニーカー"; // E列は確定値
  rowData[5] = "目立った傷や汚れなし"; // F列はまだ元値
  rowData[7] = 20000;                 // H列はまだ元値
  rowData[9] = "元の説明文";           // J列はまだ元値

  let mockTrans = null;
  sandbox.mockTrans = mockTrans;
  vm.runInContext("getProductTranslation = function() { return mockTrans; };", sandbox);
  sandbox.saveConfirmedProductTranslation_ = (p, data) => {
    mockTrans = {
      product_id: p,
      translated_title: data.translated_title,
      translated_description: data.translated_description,
      translation_status: "approved"
    };
    sandbox.mockTrans = mockTrans;
  };

  const retryRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedRetry = JSON.parse(retryRes.getContent());
  assert("22-1. 本票の各セル書込み途中で失敗した場合の同一attempt再試行は成功する", parsedRetry.success === true && draftRecord.review_status === "confirmed");
  assert("22-2. 再試行後に本票の全セルが確定値で上書き完了している", rowData[4] === "確定済みスニーカー" && rowData[5] === "新品・未使用" && rowData[7] === 30000 && rowData[9] === "確定済み説明文");
})();

// --------------------------------------------------
// 23. ポケカ未保存と他スタッフ変更の区別テスト
// --------------------------------------------------
(() => {
  const pid = "TMP-POKE-DIFF-001";
  let rowData = [
    new Date(), pid, "pokemon_card", "Pokemon", "リザードン", "目立った傷や汚れなし",
    5000, 10000, "A-1", "説明文", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [rowData],
      getValue: () => rowData[c - 1],
      setValue: (val) => { rowData[c - 1] = val; }
    })
  };

  const draftNow = new Date("2026-10-01T12:00:00.000Z");
  const draftRecord = {
    row_number: 2,
    draft_id: "D_POKE",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "src_fp_poke",
    source_image_fingerprint: "img_fp_poke",
    last_confirmation_attempt_id: "ATTEMPT_POKE_01",
    generated_at: draftNow.toISOString()
  };

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c) => {
      if (r === 1) return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      return {
        setValue: (val) => {
          const h = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (h) draftRecord[h] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...draftRecord });
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_poke";
  sandbox.findProductRow = () => 2;

  const payload = {
    product_id: pid,
    draft_id: "D_POKE",
    draft_version: 1,
    staff_id: "staff_poke",
    confirmation_attempt_id: "ATTEMPT_POKE_01",
    confirmed_data: {
      product_name: "確定リザードン",
      planned_sale_price: 15000,
      condition: "目立った傷や汚れなし",
      description: "確定説明",
      translated_title: "Charizard",
      translated_description: "English desc",
      category: "pokemon_card",
      pokemon_card: {
        card_name: "リザードン",
        grading_status: "graded",
        grader: "PSA",
        grade: "10"
      }
    }
  };

  draftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(payload.confirmed_data);

  // 本票は確定値で保存済み (Stage 1)
  rowData[4] = "確定リザードン";
  rowData[7] = 15000;
  rowData[9] = "確定説明";
  rowData[2] = "pokemon_card";

  // 23-1. ポケカ未保存（初期状態のままレコードなし）での再試行は成功する
  let mockPoke = null;
  sandbox.mockPoke = mockPoke;
  vm.runInContext("getPokemonCardByProductId = function() { return mockPoke; };", sandbox);
  vm.runInContext("savePokemonCardByProductId = function(p, data) { mockPoke = data; return { success: true }; };", sandbox);

  let mockPokeTrans = null;
  sandbox.mockPokeTrans = mockPokeTrans;
  vm.runInContext("getProductTranslation = function() { return mockPokeTrans; };", sandbox);
  sandbox.saveConfirmedProductTranslation_ = (p, data) => {
    mockPokeTrans = {
      product_id: p,
      translated_title: data.translated_title,
      translated_description: data.translated_description,
      translation_status: "approved",
      generated_at: new Date().toISOString()
    };
    sandbox.mockPokeTrans = mockPokeTrans;
  };

  const retryPokeRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedPokeRetry = JSON.parse(retryPokeRes.getContent());
  assert("23-1. ポケカ未保存 (初期状態のまま未登録) からの同一attempt再試行は成功する", parsedPokeRetry.success === true && draftRecord.review_status === "confirmed");

  // 23-2. 本票更新後、他スタッフがポケカシートに別レコードを新規作成していた場合の遮断
  draftRecord.review_status = "pending_review";
  mockPoke = {
    card_name: "他スタッフ作成カメックス",
    grade: "PSA 9",
    updated_at: new Date(draftNow.getTime() + 60000).toISOString() // ドラフト生成より後
  };
  sandbox.mockPoke = mockPoke;

  const conflictPokeRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedConflictPoke = JSON.parse(conflictPokeRes.getContent());
  assert("23-2. ポケカ保存前に他スタッフがポケカ属性を変更・作成していた場合は競合遮断 (SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER)", parsedConflictPoke.success === false && parsedConflictPoke.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");
})();

// --------------------------------------------------
// 24. 元から承認済み英文がある商品の、英文更新前失敗からの復旧テスト
// --------------------------------------------------
(() => {
  const pid = "TMP-APPROVED-TRANS-001";
  let rowData = [
    new Date(), pid, "sneaker", "NIKE", "元スニーカー", "目立った傷や汚れなし",
    10000, 20000, "A-1", "説明文", "", "555088-001", "27.0", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastColumn: () => 40,
    getRange: (r, c) => ({
      getValues: () => [rowData],
      getValue: () => rowData[c - 1],
      setValue: (val) => { rowData[c - 1] = val; }
    })
  };

  const draftNow = new Date("2026-10-01T12:00:00.000Z");
  const draftRecord = {
    row_number: 2,
    draft_id: "D_TRANS_RECOVER",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "src_fp_trans_rec",
    source_image_fingerprint: "img_fp_trans_rec",
    last_confirmation_attempt_id: "ATTEMPT_TRANS_REC_01",
    generated_at: draftNow.toISOString()
  };

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c) => {
      if (r === 1) return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      return {
        setValue: (val) => {
          const h = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (h) draftRecord[h] = val;
        }
      };
    }
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({ ...draftRecord });
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "img_fp_trans_rec";
  sandbox.findProductRow = () => 2;
  vm.runInContext("getPokemonCardByProductId = function() { return null; };", sandbox);

  const payload = {
    product_id: pid,
    draft_id: "D_TRANS_RECOVER",
    draft_version: 1,
    staff_id: "staff_trans_rec",
    confirmation_attempt_id: "ATTEMPT_TRANS_REC_01",
    confirmed_data: {
      product_name: "確定済みスニーカー",
      planned_sale_price: 30000,
      condition: "目立った傷や汚れなし",
      description: "確定済み説明文",
      translated_title: "Confirmed Title (New)",
      translated_description: "Confirmed Description (New)",
      category: "sneaker",
      brand: "NIKE",
      sneaker_sku: "555088-001",
      sneaker_size: "27.0"
    }
  };

  draftRecord.last_confirmation_payload_hash = computeConfirmationPayloadHash_(payload.confirmed_data);

  // 本票は確定値で保存済み (Stage 1 / Stage 2 相当)
  rowData[4] = "確定済みスニーカー";
  rowData[7] = 30000;
  rowData[9] = "確定済み説明文";
  rowData[2] = "sneaker";

  // ドラフト生成前 (過去) に生成・承認された元の英文が存在する
  let mockTrans = {
    product_id: pid,
    translated_title: "Old Pre-Existing Approved Title",
    translated_description: "Old Pre-Existing Approved Description",
    translation_status: "approved",
    generated_at: new Date(draftNow.getTime() - 3600000).toISOString() // ドラフト生成の1時間前
  };
  sandbox.mockTrans = mockTrans;
  vm.runInContext("getProductTranslation = function() { return mockTrans; };", sandbox);
  sandbox.saveConfirmedProductTranslation_ = (p, data) => {
    mockTrans = {
      product_id: p,
      translated_title: data.translated_title,
      translated_description: data.translated_description,
      translation_status: "approved",
      generated_at: new Date().toISOString()
    };
    sandbox.mockTrans = mockTrans;
  };

  // 24-1. 元から承認済み英文がある商品でも、英文更新前の同一attempt再試行は成功し更新される
  const retryTransRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedTransRetry = JSON.parse(retryTransRes.getContent());
  assert("24-1. 元から承認済み英文がある商品の、英文更新前失敗からの同一attempt再試行は成功する", parsedTransRetry.success === true && draftRecord.review_status === "confirmed");
  assert("24-2. 再試行後に確定英文へ正しく上書き更新されている", mockTrans.translated_title === "Confirmed Title (New)");

  // 24-3. もし他スタッフがドラフト生成後に英文を変更していた場合は競合遮断
  draftRecord.review_status = "pending_review";
  mockTrans = {
    product_id: pid,
    translated_title: "Other Staff Later Approved Title",
    translated_description: "Other Staff Later Approved Description",
    translation_status: "approved",
    generated_at: new Date(draftNow.getTime() + 60000).toISOString() // ドラフト生成より後
  };
  sandbox.mockTrans = mockTrans;

  const conflictTransRes = handleConfirmAiProductDraft(mockProductSheet, payload);
  const parsedConflictTrans = JSON.parse(conflictTransRes.getContent());
  assert("24-3. 英文保存前に他スタッフがドラフト生成後に英文を変更していた場合は競合遮断 (SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER)", parsedConflictTrans.success === false && parsedConflictTrans.error_code === "SOURCE_ATTRIBUTE_MODIFIED_BY_OTHER");
})();

// --------------------------------------------------
// 25. スニーカーサイズ仕様 統合検証: 空欄確定 -> 公開拒否(SNEAKER_SIZE_REQUIRED) -> サイズ追加入力(再確認) -> 公開成功
// --------------------------------------------------
(() => {
  const pid = "TMP-SIZE-FLOW-001";
  const rowData = [
    new Date(), pid, "sneaker", "NIKE", "", "", "", "", "", "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/sizeflow", "", "draft", "in_stock", "active", "", "", "", "", 1,
    "ai_managed"
  ];

  const mockProductSheet = {
    getLastRow: () => 2,
    getLastColumn: () => 40,
    getRange: (r, c, numR, numC) => {
      if (numR && numC) {
        return { getValues: () => [rowData] };
      }
      return {
        getValue: () => rowData[c - 1],
        setValue: (v) => { rowData[c - 1] = v; },
        getValues: () => [[rowData[c - 1]]]
      };
    }
  };

  const draftRecord = {
    row_number: 2,
    draft_id: "DRFT_SIZE_001",
    product_id: pid,
    draft_version: 1,
    review_status: "pending_review",
    source_fingerprint: "size_source_fp",
    source_image_fingerprint: "size_img_fp",
    confirmed_fingerprint: "",
    last_confirmation_attempt_id: "",
    last_confirmation_payload_hash: ""
  };

  sandbox.getLatestProductAiDraft_ = (id) => (id === pid ? draftRecord : null);
  sandbox.findProductRow = () => 2;
  sandbox.computeImageFingerprintFromFolderUrl_ = () => "size_img_fp";
  sandbox.computeProductSourceFingerprint_ = () => "size_source_fp";
  const mockTranslation = {
    product_id: pid,
    translated_title: "Nike Dunk Low",
    translated_description: "Classic court sneaker",
    translation_status: "approved"
  };
  sandbox.saveConfirmedProductTranslation_ = (pId, data) => {
    mockTranslation.translated_title = data.translated_title;
    mockTranslation.translated_description = data.translated_description;
    mockTranslation.translation_status = "approved";
  };
  sandbox.getProductTranslation = () => mockTranslation;

  const mockDraftSheet = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: (r, c) => {
      if (r === 1) return { getValues: () => [AI_DRAFT_CONFIG.HEADERS] };
      return {
        setValue: (val) => {
          const headerName = AI_DRAFT_CONFIG.HEADERS[c - 1];
          if (headerName) draftRecord[headerName] = val;
        }
      };
    }
  };
  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.computeConfirmedProductFingerprint_ = originalComputeConfirmedFp;

  // Step 1: サイズ空欄で確定保存 -> 成功して review_status: "confirmed"
  const emptySizeConfirmRes = handleConfirmAiProductDraft(mockProductSheet, {
    product_id: pid,
    draft_id: "DRFT_SIZE_001",
    draft_version: 1,
    staff_id: "staff_tester",
    confirmation_attempt_id: "ATTEMPT_SIZE_INIT",
    confirmed_data: {
      product_name: "ナイキ ダンク ロー",
      planned_sale_price: 18000,
      condition: "目立った傷や汚れなし",
      category: "sneaker",
      sneaker_size: "", // 空欄
      translated_title: "Nike Dunk Low",
      translated_description: "Classic court sneaker"
    }
  });
  const parsedEmptyConfirm = JSON.parse(emptySizeConfirmRes.getContent());
  assert("25-1. スニーカーのサイズ空欄での確定保存は成功する", parsedEmptyConfirm.success === true && draftRecord.review_status === "confirmed");
  assert("25-2. 確定指紋が記録される", Boolean(draftRecord.confirmed_fingerprint));

  // Step 2: サイズ空欄のまま公開試行 -> SNEAKER_SIZE_REQUIRED で拒絶
  let gateBlockedOnEmptySize = false;
  try {
    assertProductPublishable_(mockProductSheet, 2, pid);
  } catch (err) {
    if (err.error_code === "SNEAKER_SIZE_REQUIRED") gateBlockedOnEmptySize = true;
  }
  assert("25-3. サイズ空欄のスニーカーは公開ゲートで SNEAKER_SIZE_REQUIRED 拒絶される", gateBlockedOnEmptySize);

  // Step 3: サイズ追加入力 (再確認: 新しい attempt ID で sneaker_size: '27.5cm')
  const reconfirmRes = handleConfirmAiProductDraft(mockProductSheet, {
    product_id: pid,
    draft_id: "DRFT_SIZE_001",
    draft_version: 1,
    staff_id: "staff_tester",
    confirmation_attempt_id: "ATTEMPT_SIZE_RECONFIRM",
    confirmed_data: {
      product_name: "ナイキ ダンク ロー",
      planned_sale_price: 18000,
      condition: "目立った傷や汚れなし",
      category: "sneaker",
      sneaker_size: "27.5cm", // サイズ追加
      translated_title: "Nike Dunk Low",
      translated_description: "Classic court sneaker"
    }
  });
  const parsedReconfirm = JSON.parse(reconfirmRes.getContent());
  assert("25-4. サイズ追加入力の再確認は画像再生成なしで成功する", parsedReconfirm.success === true && draftRecord.review_status === "confirmed");
  assert("25-5. シートにサイズが書き込まれる", rowData[12] === "27.5cm");

  // Step 4: サイズ追加後の公開試行 -> 通過！
  const publishAllowed = assertProductPublishable_(mockProductSheet, 2, pid);
  assert("25-6. サイズ追加入力・再確認後は公開ゲートを通過する", publishAllowed === true);

  // Step 5: 再確認後に本票のサイズを直接改ざん -> AI_DRAFT_MODIFIED_AFTER_CONFIRMATION で拒絶
  rowData[12] = "28.0cm"; // スタッフが本票を再確認なしで変更
  let gateBlockedOnModified = false;
  try {
    assertProductPublishable_(mockProductSheet, 2, pid);
  } catch (err) {
    if (err.error_code === "AI_DRAFT_MODIFIED_AFTER_CONFIRMATION") gateBlockedOnModified = true;
  }
  assert("25-7. 再確認後の本票変更は指紋不一致で検知遮断される (指紋チェック維持)", gateBlockedOnModified);

  // Step 6: 空欄確定後にシート側だけサイズ追加入力された場合の差分診断メッセージ検証
  rowData[12] = ""; // 初期確定状態に戻す
  const resetEmptyFp = computeConfirmedProductFingerprint_(mockProductSheet, 2, pid);
  draftRecord.confirmed_fingerprint = resetEmptyFp; // 空欄確定状態
  rowData[12] = "27.5"; // update_product 等でサイズだけ追加
  let diagMessageMatched = false;
  try {
    assertProductPublishable_(mockProductSheet, 2, pid);
  } catch (err) {
    if (err.message && err.message.indexOf("sneaker_size was updated to '27.5'") !== -1) {
      diagMessageMatched = true;
    }
  }
  assert("25-8. サイズ空欄確定後に本票サイズのみ追加された場合の診断メッセージ出力", diagMessageMatched);

  // Step 7: candidate プロパティ名（size, sku, title_ja, price, title_en, description_en）での確定保存成功
  const aliasConfirmRes = handleConfirmAiProductDraft(mockProductSheet, {
    product_id: pid,
    draft_id: "DRFT_SIZE_001",
    draft_version: 1,
    staff_id: "staff_alias",
    confirmation_attempt_id: "ATTEMPT_ALIAS_CONFIRM",
    confirmed_data: {
      title_ja: "ナイキ ダンク ロー エイリアス",
      price: 19000,
      condition: "新品・未使用",
      category: "sneaker",
      size: "27.5cm",
      sku: "DD1391-100",
      title_en: "Nike Dunk Low Alias",
      description_en: "Classic sneaker alias"
    }
  });
  const parsedAliasConfirm = JSON.parse(aliasConfirmRes.getContent());
  assert("25-9. candidate エイリアス名での再確定保存は成功する", parsedAliasConfirm.success === true && rowData[12] === "27.5cm" && rowData[11] === "DD1391-100");
})();

// --------------------------------------------------
// 26. Square Idempotency Key & Deletion Separation Tests
// --------------------------------------------------
(() => {
  const pid = "TMP-000088";

  // 26-1. buildSquareProdCreateIdempotencyKey_ tests
  const keyGen1 = sandbox.buildSquareProdCreateIdempotencyKey_(pid, 1);
  const keyGen2 = sandbox.buildSquareProdCreateIdempotencyKey_(pid, 2);
  const keyGen3 = sandbox.buildSquareProdCreateIdempotencyKey_(pid, 3);
  const keyDefault = sandbox.buildSquareProdCreateIdempotencyKey_(pid);

  assert("26-1. buildSquareProdCreateIdempotencyKey_ は初回(gen 1)およびデフォルトで固定キーを生成する",
    keyGen1 === "ais-square-prod-create-TMP-000088" && keyDefault === "ais-square-prod-create-TMP-000088"
  );
  assert("26-2. buildSquareProdCreateIdempotencyKey_ は新世代で世代サフィックス付きキーを生成する",
    keyGen2 === "ais-square-prod-create-TMP-000088-g2" && keyGen3 === "ais-square-prod-create-TMP-000088-g3"
  );

  // 26-2. getSquareProdCreateGeneration_ / setSquareProdCreateGeneration_ tests
  sandbox.setSquareProdCreateGeneration_(pid, 2);
  const retrievedGen = sandbox.getSquareProdCreateGeneration_(pid);
  assert("26-3. 世代番号の保存と取得が正常に行われる", retrievedGen === 2);
  sandbox.setSquareProdCreateGeneration_(pid, 1); // cleanup

  // 26-3. 削除済みオブジェクト検出と世代進展の動作検証
  // attempt 0 で is_deleted: true が返された場合、世代を進めてattempt 1で新キーにより再試行すること
  const props = sandbox.PropertiesService.getScriptProperties();
  props.setProperty("SQUARE_PROD_LOCATION_ID", "LOC_PROD_MOCK");

  let squareCallCount = 0;
  let squareKeysUsed = [];
  sandbox.squareProdRequest_ = (path, options) => {
    squareCallCount++;
    if (path === "/v2/catalog/object" && options.method === "post") {
      const payload = options.payload;
      squareKeysUsed.push(payload.idempotency_key);
      if (squareCallCount === 1) {
        // 初回: 固定キーに対してSquareが過去に削除されたオブジェクトを返却するシミュレーション
        return {
          httpStatus: 200,
          body: JSON.stringify({
            catalog_object: {
              id: "DEL_OBJ_88",
              is_deleted: true
            }
          })
        };
      }
      // 2回目 (新世代キー): 新規作成成功
      return {
        httpStatus: 200,
        body: JSON.stringify({
          catalog_object: {
            id: "NEW_OBJ_88",
            is_deleted: false,
            item_data: {
              name: "NIKE KOBE 4",
              variations: [{
                id: "NEW_VAR_88",
                item_variation_data: {
                  sku: "TMP-000088",
                  name: "27.0 cm",
                  price_money: { amount: 38000, currency: "JPY" }
                }
              }]
            }
          },
          id_mappings: [
            { client_object_id: "#ais-prod-item-TMP-000088", object_id: "NEW_OBJ_88" },
            { client_object_id: "#ais-prod-var-TMP-000088", object_id: "NEW_VAR_88" }
          ]
        })
      };
    } else if (path.startsWith("/v2/catalog/object/")) {
      return {
        httpStatus: 200,
        body: JSON.stringify({
          object: {
            type: "ITEM",
            id: "NEW_OBJ_88",
            is_deleted: false,
            item_data: {
              name: "NIKE KOBE 4",
              variations: [{
                id: "NEW_VAR_88",
                item_variation_data: {
                  sku: "TMP-000088",
                  name: "27.0 cm",
                  price_money: { amount: 38000, currency: "JPY" }
                }
              }]
            }
          }
        })
      };
    }
    return { httpStatus: 200, body: "{}" };
  };

  const rowVals = [
    new Date(), "TMP-000088", "sneaker", "NIKE", "NIKE KOBE 4", "新品・未使用",
    0, 38000, "", "説明", "", "SKU88", "27.0", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    ""
  ];
  const mockProdSheetForSquare = {
    getLastRow: () => 2,
    getLastColumn: () => 40,
    getMaxColumns: () => 40,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        if (c === 2 && nc === 1) {
          return [["product_id"], ["TMP-000088"]];
        }
        if (r === 1 && c >= 34) {
          return [["square_item_id", "square_variation_id"]];
        }
        return [rowVals];
      },
      getFormulas: () => [["", ""]],
      setValues: (vals) => {}
    })
  };
  sandbox.SpreadsheetApp.getActiveSpreadsheet = () => ({
    getSheets: () => [mockProdSheetForSquare]
  });

  // assertProductPublishable_ および buildSquareSneakerItemOptions_ をバイパス
  const origAssertPub = sandbox.assertProductPublishable_;
  const origSneakerOpts = sandbox.buildSquareSneakerItemOptions_;
  sandbox.assertProductPublishable_ = () => {};
  sandbox.buildSquareSneakerItemOptions_ = () => ({ itemOptionValues: [], itemOptions: [] });

  const prodResult = sandbox.createSquareProductionProduct("TMP-000088");
  assert("26-4. 削除済みオブジェクト返却時は固定キーのまま受容せず、新世代キーで再作成する",
    squareKeysUsed[0] === "ais-square-prod-create-TMP-000088" &&
    squareKeysUsed[1] === "ais-square-prod-create-TMP-000088-g2" &&
    prodResult.square_item_id === "NEW_OBJ_88"
  );

  // 26-5. 通信結果が不明な場合の再送（同一固定キーを維持し、Squareキャッシュから稼働中オブジェクトを取得して成功）
  const pidUnconf = "TMP-UNCONF-001";
  let unconfKeysUsed = [];
  sandbox.squareProdRequest_ = (path, options) => {
    if (path === "/v2/catalog/object" && options.method === "post") {
      unconfKeysUsed.push(options.payload.idempotency_key);
      return {
        httpStatus: 200,
        body: JSON.stringify({
          catalog_object: {
            id: "ACTIVE_OBJ_01",
            is_deleted: false,
            item_data: {
              name: "NIKE KOBE 4",
              variations: [{
                id: "ACTIVE_VAR_01",
                item_variation_data: {
                  sku: pidUnconf,
                  name: "27.0 cm",
                  price_money: { amount: 38000, currency: "JPY" }
                }
              }]
            }
          },
          id_mappings: [
            { client_object_id: "#ais-prod-item-" + pidUnconf, object_id: "ACTIVE_OBJ_01" },
            { client_object_id: "#ais-prod-var-" + pidUnconf, object_id: "ACTIVE_VAR_01" }
          ]
        })
      };
    } else if (path.startsWith("/v2/catalog/object/")) {
      return {
        httpStatus: 200,
        body: JSON.stringify({
          object: {
            type: "ITEM",
            id: "ACTIVE_OBJ_01",
            is_deleted: false,
            item_data: {
              name: "NIKE KOBE 4",
              variations: [{
                id: "ACTIVE_VAR_01",
                item_variation_data: {
                  sku: pidUnconf,
                  name: "27.0 cm",
                  price_money: { amount: 38000, currency: "JPY" }
                }
              }]
            }
          }
        })
      };
    }
    return { httpStatus: 200, body: "{}" };
  };

  const unconfRowVals = [
    new Date(), pidUnconf, "sneaker", "NIKE", "NIKE KOBE 4", "新品・未使用",
    0, 38000, "", "説明", "", "SKU88", "27.0", "", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
    ""
  ];
  sandbox.SpreadsheetApp.getActiveSpreadsheet = () => ({
    getSheets: () => [{
      getLastRow: () => 2,
      getLastColumn: () => 40,
      getMaxColumns: () => 40,
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          if (c === 2 && nc === 1) return [["product_id"], [pidUnconf]];
          if (r === 1 && c >= 34) return [["square_item_id", "square_variation_id"]];
          return [unconfRowVals];
        },
        getFormulas: () => [["", ""]],
        setValues: (vals) => {}
      })
    }]
  });

  const unconfResult = sandbox.createSquareProductionProduct(pidUnconf);
  assert("26-5. 通信結果不明での再送は同一固定キーを維持し、Square側重複作成を防ぐ",
    unconfKeysUsed.length === 1 &&
    unconfKeysUsed[0] === "ais-square-prod-create-" + pidUnconf &&
    unconfResult.square_item_id === "ACTIVE_OBJ_01" &&
    sandbox.getSquareProdCreateGeneration_(pidUnconf) === 1
  );

  sandbox.assertProductPublishable_ = origAssertPub;
  sandbox.buildSquareSneakerItemOptions_ = origSneakerOpts;

  // 26-6. スニーカー Item Options 連携時の Variation Name 命名一致検証
  // sizeValName ("27.0") + condValName ("新品・未使用") -> "27.0, 新品・未使用"
  const sneakerOptsMock = {
    itemOptions: [{ item_option_id: "OPT_SIZE" }, { item_option_id: "OPT_COND" }],
    itemOptionValues: [{ item_option_id: "OPT_SIZE", item_option_value_id: "VAL_270" }, { item_option_id: "OPT_COND", item_option_value_id: "VAL_NEW" }],
    expectedVariationName: "27.0, 新品・未使用"
  };
  const sneakerDisplay = sandbox.buildSquareProductDisplay_({
    category: "sneaker",
    product_name: "KOBE 4",
    product_id: "TMP-000088",
    sneaker_size: 27,
    condition: "新品・未使用"
  }, sneakerOptsMock);

  assert("26-6. Item Options 連携時はSquareの自動命名 (カンマ区切り) に合わせた variationName を生成する",
    sneakerDisplay.variationName === "27.0, 新品・未使用"
  );
})();

function createMockBatchSheet(name, initialHeaders) {
  let rows = initialHeaders ? [initialHeaders.slice()] : [];
  return {
    getName: () => name,
    getLastRow: () => rows.length,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    setFrozenRows: () => {},
    appendRow: (row) => {
      rows.push(row.slice());
    },
    getRange: (r, c, numR, numC) => ({
      getValues: () => {
        const res = [];
        for (let i = 0; i < numR; i++) {
          const rowData = [];
          const rowIdx = (r - 1) + i;
          const srcRow = rows[rowIdx] || [];
          for (let j = 0; j < numC; j++) {
            const colIdx = (c - 1) + j;
            rowData.push(srcRow[colIdx] !== undefined ? srcRow[colIdx] : "");
          }
          res.push(rowData);
        }
        return res;
      },
      getValue: () => {
        const srcRow = rows[r - 1] || [];
        return srcRow[c - 1] !== undefined ? srcRow[c - 1] : "";
      },
      setValue: (val) => {
        while (rows.length < r) {
          rows.push([]);
        }
        const srcRow = rows[r - 1];
        while (srcRow.length < c) {
          srcRow.push("");
        }
        srcRow[c - 1] = val;
      },
      setValues: (matrix) => {
        for (let i = 0; i < matrix.length; i++) {
          const targetRowIdx = (r - 1) + i;
          while (rows.length <= targetRowIdx) {
            rows.push([]);
          }
          const srcRow = rows[targetRowIdx];
          for (let j = 0; j < matrix[i].length; j++) {
            const targetColIdx = (c - 1) + j;
            while (srcRow.length <= targetColIdx) {
              srcRow.push("");
            }
            srcRow[targetColIdx] = matrix[i][j];
          }
        }
      }
    }),
    _getRows: () => rows
  };
}

// --------------------------------------------------
// 27. AI一括出品ドラフト生成 (Batch Generation) 包括的テスト
// --------------------------------------------------
(() => {
  console.log("\n--- [27. AI一括出品ドラフト (Batch Generation)] ---");

  const createMockSheet = createMockBatchSheet;

  const batchJobsSheet = createMockSheet("ai_batch_jobs", AI_BATCH_CONFIG.JOB_HEADERS);
  const batchItemsSheet = createMockSheet("ai_batch_items", AI_BATCH_CONFIG.ITEM_HEADERS);
  const draftsSheet = createMockSheet("product_ai_drafts", AI_DRAFT_CONFIG.HEADERS);

  const mainProdSheet = {
    getLastRow: () => 4,
    getLastColumn: () => 40,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        return [
          [
            new Date(), "TMP-001", "sneaker", "NIKE", "スニーカー1", "新品・未使用",
            10000, 20000, "A-1", "説明", "", "SKU1", "27.0", "White", "", "", "",
            "", "", "", "", "", "", "", "", "", "", "", "",
            "https://drive.google.com/folders/f1", "", "draft", "in_stock", "active", "", "", "", "", 1, ""
          ]
        ];
      },
      setValue: (val) => {}
    })
  };

  const sheetsMap = {
    "ai_batch_jobs": batchJobsSheet,
    "ai_batch_items": batchItemsSheet,
    "product_ai_drafts": draftsSheet
  };

  sandbox.SpreadsheetApp.getActiveSpreadsheet = () => ({
    getSheets: () => [mainProdSheet, batchJobsSheet, batchItemsSheet, draftsSheet],
    getSheetByName: (name) => sheetsMap[name] || null,
    insertSheet: (name) => {
      const s = createMockSheet(name);
      sheetsMap[name] = s;
      return s;
    }
  });

  // v79仕様 (自動反映 + 完了判定) に合わせたモック:
  // - コア処理モックは ownership_check (prepare/commit) を経由し、確定済み候補行を product_ai_drafts へ追記する
  // - 完了判定 (verifyProductDraftReflectionCompleted_) は confirmed かつ確定指紋 FP_OK の場合のみ通過する
  //   (実関数による本票反映検証は Section 29 で実施)
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
  const originalVerifyReflection27 = sandbox.verifyProductDraftReflectionCompleted_;
  const appendMockDraftRow = (rec) => {
    draftsSheet.appendRow(AI_DRAFT_CONFIG.HEADERS.map(h => (rec[h] !== undefined ? rec[h] : "")));
  };
  const mockCommitDraft = (pid, opts, overrides) => {
    overrides = overrides || {};
    const draftId = overrides.draft_id || ("DRFT_" + pid + "_" + Math.random().toString(36).substring(2, 8));
    if (opts && typeof opts.ownership_check === "function") {
      opts.ownership_check({ phase: "prepare" });
      opts.ownership_check({ phase: "commit", draft_id: draftId, draft_version: 1, model_name: "gemini-3.5-flash-lite" });
    }
    const rec = Object.assign({
      draft_id: draftId,
      product_id: pid,
      draft_version: 1,
      review_status: "confirmed",
      candidate_title_ja: "モック商品 " + pid,
      confirmed_fingerprint: "FP_OK",
      model_name: "gemini-3.5-flash-lite",
      generated_at: new Date().toISOString(),
      confirmed_by: "ai_batch_worker"
    }, overrides);
    appendMockDraftRow(rec);
    return { success: true, draft_id: draftId, draft_version: 1, model_name: rec.model_name, review_status: rec.review_status };
  };
  sandbox.verifyProductDraftReflectionCompleted_ = (sheet, row, pid, draft) => {
    if (!draft || draft.review_status !== "confirmed" || draft.confirmed_fingerprint !== "FP_OK") {
      const e = new Error("Verification failed (mock): draft is not fully reflected");
      e.error_code = "CONFIRMED_FINGERPRINT_MISMATCH";
      throw e;
    }
    return { success: true, confirmedFingerprint: "FP_OK" };
  };
  const findItemRow27 = (batchId, pid) => batchItemsSheet._getRows().find(r => r[0] === batchId && r[1] === pid);
  const countDraftRows27 = (pid) => draftsSheet._getRows().slice(1).filter(r => r[1] === pid).length;

  // 27-1. create_ai_product_draft_batch: request_id 未指定
  const noReqRes = sandbox.handleCreateAiProductDraftBatch({
    product_ids: ["TMP-001"]
  });
  const noReqJson = JSON.parse(noReqRes.getContent());
  assert("27-1. request_id 未指定時は REQUEST_ID_REQUIRED で拒否",
    noReqJson.success === false && noReqJson.error_code === "REQUEST_ID_REQUIRED"
  );

  // 27-2. create_ai_product_draft_batch: product_ids 空配列
  const emptyPidsRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_TEST_001",
    product_ids: []
  });
  const emptyPidsJson = JSON.parse(emptyPidsRes.getContent());
  assert("27-2. product_ids 空配列時は EMPTY_PRODUCT_IDS で拒否",
    emptyPidsJson.success === false && emptyPidsJson.error_code === "EMPTY_PRODUCT_IDS"
  );

  // 27-3. create_ai_product_draft_batch: 20件超過
  const over20 = [];
  for (let i = 1; i <= 21; i++) over20.push("TMP-" + i);
  const over20Res = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_TEST_002",
    product_ids: over20
  });
  const over20Json = JSON.parse(over20Res.getContent());
  assert("27-3. 20件超過時は MAX_BATCH_SIZE_EXCEEDED で拒否",
    over20Json.success === false && over20Json.error_code === "MAX_BATCH_SIZE_EXCEEDED"
  );

  // 27-4. create_ai_product_draft_batch: 重複ID排除と正常作成 (queued)
  const validBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_TEST_003",
    product_ids: ["TMP-001", "TMP-002", "TMP-001", "TMP-003"]
  });
  const validBatchJson = JSON.parse(validBatchRes.getContent());
  assert("27-4. 重複ID排除と正常作成 (total_count=3, status=queued)",
    validBatchJson.success === true &&
    validBatchJson.total_count === 3 &&
    validBatchJson.status === "queued" &&
    validBatchJson.is_reused === false &&
    validBatchJson.batch_id.startsWith("BAT_")
  );

  const testBatchId = validBatchJson.batch_id;

  // 27-5. create_ai_product_draft_batch: 同一 request_id の再送 (冪等性)
  const dupBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_TEST_003",
    product_ids: ["TMP-001", "TMP-002"]
  });
  const dupBatchJson = JSON.parse(dupBatchRes.getContent());
  assert("27-5. 同一 request_id の再送は既存バッチを返却 (is_reused: true)",
    dupBatchJson.success === true &&
    dupBatchJson.batch_id === testBatchId &&
    dupBatchJson.is_reused === true &&
    dupBatchJson.total_count === 3
  );

  // 27-6. get_ai_product_draft_batch: batch_id 未指定 & 未存在
  const noBatchIdRes = sandbox.handleGetAiProductDraftBatch({});
  assert("27-6a. batch_id 未指定時は BATCH_ID_REQUIRED", JSON.parse(noBatchIdRes.getContent()).error_code === "BATCH_ID_REQUIRED");
  const notFoundBatchRes = sandbox.handleGetAiProductDraftBatch({ batch_id: "BAT_NON_EXISTENT" });
  assert("27-6b. 存在しないバッチは BATCH_NOT_FOUND", JSON.parse(notFoundBatchRes.getContent()).error_code === "BATCH_NOT_FOUND");

  // 27-7. get_ai_product_draft_batch: 正常取得
  const getBatchRes = sandbox.handleGetAiProductDraftBatch({ batch_id: testBatchId });
  const getBatchJson = JSON.parse(getBatchRes.getContent());
  assert("27-7. 進捗・商品別状態の正常取得 (items配列、status階層)",
    getBatchJson.success === true &&
    getBatchJson.batch_id === testBatchId &&
    getBatchJson.status === "queued" &&
    getBatchJson.total_count === 3 &&
    getBatchJson.items.length === 3 &&
    getBatchJson.items[0].product_id === "TMP-001" &&
    getBatchJson.items[0].status === "pending" &&
    getBatchJson.items[1].product_id === "TMP-002" &&
    getBatchJson.items[2].product_id === "TMP-003"
  );

  // 27-8. processAiBatchQueue: 最大3件の処理目安とステータス更新
  // (v79仕様: コア処理が候補を自動反映・確定し、完了判定を通過した場合のみ completed)
  let executedProductIds = [];
  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) => {
    executedProductIds.push(pid);
    return mockCommitDraft(pid, opts, { draft_id: "DRFT_" + pid + "_12345" });
  };

  const workerRunRes = sandbox.processAiBatchQueue();
  assert("27-8. ワーカー実行で3件処理される (max 3件)",
    workerRunRes.processed_count === 3 && executedProductIds.length === 3
  );

  const getAfterRunRes = sandbox.handleGetAiProductDraftBatch({ batch_id: testBatchId });
  const getAfterRunJson = JSON.parse(getAfterRunRes.getContent());
  // 期待値は従来どおり。v79では pending_review を返すだけで本票へ反映しないモックは完了判定で
  // fail-closed となる (旧モックでの失敗理由)。反映・確定まで行うモックへ更新した。
  assert("27-8b. 3件成功後にバッチステータスが completed に更新される",
    getAfterRunJson.status === "completed" &&
    getAfterRunJson.completed_count === 3 &&
    getAfterRunJson.failed_count === 0 &&
    getAfterRunJson.items.every(it => it.status === "completed" && it.draft_id !== null)
  );

  // 27-8c. 候補を保存しても本票反映・確定が未完了なら completed にしない (v79 完了判定の Fail-Closed)
  const unreflectedBatch = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_UNREFLECTED_01",
    product_ids: ["TMP-UNREFLECTED-01"]
  });
  const unreflectedBatchId = JSON.parse(unreflectedBatch.getContent()).batch_id;
  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) =>
    mockCommitDraft(pid, opts, { review_status: "pending_review", confirmed_fingerprint: "" });
  sandbox.processAiBatchQueue();
  const unreflectedJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unreflectedBatchId }).getContent());
  assert("27-8c. 本票反映・確定が未完了の候補は completed にせず failed (CONFIRMED_FINGERPRINT_MISMATCH)",
    unreflectedJson.items[0].status === "failed" &&
    unreflectedJson.items[0].error_code === "CONFIRMED_FINGERPRINT_MISMATCH"
  );

  // 27-9. processAiBatchQueue: 一時エラーの再試行カウントと next_retry_at
  // (実装が実際に返す構造化コード LLM_HTTP_ERROR_503 と安全な固定 message を使用)
  const retryTestBatch = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_TRANSIENT_01",
    product_ids: ["TMP-RETRY-01"]
  });
  const retryBatchId = JSON.parse(retryTestBatch.getContent()).batch_id;

  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid) => {
    const err = new Error(AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE);
    err.error_code = "LLM_HTTP_ERROR_503";
    throw err;
  };

  sandbox.processAiBatchQueue();
  const getRetryBatchJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: retryBatchId }).getContent());
  assert("27-9. LLM_HTTP_ERROR_503 時は status=pending を維持し retry_count=1 となる",
    getRetryBatchJson.items[0].status === "pending" &&
    getRetryBatchJson.items[0].retry_count === 1 &&
    getRetryBatchJson.items[0].error_code === "LLM_HTTP_ERROR_503" &&
    getRetryBatchJson.items[0].error_message === AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE
  );

  // 27-10. processAiBatchQueue: 1件失敗時も残件を継続し、全体ステータスを partially_failed に更新
  const partialBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_PARTIAL_01",
    product_ids: ["TMP-FAIL-01", "TMP-SUCCESS-01"]
  });
  const partialBatchId = JSON.parse(partialBatchRes.getContent()).batch_id;

  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) => {
    if (pid === "TMP-FAIL-01") {
      const err = new Error("Folder not found");
      err.error_code = "NO_DRIVE_FOLDER";
      throw err;
    }
    return mockCommitDraft(pid, opts, { draft_id: "DRFT_" + pid + "_SUCCESS" });
  };

  sandbox.processAiBatchQueue();
  const getPartialBatchJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: partialBatchId }).getContent());
  assert("27-10. 1件失敗・1件成功時に全体 status=partially_failed となる",
    getPartialBatchJson.status === "partially_failed" &&
    getPartialBatchJson.completed_count === 1 &&
    getPartialBatchJson.failed_count === 1 &&
    getPartialBatchJson.items.find(i => i.product_id === "TMP-FAIL-01").status === "failed" &&
    getPartialBatchJson.items.find(i => i.product_id === "TMP-SUCCESS-01").status === "completed"
  );

  // 27-11. processAiBatchQueue: リース期限切れアイテムの自動回収
  const stalledBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_STALLED_01",
    product_ids: ["TMP-STALL-01"]
  });
  const stalledBatchId = JSON.parse(stalledBatchRes.getContent()).batch_id;
  const itemsRows = batchItemsSheet._getRows();
  for (let r = 1; r < itemsRows.length; r++) {
    if (itemsRows[r][0] === stalledBatchId && itemsRows[r][1] === "TMP-STALL-01") {
      itemsRows[r][3] = "processing";
      itemsRows[r][11] = "WRK_OLD_EXPIRED";
      itemsRows[r][12] = new Date(Date.now() - 600000).toISOString();
    }
  }

  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) =>
    mockCommitDraft(pid, opts, { draft_id: "DRFT_STALL_RECOVERED" });

  sandbox.processAiBatchQueue();
  const getStalledJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: stalledBatchId }).getContent());
  assert("27-11. リース期限切れアイテムが新ワーカーにより回収・完了される",
    getStalledJson.status === "completed" &&
    getStalledJson.items[0].status === "completed" &&
    getStalledJson.items[0].draft_id === "DRFT_STALL_RECOVERED"
  );

  // 27-12. Fencing: 処理中に別ワーカーへ所有権が移った場合、古いワーカーは候補保存も状態更新も行わない
  const fencingBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_FENCING_01",
    product_ids: ["TMP-FENCE-01"]
  });
  const fencingBatchId = JSON.parse(fencingBatchRes.getContent()).batch_id;

  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) => {
    // LLM 通信中に別ワーカーが回収した状況を再現
    const row = findItemRow27(fencingBatchId, "TMP-FENCE-01");
    row[11] = "WRK_NEW_TAKEOVER";
    row[12] = new Date(Date.now() + 300000).toISOString();
    return mockCommitDraft(pid, opts, { draft_id: "DRFT_OLD_SHOULD_DISCARD" });
  };

  sandbox.processAiBatchQueue();
  const fenceRow = findItemRow27(fencingBatchId, "TMP-FENCE-01");
  assert("27-12. Fencing: 古いワーカーは候補を保存せず、新ワーカーの状態 (worker_id/status/draft_id) を変更しない",
    countDraftRows27("TMP-FENCE-01") === 0 &&
    fenceRow[11] === "WRK_NEW_TAKEOVER" &&
    fenceRow[3] === "processing" &&
    fenceRow[4] !== "DRFT_OLD_SHOULD_DISCARD"
  );

  // 27-13. 中断回復: このアイテムが予約・保存した候補 (draft_id 一致) のみを LLM 再呼出しなしで回収
  const recovBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_RECOV_01",
    product_ids: ["TMP-RECOV-01"]
  });
  const recovBatchId = JSON.parse(recovBatchRes.getContent()).batch_id;
  appendMockDraftRow({
    draft_id: "DRFT_PRE_SAVED_001",
    product_id: "TMP-RECOV-01",
    draft_version: 1,
    review_status: "confirmed",
    confirmed_fingerprint: "FP_OK",
    model_name: "gemini-3.5-flash-lite",
    generated_at: new Date().toISOString()
  });
  const recovRow = findItemRow27(recovBatchId, "TMP-RECOV-01");
  recovRow[3] = "processing";
  recovRow[4] = "DRFT_PRE_SAVED_001"; // commit 時に予約済みの draft_id
  recovRow[11] = "WRK_CRASHED";
  recovRow[12] = new Date(Date.now() - 600000).toISOString();

  let executeCalledForRecov = false;
  sandbox.executeSingleAiProductDraftCore_ = () => {
    executeCalledForRecov = true;
    return { success: true };
  };

  sandbox.processAiBatchQueue();
  const getRecovJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: recovBatchId }).getContent());
  assert("27-13. 予約済み draft_id の保存済み候補はLLMを再呼出しせず回収して完了",
    executeCalledForRecov === false &&
    getRecovJson.items[0].status === "completed" &&
    getRecovJson.items[0].draft_id === "DRFT_PRE_SAVED_001"
  );

  // 27-13b. アイテムに対応しない過去候補 (最新ドラフト) は流用せず、新規生成する
  const noReuseBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_NO_REUSE_01",
    product_ids: ["TMP-RECOV-01"]
  });
  const noReuseBatchId = JSON.parse(noReuseBatchRes.getContent()).batch_id;
  let executeCalledForNoReuse = false;
  sandbox.executeSingleAiProductDraftCore_ = (sheet, pid, opts) => {
    executeCalledForNoReuse = true;
    return mockCommitDraft(pid, opts, { draft_id: "DRFT_FRESH_FOR_NEW_ITEM" });
  };
  sandbox.processAiBatchQueue();
  const noReuseJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: noReuseBatchId }).getContent());
  assert("27-13b. 最新ドラフトが存在するだけでは過去候補を流用せず新規生成する",
    executeCalledForNoReuse === true &&
    noReuseJson.items[0].status === "completed" &&
    noReuseJson.items[0].draft_id === "DRFT_FRESH_FOR_NEW_ITEM"
  );

  // 27-14. retry_ai_product_draft_batch: 失敗分のみ pending に戻し、成功分は再生成しない
  const retryActionRes = sandbox.handleRetryAiProductDraftBatch({
    batch_id: partialBatchId,
    request_id: "REQ_RETRY_ACTION_01"
  });
  const retryActionJson = JSON.parse(retryActionRes.getContent());
  assert("27-14. retry_ai_product_draft_batch で失敗1件のみ pending に戻り、バッチは queued に復帰",
    retryActionJson.success === true &&
    retryActionJson.retried_count === 1 &&
    retryActionJson.completed_count === 1 &&
    retryActionJson.status === "queued"
  );

  const getAfterRetryJson = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: partialBatchId }).getContent());
  assert("27-14b. 成功済み商品は completed を維持し、失敗商品のみ pending にリセット",
    getAfterRetryJson.items.find(i => i.product_id === "TMP-SUCCESS-01").status === "completed" &&
    getAfterRetryJson.items.find(i => i.product_id === "TMP-FAIL-01").status === "pending"
  );

  // 27-15. ensureAiBatchTrigger: トリガー重複作成防止 (1つだけ設置)
  sandbox._mockTriggers = [];
  const trg1 = sandbox.ensureAiBatchTrigger();
  const trg2 = sandbox.ensureAiBatchTrigger();
  assert("27-15. ensureAiBatchTrigger は多重呼出しでもトリガーを重複作成しない (count=1)",
    sandbox._mockTriggers.length === 1 && trg1 !== null && trg2 !== null
  );

  // 27-15b. 重複トリガーの自動クリーンアップ
  sandbox._mockTriggers.push({
    getHandlerFunction: () => "processAiBatchQueue",
    getUniqueId: () => "mock-dup-1"
  });
  sandbox._mockTriggers.push({
    getHandlerFunction: () => "processAiBatchQueue",
    getUniqueId: () => "mock-dup-2"
  });
  const cleanTrg = sandbox.ensureAiBatchTrigger();
  assert("27-15b. ensureAiBatchTrigger は重複トリガーを削除し1つだけ維持する (count=1)",
    sandbox._mockTriggers.length === 1 && cleanTrg !== null
  );

  // 27-16. doPost / doGet: mode=admin なしの batch API は UNAUTHORIZED_ADMIN_ACCESS で拒否
  mockScriptProperties["ADMIN_API_KEY"] = "VALID_ADMIN_KEY";
  const unauthPost = sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "create_ai_product_draft_batch",
        request_id: "REQ_UNAUTH_01",
        product_ids: ["TMP-001"]
      })
    }
  });
  const unauthPostJson = JSON.parse(unauthPost.getContent());
  assert("27-16a. doPost create_ai_product_draft_batch (認証なし) は UNAUTHORIZED_ADMIN_ACCESS",
    unauthPostJson.success === false && unauthPostJson.error_code === "UNAUTHORIZED_ADMIN_ACCESS"
  );

  const unauthGet = sandbox.doGet({
    parameter: {
      action: "get_ai_product_draft_batch",
      batch_id: testBatchId
    }
  });
  const unauthGetJson = JSON.parse(unauthGet.getContent());
  assert("27-16b. doGet get_ai_product_draft_batch (認証なし) は UNAUTHORIZED_ADMIN_ACCESS",
    unauthGetJson.success === false && unauthGetJson.error_code === "UNAUTHORIZED_ADMIN_ACCESS"
  );

  // Section 27 で差し替えた完了判定モックを実装へ戻す
  sandbox.verifyProductDraftReflectionCompleted_ = originalVerifyReflection27;
})();

// --------------------------------------------------
// 29. v79自動反映 + 一時エラー再試行・ワーカー所有権・再試行冪等性 (実関数による統合検証)
//     ※ 旧端末の148件版ハーネスは未回収。本セクションは今回の修正と v79 仕様の検証用に新規作成したもので、
//       失われた148件版と同等であることは保証しない。
// --------------------------------------------------
(() => {
  console.log("\n--- [29. v79自動反映・再試行・所有権・冪等性 統合検証] ---");

  const realCore29 = executeSingleAiProductDraftCore_;
  const realCallGemini29 = vm.runInContext("callGeminiMultimodalAiDraft_", sandbox);
  const realApplyExisting29 = vm.runInContext("applyExistingAiDraftToProductRecord_", sandbox);
  const realVerify29 = vm.runInContext("verifyProductDraftReflectionCompleted_", sandbox);
  const realIsTransient29 = vm.runInContext("isTransientLlmError_", sandbox);
  const realGetJobOptions29 = vm.runInContext("getAiBatchJobOptions_", sandbox);
  const realGetJobsSheet29 = vm.runInContext("getOrCreateAiBatchJobsSheet_", sandbox);

  // 本セクションで差し替える sandbox 値を退避 (終了時に復元)
  const savedKeys29 = [
    "executeSingleAiProductDraftCore_", "callGeminiMultimodalAiDraft_", "callGeminiMultimodalAiDraftWithSearch_",
    "getValidatedProductDriveImages_", "computeImageFingerprintFromFolderUrl_", "computeConfirmedProductFingerprint_",
    "getLatestProductAiDraft_", "verifyProductDraftReflectionCompleted_", "findProductRow", "getProductTranslation",
    "saveProductTranslation", "getPokemonCardByProductId", "UrlFetchApp", "saveConfirmedProductTranslation_",
    "getOrCreateProductAiDraftsSheet_", "computeProductSourceFingerprint_", "assertProductPublishable_"
  ];
  const saved29 = {};
  savedKeys29.forEach(k => { saved29[k] = sandbox[k]; });
  const savedSpreadsheetFn29 = sandbox.SpreadsheetApp.getActiveSpreadsheet;
  const savedSleep29 = sandbox.Utilities.sleep;

  const MAIN_HEADERS = [];
  for (let i = 0; i < 40; i++) MAIN_HEADERS.push("col_" + (i + 1));
  MAIN_HEADERS[1] = "product_id";
  MAIN_HEADERS[39] = "ai_draft_flag";

  let env = null;
  let geminiCalls = [];
  let fetchCount = 0;

  const buildProductRow = (pid, overrides) => {
    const row = new Array(40).fill("");
    row[0] = new Date();
    row[1] = pid;
    row[2] = "sneaker";
    row[29] = "https://drive.google.com/folders/F_" + pid;
    row[31] = "draft";
    row[32] = "in_stock";
    row[33] = "active";
    Object.keys(overrides || {}).forEach(k => { row[Number(k)] = overrides[k]; });
    return row;
  };

  const resetEnv = () => {
    const main = createMockBatchSheet("main", MAIN_HEADERS);
    main.getMaxColumns = () => 40;
    main.insertColumnsAfter = () => {};
    const jobs = createMockBatchSheet("ai_batch_jobs", AI_BATCH_CONFIG.JOB_HEADERS);
    const items = createMockBatchSheet("ai_batch_items", AI_BATCH_CONFIG.ITEM_HEADERS);
    const drafts = createMockBatchSheet("product_ai_drafts", AI_DRAFT_CONFIG.HEADERS);
    const map = { "ai_batch_jobs": jobs, "ai_batch_items": items, "product_ai_drafts": drafts };
    env = { main, jobs, items, drafts, map, translations: {} };
    sandbox.SpreadsheetApp.getActiveSpreadsheet = () => ({
      getSheets: () => [main],
      getSheetByName: (name) => map[name] || null,
      insertSheet: (name) => { const s = createMockBatchSheet(name); map[name] = s; return s; }
    });
    Object.keys(mockScriptProperties).forEach(k => {
      if (k.indexOf("AI_GEN_LOCK_") === 0) delete mockScriptProperties[k];
    });
    mockScriptProperties["LLM_API_KEY"] = "dummy-test-key";
    geminiCalls = [];
    fetchCount = 0;
  };

  const addProduct = (pid, overrides) => {
    env.main.appendRow(buildProductRow(pid, overrides));
  };
  const mainRow = (pid) => env.main._getRows().find(r => r[1] === pid);
  const itemRow = (batchId, pid) => env.items._getRows().find(r => r[0] === batchId && r[1] === pid);
  const draftRows = (pid) => env.drafts._getRows().slice(1).filter(r => r[1] === pid);
  const draftCol = (name) => AI_DRAFT_CONFIG.HEADERS.indexOf(name);
  const getBatch = (batchId) => JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: batchId }).getContent());
  const createBatch = (reqId, pids, extra) =>
    JSON.parse(sandbox.handleCreateAiProductDraftBatch(Object.assign({ request_id: reqId, product_ids: pids }, extra || {})).getContent());

  const sampleCandidate = (overrides) => Object.assign({
    title_ja: "ナイキ エアジョーダン1 シカゴ",
    hashtags_ja: "#NIKE #AJ1",
    description_ja: "AIによる説明文です。",
    title_en: "Nike Air Jordan 1 Chicago",
    description_en: "AI generated English description.",
    condition: "目立った傷や汚れなし",
    price: 15000,
    price_note: "AIによる概算価格です",
    category: "sneaker",
    brand: "NIKE",
    sku: "555088-101",
    size: "27.0",
    identity_status: "confident",
    price_evidence_verified: true,
    actual_model_name: "gemini-3.5-flash-lite"
  }, overrides || {});

  const appendDraft = (rec) => {
    env.drafts.appendRow(AI_DRAFT_CONFIG.HEADERS.map(h => (rec[h] !== undefined ? rec[h] : "")));
  };

  // 共通スタブ (Drive / 翻訳 / 行検索)。LLM 応答は各テストで設定
  const installCommonStubs = () => {
    sandbox.executeSingleAiProductDraftCore_ = realCore29;
    sandbox.saveConfirmedProductTranslation_ = saveConfirmedProductTranslation_; // 前セクションのスタブを実装へ戻す
    sandbox.getOrCreateProductAiDraftsSheet_ = originalGetOrCreateDraftsSheet;
    sandbox.computeProductSourceFingerprint_ = computeProductSourceFingerprint_;
    sandbox.assertProductPublishable_ = assertProductPublishable_;
    sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
    sandbox.computeConfirmedProductFingerprint_ = originalComputeConfirmedFp;
    sandbox.verifyProductDraftReflectionCompleted_ = realVerify29;
    sandbox.computeImageFingerprintFromFolderUrl_ = (url) => "IMGFP::" + url;
    sandbox.getValidatedProductDriveImages_ = () => ({
      images: [{ mimeType: "image/jpeg", base64: "AA==", fileId: "f1", fileName: "1.jpg" }],
      imageIds: ["f1"]
    });
    sandbox.findProductRow = (sheet, pid) => {
      const rows = sheet._getRows ? sheet._getRows() : [];
      const idx = rows.findIndex((r, i) => i > 0 && r[1] === pid);
      if (idx < 1) throw new Error("product not found: " + pid);
      return idx + 1;
    };
    sandbox.getProductTranslation = (pid) => env.translations[pid] || null;
    sandbox.saveProductTranslation = (pid, rec) => { env.translations[pid] = Object.assign({}, rec); return { success: true }; };
    sandbox.getPokemonCardByProductId = () => null;
    sandbox.Utilities.sleep = () => {};
  };

  const stubGeminiSuccess = (candOverrides) => {
    sandbox.callGeminiMultimodalAiDraft_ = (images, meta, overrideModel) => {
      geminiCalls.push({ productId: meta.productId, overrideModel: overrideModel || "" });
      return sampleCandidate(Object.assign({ actual_model_name: overrideModel || "gemini-3.8-flash" }, candOverrides || {}));
    };
    sandbox.callGeminiMultimodalAiDraftWithSearch_ = (images, meta, overrideModel, options) => {
      geminiCalls.push({ productId: meta.productId, overrideModel: overrideModel || "" });
      const candidate = sampleCandidate(Object.assign({ actual_model_name: overrideModel || "gemini-3.8-flash" }, candOverrides || {}));
      candidate.search_grounding = {
        enabled: true,
        mode_used: "two_stage",
        search_executed: true,
        queries: ["nike air jordan 1 chicago"],
        sources: [{ uri: "https://example.com/chicago", title: "Air Jordan 1 Chicago" }],
        queries_count: 1,
        sources_count: 1,
        stage_a_elapsed_ms: 1200,
        stage_b_elapsed_ms: 800,
        search_total_elapsed_ms: 2000,
        search_finish_reason: "STOP",
        search_tokens_json: JSON.stringify({ prompt: 100, candidates: 50 })
      };
      return candidate;
    };
  };

  // 実 callGeminiMultimodalAiDraft_ を UrlFetchApp モックで動かし、実装が実際に返すエラーコードを得る
  const useRealGeminiWithHttp = (handler) => {
    sandbox.callGeminiMultimodalAiDraft_ = realCallGemini29;
    sandbox.UrlFetchApp = {
      fetch: () => {
        fetchCount++;
        return handler();
      }
    };
  };
  const httpResponse = (code, body) => ({ getResponseCode: () => code, getContentText: () => body });

  // ------------------------------------------------------------
  // 29-1. 一時エラー判定は構造化コードのみ (message は判定に使わない)
  // ------------------------------------------------------------
  const transientCodes = ["LLM_HTTP_ERROR_429", "LLM_HTTP_ERROR_500", "LLM_HTTP_ERROR_502", "LLM_HTTP_ERROR_503", "LLM_HTTP_ERROR_504", "LLM_COMMUNICATION_FAILED"];
  const nonTransientCodes = ["LLM_HTTP_ERROR_400", "LLM_HTTP_ERROR_403", "STRUCTURED_PARSE_FAILED", "EMPTY_LLM_RESPONSE", "NO_DRIVE_FOLDER", "CONFIRMED_DRAFT_EXISTS", "BATCH_ITEM_OWNERSHIP_LOST"];
  const mkErr = (code, msg) => { const e = new Error(msg || AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE); if (code) e.error_code = code; return e; };
  assert("29-1a. 実装が返す一時エラーコード (429/500/502/503/504/通信例外) は再試行対象",
    transientCodes.every(c => realIsTransient29(mkErr(c)) === true));
  assert("29-1b. 恒久エラーコードは再試行対象外",
    nonTransientCodes.every(c => realIsTransient29(mkErr(c)) === false));
  assert("29-1c. コードなしで message に 503 を含むだけでは再試行対象外 (message 非依存)",
    realIsTransient29(mkErr("", "503 Service Unavailable")) === false);

  // ------------------------------------------------------------
  // 29-2〜29-4. 実 Gemini 呼出し経路の HTTP 503 → LLM_HTTP_ERROR_503 → 再試行予約・待機・上限・最終失敗
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  addProduct("TMP-T503");
  useRealGeminiWithHttp(() => httpResponse(503, JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded." } })));
  const b503 = createBatch("REQ_29_503", ["TMP-T503"]);
  const t0 = Date.now();
  sandbox.processAiBatchQueue();
  let r503 = itemRow(b503.batch_id, "TMP-T503");
  const firstFetchCount = fetchCount;
  const nextRetryMs = new Date(r503[10]).getTime() - t0;
  assert("29-2. HTTP 503 は LLM_HTTP_ERROR_503 として pending・retry_count=1・next_retry_at 予約 (安全な固定 message)",
    r503[3] === "pending" &&
    r503[7] === "LLM_HTTP_ERROR_503" &&
    r503[8] === AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE &&
    Number(r503[9]) === 1 &&
    nextRetryMs >= AI_BATCH_CONFIG.RETRY_BACKOFF_MS - 1000 && nextRetryMs <= AI_BATCH_CONFIG.RETRY_BACKOFF_MS + 5000 &&
    firstFetchCount >= 1,
    JSON.stringify({ status: r503[3], code: r503[7], rc: r503[9], next: r503[10], fetchCount })
  );
  assert("29-2b. 再試行予約時は商品のAI生成実行ロックが解放されている",
    !mockScriptProperties["AI_GEN_LOCK_TMP-T503"]);

  const runRes503 = sandbox.processAiBatchQueue();
  r503 = itemRow(b503.batch_id, "TMP-T503");
  assert("29-3. next_retry_at 到達前は再取得せず LLM も呼ばない",
    runRes503.processed_count === 0 && fetchCount === firstFetchCount && Number(r503[9]) === 1);

  const retryCounts = [];
  for (let i = 0; i < 3; i++) {
    r503 = itemRow(b503.batch_id, "TMP-T503");
    r503[10] = new Date(Date.now() - 1000).toISOString();
    sandbox.processAiBatchQueue();
    r503 = itemRow(b503.batch_id, "TMP-T503");
    retryCounts.push(r503[3] + ":" + r503[9]);
  }
  const b503Json = getBatch(b503.batch_id);
  assert("29-4. 再試行上限 (MAX_RETRIES=3) 到達後の失敗は failed・retry_count=3・next_retry_at 空・バッチ failed",
    retryCounts.join(",") === "pending:2,pending:3,failed:3" &&
    r503[7] === "LLM_HTTP_ERROR_503" &&
    r503[10] === "" &&
    b503Json.status === "failed" && b503Json.failed_count === 1,
    retryCounts.join(",") + " / batch=" + b503Json.status
  );

  // 29-5. 通信例外 → LLM_COMMUNICATION_FAILED は再試行予約
  resetEnv();
  installCommonStubs();
  addProduct("TMP-TNET");
  useRealGeminiWithHttp(() => { throw new Error("Timeout: request timed out"); });
  const bNet = createBatch("REQ_29_NET", ["TMP-TNET"]);
  sandbox.processAiBatchQueue();
  const rNet = itemRow(bNet.batch_id, "TMP-TNET");
  assert("29-5. 通信例外は LLM_COMMUNICATION_FAILED として pending・retry_count=1 (固定 message)",
    rNet[3] === "pending" && rNet[7] === "LLM_COMMUNICATION_FAILED" && Number(rNet[9]) === 1 &&
    rNet[8] === AI_DRAFT_CONFIG.SAFE_LLM_ERROR_MESSAGE && rNet[10] !== "");

  // 29-5b. HTTP 429 も再試行予約
  resetEnv();
  installCommonStubs();
  addProduct("TMP-T429");
  useRealGeminiWithHttp(() => httpResponse(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } })));
  const b429 = createBatch("REQ_29_429", ["TMP-T429"]);
  sandbox.processAiBatchQueue();
  const r429 = itemRow(b429.batch_id, "TMP-T429");
  assert("29-5b. HTTP 429 は LLM_HTTP_ERROR_429 として pending・retry_count=1",
    r429[3] === "pending" && r429[7] === "LLM_HTTP_ERROR_429" && Number(r429[9]) === 1);

  // 29-6. 恒久エラー (HTTP 400) は即 failed
  resetEnv();
  installCommonStubs();
  addProduct("TMP-T400");
  useRealGeminiWithHttp(() => httpResponse(400, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad" } })));
  const b400 = createBatch("REQ_29_400", ["TMP-T400"]);
  sandbox.processAiBatchQueue();
  const r400 = itemRow(b400.batch_id, "TMP-T400");
  assert("29-6. HTTP 400 は LLM_HTTP_ERROR_400 として再試行せず failed・retry_count=0",
    r400[3] === "failed" && r400[7] === "LLM_HTTP_ERROR_400" && Number(r400[9] || 0) === 0 && r400[10] === "");

  // ------------------------------------------------------------
  // 29-7. 自動反映 (実コア + 実反映 + 実完了判定) と公開ゲート
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-AUTO");
  const bAuto = createBatch("REQ_29_AUTO", ["TMP-AUTO"]);
  sandbox.processAiBatchQueue();
  const rAuto = itemRow(bAuto.batch_id, "TMP-AUTO");
  const mAuto = mainRow("TMP-AUTO");
  const dAuto = draftRows("TMP-AUTO");
  const latestAuto = originalGetLatestProductAiDraft("TMP-AUTO");
  let verifyAutoOk = false;
  try { realVerify29(env.main, 2, "TMP-AUTO", latestAuto); verifyAutoOk = true; } catch (_) {}
  assert("29-7. 自動反映: 本票・英文へ反映し confirmed、アイテムは自分の draft_id で completed、完了判定を通過",
    rAuto[3] === "completed" &&
    dAuto.length === 1 &&
    rAuto[4] === dAuto[0][draftCol("draft_id")] &&
    dAuto[0][draftCol("review_status")] === "confirmed" &&
    dAuto[0][draftCol("confirmed_by")] === "ai_batch_worker" &&
    mAuto[4] === "ナイキ エアジョーダン1 シカゴ" &&
    mAuto[7] === 15000 &&
    mAuto[12] === "27.0" &&
    mAuto[39] === "ai_managed" &&
    env.translations["TMP-AUTO"] && env.translations["TMP-AUTO"].translation_status === "approved" &&
    verifyAutoOk,
    JSON.stringify({ status: rAuto[3], err: rAuto[7], msg: rAuto[8] })
  );

  let gateOk = false;
  try { gateOk = assertProductPublishable_(env.main, 2, "TMP-AUTO") === true; } catch (_) {}
  mAuto[9] = mAuto[9] + "（スタッフ追記）";
  let gateBlockedCode = "";
  try { assertProductPublishable_(env.main, 2, "TMP-AUTO"); } catch (e) { gateBlockedCode = e.error_code; }
  assert("29-7b. 公開ゲート: 自動反映直後は公開可、確定後に本票を直接変更すると AI_DRAFT_MODIFIED_AFTER_CONFIRMATION",
    gateOk === true && gateBlockedCode === "AI_DRAFT_MODIFIED_AFTER_CONFIRMATION");

  // 29-8. スタッフ入力保護 (入力済み価格・サイズは上書きしない) と サイズ空欄時の公開ゲート
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-STAFF", { 7: 30000, 12: "28.5" });
  addProduct("TMP-NOSIZE");
  const bStaff = createBatch("REQ_29_STAFF", ["TMP-STAFF"]);
  sandbox.processAiBatchQueue();
  const mStaff = mainRow("TMP-STAFF");
  assert("29-8. スタッフ入力済みの価格・サイズは自動反映で上書きされない (completed)",
    itemRow(bStaff.batch_id, "TMP-STAFF")[3] === "completed" && mStaff[7] === 30000 && mStaff[12] === "28.5");

  stubGeminiSuccess({ size: "" });
  const bNoSize = createBatch("REQ_29_NOSIZE", ["TMP-NOSIZE"]);
  sandbox.processAiBatchQueue();
  let noSizeGate = "";
  try { assertProductPublishable_(env.main, 3, "TMP-NOSIZE"); } catch (e) { noSizeGate = e.error_code; }
  assert("29-8b. サイズ空欄の自動反映は completed になるが公開ゲートで SNEAKER_SIZE_REQUIRED",
    itemRow(bNoSize.batch_id, "TMP-NOSIZE")[3] === "completed" && noSizeGate === "SNEAKER_SIZE_REQUIRED");

  resetEnv();
  installCommonStubs();
  addProduct("TMP-CANDIDATE");
  stubGeminiSuccess({
    identity_status: "candidate",
    size: "",
    sku: "",
    price: 19300,
    title_ja: "ナイキ ダンク ロー CO.JP ワット ザ",
    needs_review: ["size", "sku"]
  });
  const bCandidate = createBatch("REQ_29_CANDIDATE", ["TMP-CANDIDATE"]);
  sandbox.processAiBatchQueue();
  const mCand = mainRow("TMP-CANDIDATE");
  const candItem = itemRow(bCandidate.batch_id, "TMP-CANDIDATE");
  assert("29-8c. identity_status: candidate (サイズ・SKU未確認) でも商品名・価格案が本票へ自動反映され completed になること",
    candItem[3] === "completed" &&
    mCand[4] === "ナイキ ダンク ロー CO.JP ワット ザ" &&
    mCand[7] === 19300 &&
    mCand[12] === "");

  // ------------------------------------------------------------
  // 29-9〜29-10. 古いワーカーの保存拒否 (保存直前の所有権・リース確認)
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  addProduct("TMP-STALE");
  const bStale = createBatch("REQ_29_STALE", ["TMP-STALE"]);
  const staleStub = () => {
    // LLM 通信中にリース失効 → 別ワーカーが回収した状況
    const row = itemRow(bStale.batch_id, "TMP-STALE");
    row[11] = "WRK_NEW_OWNER";
    row[12] = new Date(Date.now() + 300000).toISOString();
    const cand = sampleCandidate();
    cand.search_grounding = {
      enabled: true, mode_used: "two_stage", search_executed: true,
      queries: ["q"], sources: [{ uri: "u", title: "t" }],
      queries_count: 1, sources_count: 1,
      stage_a_elapsed_ms: 100, stage_b_elapsed_ms: 100, search_total_elapsed_ms: 200,
      search_finish_reason: "STOP", search_tokens_json: "{}"
    };
    return cand;
  };
  sandbox.callGeminiMultimodalAiDraft_ = staleStub;
  sandbox.callGeminiMultimodalAiDraftWithSearch_ = staleStub;
  sandbox.processAiBatchQueue();
  const rStale = itemRow(bStale.batch_id, "TMP-STALE");
  const mStale = mainRow("TMP-STALE");
  assert("29-9. 別ワーカーに回収された古いワーカーは候補保存・本票反映・アイテム更新を行わない",
    draftRows("TMP-STALE").length === 0 &&
    mStale[4] === "" && mStale[9] === "" &&
    !env.translations["TMP-STALE"] &&
    rStale[11] === "WRK_NEW_OWNER" && rStale[3] === "processing" && rStale[4] === "" &&
    !mockScriptProperties["AI_GEN_LOCK_TMP-STALE"]
  );

  resetEnv();
  installCommonStubs();
  addProduct("TMP-LEASE");
  const bLease = createBatch("REQ_29_LEASE", ["TMP-LEASE"]);
  let originalWorkerId = "";
  const leaseStub = () => {
    const row = itemRow(bLease.batch_id, "TMP-LEASE");
    originalWorkerId = row[11];
    row[12] = new Date(Date.now() - 1000).toISOString(); // 回収前にリースのみ失効
    const cand = sampleCandidate();
    cand.search_grounding = {
      enabled: true, mode_used: "two_stage", search_executed: true,
      queries: ["q"], sources: [{ uri: "u", title: "t" }],
      queries_count: 1, sources_count: 1,
      stage_a_elapsed_ms: 100, stage_b_elapsed_ms: 100, search_total_elapsed_ms: 200,
      search_finish_reason: "STOP", search_tokens_json: "{}"
    };
    return cand;
  };
  sandbox.callGeminiMultimodalAiDraft_ = leaseStub;
  sandbox.callGeminiMultimodalAiDraftWithSearch_ = leaseStub;
  sandbox.processAiBatchQueue();
  const rLease = itemRow(bLease.batch_id, "TMP-LEASE");
  assert("29-10. リース失効後は (回収前でも) 保存せず、アイテムを failed/pending へ変更しない",
    draftRows("TMP-LEASE").length === 0 && mainRow("TMP-LEASE")[4] === "" &&
    rLease[3] === "processing" && rLease[11] === originalWorkerId && Number(rLease[9] || 0) === 0);

  stubGeminiSuccess();
  sandbox.processAiBatchQueue();
  const rLease2 = itemRow(bLease.batch_id, "TMP-LEASE");
  assert("29-10b. 失効アイテムは次のワーカーが回収し、新しい所有者として正常完了する",
    rLease2[3] === "completed" && rLease2[11] !== originalWorkerId && draftRows("TMP-LEASE").length === 1);

  // ------------------------------------------------------------
  // 29-11〜29-14. 回収対象はアイテムに対応する候補のみ
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-OLD");
  appendDraft({
    draft_id: "DRFT_TMP-OLD_SINGLE", product_id: "TMP-OLD", draft_version: 1, review_status: "pending_review",
    candidate_title_ja: "単品生成の古い候補", generated_at: new Date(Date.now() - 3600000).toISOString()
  });
  const bOld = createBatch("REQ_29_OLD", ["TMP-OLD"]);
  sandbox.processAiBatchQueue();
  const rOld = itemRow(bOld.batch_id, "TMP-OLD");
  const oldRows = draftRows("TMP-OLD");
  assert("29-11. アイテムに対応しない過去候補は流用せず新規生成 (旧候補は stale、新候補で completed)",
    geminiCalls.length === 1 && rOld[3] === "completed" && rOld[4] !== "DRFT_TMP-OLD_SINGLE" &&
    oldRows[0][draftCol("review_status")] === "stale" && mainRow("TMP-OLD")[4] === "ナイキ エアジョーダン1 シカゴ");

  // 29-12. 途中保存からの復旧: 予約済み候補 (pending_review) を LLM 再呼出しなしで反映 (本票が部分反映済み)
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-RESUME");
  const resumeSourceFp = computeProductSourceFingerprint_(env.main, 2, "TMP-RESUME");
  const resumeCand = sampleCandidate();
  appendDraft({
    draft_id: "DRFT_TMP-RESUME_1", product_id: "TMP-RESUME", draft_version: 1, review_status: "pending_review",
    candidate_title_ja: resumeCand.title_ja, candidate_hashtags_ja: resumeCand.hashtags_ja,
    candidate_description_ja: resumeCand.description_ja, candidate_title_en: resumeCand.title_en,
    candidate_description_en: resumeCand.description_en, candidate_condition: resumeCand.condition,
    candidate_price: resumeCand.price, candidate_category: resumeCand.category, candidate_brand: resumeCand.brand,
    candidate_sku: resumeCand.sku, candidate_size: resumeCand.size, source_fingerprint: resumeSourceFp,
    source_image_fingerprint: "IMGFP::https://drive.google.com/folders/F_TMP-RESUME",
    model_name: "gemini-3.5-flash-lite", generated_at: new Date().toISOString()
  });
  mainRow("TMP-RESUME")[4] = resumeCand.title_ja; // 商品名のみ書込み済みで中断した状態
  const bResume = createBatch("REQ_29_RESUME", ["TMP-RESUME"]);
  const resumeItem = itemRow(bResume.batch_id, "TMP-RESUME");
  resumeItem[3] = "processing";
  resumeItem[4] = "DRFT_TMP-RESUME_1";
  resumeItem[11] = "WRK_CRASHED";
  resumeItem[12] = new Date(Date.now() - 1000).toISOString();
  sandbox.processAiBatchQueue();
  const rResume = itemRow(bResume.batch_id, "TMP-RESUME");
  const dResume = draftRows("TMP-RESUME")[0];
  assert("29-12. 途中保存からの復旧: 予約済み候補を LLM 再呼出しなしで反映・確定し completed",
    geminiCalls.length === 0 && rResume[3] === "completed" && rResume[4] === "DRFT_TMP-RESUME_1" &&
    dResume[draftCol("review_status")] === "confirmed" && mainRow("TMP-RESUME")[9].indexOf("AIによる説明文です。") === 0,
    JSON.stringify({ status: rResume[3], err: rResume[7], msg: rResume[8] })
  );

  // 29-12b. スタッフ入力保護: 復旧対象でもスタッフ編集済みなら上書きしない
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-STAFFEDIT");
  const staffSourceFp = computeProductSourceFingerprint_(env.main, 2, "TMP-STAFFEDIT");
  appendDraft({
    draft_id: "DRFT_TMP-STAFFEDIT_1", product_id: "TMP-STAFFEDIT", draft_version: 1, review_status: "pending_review",
    candidate_title_ja: resumeCand.title_ja, candidate_description_ja: resumeCand.description_ja,
    candidate_condition: resumeCand.condition, candidate_category: "sneaker", source_fingerprint: staffSourceFp,
    source_image_fingerprint: "IMGFP::https://drive.google.com/folders/F_TMP-STAFFEDIT", generated_at: new Date().toISOString()
  });
  mainRow("TMP-STAFFEDIT")[4] = "スタッフが入力した商品名";
  const bStaffEdit = createBatch("REQ_29_STAFFEDIT", ["TMP-STAFFEDIT"]);
  const staffEditItem = itemRow(bStaffEdit.batch_id, "TMP-STAFFEDIT");
  staffEditItem[3] = "processing";
  staffEditItem[4] = "DRFT_TMP-STAFFEDIT_1";
  staffEditItem[11] = "WRK_CRASHED";
  staffEditItem[12] = new Date(Date.now() - 1000).toISOString();
  sandbox.processAiBatchQueue();
  const rStaffEdit = itemRow(bStaffEdit.batch_id, "TMP-STAFFEDIT");
  assert("29-12b. スタッフ編集済みの本票は復旧で上書きせず failed (SOURCE_MODIFIED_DURING_GENERATION)",
    rStaffEdit[3] === "failed" && rStaffEdit[7] === "SOURCE_MODIFIED_DURING_GENERATION" &&
    mainRow("TMP-STAFFEDIT")[4] === "スタッフが入力した商品名" && geminiCalls.length === 0);

  // 29-13. 予約済み候補より新しい候補が存在する場合は古い候補で上書きしない
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-SUPER");
  appendDraft({ draft_id: "DRFT_TMP-SUPER_1", product_id: "TMP-SUPER", draft_version: 1, review_status: "stale", candidate_title_ja: "古い候補" });
  appendDraft({ draft_id: "DRFT_TMP-SUPER_2", product_id: "TMP-SUPER", draft_version: 2, review_status: "pending_review", candidate_title_ja: "新しい候補" });
  const bSuper = createBatch("REQ_29_SUPER", ["TMP-SUPER"]);
  const superItem = itemRow(bSuper.batch_id, "TMP-SUPER");
  superItem[3] = "processing";
  superItem[4] = "DRFT_TMP-SUPER_1";
  superItem[11] = "WRK_CRASHED";
  superItem[12] = new Date(Date.now() - 1000).toISOString();
  sandbox.processAiBatchQueue();
  const rSuper = itemRow(bSuper.batch_id, "TMP-SUPER");
  assert("29-13. 予約済み候補が新しい候補に置き換わっていれば failed (AI_DRAFT_SUPERSEDED)、本票・LLM 不変",
    rSuper[3] === "failed" && rSuper[7] === "AI_DRAFT_SUPERSEDED" && geminiCalls.length === 0 && mainRow("TMP-SUPER")[4] === "");

  // 29-14. 予約済み draft_id の候補が未保存 (保存前に中断) なら再生成
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-UNSAVED");
  const bUnsaved = createBatch("REQ_29_UNSAVED", ["TMP-UNSAVED"]);
  const unsavedItem = itemRow(bUnsaved.batch_id, "TMP-UNSAVED");
  unsavedItem[3] = "processing";
  unsavedItem[4] = "DRFT_TMP-UNSAVED_NEVER_SAVED";
  unsavedItem[11] = "WRK_CRASHED";
  unsavedItem[12] = new Date(Date.now() - 1000).toISOString();
  sandbox.processAiBatchQueue();
  const rUnsaved = itemRow(bUnsaved.batch_id, "TMP-UNSAVED");
  assert("29-14. 予約のみで候補未保存の場合は再生成して completed (新しい draft_id)",
    geminiCalls.length === 1 && rUnsaved[3] === "completed" && rUnsaved[4] !== "DRFT_TMP-UNSAVED_NEVER_SAVED" &&
    draftRows("TMP-UNSAVED").length === 1);

  // 29-15. applyExistingAiDraftToProductRecord_ のロック内検証 (所有権・最新性・他生成中)
  resetEnv();
  installCommonStubs();
  addProduct("TMP-APPLY");
  const applySourceFp = computeProductSourceFingerprint_(env.main, 2, "TMP-APPLY");
  appendDraft({
    draft_id: "DRFT_TMP-APPLY_1", product_id: "TMP-APPLY", draft_version: 1, review_status: "pending_review",
    candidate_title_ja: "反映候補", candidate_condition: "新品・未使用", candidate_category: "sneaker",
    candidate_title_en: "Apply EN", candidate_description_en: "desc", source_fingerprint: applySourceFp,
    source_image_fingerprint: "IMGFP::https://drive.google.com/folders/F_TMP-APPLY"
  });
  const applyDraft = originalGetLatestProductAiDraft("TMP-APPLY");
  let ownErr = "";
  try {
    realApplyExisting29(env.main, "TMP-APPLY", applyDraft, {
      ownership_check: () => { const e = new Error("lost"); e.error_code = "BATCH_ITEM_OWNERSHIP_LOST"; throw e; }
    });
  } catch (e) { ownErr = e.error_code; }
  assert("29-15a. 所有権喪失時は回収反映を行わない (本票・ドラフト不変)",
    ownErr === "BATCH_ITEM_OWNERSHIP_LOST" && mainRow("TMP-APPLY")[4] === "" &&
    draftRows("TMP-APPLY")[0][draftCol("review_status")] === "pending_review");

  appendDraft({ draft_id: "DRFT_TMP-APPLY_2", product_id: "TMP-APPLY", draft_version: 2, review_status: "pending_review", candidate_title_ja: "新候補" });
  let supErr = "";
  try { realApplyExisting29(env.main, "TMP-APPLY", applyDraft, {}); } catch (e) { supErr = e.error_code; }
  assert("29-15b. ロック外で読んだ候補が最新でなければ AI_DRAFT_SUPERSEDED (古い候補で上書きしない)",
    supErr === "AI_DRAFT_SUPERSEDED" && mainRow("TMP-APPLY")[4] === "");

  mockScriptProperties["AI_GEN_LOCK_TMP-APPLY"] = JSON.stringify({ execution_id: "EXEC_OTHER", started_at: Date.now() });
  let inProgErr = "";
  try { realApplyExisting29(env.main, "TMP-APPLY", originalGetLatestProductAiDraft("TMP-APPLY"), {}); } catch (e) { inProgErr = e.error_code; }
  assert("29-15c. 同一商品の別生成が実行中なら GENERATION_ALREADY_IN_PROGRESS で反映しない",
    inProgErr === "GENERATION_ALREADY_IN_PROGRESS" && mainRow("TMP-APPLY")[4] === "");
  delete mockScriptProperties["AI_GEN_LOCK_TMP-APPLY"];

  // ------------------------------------------------------------
  // 29-16〜29-17. force_regenerate / model_name の保存・受渡し
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  stubGeminiSuccess();
  addProduct("TMP-FORCE");
  appendDraft({ draft_id: "DRFT_TMP-FORCE_STAFF", product_id: "TMP-FORCE", draft_version: 1, review_status: "confirmed", confirmed_by: "staff_01", candidate_title_ja: "確定済み" });
  const bNoForce = createBatch("REQ_29_NOFORCE", ["TMP-FORCE"]);
  sandbox.processAiBatchQueue();
  const rNoForce = itemRow(bNoForce.batch_id, "TMP-FORCE");
  assert("29-16a. force_regenerate=false では確定済み候補を上書きせず failed (CONFIRMED_DRAFT_EXISTS)",
    rNoForce[3] === "failed" && rNoForce[7] === "CONFIRMED_DRAFT_EXISTS" && geminiCalls.length === 0);

  const bForce = createBatch("REQ_29_FORCE", ["TMP-FORCE"], { force_regenerate: true, model_name: "gemini-custom-model-1" });
  const jobIdx29 = {};
  AI_BATCH_CONFIG.JOB_HEADERS.forEach((h, i) => { jobIdx29[h] = i; });
  const forceJobRow = env.jobs._getRows().find(r => r[0] === bForce.batch_id);
  sandbox.processAiBatchQueue();
  const rForce = itemRow(bForce.batch_id, "TMP-FORCE");
  assert("29-16b. force_regenerate / model_name をジョブへ保存し、ワーカーからコア・LLM 呼出しへ受け渡す",
    forceJobRow[jobIdx29.force_regenerate] === true &&
    forceJobRow[jobIdx29.model_name] === "gemini-custom-model-1" &&
    geminiCalls.length === 1 && geminiCalls[0].overrideModel === "gemini-custom-model-1" &&
    rForce[3] === "completed" && rForce[6] === "gemini-custom-model-1",
    JSON.stringify({ status: rForce[3], err: rForce[7], calls: geminiCalls })
  );

  const badModel = createBatch("REQ_29_BADMODEL", ["TMP-FORCE"], { model_name: "../../evil model" });
  assert("29-16c. 不正な model_name は INVALID_MODEL_NAME で受付拒否",
    badModel.success === false && badModel.error_code === "INVALID_MODEL_NAME");

  // 29-17. 既存 (12列) ジョブシートとの互換性: 追加列は末尾に追記され、既存データは移動しない
  resetEnv();
  installCommonStubs();
  const legacyHeaders = AI_BATCH_CONFIG.JOB_HEADERS.slice(0, 12);
  const legacyJobs = createMockBatchSheet("ai_batch_jobs", legacyHeaders);
  const legacyRow = ["BAT_LEGACY_1", "REQ_LEGACY_1", "completed", 1, 1, 0, 0, "2026-10-05T00:00:00.000Z", "2026-10-05T00:01:00.000Z", "2026-10-05T00:01:00.000Z", "", ""];
  legacyJobs.appendRow(legacyRow);
  env.map["ai_batch_jobs"] = legacyJobs;
  realGetJobsSheet29();
  const legacyHeaderAfter = legacyJobs._getRows()[0];
  const legacyOpts = realGetJobOptions29("BAT_LEGACY_1");
  assert("29-17. 既存12列ジョブシート: 追加列を13列目以降に追記し既存行を保持、旧ジョブは既定値で動作",
    legacyHeaderAfter.slice(0, 12).join(",") === legacyHeaders.join(",") &&
    legacyHeaderAfter[12] === "force_regenerate" && legacyHeaderAfter[13] === "model_name" && legacyHeaderAfter[14] === "retry_requests" &&
    legacyJobs._getRows()[1].slice(0, 12).join(",") === legacyRow.join(",") &&
    legacyOpts.force_regenerate === false && legacyOpts.model_name === "");

  // ------------------------------------------------------------
  // 29-18. retry_ai_product_draft_batch の request_id 冪等性と契約整合
  // ------------------------------------------------------------
  resetEnv();
  installCommonStubs();
  addProduct("TMP-RETRYREQ");
  sandbox.callGeminiMultimodalAiDraftWithSearch_ = sandbox.callGeminiMultimodalAiDraft_ = () => { const e = new Error("bad json"); e.error_code = "STRUCTURED_PARSE_FAILED"; throw e; };
  const bRetry = createBatch("REQ_29_RETRY", ["TMP-RETRYREQ"]);
  sandbox.processAiBatchQueue();
  const retryNoId = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id }).getContent());
  assert("29-18a. retry の request_id 未指定は REQUEST_ID_REQUIRED",
    itemRow(bRetry.batch_id, "TMP-RETRYREQ")[3] === "failed" &&
    retryNoId.success === false && retryNoId.error_code === "REQUEST_ID_REQUIRED");

  const retry1 = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_1" }).getContent());
  const afterRetry1 = itemRow(bRetry.batch_id, "TMP-RETRYREQ")[3];
  const retry1Dup = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_1" }).getContent());
  assert("29-18b. 初回 retry は 1件を pending へ、同一 request_id の再送は is_reused=true で同一応答",
    retry1.success === true && retry1.retried_count === 1 && retry1.is_reused === false && afterRetry1 === "pending" &&
    retry1Dup.success === true && retry1Dup.is_reused === true && retry1Dup.retried_count === 1);

  sandbox.processAiBatchQueue(); // 再度失敗させる
  const failedAgain = itemRow(bRetry.batch_id, "TMP-RETRYREQ")[3];
  const retry1Late = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_1" }).getContent());
  assert("29-18c. 遅延した同一 request_id の再送で再試行を重複登録しない (failed のまま)",
    failedAgain === "failed" && retry1Late.is_reused === true &&
    itemRow(bRetry.batch_id, "TMP-RETRYREQ")[3] === "failed");

  const retry2 = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_2" }).getContent());
  assert("29-18d. 新しい request_id では再試行を受け付ける",
    retry2.success === true && retry2.retried_count === 1 && itemRow(bRetry.batch_id, "TMP-RETRYREQ")[3] === "pending");

  stubGeminiSuccess();
  sandbox.processAiBatchQueue();
  const beforeNoFailed = getBatch(bRetry.batch_id).status;
  const retryNone = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_3" }).getContent());
  const retryNoneDup = JSON.parse(sandbox.handleRetryAiProductDraftBatch({ batch_id: bRetry.batch_id, request_id: "RETRY_REQ_3" }).getContent());
  assert("29-18e. 失敗商品なしは NO_FAILED_ITEMS (success=false・status 不変)、再送も同一応答",
    beforeNoFailed === "completed" &&
    retryNone.success === false && retryNone.error_code === "NO_FAILED_ITEMS" && retryNone.retried_count === 0 &&
    retryNone.status === "completed" && getBatch(bRetry.batch_id).status === "completed" &&
    retryNoneDup.is_reused === true && retryNoneDup.error_code === "NO_FAILED_ITEMS");

  // 退避した sandbox 値を復元
  savedKeys29.forEach(k => { sandbox[k] = saved29[k]; });
  sandbox.SpreadsheetApp.getActiveSpreadsheet = savedSpreadsheetFn29;
  sandbox.Utilities.sleep = savedSleep29;
})();

// --------------------------------------------------
// 30. Google Search Grounding 検索付きドラフト生成の検証 (新仕様)
// --------------------------------------------------
(() => {
  const origUrlFetchApp = sandbox.UrlFetchApp;
  if (!sandbox.UrlFetchApp) {
    sandbox.UrlFetchApp = {};
  }
  const origFetch = sandbox.UrlFetchApp.fetch;
  const origProps = sandbox.PropertiesService.getScriptProperties();
  const scriptPropStore = {};
  scriptPropStore["LLM_API_KEY"] = "dummy_test_api_key";

  sandbox.PropertiesService.getScriptProperties = () => ({
    getProperty: (k) => scriptPropStore[k] || null,
    setProperty: (k, v) => { scriptPropStore[k] = String(v); },
    deleteProperty: (k) => { delete scriptPropStore[k]; }
  });

  const dummyImages = [{ mimeType: "image/jpeg", base64: "dummybase64data" }];
  const dummyMeta = {
    productId: "TMP-GROUND-01",
    category: "sneaker",
    brand: "NIKE",
    productName: "ダンク 白黒",
    sneakerSku: ""
  };

  // 30-1. 初期状態ON: プロパティ未設定時は isAiDraftSearchGroundingEnabled_() が true (Web検索必須方針)
  assert("30-1a. 初期状態ON: プロパティ未設定時は検索グラウンディング有効",
    sandbox.isAiDraftSearchGroundingEnabled_() === true);
  scriptPropStore.AI_DRAFT_ENABLE_SEARCH_GROUNDING = "false";
  assert("30-1b. プロパティで 'false' が明示設定された場合のみ無効化可能",
    sandbox.isAiDraftSearchGroundingEnabled_() === false);
  delete scriptPropStore.AI_DRAFT_ENABLE_SEARCH_GROUNDING;

  // 30-2. 1回方式 検索実行成功 (HTTP 200 + groundingMetadata 付き)
  sandbox.UrlFetchApp.fetch = (url, options) => {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE DUNK LOW RETRO WHITE/BLACK",
                title_en: "Nike Dunk Low Retro White/Black",
                category: "sneaker",
                brand: "Nike",
                condition: "目立った傷や汚れなし",
                description_ja: "人気のパンダカラーです。",
                description_en: "Popular panda colorway.",
                sku: "DD1391-100"
              })
            }]
          },
          groundingMetadata: {
            webSearchQueries: ["nike dunk low retro white black dd1391-100"],
            groundingChunks: [{
              web: { uri: "https://example.com/dunk", title: "Nike Dunk Low Retro" }
            }]
          }
        }]
      })
    };
  };

  const res30_2 = sandbox.callGeminiSingleRequestSearchGrounding_(dummyImages, dummyMeta, "gemini-3.5-flash-lite");
  assert("30-2a. 1回方式 成功判定とHTTP 200",
    res30_2.success === true && res30_2.status_code === 200);
  assert("30-2b. 検索実行フラグとクエリ取得",
    res30_2.grounding.search_executed === true &&
    res30_2.grounding.queries.length === 1 &&
    res30_2.grounding.queries[0] === "nike dunk low retro white black dd1391-100");

  // 30-3. SKU保護: callGeminiMultimodalAiDraftWithSearch_ を通した際に検索由来型番が候補提示され、sku_sourceとneeds_reviewで区別されること
  const candidate30_3 = sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, dummyMeta, "gemini-3.5-flash-lite", { search_mode: "single" });
  assert("30-3a. 具体的な商品名が採用されること",
    candidate30_3.title_ja === "NIKE DUNK LOW RETRO WHITE/BLACK");
  assert("30-3b. 検索由来のSKUはドラフト候補として提示され、sku_source='search_corroborated'かつneeds_reviewにskuが付与されること",
    candidate30_3.sku === "DD1391-100" &&
    candidate30_3.sku_source === "search_corroborated" &&
    candidate30_3.inferred_sku_from_search === "DD1391-100" &&
    candidate30_3.needs_review.indexOf("sku") !== -1);
  assert("30-3c. search_grounding メタデータが正しく付与されること",
    candidate30_3.search_grounding.enabled === true &&
    candidate30_3.search_grounding.search_executed === true &&
    candidate30_3.search_grounding.mode_used === "single_request");

  // 30-4. 1回方式 検索未実行 (モデルが検索をスキップ) -> SEARCH_GROUNDING_NOT_EXECUTED で厳格に失敗
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              title_ja: "NIKE SNEAKER",
              title_en: "Nike Sneaker",
              category: "sneaker",
              brand: "Nike",
              condition: "目立った傷や汚れなし",
              description_ja: "説明文",
              description_en: "Description"
            })
          }]
        },
        groundingMetadata: {}
      }]
    })
  });

  let caught30_4 = null;
  try {
    sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, dummyMeta, "gemini-3.5-flash-lite", { search_mode: "single" });
  } catch (e) {
    caught30_4 = e;
  }
  assert("30-4. 検索未実行時は SEARCH_GROUNDING_NOT_EXECUTED で厳格に失敗し、未検索候補を下書き確定させないこと",
    caught30_4 !== null && caught30_4.error_code === "SEARCH_GROUNDING_NOT_EXECUTED");

  // 30-5. 1回方式 仕様不適合 (HTTP 400) からの 2段階方式自動フォールバック (auto モード)
  let fetchCallCount = 0;
  sandbox.UrlFetchApp.fetch = (url, options) => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      // 1回目の呼出し (1回方式): HTTP 400 で tools と responseSchema が非互換
      return {
        getResponseCode: () => 400,
        getContentText: () => JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Tools are not supported with responseSchema in this model."
          }
        })
      };
    }
    if (fetchCallCount === 2) {
      // 2回目の呼出し (Stage A: 検索 & 自由形式テキスト): HTTP 200
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: "【特定商品名(日本語)】: NIKE DUNK LOW RETRO PANDA\n【特定根拠】: 白黒のレザー配色がDunk Low Retroと一致"
              }]
            },
            groundingMetadata: {
              webSearchQueries: ["nike dunk low retro panda"],
              groundingChunks: [{ web: { uri: "https://example.com/panda", title: "Panda Dunk" } }]
            }
          }]
        })
      };
    }
    // 3回目の呼出し (Stage B: 構造化出力): HTTP 200
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE DUNK LOW RETRO PANDA",
                title_en: "Nike Dunk Low Retro Panda",
                category: "sneaker",
                brand: "Nike",
                condition: "目立った傷や汚れなし",
                description_ja: "パンダダンクです。",
                description_en: "Panda dunk.",
                sku: "DD1391-100"
              })
            }]
          }
        }]
      })
    };
  };

  const candidate30_5 = sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, dummyMeta, "gemini-3.5-flash-lite", { search_mode: "auto" });
  assert("30-5a. HTTP 400仕様エラー時に2段階方式へフォールバックして成功すること",
    candidate30_5.title_ja === "NIKE DUNK LOW RETRO PANDA" &&
    candidate30_5.search_grounding.mode_used === "two_stage_fallback" &&
    candidate30_5.search_grounding.search_executed === true);
  assert("30-5b. フォールバック後も検索由来SKU候補提示と要確認フラグが付与されること",
    candidate30_5.sku === "DD1391-100" &&
    candidate30_5.sku_source === "search_corroborated" &&
    candidate30_5.needs_review.indexOf("sku") !== -1);

  // 30-6. HTTP 429 発生時: 1回方式非対応と判定せず、フォールバックも行わず透過的に例外スロー
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 429,
    getContentText: () => JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource has been exhausted (e.g. check quota)."
      }
    })
  });

  let caught429 = null;
  try {
    sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, dummyMeta, "gemini-3.5-flash-lite", { search_mode: "auto" });
  } catch (e) {
    caught429 = e;
  }
  assert("30-6. HTTP 429発生時は1回方式非対応と判定せず、透過的にLLM_HTTP_ERROR_429をスローすること",
    caught429 !== null && caught429.error_code === "LLM_HTTP_ERROR_429");

  const mockSheet30 = {
    getLastRow: () => 2,
    getLastColumn: () => 40,
    getMaxColumns: () => 40,
    getRange: () => ({
      getValues: () => [
        [new Date(), "TMP-NORM-01", "sneaker", "NIKE", "サンプル", "目立った傷や汚れなし", 10000, 20000, "A-1", "説明文", "", "", "28.0", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1, ""]
      ],
      getValue: () => "ai_draft_flag",
      setValues: () => {},
      setValue: () => {}
    })
  };

  const origFindProductRow = sandbox.findProductRow;
  const origGetValImages = sandbox.getValidatedProductDriveImages_;
  const origGetLatest = sandbox.getLatestProductAiDraft_;
  const origComputeFp = sandbox.computeProductSourceFingerprint_;
  const origGetOrCreateDraftSheet = sandbox.getOrCreateProductAiDraftsSheet_;

  const mockDraftSheet30 = {
    getLastRow: () => 1,
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    getRange: () => ({
      getValues: () => [AI_DRAFT_CONFIG.HEADERS],
      setValue: () => {}
    }),
    appendRow: () => {}
  };

  const origCore = sandbox.executeSingleAiProductDraftCore_;
  sandbox.executeSingleAiProductDraftCore_ = executeSingleAiProductDraftCore_;

  sandbox.findProductRow = () => 2;
  sandbox.getValidatedProductDriveImages_ = () => ({ images: dummyImages, imageIds: ["dummy_img_1"] });
  sandbox.getLatestProductAiDraft_ = () => null;
  sandbox.computeProductSourceFingerprint_ = () => "fp_mock_30";
  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet30;

  // 30-7. 明示的OFF時実行 (enable_search_grounding: false)
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              title_ja: "通常生成スニーカー",
              title_en: "Normal Sneaker",
              category: "sneaker",
              brand: "Nike",
              condition: "目立った傷や汚れなし",
              description_ja: "通常説明文",
              description_en: "Normal description",
              sku: ""
            })
          }]
        }
      }]
    })
  });

  const res30_7 = sandbox.executeSingleAiProductDraftCore_(mockSheet30, "TMP-NORM-01", { force_regenerate: true, enable_search_grounding: false });
  assert("30-7. 明示的OFF (enable_search_grounding: false) 時は通常生成が実行され search_grounding が付与されないこと",
    res30_7.success === true &&
    res30_7.candidate.title_ja === "通常生成スニーカー" &&
    res30_7.candidate.search_grounding === null);

  // 30-8. 既定ON時実行 (Web検索必須方針: 2段階方式が既定)
  sandbox.UrlFetchApp.fetch = (url, opts) => {
    const payload = (opts && opts.payload) ? JSON.parse(opts.payload) : {};
    const firstText = (payload.contents && payload.contents[0] && payload.contents[0].parts && payload.contents[0].parts[0] && payload.contents[0].parts[0].text) || "";
    if (firstText.includes("classify the product")) {
      // 先行カテゴリー判定 (Prior Category Detection)
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "sneaker", confidence: "high" }) }] } }]
        })
      };
    }
    if (payload.tools) {
      // Stage A
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: "### OBSERVED_FEATURES\nNike Dunk Low\n### CANDIDATE_TITLES\n- Title (JA): 検索付き生成スニーカー\n- Title (EN): Search Grounded Sneaker" }] },
            groundingMetadata: {
              webSearchQueries: ["nike dunk search query"],
              groundingChunks: [{ web: { uri: "https://example.com/dunk", title: "Dunk" } }]
            }
          }]
        })
      };
    }
    // Stage B
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "検索付き生成スニーカー",
                title_en: "Search Grounded Sneaker",
                category: "sneaker",
                brand: "Nike",
                condition: "目立った傷や汚れなし",
                description_ja: "検索付き説明文",
                description_en: "Search grounded description",
                sku: "DD1391-100"
              })
            }]
          }
        }]
      })
    };
  };

  const res30_8 = sandbox.executeSingleAiProductDraftCore_(mockSheet30, "TMP-NORM-01", { force_regenerate: true });
  assert("30-8. 既定で2段階検索付き生成が実行され search_grounding が付与され SKU候補が提示されること",
    res30_8.success === true &&
    res30_8.candidate.title_ja === "検索付き生成スニーカー" &&
    res30_8.candidate.sku === "DD1391-100" &&
    res30_8.candidate.sku_source === "search_corroborated" &&
    res30_8.candidate.search_grounding &&
    res30_8.candidate.search_grounding.search_executed === true &&
    res30_8.candidate.search_grounding.sources_count === 1);

  // 30-9. Stage A で参照元0件時は SEARCH_GROUNDING_NO_SOURCES で失敗
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "No sources found" }] },
        groundingMetadata: {
          webSearchQueries: ["query without sources"],
          groundingChunks: [] // 参照元0件
        }
      }]
    })
  });

  let caught30_9 = null;
  try {
    sandbox.callGeminiTwoStageSearchGrounding_(dummyImages, dummyMeta, "gemini-3.8-flash");
  } catch (e) {
    caught30_9 = e;
  }
  assert("30-9. Stage A で検索クエリ発行ありでも参照元0件なら SEARCH_GROUNDING_NO_SOURCES で失敗すること",
    caught30_9 !== null && caught30_9.error_code === "SEARCH_GROUNDING_NO_SOURCES");

  // 30-10. Stage A で MAX_TOKENS 打ち切り時は STAGE_A_MAX_TOKENS で失敗
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: "Thought process cut off..." }] },
        groundingMetadata: { webSearchQueries: ["query"] }
      }]
    })
  });

  let caught30_10 = null;
  try {
    sandbox.callGeminiTwoStageSearchGrounding_(dummyImages, dummyMeta, "gemini-3.8-flash");
  } catch (e) {
    caught30_10 = e;
  }
  assert("30-10. Stage A で MAX_TOKENS による打ち切り時は STAGE_A_MAX_TOKENS で失敗すること",
    caught30_10 !== null && caught30_10.error_code === "STAGE_A_MAX_TOKENS");

  sandbox.findProductRow = origFindProductRow;
  sandbox.getValidatedProductDriveImages_ = origGetValImages;
  sandbox.getLatestProductAiDraft_ = origGetLatest;
  sandbox.computeProductSourceFingerprint_ = origComputeFp;
  sandbox.getOrCreateProductAiDraftsSheet_ = origGetOrCreateDraftSheet;
  sandbox.executeSingleAiProductDraftCore_ = origCore;

  // 元に戻す
  sandbox.UrlFetchApp = origUrlFetchApp;
  sandbox.PropertiesService.getScriptProperties = () => origProps;
})();

// --------------------------------------------------
// 31. AI Search Grounding レビュー指摘対応の検証
// --------------------------------------------------
(() => {
  console.log("\n>>> 31. AI Search Grounding レビュー指摘対応の検証 <<<");
  const origUrlFetchApp = sandbox.UrlFetchApp;
  const origPropsGetter = sandbox.PropertiesService.getScriptProperties;
  const scriptPropStore = {
    AI_DRAFT_ENABLE_SEARCH_GROUNDING: "true",
    LLM_API_KEY: "test-fake-key"
  };
  sandbox.PropertiesService.getScriptProperties = () => ({
    getProperty: (k) => scriptPropStore[k] || null,
    setProperty: (k, v) => { scriptPropStore[k] = String(v); },
    deleteProperty: (k) => { delete scriptPropStore[k]; }
  });

  const dummyImages = [{ mimeType: "image/jpeg", base64: "dGVzdA==" }];
  const taintedMeta = {
    productId: "TMP-000102",
    category: "sneaker",
    brand: "NIKE",
    productName: "誤認された商品名（エアジョーダン1 レトロ）",
    sneakerSku: "MISIDENTIFIED-SKU-999"
  };

  // 31-1. 指摘1: 既存商品名・SKUをモデルに渡さず客観評価 (ignore_existing_identity: true)
  let sentSinglePrompt = "";
  sandbox.UrlFetchApp = {
    fetch: (url, opts) => {
      const payload = JSON.parse(opts.payload);
      sentSinglePrompt = (payload.contents[0].parts[0].text || "");
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({ title_ja: "客観評価", title_en: "Objective", description_ja: "d", description_en: "d", condition: "目立った傷や汚れなし" }) }] },
            groundingMetadata: { webSearchQueries: ["query"] }
          }]
        })
      };
    }
  };

  sandbox.callGeminiSingleRequestSearchGrounding_(dummyImages, taintedMeta, "gemini-3.5-flash-lite", { ignore_existing_identity: true });
  assert("31-1a. 1回方式: ignore_existing_identity 時はプロンプトに誤認名・誤認SKUが含まれず Unspecified に置換されること",
    !sentSinglePrompt.includes("誤認された商品名") &&
    !sentSinglePrompt.includes("MISIDENTIFIED-SKU-999") &&
    sentSinglePrompt.includes("Existing Name: Unspecified") &&
    sentSinglePrompt.includes("Existing SKU: Unspecified"));

  // 2段階方式で ignore_existing_identity: true のプロンプト検証
  let stageAPromptCaptured = "";
  let stageBPromptCaptured = "";
  sandbox.UrlFetchApp.fetch = (url, opts) => {
    const payload = JSON.parse(opts.payload);
    const pText = payload.contents[0].parts[0].text || "";
    if (payload.tools) {
      stageAPromptCaptured = pText;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: "Stage A research summary" }] },
            groundingMetadata: {
              webSearchQueries: ["query"],
              groundingChunks: [{ web: { uri: "https://example.com/res", title: "Res" } }]
            }
          }]
        })
      };
    } else {
      stageBPromptCaptured = pText;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({ title_ja: "2段階客観評価", title_en: "Two-stage Objective", description_ja: "d", description_en: "d", condition: "目立った傷や汚れなし" }) }] }
          }]
        })
      };
    }
  };

  sandbox.callGeminiTwoStageSearchGrounding_(dummyImages, taintedMeta, "gemini-3.5-flash-lite", { ignore_existing_identity: true });
  assert("31-1b. 2段階方式: Stage A, Stage B ともに誤認名・誤認SKUが含まれず除外されること",
    !stageAPromptCaptured.includes("誤認された商品名") &&
    !stageAPromptCaptured.includes("MISIDENTIFIED-SKU-999") &&
    !stageBPromptCaptured.includes("誤認された商品名") &&
    !stageBPromptCaptured.includes("MISIDENTIFIED-SKU-999") &&
    stageAPromptCaptured.includes("CRITICAL RULES"));

  // 31-2. 指摘2: search_executed: false 時は auto_apply でも自動確定せず pending_review に留まること
  const mockRowData = new Array(40).fill("");
  mockRowData[1] = "TMP-NOSEARCH-01"; // B列
  mockRowData[2] = "sneaker";         // C列
  mockRowData[3] = "NIKE";            // D列
  mockRowData[4] = "スニーカー未検索"; // E列
  mockRowData[29] = "https://drive.google.com/folders/fake-nosearch"; // AD列
  mockRowData[31] = "draft";          // AF列
  mockRowData[33] = "active";         // AH列

  const mockProductSheetNoSearch = {
    getLastColumn: () => 40,
    getMaxColumns: () => 40,
    getLastRow: () => 2,
    getRange: (r, c, nr, nc) => ({
      getValues: () => [mockRowData.slice()],
      getValue: () => "ai_draft_flag",
      setValue: (val) => { mockRowData[c - 1] = val; }
    })
  };

  let appendedDraftStatus = "";
  const mockDraftSheetForNoSearch = {
    getLastColumn: () => AI_DRAFT_CONFIG.HEADERS.length,
    appendRow: (row) => {
      // 4列目が review_status
      appendedDraftStatus = row[3];
    },
    getRange: () => ({ getValues: () => [AI_DRAFT_CONFIG.HEADERS] })
  };

  const origCore = sandbox.executeSingleAiProductDraftCore_;
  sandbox.executeSingleAiProductDraftCore_ = executeSingleAiProductDraftCore_;

  const origFindRow = sandbox.findProductRow;
  const origValImg = sandbox.getValidatedProductDriveImages_;
  const origLatestDraft = sandbox.getLatestProductAiDraft_;
  const origDraftSheetGetter = sandbox.getOrCreateProductAiDraftsSheet_;
  const origComputeFp = sandbox.computeProductSourceFingerprint_;

  sandbox.findProductRow = () => 2;
  sandbox.getValidatedProductDriveImages_ = () => ({ images: dummyImages, imageIds: ["img-nosearch"] });
  sandbox.getLatestProductAiDraft_ = () => null;
  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheetForNoSearch;
  sandbox.computeProductSourceFingerprint_ = () => "fp_mock_31";

  // 検索メタデータで search_executed: false (未検索) を返すレスポンス
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              title_ja: "未検索生成スニーカー",
              title_en: "Unsearched Sneaker",
              condition: "目立った傷や汚れなし",
              description_ja: "説明",
              description_en: "Desc",
              sku: ""
            })
          }]
        },
        groundingMetadata: { webSearchQueries: [] } // クエリなし -> search_executed: false
      }]
    })
  });

  let noSearchErr = null;
  try {
    sandbox.executeSingleAiProductDraftCore_(mockProductSheetNoSearch, "TMP-NOSEARCH-01", {
      force_regenerate: true,
      auto_apply: true,
      enable_search_grounding: true
    });
  } catch (err) {
    noSearchErr = err;
  }

  assert("31-2. 検索グラウンディング有効かつ実検索未実行時は SEARCH_GROUNDING_NOT_EXECUTED で失敗し、本票反映・ドラフト確定を行わないこと",
    noSearchErr !== null &&
    noSearchErr.error_code === "SEARCH_GROUNDING_NOT_EXECUTED");

  // 31-3. 指摘3: 本票の既存SKU保護 (スタッフ入力済みSKUをAI候補で上書きしない)
  const productRowWithSku = new Array(40).fill("");
  productRowWithSku[1] = "TMP-SKU-PROTECT";
  productRowWithSku[4] = "既存商品名";
  productRowWithSku[11] = "STAFF-PRESERVED-SKU"; // L列 (12) に既存SKUあり
  let updatedSkuValue = null;

  const mockProductSheetSku = {
    getLastColumn: () => 40,
    getRange: (r, c, nr, nc) => {
      if (nr && nc) {
        return { getValues: () => [productRowWithSku.slice()] };
      }
      return {
        setValue: (val) => {
          productRowWithSku[c - 1] = val;
          if (c === 12) updatedSkuValue = val;
        }
      };
    }
  };

  const aiCandidateWithSku = {
    title_ja: "AI商品名",
    title_en: "AI Title",
    condition: "目立った傷や汚れなし",
    sku: "AI-NEW-SKU-999" // AIが提案したSKU
  };

  sandbox.applyCandidateToProduct_(mockProductSheetSku, 2, "TMP-SKU-PROTECT", aiCandidateWithSku);
  assert("31-3a. 本票に既存SKUがある場合、AI候補のSKUで上書きされないこと",
    updatedSkuValue === null && productRowWithSku[11] === "STAFF-PRESERVED-SKU");

  // 既存SKUが空文字の場合はAI候補が反映されること
  productRowWithSku[11] = "";
  sandbox.applyCandidateToProduct_(mockProductSheetSku, 2, "TMP-SKU-PROTECT", aiCandidateWithSku);
  assert("31-3b. 本票の既存SKUが空文字の場合、AI候補のSKUが反映されること",
    updatedSkuValue === "AI-NEW-SKU-999");

  // 31-4. 指摘4: 原因不明の一般的な HTTP 400 を2段階方式へフォールバックせず例外スローすること
  // (a) スキーマ非互換ではない一般的な 400 (例: INVALID_ARGUMENT: Invalid prompt length)
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 400,
    getContentText: () => JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Invalid field value for contents[0].parts[0]"
      }
    })
  });

  let generic400Failed = false;
  let generic400ErrorCode = "";
  try {
    sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, taintedMeta, "gemini-3.5-flash-lite", { search_mode: "auto" });
  } catch (g400Err) {
    generic400Failed = true;
    generic400ErrorCode = g400Err.error_code;
  }
  assert("31-4a. 原因不明の一般的な HTTP 400 は2段階方式へフォールバックせず例外スローされること",
    generic400Failed && generic400ErrorCode === "LLM_HTTP_ERROR_400");

  // (b) 明示的な tools/schema 併用非互換シグネチャの 400 -> 2段階方式へフォールバックして成功すること
  let fellBackToStageA = false;
  sandbox.UrlFetchApp.fetch = (url, opts) => {
    const payload = JSON.parse(opts.payload);
    if (payload.tools && payload.generationConfig && payload.generationConfig.responseSchema) {
      // 1回方式: tools と responseSchema が併用されている
      return {
        getResponseCode: () => 400,
        getContentText: () => JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "tools are not supported with responseSchema in this version"
          }
        })
      };
    } else if (payload.tools) {
      // 2段階方式 Stage A
      fellBackToStageA = true;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: "Stage A research summary" }] },
            groundingMetadata: {
              webSearchQueries: ["query"],
              groundingChunks: [{ web: { uri: "https://example.com/res", title: "Res" } }]
            }
          }]
        })
      };
    } else {
      // 2段階方式 Stage B
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: JSON.stringify({ title_ja: "2段階フォールバック成功", title_en: "Fallback", condition: "目立った傷や汚れなし", description_ja: "d", description_en: "d" }) }] }
          }]
        })
      };
    }
  };

  const schemaConflictRes = sandbox.callGeminiMultimodalAiDraftWithSearch_(dummyImages, taintedMeta, "gemini-3.5-flash-lite", { search_mode: "auto" });
  assert("31-4b. 明示的な tools/schema 競合エラー時は2段階方式へフォールバックして成功すること",
    fellBackToStageA === true &&
    schemaConflictRes.title_ja === "2段階フォールバック成功" &&
    schemaConflictRes.search_grounding.mode_used === "two_stage_fallback");

  // 31-5. 未検索候補のバッチ処理と中断回収テスト
  // 31-5a. 未検索ドラフトに対する applyExistingAiDraftToProductRecord_ の Fail-Closed 遮断
  const mockProductSheetForDirectApply = {
    getLastColumn: () => 40,
    getRange: (r, c, nr, nc) => ({
      getValues: () => [[
        new Date(), "TMP-DIRECT-APPLY", "sneaker", "NIKE", "元の商品名", "目立った傷や汚れなし",
        10000, 20000, "A-1", "元説明", "", "SKU-ORIG", "27.0", "White", "", "", "",
        "", "", "", "", "", "", "", "", "", "", "", "",
        "https://drive.google.com/folders/f1", "", "draft", "in_stock", "active", "", "", "", "", 1, ""
      ]],
      setValue: () => {}
    })
  };
  const unsearchedDraftObj = {
    draft_id: "DRFT_DIRECT_FAIL_001",
    product_id: "TMP-DIRECT-APPLY",
    draft_version: 1,
    review_status: "pending_review",
    candidate_title_ja: "未検索候補",
    candidate_description_ja: "説明",
    candidate_condition: "目立った傷や汚れなし",
    candidate_price: 22000,
    search_grounding_enabled: true,
    search_executed: false
  };
  sandbox.getLatestProductAiDraft_ = (pid) => (pid === "TMP-DIRECT-APPLY" ? unsearchedDraftObj : null);

  let directApplyThrew = false;
  let directApplyErrorCode = "";
  try {
    sandbox.applyExistingAiDraftToProductRecord_(mockProductSheetForDirectApply, "TMP-DIRECT-APPLY", unsearchedDraftObj);
  } catch (err) {
    directApplyThrew = true;
    directApplyErrorCode = err.error_code;
  }
  assert("31-5a. 未検索ドラフトに対する applyExistingAiDraftToProductRecord_ は Fail-Closed で拒絶される (UNSEARCHED_DRAFT_CANNOT_AUTO_APPLY)",
    directApplyThrew === true && directApplyErrorCode === "UNSEARCHED_DRAFT_CANNOT_AUTO_APPLY");
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;

  // 31-5b. 通常再生成 (force_regenerate: true) 時に検索グラウンディング有効なら ignore_existing_identity がデフォルト true になること
  let passedSearchOptions = null;
  const origCallWithSearch = sandbox.callGeminiMultimodalAiDraftWithSearch_;
  sandbox.callGeminiMultimodalAiDraftWithSearch_ = (images, meta, model, options) => {
    passedSearchOptions = options;
    return {
      title_ja: "再生成スニーカー",
      title_en: "Regen Sneaker",
      condition: "目立った傷や汚れなし",
      description_ja: "d",
      description_en: "d",
      search_grounding: { enabled: true, mode_used: "single_request", search_executed: true, queries: ["test"] }
    };
  };

  sandbox.executeSingleAiProductDraftCore_(mockProductSheetNoSearch, "TMP-NOSEARCH-01", {
    force_regenerate: true,
    enable_search_grounding: true
  });
  assert("31-5b. 通常再生成 (force_regenerate: true) 時に検索グラウンディング有効なら ignore_existing_identity がデフォルト true になること",
    passedSearchOptions !== null && passedSearchOptions.ignore_existing_identity === true);
  sandbox.callGeminiMultimodalAiDraftWithSearch_ = origCallWithSearch;

  // 31-5c & 31-5d: バッチ初回生成および中断回収 (Worker Interruption Recovery)
  const batchTestJobsSheet = createMockBatchSheet("ai_batch_jobs", AI_BATCH_CONFIG.JOB_HEADERS);
  const batchTestItemsSheet = createMockBatchSheet("ai_batch_items", AI_BATCH_CONFIG.ITEM_HEADERS);
  const batchTestDraftsSheet = createMockBatchSheet("product_ai_drafts", AI_DRAFT_CONFIG.HEADERS);

  let batchMainProductRow = [
    new Date(), "TMP-BATCH-UNSEARCH-01", "sneaker", "NIKE", "元の未変更商品名", "目立った傷や汚れなし",
    10000, 20000, "A-1", "元の説明", "", "ORIG-SKU", "27.0", "White", "", "", "",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "https://drive.google.com/folders/f_unsearch", "", "draft", "in_stock", "active", "", "", "", "", 1, ""
  ];
  let batchMainRowSetValues = [];

  const headersRow = new Array(40).fill("");
  headersRow[0] = "timestamp";
  headersRow[1] = "product_id";
  headersRow[39] = "ai_draft_flag";

  const batchTestProductSheet = {
    getLastRow: () => 2,
    getLastColumn: () => 40,
    getMaxColumns: () => 40,
    getRange: (r, c, nr, nc) => {
      if (r === 1) {
        if (nr && nc) {
          return {
            getValues: () => [headersRow.slice(c - 1, c - 1 + nc)],
            getValue: () => headersRow[c - 1]
          };
        }
        return {
          getValue: () => headersRow[c - 1],
          setValue: () => {}
        };
      }
      if (nr && nc) {
        return {
          getValues: () => [batchMainProductRow.slice(c - 1, c - 1 + nc)],
          setValues: (matrix) => {
            batchMainRowSetValues.push(matrix);
            for (let j = 0; j < matrix[0].length; j++) {
              batchMainProductRow[(c - 1) + j] = matrix[0][j];
            }
          }
        };
      }
      return {
        setValue: (val) => {
          batchMainProductRow[c - 1] = val;
        },
        getValue: () => batchMainProductRow[c - 1]
      };
    }
  };

  const batchTestSheetsMap = {
    "ai_batch_jobs": batchTestJobsSheet,
    "ai_batch_items": batchTestItemsSheet,
    "product_ai_drafts": batchTestDraftsSheet
  };

  const origSpreadsheetApp = sandbox.SpreadsheetApp;
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheets: () => [batchTestProductSheet, batchTestJobsSheet, batchTestItemsSheet, batchTestDraftsSheet],
      getSheetByName: (name) => batchTestSheetsMap[name] || (name === "商品マスタ" ? batchTestProductSheet : null),
      insertSheet: (name) => {
        const s = createMockBatchSheet(name);
        batchTestSheetsMap[name] = s;
        return s;
      }
    })
  };

  sandbox.getOrCreateProductAiDraftsSheet_ = () => batchTestDraftsSheet;
  sandbox.getOrCreateAiBatchJobsSheet_ = () => batchTestJobsSheet;
  sandbox.getOrCreateAiBatchItemsSheet_ = () => batchTestItemsSheet;
  sandbox.findProductRow = (sheet, pid) => (pid === "TMP-BATCH-UNSEARCH-01" ? 2 : -1);
  sandbox.getValidatedProductDriveImages_ = () => ({
    images: [{ mimeType: "image/jpeg", data: "base64" }],
    imageIds: ["img-batch-unsearch-01"]
  });
  sandbox.computeProductSourceFingerprint_ = () => "fp_batch_unsearch_src";

  // 検索メタデータで未検索 (search_executed: false) を返すレスポンス
  // 検索メタデータで未検索 (search_executed: false) を返すレスポンス
  let geminiApiCallCount = 0;
  sandbox.UrlFetchApp.fetch = () => {
    geminiApiCallCount++;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "未検索バッチスニーカー",
                title_en: "Unsearched Batch Sneaker",
                condition: "目立った傷や汚れなし",
                description_ja: "未検索説明",
                description_en: "Unsearched Desc",
                sku: ""
              })
            }]
          },
          groundingMetadata: { webSearchQueries: [] }
        }]
      })
    };
  };

  // 検索グラウンディング有効化
  sandbox.PropertiesService.getScriptProperties = () => ({
    getProperty: (k) => {
      if (k === "AI_DRAFT_ENABLE_SEARCH_GROUNDING") return "true";
      return mockScriptProperties[k] || "dummy";
    },
    setProperty: (k, v) => { mockScriptProperties[k] = String(v); },
    deleteProperty: (k) => { delete mockScriptProperties[k]; }
  });

  // 31-5c: 初回バッチ生成実行 (未検索候補の生成)
  geminiApiCallCount = 0;
  const createdBatchRes = sandbox.handleCreateAiProductDraftBatch({
    request_id: "REQ_UNSEARCH_BATCH_01",
    product_ids: ["TMP-BATCH-UNSEARCH-01"]
  });
  const unsearchBatchId = JSON.parse(createdBatchRes.getContent()).batch_id;

  // バッチワーカー実行
  sandbox.processAiBatchQueue();

  const batchAfterFirstRun = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unsearchBatchId }).getContent());
  const itemAfterFirstRun = batchAfterFirstRun.items[0];
  const latestDraftAfterFirstRun = sandbox.getLatestProductAiDraft_("TMP-BATCH-UNSEARCH-01");

  assert("31-5c. バッチ初回生成: 未検索時は下書き保存せず SEARCH_GROUNDING_NOT_EXECUTED で failed となり本票未変更であること (Fail-Closed)",
    itemAfterFirstRun.status === "failed" &&
    itemAfterFirstRun.error_code === "SEARCH_GROUNDING_NOT_EXECUTED" &&
    latestDraftAfterFirstRun === null &&
    batchMainProductRow[4] === "元の未変更商品名" &&
    geminiApiCallCount === 1
  );

  // 31-5d: バッチワーカー中断後の再実行 (Worker Interruption Recovery)
  // 未検索候補を保持したアイテムが回収される際、不要な再生成 (Gemini呼出し0回) を行わず、pending_review を維持し SEARCH_GROUNDING_NOT_EXECUTED で failed 回収すること
  const unsearchDraftId = "DRFT_TMP-BATCH-UNSEARCH_LEGACY";
  const unsearchDraftRow = new Array(AI_DRAFT_CONFIG.HEADERS.length).fill("");
  const unsearchHIdx = {};
  AI_DRAFT_CONFIG.HEADERS.forEach((h, i) => { unsearchHIdx[h] = i; });
  unsearchDraftRow[unsearchHIdx["draft_id"]] = unsearchDraftId;
  unsearchDraftRow[unsearchHIdx["product_id"]] = "TMP-BATCH-UNSEARCH-01";
  unsearchDraftRow[unsearchHIdx["draft_version"]] = 1;
  unsearchDraftRow[unsearchHIdx["review_status"]] = "pending_review";
  unsearchDraftRow[unsearchHIdx["candidate_title_ja"]] = "未検索バッチスニーカー";
  unsearchDraftRow[unsearchHIdx["candidate_description_ja"]] = "未検索説明";
  unsearchDraftRow[unsearchHIdx["model_name"]] = "gemini-3.8-flash";
  unsearchDraftRow[unsearchHIdx["search_grounding_enabled"]] = "true";
  unsearchDraftRow[unsearchHIdx["search_grounding_mode"]] = "two_stage";
  unsearchDraftRow[unsearchHIdx["search_executed"]] = "false";
  unsearchDraftRow[unsearchHIdx["source_fingerprint"]] = "fp_batch_unsearch_src";
  unsearchDraftRow[unsearchHIdx["source_image_fingerprint"]] = "IMGFP_dummy";
  batchTestDraftsSheet.appendRow(unsearchDraftRow);

  const itemRowIndex = 2; // ヘッダーの次
  batchTestItemsSheet.getRange(itemRowIndex, 4).setValue("processing");
  batchTestItemsSheet.getRange(itemRowIndex, 5).setValue(unsearchDraftId);
  batchTestItemsSheet.getRange(itemRowIndex, 12).setValue("WRK_STALLED_OLD_EXEC");
  batchTestItemsSheet.getRange(itemRowIndex, 13).setValue(new Date(Date.now() - 60000).toISOString()); // 1分前のリース切れ

  // ワーカー再実行
  geminiApiCallCount = 0;
  sandbox.processAiBatchQueue();

  const batchAfterRecovery = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unsearchBatchId }).getContent());
  const itemAfterRecovery = batchAfterRecovery.items[0];
  const latestDraftAfterRecovery = sandbox.getLatestProductAiDraft_("TMP-BATCH-UNSEARCH-01");

  assert("31-5d. 中断回収: 未検索候補のアイテム回収時は不要な再生成を行わず(API呼出し0回)、pending_review を維持し SEARCH_GROUNDING_NOT_EXECUTED で failed 回収すること",
    geminiApiCallCount === 0 &&
    itemAfterRecovery.status === "failed" &&
    itemAfterRecovery.error_code === "SEARCH_GROUNDING_NOT_EXECUTED" &&
    itemAfterRecovery.draft_id === unsearchDraftId &&
    latestDraftAfterRecovery.review_status === "pending_review" &&
    batchMainProductRow[4] === "元の未変更商品名"
  );

  // 31-5f: スタッフによる明示再試行 (handleRetryAiProductDraftBatch)
  // 再試行時はアイテムの draft_id がクリアされ、ワーカー再実行時に新しい推論 (Gemini呼出し) が走ること
  // かつ、以前の未検索ドラフトは削除されずにシートに残ること

  // アイテム行を failed 状態に戻す (31-5c/31-5d の結果を再現)
  batchTestItemsSheet.getRange(itemRowIndex, 4).setValue("failed");
  batchTestItemsSheet.getRange(itemRowIndex, 5).setValue(unsearchDraftId);
  batchTestItemsSheet.getRange(itemRowIndex, 6).setValue(1);
  batchTestItemsSheet.getRange(itemRowIndex, 7).setValue("gemini-3.8-flash");
  batchTestItemsSheet.getRange(itemRowIndex, 8).setValue("SEARCH_GROUNDING_NOT_EXECUTED");
  batchTestItemsSheet.getRange(itemRowIndex, 9).setValue("Search unexecuted");

  // ジョブも failed 状態に
  const jobRowIndex = 2;
  batchTestJobsSheet.getRange(jobRowIndex, 3).setValue("failed");
  batchTestJobsSheet.getRange(jobRowIndex, 6).setValue(1); // failed_count

  // スタッフによる「失敗分のみ再試行」API実行
  const retryRes = sandbox.handleRetryAiProductDraftBatch({
    batch_id: unsearchBatchId,
    request_id: "REQ_RETRY_STAFF_01"
  });
  const retryParsed = JSON.parse(retryRes.getContent());
  assert("31-5f-1. 明示再試行: handleRetryAiProductDraftBatch は成功レスポンスを返すこと",
    retryParsed.success === true && retryParsed.status === "queued"
  );

  // 再試行後のアイテム行検証: status=pending, draft_id/draft_version/model_name がクリアされていること
  const itemRowAfterRetryCall = batchTestItemsSheet.getRange(itemRowIndex, 1, 1, AI_BATCH_CONFIG.ITEM_HEADERS.length).getValues()[0];
  assert("31-5f-2. 明示再試行: アイテム行の draft_id / draft_version / model_name がクリアされ pending に戻ること",
    itemRowAfterRetryCall[3] === "pending" &&
    itemRowAfterRetryCall[4] === "" &&
    itemRowAfterRetryCall[5] === "" &&
    itemRowAfterRetryCall[6] === ""
  );

  // 以前の未検索ドラフトが削除されずに残っていること
  assert("31-5f-3. 明示再試行: 再試行受付後も旧ドラフトは削除されずシートに保持されること",
    sandbox.productAiDraftExists_("TMP-BATCH-UNSEARCH-01", unsearchDraftId) === true
  );

  // 今度は検索が成功する Gemini レスポンスに切り替え (Stage A + Stage B)
  sandbox.UrlFetchApp.fetch = () => {
    geminiApiCallCount++;
    if (geminiApiCallCount % 2 === 1) {
      // Stage A
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: "### OBSERVED_FEATURES\nNike Dunk Low\n### CANDIDATE_TITLES\n- Title (JA): 再試行検索成功スニーカー\n- Title (EN): Retried Searched Sneaker" }] },
            groundingMetadata: {
              webSearchQueries: ["nike dunk low retro"],
              groundingChunks: [{ web: { uri: "https://example.com/nike-dunk", title: "Nike Dunk Low" } }]
            }
          }]
        })
      };
    }
    // Stage B
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "再試行検索成功スニーカー",
                title_en: "Retried Searched Sneaker",
                category: "sneaker",
                brand: "Nike",
                condition: "目立った傷や汚れなし",
                description_ja: "検索成功説明",
                description_en: "Searched Desc",
                sku: "DD1391-100"
              })
            }]
          }
        }]
      })
    };
  };

  // 本票・反映モックの準備
  batchMainProductRow[4] = "元の未変更商品名";
  sandbox.verifyProductDraftReflectionCompleted_ = () => ({ success: true, confirmedFingerprint: "FP_RETRY_SEARCH_OK" });

  // 同一ミリ秒での draft_id 衝突を防ぐためミリ秒を進める
  const waitMs = Date.now();
  while (Date.now() <= waitMs) {}

  // ワーカー再実行
  geminiApiCallCount = 0;
  sandbox.processAiBatchQueue();

  const batchAfterStaffRetry = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unsearchBatchId }).getContent());
  const itemAfterStaffRetry = batchAfterStaffRetry.items[0];
  const latestDraftAfterStaffRetry = sandbox.getLatestProductAiDraft_("TMP-BATCH-UNSEARCH-01");

  assert("31-5f-4. 明示再試行: ワーカー実行時に新しい推論(Gemini呼出し)が走り、新ドラフトが作成・完了され、旧ドラフトも保持されること",
    geminiApiCallCount === 2 &&
    itemAfterStaffRetry.status === "completed" &&
    itemAfterStaffRetry.draft_id !== unsearchDraftId &&
    latestDraftAfterStaffRetry.draft_id !== unsearchDraftId &&
    latestDraftAfterStaffRetry.search_executed === true &&
    sandbox.productAiDraftExists_("TMP-BATCH-UNSEARCH-01", unsearchDraftId) === true
  );

  // 31-5e: 中断回収: 既に confirmed（反映済み）のドラフトを回収した際、recoveredDraft.review_status に基づき status プロパティに依存せず completed として回収完了すること
  const confirmedDraftId = "DRFT_TMP-BATCH-CONFIRMED_01";
  const confirmedDraftRow = new Array(AI_DRAFT_CONFIG.HEADERS.length).fill("");
  const hIndices = {};
  AI_DRAFT_CONFIG.HEADERS.forEach((h, i) => { hIndices[h] = i; });
  confirmedDraftRow[hIndices["draft_id"]] = confirmedDraftId;
  confirmedDraftRow[hIndices["product_id"]] = "TMP-BATCH-UNSEARCH-01";
  confirmedDraftRow[hIndices["draft_version"]] = 3;
  confirmedDraftRow[hIndices["review_status"]] = "confirmed"; // review_status が confirmed
  confirmedDraftRow[hIndices["candidate_title_ja"]] = "確定済み商品名";
  confirmedDraftRow[hIndices["confirmed_fingerprint"]] = "FP_OK_CONFIRMED";
  confirmedDraftRow[hIndices["model_name"]] = "gemini-3.5-flash-lite";
  confirmedDraftRow[hIndices["search_grounding_enabled"]] = "true";
  confirmedDraftRow[hIndices["search_executed"]] = "true";
  batchTestDraftsSheet.appendRow(confirmedDraftRow);

  // 本票側も反映済み状態に合わせる
  batchMainProductRow[4] = "確定済み商品名";

  // 反映検証モックを通過するように設定
  sandbox.verifyProductDraftReflectionCompleted_ = () => ({ success: true, confirmedFingerprint: "FP_OK_CONFIRMED" });

  // アイテム行: ステータスを processing、linked_draft_id を confirmedDraftId に設定してリース切れ
  batchTestItemsSheet.getRange(itemRowIndex, 4).setValue("processing");
  batchTestItemsSheet.getRange(itemRowIndex, 5).setValue(confirmedDraftId);
  batchTestItemsSheet.getRange(itemRowIndex, 12).setValue("WRK_STALLED_CONFIRMED");
  batchTestItemsSheet.getRange(itemRowIndex, 13).setValue(new Date(Date.now() - 60000).toISOString());

  // ワーカー再実行
  sandbox.processAiBatchQueue();

  const batchAfterConfirmedRecov = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unsearchBatchId }).getContent());
  const itemAfterConfirmedRecov = batchAfterConfirmedRecov.items[0];
  const latestConfirmedDraft = sandbox.getLatestProductAiDraft_("TMP-BATCH-UNSEARCH-01");

  assert("31-5e. 中断回収: recoveredDraft.review_status が confirmed のドラフト回収時に status プロパティ依存なく completed として回収完了すること",
    itemAfterConfirmedRecov.status === "completed" &&
    itemAfterConfirmedRecov.draft_id === confirmedDraftId &&
    latestConfirmedDraft.review_status === "confirmed"
  );

  // 31-5g: 通常失敗（SEARCH_GROUNDING_NOT_EXECUTED 以外）の明示再試行では draft_id が保持され、
  // ワーカー再実行時に Gemini を再呼出しせず既存候補を中断回収すること
  const normalFailDraftId = "DRFT_TMP-BATCH-NORMAL-FAIL_01";
  const normalFailDraftRow = new Array(AI_DRAFT_CONFIG.HEADERS.length).fill("");
  normalFailDraftRow[hIndices["draft_id"]] = normalFailDraftId;
  normalFailDraftRow[hIndices["product_id"]] = "TMP-BATCH-UNSEARCH-01";
  normalFailDraftRow[hIndices["draft_version"]] = 4;
  normalFailDraftRow[hIndices["review_status"]] = "confirmed";
  normalFailDraftRow[hIndices["candidate_title_ja"]] = "通常保存後回収商品名";
  normalFailDraftRow[hIndices["confirmed_fingerprint"]] = "FP_NORMAL_FAIL_OK";
  normalFailDraftRow[hIndices["model_name"]] = "gemini-3.5-flash-lite";
  normalFailDraftRow[hIndices["search_grounding_enabled"]] = "true";
  normalFailDraftRow[hIndices["search_executed"]] = "true";
  batchTestDraftsSheet.appendRow(normalFailDraftRow);

  // アイテム行: 通常生成保存後に一時的エラー等で failed になった状態を設定 (error_code は VERIFICATION_FAILED)
  batchTestItemsSheet.getRange(itemRowIndex, 4).setValue("failed");
  batchTestItemsSheet.getRange(itemRowIndex, 5).setValue(normalFailDraftId);
  batchTestItemsSheet.getRange(itemRowIndex, 6).setValue(4);
  batchTestItemsSheet.getRange(itemRowIndex, 7).setValue("gemini-3.5-flash-lite");
  batchTestItemsSheet.getRange(itemRowIndex, 8).setValue("VERIFICATION_FAILED");
  batchTestItemsSheet.getRange(itemRowIndex, 9).setValue("Post-save verification failed");

  batchTestJobsSheet.getRange(jobRowIndex, 3).setValue("failed");
  batchTestJobsSheet.getRange(jobRowIndex, 6).setValue(1);

  // スタッフによる「失敗分のみ再試行」API実行
  const retryNormalRes = sandbox.handleRetryAiProductDraftBatch({
    batch_id: unsearchBatchId,
    request_id: "REQ_RETRY_NORMAL_FAIL_01"
  });
  const retryNormalParsed = JSON.parse(retryNormalRes.getContent());
  assert("31-5g-1. 通常失敗再試行: handleRetryAiProductDraftBatch は成功レスポンスを返すこと",
    retryNormalParsed.success === true && retryNormalParsed.status === "queued"
  );

  // 再試行後のアイテム行検証: status=pending だが、draft_id / draft_version / model_name は保持されていること
  const itemRowAfterNormalRetry = batchTestItemsSheet.getRange(itemRowIndex, 1, 1, AI_BATCH_CONFIG.ITEM_HEADERS.length).getValues()[0];
  assert("31-5g-2. 通常失敗再試行: SEARCH_GROUNDING_NOT_EXECUTED 以外の失敗では draft_id / draft_version / model_name が保持されること",
    itemRowAfterNormalRetry[3] === "pending" &&
    itemRowAfterNormalRetry[4] === normalFailDraftId &&
    Number(itemRowAfterNormalRetry[5]) === 4 &&
    itemRowAfterNormalRetry[6] === "gemini-3.5-flash-lite"
  );

  // ワーカー再実行: Gemini API は呼ばれず (0回)、既存候補が中断回収されて completed になること
  geminiApiCallCount = 0;
  sandbox.verifyProductDraftReflectionCompleted_ = () => ({ success: true, confirmedFingerprint: "FP_NORMAL_FAIL_OK" });
  sandbox.processAiBatchQueue();

  const batchAfterNormalRecov = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: unsearchBatchId }).getContent());
  const itemAfterNormalRecov = batchAfterNormalRecov.items[0];

  assert("31-5g-3. 通常失敗再試行: ワーカー実行時に Gemini 再呼出しを行わず(API呼出し0回)、既存候補を中断回収して完了すること",
    geminiApiCallCount === 0 &&
    itemAfterNormalRecov.status === "completed" &&
    itemAfterNormalRecov.draft_id === normalFailDraftId
  );

  // 31-5h: 部分失敗 (partially_failed) のステータス判定検証
  // 1件完了・1件失敗のバッチを作成し、recomputeBatchJobSummary_ でステータスが partially_failed となること
  const multiJobBatchId = "BAT_PARTIAL_TEST_01";
  const nowIso = new Date().toISOString();
  batchTestJobsSheet.appendRow([multiJobBatchId, "REQ_PARTIAL_01", "processing", 2, 0, 0, 0, nowIso, nowIso, "", "", ""]);
  batchTestItemsSheet.appendRow([multiJobBatchId, "TMP-PARTIAL-01", 1, "completed", "DRFT_P01", 1, "model", "", "", 0, "", "", "", nowIso, nowIso]);
  batchTestItemsSheet.appendRow([multiJobBatchId, "TMP-PARTIAL-02", 2, "failed", "", "", "", "GENERATION_FAILED", "Err", 0, "", "", "", nowIso, nowIso]);

  sandbox.recomputeBatchJobSummary_(multiJobBatchId);

  const partialBatchRes = JSON.parse(sandbox.handleGetAiProductDraftBatch({ batch_id: multiJobBatchId }).getContent());
  assert("31-5h. バッチ部分失敗: completed と failed が混在する場合、バッチステータスが partially_failed となること",
    partialBatchRes.status === "partially_failed" &&
    partialBatchRes.total_count === 2 &&
    partialBatchRes.completed_count === 1 &&
    partialBatchRes.failed_count === 1
  );

  sandbox.SpreadsheetApp = origSpreadsheetApp;

  // モックの後始末
  sandbox.executeSingleAiProductDraftCore_ = origCore;
  sandbox.findProductRow = origFindRow;
  sandbox.getValidatedProductDriveImages_ = origValImg;
  sandbox.getLatestProductAiDraft_ = origLatestDraft;
  sandbox.getOrCreateProductAiDraftsSheet_ = origDraftSheetGetter;
  sandbox.computeProductSourceFingerprint_ = origComputeFp;
  sandbox.UrlFetchApp = origUrlFetchApp;
  sandbox.PropertiesService.getScriptProperties = origPropsGetter;
})();

// --------------------------------------------------
// 28. GAS内統合テスト関数 testAiProductDraftSuite_ の実行
// --------------------------------------------------
(() => {
  console.log("\n>>> tests.js の testAiProductDraftSuite_ を実行 <<<");
  // 前のテストで差し替えたモックを本来の実装へリセット
  sandbox.computeConfirmedProductFingerprint_ = originalComputeConfirmedFp;
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
  sandbox.getOrCreateProductAiDraftsSheet_ = originalGetOrCreateDraftsSheet;
  sandbox.verifyProductDraftReflectionCompleted_ = originalVerifyReflection;
  sandbox.getPokemonCardByProductId = () => null;

  const mockProductSheet = {
    getLastRow: () => 2,
    getLastColumn: () => 40,
    getRange: (r, c, numR, numC) => ({
      getValues: () => [
        [
          new Date(), "TMP-000001", "sneaker", "NIKE", "サンプルスニーカー", "目立った傷や汚れなし",
          10000, 20000, "A-1", "説明文\n\n#NIKE", "", "555088-101", "28.0", "Chicago", "あり", "黒タグ", "2015",
          "", "", "", "", "", "", "", "", "", "", "", "",
          "https://drive.google.com/folders/123", "", "draft", "in_stock", "active", "", "", "", "", 1,
          ""
        ]
      ],
      getValue: () => ""
    })
  };

  const mockDraftSheet = createMockBatchSheet(AI_DRAFT_CONFIG.SHEET_NAME, AI_DRAFT_CONFIG.HEADERS);

  const extraSheets = {};
  sandbox.SpreadsheetApp.getActiveSpreadsheet = () => ({
    getSheets: () => [mockProductSheet],
    getSheetByName: (name) => {
      if (name === AI_DRAFT_CONFIG.SHEET_NAME) return mockDraftSheet;
      return extraSheets[name] || null;
    },
    insertSheet: (name) => {
      const s = createMockBatchSheet(name);
      extraSheets[name] = s;
      return s;
    }
  });

  // テスト8用の approved 翻訳モック
  sandbox.getProductTranslation = (pid) => ({
    product_id: pid,
    translated_title: "Nike Air Jordan 1",
    translated_description: "English description",
    translated_condition: "Excellent",
    translation_status: "approved"
  });

  const testGasSuite = sandbox.testAiProductDraftSuite_;
  if (typeof testGasSuite === "function") {
    const res = testGasSuite();
    assert("18. GAS内テストスイート testAiProductDraftSuite_ (全20項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testArchiveSuite = sandbox.testBulkProductArchiveSafetySuite_;
  if (typeof testArchiveSuite === "function") {
    const res = testArchiveSuite();
    assert("19. GAS内テストスイート testBulkProductArchiveSafetySuite_ (全12項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testIdentityPricingSuite = sandbox.testAiProductDraftIdentityAndPricingSuite_;
  if (typeof testIdentityPricingSuite === "function") {
    const res = testIdentityPricingSuite();
    assert("20. GAS内テストスイート testAiProductDraftIdentityAndPricingSuite_ (全24項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testDocSuite = sandbox.testProductDocumentAttachmentSuite_;
  if (typeof testDocSuite === "function") {
    const res = testDocSuite();
    assert("21. GAS内テストスイート testProductDocumentAttachmentSuite_ (全9項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testPokeCondSuite = sandbox.testPokemonCardConditionAbcSuite_;
  if (typeof testPokeCondSuite === "function") {
    const res = testPokeCondSuite();
    assert("22. GAS内テストスイート testPokemonCardConditionAbcSuite_ (全6項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testPaginationSuite = sandbox.testAdminProductListPaginationSuite_;
  if (typeof testPaginationSuite === "function") {
    const res = testPaginationSuite();
    assert("23. GAS内テストスイート testAdminProductListPaginationSuite_ (全8項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testIndepDocSuite = sandbox.testIndependentDocumentUploadSuite_;
  if (typeof testIndepDocSuite === "function") {
    const res = testIndepDocSuite();
    assert("24. GAS内テストスイート testIndependentDocumentUploadSuite_ (全8項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testTransTitleSuite = sandbox.testUpdateProductTranslatedTitleSuite_;
  if (typeof testTransTitleSuite === "function") {
    const res = testTransTitleSuite();
    assert("25. GAS内テストスイート testUpdateProductTranslatedTitleSuite_ (全7項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

// ==================================================
// Section 32: 商品カテゴリ拡張テスト (testCategoryExpansionSuite_)
// ==================================================
(() => {
  console.log("\n--- [Section 32: 商品カテゴリ拡張 (apparel, fashion_goods, jewelry追加候補, 列保護, Square連携)] ---");

  // 32-1. apparel 商品の新規作成と41〜43列目保存・1〜40列目保護
  const mockRows32 = [];
  mockRows32.push(new Array(43).fill("header"));
  const mockSheet32 = {
    getName: () => "商品マスター",
    getLastRow: () => mockRows32.length,
    getLastColumn: () => 43,
    getMaxColumns: () => 43,
    appendRow: (row) => {
      const r = row.slice();
      while (r.length < 43) r.push("");
      mockRows32.push(r);
    },
    getRange: (r, c, numR, numC) => {
      numR = numR || 1;
      numC = numC || 1;
      return {
        getValue: () => {
          const rowData = mockRows32[r - 1] || [];
          return rowData[c - 1] !== undefined ? rowData[c - 1] : "";
        },
        getValues: () => {
          const res = [];
          for (let i = 0; i < numR; i++) {
            const rowData = mockRows32[r - 1 + i] || [];
            const cols = [];
            for (let j = 0; j < numC; j++) {
              cols.push(rowData[c - 1 + j] !== undefined ? rowData[c - 1 + j] : "");
            }
            res.push(cols);
          }
          return res;
        },
        setValue: (val) => {
          while (mockRows32.length < r) mockRows32.push(new Array(43).fill(""));
          const rowData = mockRows32[r - 1];
          while (rowData.length < c) rowData.push("");
          rowData[c - 1] = val;
        }
      };
    }
  };

  const origGenPid32 = sandbox.generateNextProductId;
  sandbox.generateNextProductId = () => "TMP-APP-001";
  sandbox.DriveApp = {
    getFolderById: () => ({
      createFolder: () => ({
        getId: () => "folder_app_001",
        getUrl: () => "https://drive.google.com/folders/folder_app_001",
        getFiles: () => ({ hasNext: () => false })
      })
    })
  };

  const apparelCreatePayload = {
    category: "apparel",
    subcategory: "t_shirt",
    size: "L",
    official_sku: "CH-TS-001",
    brand: "Chrome Hearts",
    product_name: "CH Horseshoe Floral Cross Tee Black",
    condition: "A",
    planned_sale_price: 58000,
    purchase_price: 35000,
    storage_location: "倉庫A-1",
    description: "クロムハーツ定番Tシャツ",
    publish_status: "draft"
  };

  const createResRaw = sandbox.executeProductCreationCore_(mockSheet32, apparelCreatePayload, {});
  const createRes = JSON.parse(createResRaw.getContent());

  const createdRow = mockRows32[1]; // 2行目
  assert("32-1a. apparel 新規登録成功", createRes.success === true && createRes.product_id === "TMP-APP-001");
  assert("32-1b. 41〜43列目にサブカテゴリ・サイズ・公式品番が正しく保存される",
    createdRow[40] === "t_shirt" && createdRow[41] === "L" && createdRow[42] === "CH-TS-001",
    "col41=" + createdRow[40] + ", col42=" + createdRow[41] + ", col43=" + createdRow[42]);
  assert("32-1c. 12〜17列(スニーカー列)および18〜29列(ジュエリー列)が空欄のまま保護されている",
    createdRow[11] === "" && createdRow[12] === "" && createdRow[17] === "" && createdRow[25] === "",
    "col12=" + createdRow[11] + ", col13=" + createdRow[12] + ", col18=" + createdRow[17] + ", col26=" + createdRow[25]);

  // 32-2. apparel 商品の詳細取得 (buildProductDetail)
  const detail = sandbox.buildProductDetail(createdRow, true, true);
  assert("32-2. buildProductDetail で新属性と互換エイリアスが往復取得できる",
    detail.category === "apparel" &&
    detail.subcategory === "t_shirt" &&
    detail.sub_category === "t_shirt" &&
    detail.size === "L" &&
    detail.official_sku === "CH-TS-001" &&
    detail.sku === "CH-TS-001");

  // 32-3. apparel 商品の更新 (handleUpdateProduct)
  sandbox.findProductRow = () => 2;
  const updatePayload = {
    product_id: "TMP-APP-001",
    size: "XL",
    planned_sale_price: 62000,
    subcategory: "hoodie_sweatshirt"
  };
  const updateResRaw = sandbox.handleUpdateProduct(mockSheet32, updatePayload);
  const updateRes = JSON.parse(updateResRaw.getContent());

  assert("32-3. handleUpdateProduct でサイズ・販売価格・サブカテゴリが更新できる",
    updateRes.success === true &&
    createdRow[40] === "hoodie_sweatshirt" &&
    createdRow[41] === "XL" &&
    Number(createdRow[7]) === 62000);

  // 32-4. 登録後のカテゴリ変更拒否
  let catChangeBlocked = false;
  try {
    sandbox.handleUpdateProduct(mockSheet32, {
      product_id: "TMP-APP-001",
      category: "sneaker"
    });
  } catch (e) {
    if (e.message.includes("product category cannot be changed after creation")) {
      catChangeBlocked = true;
    }
  }
  assert("32-4. 登録後のカテゴリ変更は例外で厳格に拒絶される", catChangeBlocked);

  // 32-5. apparel 商品へのスニーカー列・ジュエリー列の誤保存遮断
  sandbox.handleUpdateProduct(mockSheet32, {
    product_id: "TMP-APP-001",
    sneaker_size: "28.0",
    sneaker_sku: "SNEAKER-ERR",
    jewelry_material: "SV925"
  });
  assert("32-5. apparel商品に対するスニーカー・ジュエリー属性の更新要求は遮断され値不変",
    createdRow[11] === "" && createdRow[12] === "" && createdRow[18] === "");

  // 32-6. fashion_goods 商品の作成と管理一覧取得 (buildAdminProductSummary)
  sandbox.generateNextProductId = () => "TMP-FSH-001";
  const fashionCreatePayload = {
    category: "fashion_goods",
    subcategory: "eyewear",
    size: "53□18-145",
    official_sku: "CH-SUN-001",
    brand: "Chrome Hearts",
    product_name: "CH Gittin Any? Sunglasses Black",
    condition: "S",
    planned_sale_price: 128000
  };
  sandbox.executeProductCreationCore_(mockSheet32, fashionCreatePayload, {});
  const fashionRow = mockRows32[2]; // 3行目

  const adminSummary = sandbox.buildAdminProductSummary(fashionRow, "");
  assert("32-6. fashion_goods 商品が作成され管理一覧サマリーに3属性が返却される",
    adminSummary.category === "fashion_goods" &&
    adminSummary.subcategory === "eyewear" &&
    adminSummary.size === "53□18-145" &&
    adminSummary.official_sku === "CH-SUN-001");

  // 32-7. Square連携 表示情報の構築 (buildSquareProductDisplay_)
  const sourceApparel = {
    product_id: "TMP-APP-001",
    category: "apparel",
    brand: "Chrome Hearts",
    product_name: "CH Hoodie Black",
    condition: "A",
    size: "XL",
    official_sku: "CH-HD-001",
    description: "クロムハーツ定番パーカー"
  };
  const sqDisplay = sandbox.buildSquareProductDisplay_(sourceApparel);
  assert("32-7a. apparel で size 指定時は Square Variation 名に size が反映される",
    sqDisplay.variationName === "XL");
  assert("32-7b. Square 商品説明HTMLに【サイズ】【品番】【ブランド】が含まれる",
    sqDisplay.descriptionHtml.includes("【サイズ】 XL") &&
    sqDisplay.descriptionHtml.includes("【品番】 CH-HD-001") &&
    sqDisplay.descriptionHtml.includes("【ブランド】 Chrome Hearts"));

  const sourceApparelNoSize = {
    product_id: "TMP-APP-002",
    category: "apparel",
    product_name: "CH Scarf",
    condition: "S",
    size: "",
    official_sku: "",
    description: "スカーフ"
  };
  const sqDisplayNoSize = sandbox.buildSquareProductDisplay_(sourceApparelNoSize);
  assert("32-7c. apparel で size 未指定時は Square Variation 名が 'Regular' となる",
    sqDisplayNoSize.variationName === "Regular");

  // 32-8. ジュエリー新種別 (pendant, charm, chain) の保存・取得
  sandbox.generateNextProductId = () => "TMP-JWL-001";
  const jewelryCreatePayload = {
    category: "jewelry",
    jewelry_type: "pendant",
    jewelry_material: "22K",
    carat: "0.5",
    brand: "Chrome Hearts",
    product_name: "CH Baby Fat Pendant 22K with Pave Diamond",
    condition: "S",
    planned_sale_price: 380000
  };
  sandbox.executeProductCreationCore_(mockSheet32, jewelryCreatePayload, {});
  const jewelryRow = mockRows32[3]; // 4行目
  const jwlDetail = sandbox.buildProductDetail(jewelryRow, true, true);
  assert("32-8. ジュエリー新種別 (pendant) が正常に登録・取得できる",
    jwlDetail.category === "jewelry" &&
    jwlDetail.jewelry_type === "pendant" &&
    jwlDetail.jewelry_material === "22K");
  sandbox.generateNextProductId = origGenPid32;

  // 32-9. AIドラフト確定・反映経路での新カテゴリスニーカー列汚染防止 & カテゴリ不変
  const aiCandidateForApparel = {
    title_ja: "AI生成タイトル",
    category: "apparel",
    sku: "AI-NEW-SKU-SHOULD-NOT-POLLUTE",
    size: "M"
  };
  sandbox.applyCandidateToProduct_(mockSheet32, 2, "TMP-APP-001", aiCandidateForApparel);
  assert("32-9a. apparel商品にAI候補が適用されてもスニーカーSKU(12列)・スニーカーサイズ(13列)は汚染されない",
    createdRow[11] === "" && createdRow[12] === "");
  assert("32-9b. apparel商品の既存カテゴリは上書きされず維持される",
    createdRow[2] === "apparel");

  // 32-10. シート列数不足 (43列未満) 時の事前停止検証
  const shortSheet = {
    getMaxColumns: () => 40,
    getLastColumn: () => 40,
    getLastRow: () => 1,
    getRange: () => ({ getValue: () => "", getValues: () => [[]], setValue: () => {} })
  };
  let shortSheetCreateBlocked = false;
  try {
    sandbox.executeProductCreationCore_(shortSheet, { category: "apparel", product_name: "Test" }, { isImport: false });
  } catch (err) {
    if (err.error_code === "INSUFFICIENT_SHEET_COLUMNS") shortSheetCreateBlocked = true;
  }
  assert("32-10a. 商品シート列数が43未満の場合、新規登録は画像・行作成前に INSUFFICIENT_SHEET_COLUMNS で停止する", shortSheetCreateBlocked);

  let shortSheetUpdateBlocked = false;
  try {
    sandbox.handleUpdateProduct(shortSheet, { product_id: "TMP-APP-001", size: "M" });
  } catch (err) {
    if (err.error_code === "INSUFFICIENT_SHEET_COLUMNS") shortSheetUpdateBlocked = true;
  }
  assert("32-10b. 商品シート列数が43未満の場合、商品更新は INSUFFICIENT_SHEET_COLUMNS で停止する", shortSheetUpdateBlocked);

  // 32-11. 既存4カテゴリ新規登録時の新列書き込み防止
  sandbox.executeProductCreationCore_(mockSheet32, {
    category: "sneaker",
    product_name: "Test Sneaker",
    sneaker_size: 27.5,
    sneaker_sku: "SNK-001",
    // 誤って新列キーが渡された場合
    size: "27.5",
    official_sku: "ACCIDENTAL-SKU",
    subcategory: "t_shirt"
  }, { isImport: false });
  const sneakerRow = mockRows32[mockRows32.length - 1];
  assert("32-11. sneaker新規登録時にsize/official_sku/subcategoryが渡されても41〜43列への書き込みは遮断される",
    sneakerRow[40] === "" && sneakerRow[41] === "" && sneakerRow[42] === "" && sneakerRow[11] === "SNK-001" && sneakerRow[12] === 27.5);

  // 32-12. 既存4カテゴリ更新時の新列書き込み遮断
  const sneakerId = sneakerRow[1];
  sandbox.handleUpdateProduct(mockSheet32, {
    product_id: sneakerId,
    size: "28.0",
    official_sku: "MALICIOUS-SKU",
    subcategory: "pants"
  });
  assert("32-12. sneaker商品に対するsize/official_sku/subcategory更新は遮断され41〜43列は空欄のまま",
    sneakerRow[40] === "" && sneakerRow[41] === "" && sneakerRow[42] === "");

  // 32-13. AI反映でのスタッフ入力保護 (size, sku) & サブカテゴリ推測値非保存
  const targetAppRow = mockRows32[1]; // TMP-APP-001
  targetAppRow[2] = "apparel";
  targetAppRow[41] = "L";           // 42列目: staff size
  targetAppRow[42] = "CH-STAFF-01"; // 43列目: staff sku
  targetAppRow[40] = "t_shirt";     // 41列目: staff subcategory
  sandbox.applyCandidateToProduct_(mockSheet32, 2, "TMP-APP-001", {
    title_ja: "AIタイトル2",
    category: "apparel",
    size: "S",              // AI候補の別サイズ
    sku: "AI-NEW-SKU-02"   // AI候補の別SKU
  });
  assert("32-13. apparel商品でスタッフ入力済みのsize(42列)・sku(43列)はAI反映で上書きされず保護される",
    targetAppRow[41] === "L" && targetAppRow[42] === "CH-STAFF-01" && targetAppRow[40] === "t_shirt");

  // 32-14a. 通常の既存 other 商品に新しいAIドラフトを生成・確定するケースは CATEGORY_CANNOT_BE_CHANGED で拒絶される
  targetAppRow[2] = "other";
  targetAppRow[39] = "ai_managed"; // 通常商品にAIドラフト生成を実行して ai_managed が付与された状態
  targetAppRow[40] = "";
  targetAppRow[41] = "";
  targetAppRow[42] = "";

  const mockDraftRow = [
    "DRFT_FASHION_01", "TMP-APP-001", 1, "pending_review",
    "AI仮商品", "#CH", "説明文", "CH Tee", "Description", "未使用に近い",
    50000, "other", "Chrome Hearts", "", "",
    "", "", "", "", "gemini-3.8-flash", new Date(), "", "", "", ""
  ];
  const mockDraftSheet = {
    getLastColumn: () => mockDraftRow.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => [mockDraftRow],
      setValue: (val) => { mockDraftRow[c - 1] = val; }
    })
  };
  sandbox.getOrCreateProductAiDraftsSheet_ = () => mockDraftSheet;
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_FASHION_01",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "pending_review",
    candidate_condition: "未使用に近い",
    source_fingerprint: "",
    source_image_fingerprint: ""
  });
  const mockTrans32 = {
    product_id: "TMP-APP-001",
    translated_title: "CH Floral Cross Tee",
    translated_description: "English description",
    translation_status: "approved"
  };
  sandbox.saveConfirmedProductTranslation_ = (pId, data) => {
    mockTrans32.translated_title = data.translated_title;
    mockTrans32.translated_description = data.translated_description;
    mockTrans32.translation_status = "approved";
  };
  sandbox.getProductTranslation = () => mockTrans32;
  sandbox.safeGetProductTranslation_ = () => mockTrans32;

  const normalOtherConfirmRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_FASHION_01",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_FASHION_01",
    confirmed_data: {
      category: "apparel",
      subcategory: "t_shirt",
      size: "XL",
      official_sku: "CH-TS-CONFIRMED",
      brand: "Chrome Hearts",
      product_name: "CH Floral Cross Tee",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "確定説明文",
      translated_title: "CH Floral Cross Tee",
      translated_description: "English description"
    }
  });
  const parsedNormalOtherRes = JSON.parse(normalOtherConfirmRes.getContent());
  assert("32-14a. 通常の既存 other 商品に新しいAIドラフトを生成・確定するケースは CATEGORY_CANNOT_BE_CHANGED で拒絶される",
    parsedNormalOtherRes.success === false &&
    parsedNormalOtherRes.error_code === "CATEGORY_CANNOT_BE_CHANGED" &&
    targetAppRow[2] === "other");

  // 32-14b. 本票カテゴリ未設定(空欄)の新規仮登録商品は確定時に apparel に初回設定され新属性が保存される
  targetAppRow[2] = ""; // カテゴリ未設定（空欄）
  const unsetCatConfirmRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_FASHION_01",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_FASHION_01",
    confirmed_data: {
      category: "apparel",
      subcategory: "t_shirt",
      size: "XL",
      official_sku: "CH-TS-CONFIRMED",
      brand: "Chrome Hearts",
      product_name: "CH Floral Cross Tee",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "確定説明文",
      translated_title: "CH Floral Cross Tee",
      translated_description: "English description"
    }
  });
  const parsedUnsetCatRes = JSON.parse(unsetCatConfirmRes.getContent());
  assert("32-14b. 本票カテゴリ未設定(空欄)の新規仮登録商品は確定時に apparel に初回設定され新属性が保存される",
    parsedUnsetCatRes.success === true &&
    targetAppRow[2] === "apparel" &&
    targetAppRow[40] === "t_shirt" &&
    targetAppRow[41] === "XL" &&
    targetAppRow[42] === "CH-TS-CONFIRMED");

  // 32-15. 非AI管理 other 商品および既存他カテゴリ商品のカテゴリ変更阻止
  targetAppRow[2] = "other";
  targetAppRow[39] = ""; // 非AI管理
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_NON_AI",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "pending_review",
    candidate_condition: "未使用に近い"
  });
  const nonAiConfirmRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_NON_AI",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_NON_AI",
    confirmed_data: {
      category: "apparel",
      brand: "Chrome Hearts",
      product_name: "Should Not Change Cat",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "desc",
      translated_title: "Title",
      translated_description: "Desc"
    }
  });
  const parsedNonAiRes = JSON.parse(nonAiConfirmRes.getContent());
  assert("32-15. 非AI管理の other 商品は確定要求でもカテゴリ変更が CATEGORY_CANNOT_BE_CHANGED で拒絶され other を維持する",
    parsedNonAiRes.success === false && parsedNonAiRes.error_code === "CATEGORY_CANNOT_BE_CHANGED" && targetAppRow[2] === "other");

  // 32-16a. [要件1] 列不足時の部分更新防止: 43列未満のシートでの確定要求は一切の書き込み前に停止
  const initialRowSnapshot = [...targetAppRow];
  const shortSheet32 = {
    getMaxColumns: () => 40,
    getLastColumn: () => 40,
    getRange: (r, c, numRows, numCols) => {
      const startCol = c;
      const endCol = c + (numCols !== undefined ? numCols : 1) - 1;
      if (startCol > 40 || endCol > 40) {
        throw new Error(`Coordinates out of range: getRange requested column ${startCol}..${endCol}, but sheet has only 40 columns`);
      }
      return {
        getValues: () => [targetAppRow.slice(0, 40)],
        setValue: (val) => {
          // 部分更新が発生した場合は行が書き換わってしまう
          targetAppRow[c - 1] = val;
        }
      };
    }
  };
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_SHORT_COL",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "pending_review",
    candidate_condition: "未使用に近い"
  });
  targetAppRow[2] = "apparel";
  targetAppRow[4] = "BEFORE_PRODUCT_NAME";
  targetAppRow[7] = 10000;
  const shortColRes = sandbox.handleConfirmAiProductDraft(shortSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_SHORT_COL",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_SHORT_COL",
    confirmed_data: {
      category: "apparel",
      brand: "Chrome Hearts",
      product_name: "SHOULD_NOT_WRITE_ANYTHING",
      condition: "未使用に近い",
      planned_sale_price: 99999,
      description: "SHOULD_NOT_WRITE_DESC",
      translated_title: "Title",
      translated_description: "Desc",
      size: "XL",
      official_sku: "CH-FAIL-COL"
    }
  });
  const parsedShortColRes = JSON.parse(shortColRes.getContent());
  assert("32-16a. [要件1] 43列未満時の確定要求は商品名・価格等の書き込み前に INSUFFICIENT_SHEET_COLUMNS で停止し部分更新を防ぐ",
    parsedShortColRes.success === false &&
    parsedShortColRes.error_code === "INSUFFICIENT_SHEET_COLUMNS" &&
    targetAppRow[4] === "BEFORE_PRODUCT_NAME" &&
    targetAppRow[7] === 10000
  );

  // 32-16b. [要件2] スタッフ入力済みサイズ(AP)・公式品番(AQ)の保護: 既存値があればAI候補で上書きしない
  targetAppRow[4] = "CH Staff Protected Tee";
  targetAppRow[41] = "M"; // スタッフ入力済みサイズ
  targetAppRow[42] = "STAFF-CH-TS-001"; // スタッフ入力済み公式品番
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_STAFF_PROTECT",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "pending_review",
    candidate_condition: "未使用に近い"
  });
  const protectConfirmRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_STAFF_PROTECT",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_STAFF_PROTECT",
    confirmed_data: {
      category: "apparel",
      brand: "Chrome Hearts",
      product_name: "CH Staff Protected Tee",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "保護検証",
      translated_title: "Protected Tee",
      translated_description: "Protected Desc",
      size: "XL", // AI候補サイズ（上書きされてはならない）
      official_sku: "AI-NEW-SKU-OVERWRITE" // AI候補品番（上書きされてはならない）
    }
  });
  const parsedProtectRes = JSON.parse(protectConfirmRes.getContent());
  assert("32-16b. [要件2] 既存商品にサイズ・公式品番がある場合、確定時にAI候補で上書きされず保護される",
    parsedProtectRes.success === true &&
    targetAppRow[41] === "M" &&
    targetAppRow[42] === "STAFF-CH-TS-001"
  );

  // 32-16c. [要件2] 空欄のみ補完する動作の検証: サイズ空欄・品番既存値のとき、サイズのみ補完され品番は保護される
  targetAppRow[41] = ""; // サイズ空欄
  targetAppRow[42] = "STAFF-CH-TS-001"; // 品番既存値
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_PARTIAL_FILL",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "pending_review",
    candidate_condition: "未使用に近い"
  });
  const partialFillRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_PARTIAL_FILL",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_PARTIAL_FILL",
    confirmed_data: {
      category: "apparel",
      brand: "Chrome Hearts",
      product_name: "CH Staff Protected Tee",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "補完検証",
      translated_title: "Protected Tee",
      translated_description: "Protected Desc",
      size: "XL", // 空欄なので補完されるべき
      official_sku: "AI-NEW-SKU-OVERWRITE" // 既存値があるので保護されるべき
    }
  });
  const parsedPartialFillRes = JSON.parse(partialFillRes.getContent());
  assert("32-16c. [要件2] サイズ空欄・品番既存値の場合、サイズのみ補完され既存品番は保護される",
    parsedPartialFillRes.success === true &&
    targetAppRow[41] === "XL" &&
    targetAppRow[42] === "STAFF-CH-TS-001"
  );

  // 32-17. [要件3] 昇格条件の限定: 既に confirmed 済みの別のAI管理商品では other からのカテゴリ変更が拒絶される
  targetAppRow[2] = "other";
  targetAppRow[39] = "ai_managed"; // ai_managed フラグは立っている
  sandbox.getLatestProductAiDraft_ = () => ({
    draft_id: "DRFT_ALREADY_CONFIRMED",
    product_id: "TMP-APP-001",
    draft_version: 1,
    review_status: "confirmed", // すでに確定済みの別のAI管理状態
    candidate_condition: "未使用に近い"
  });
  const confirmedDraftPromoteRes = sandbox.handleConfirmAiProductDraft(mockSheet32, {
    product_id: "TMP-APP-001",
    draft_id: "DRFT_ALREADY_CONFIRMED",
    draft_version: 1,
    staff_id: "staff_test",
    confirmation_attempt_id: "ATTEMPT_ALREADY_CONFIRMED",
    confirmed_data: {
      category: "apparel",
      brand: "Chrome Hearts",
      product_name: "Should Not Promote Confirmed",
      condition: "未使用に近い",
      planned_sale_price: 55000,
      description: "desc",
      translated_title: "Title",
      translated_description: "Desc"
    }
  });
  const parsedConfirmedDraftRes = JSON.parse(confirmedDraftPromoteRes.getContent());
  assert("32-17. [要件3] すでに確定済みの別のAI管理商品では other から apparel への昇格が CATEGORY_CANNOT_BE_CHANGED で拒絶される",
    parsedConfirmedDraftRes.success === false &&
    parsedConfirmedDraftRes.error_code === "CATEGORY_CANNOT_BE_CHANGED" &&
    targetAppRow[2] === "other"
  );
})();

  const testCatExpSuite = sandbox.testCategoryExpansionSuite_;
  if (typeof testCatExpSuite === "function") {
    const res = testCatExpSuite();
    assert("26. GAS内テストスイート testCategoryExpansionSuite_ (全17項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testDriveOpsSuite = sandbox.testDriveFileOperationsSuite_;
  if (typeof testDriveOpsSuite === "function") {
    const res = testDriveOpsSuite();
    assert("27. GAS内テストスイート testDriveFileOperationsSuite_ (全10項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  // Restore real implementations before running testAiBatchSelectedImagesSuite_
  sandbox.executeSingleAiProductDraftCore_ = executeSingleAiProductDraftCore_;
  sandbox.computeImageFingerprintFromFolderUrl_ = originalComputeImageFp;
  sandbox.getLatestProductAiDraft_ = originalGetLatestProductAiDraft;
  sandbox.computeConfirmedProductFingerprint_ = originalComputeConfirmedFp;
  sandbox.getOrCreateProductAiDraftsSheet_ = originalGetOrCreateDraftsSheet;
  sandbox.verifyProductDraftReflectionCompleted_ = originalVerifyReflection;
  sandbox.findProductRow = originalFindProductRow;
  sandbox.getValidatedProductDriveImages_ = originalGetValidatedProductDriveImages;
  sandbox.computeProductSourceFingerprint_ = originalComputeProductSourceFp;
  sandbox.getOrCreateAiBatchJobsSheet_ = originalGetOrCreateBatchJobsSheet;
  sandbox.getOrCreateAiBatchItemsSheet_ = originalGetOrCreateBatchItemsSheet;

  const testAiBatchSelectedSuite = sandbox.testAiBatchSelectedImagesSuite_;
  if (typeof testAiBatchSelectedSuite === "function") {
    const res = testAiBatchSelectedSuite();
    assert("28. GAS内テストスイート testAiBatchSelectedImagesSuite_ (全10項目PASS)", res.failed === 0 && res.passed === res.total, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testAiBatchCategoryAndCostSuite = sandbox.testAiBatchCategoryAndCostExpansionSuite_;
  if (typeof testAiBatchCategoryAndCostSuite === "function") {
    const res = testAiBatchCategoryAndCostSuite();
    assert("29. GAS内テストスイート testAiBatchCategoryAndCostExpansionSuite_ (全9項目PASS)", res.failed === 0 && res.passed === res.total && res.total === 9, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testAuctionItemNumberSuite = sandbox.testAuctionItemNumberContractSuite_;
  if (typeof testAuctionItemNumberSuite === "function") {
    const res = testAuctionItemNumberSuite();
    assert("30. GAS内テストスイート testAuctionItemNumberContractSuite_ (全8項目PASS)", res.failed === 0 && res.passed === res.total && res.total === 8, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testMirrorDraftSuite = sandbox.testMirrorCreatedDraftProductSuite_;
  if (typeof testMirrorDraftSuite === "function") {
    const res = testMirrorDraftSuite();
    assert("31. GAS内テストスイート testMirrorCreatedDraftProductSuite_ (全4項目PASS)", res.failed === 0 && res.passed === res.total && res.total === 4, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  const testMirrorAiDraftStateSuite = sandbox.testMirrorAiProductDraftStateSuite_;
  if (typeof testMirrorAiDraftStateSuite === "function") {
    const res = testMirrorAiDraftStateSuite();
    assert("32. GAS内テストスイート testMirrorAiProductDraftStateSuite_ (全5項目PASS)", res.failed === 0 && res.passed === res.total && res.total === 5, `passed: ${res.passed}, failed: ${res.failed}, total: ${res.total}`);
  }

  // --------------------------------------------------
  // 33. AI一括生成 改訂要件 (原価未取得/原価なし区別・価格未設定下書き保存・アパレル/靴の状態基準・スタッフ状態保護)
  // --------------------------------------------------
  (() => {
    const noCostSummary = sandbox.computeProductCostSummaryFromInput_({ cost_breakdown: { total_allocated_cost: 0 }, links: [] });
    assert(
      "33-1. 原価なし商品は架空の0円確定原価を立てず reference_allocated_total: null, cost_status: 'no_cost' となる",
      noCostSummary.reference_allocated_total === null &&
      noCostSummary.effective_cost_amount === null &&
      noCostSummary.cost_status === "no_cost"
    );

    const failedCostSummary = sandbox.computeProductCostSummaryFromInput_({
      cost_status: "lookup_failed",
      cost_lookup_error: "Documents relay request timed out"
    });
    assert(
      "33-2. 原価取得エラー商品は cost_status: 'lookup_failed' として原価なしと内部的に区別される",
      failedCostSummary.reference_allocated_total === null &&
      failedCostSummary.effective_cost_amount === null &&
      failedCostSummary.cost_status === "lookup_failed" &&
      failedCostSummary.cost_lookup_error.indexOf("timed out") !== -1
    );

    const usedShoeGood = sandbox.validateAndSanitizeDraftCandidate_({
      title_ja: "ナイキ エアフォース1 ロー ホワイト",
      description_ja: "着用に伴う若干の使用感はありますが、目立つ傷や汚れはなく全体的に良好な状態です。出品前にクリーニング済みです。",
      title_en: "Nike Air Force 1 Low White",
      description_en: "Pre-owned in good condition with minor wear.",
      condition: "やや傷や汚れあり",
      category: "sneaker",
      brand: "NIKE"
    });
    assert(
      "33-3. 軽微な使用感のみで良好な靴・アパレルは『目立った傷や汚れなし』に正規化され『クリーニング済み』は除去される",
      usedShoeGood.condition === "目立った傷や汚れなし" &&
      usedShoeGood.description_ja.indexOf("クリーニング済み") === -1
    );

    const usedApparelNoBasisNew = sandbox.validateAndSanitizeDraftCandidate_({
      title_ja: "ステューシー ロゴ スウェット パーカー",
      description_ja: "状態良好なスウェットパーカーです。",
      title_en: "Stussy Logo Hoodie",
      description_en: "Good condition hoodie.",
      condition: "新品・未使用",
      category: "apparel",
      brand: "STUSSY"
    });
    assert(
      "33-4. 明確なタグ付き・未使用根拠のないアパレルは『新品・未使用』にせず『目立った傷や汚れなし』を標準候補にする",
      usedApparelNoBasisNew.condition === "目立った傷や汚れなし"
    );

    const damagedApparel = sandbox.validateAndSanitizeDraftCandidate_({
      title_ja: "ヴィンテージ Tシャツ",
      description_ja: "フロントに目立つシミと小さな破れがあります。",
      title_en: "Vintage T-Shirt",
      description_en: "Has a prominent stain on the front.",
      condition: "目立った傷や汚れなし",
      category: "apparel"
    });
    assert(
      "33-5. 明らかな破損や目立つ汚れがあるアパレル・靴は状態に反映される",
      damagedApparel.condition === "やや傷や汚れあり" || damagedApparel.condition === "傷や汚れあり"
    );

    // 33-6. Vans Authentic 44 DX 回帰テスト（AI生成時 + スタッフ確定時）および最低粗利率30%下限（原価11,500円 -> 16,500円）
    const vansConfirmTitle = sandbox.stripAuthenticityGuaranteeText_("Vans Authentic 44 DX アナハイム 本物保証", { isTitle: true }).text;
    const vansConfirmEnTitle = sandbox.stripAuthenticityGuaranteeText_("Vans Authentic 44 DX Anaheim Guaranteed Authentic", { isTitle: true }).text;
    const vansFloorCand = sandbox.applyCostFloorToCandidate_(
      { price: 14000, price_basis: "active_listing_reference", price_note: "販売中相場14,000円", needs_review: [] },
      {
        links: [
          {
            status: "confirmed",
            allocated_amount: 11500,
            line: { item_amount: 10000, fee_amount: 1500, tax_included_flag: true, total_line_amount: 11500 }
          }
        ]
      },
      0.30
    );
    assert(
      "33-6. 回帰検証: 'Vans Authentic 44 DX' がAI生成・スタッフ確定の双方で保持され、原価11,500円(10,000+手数料1,500)の最低粗利率30%下限が16,500円となる",
      vansConfirmTitle === "Vans Authentic 44 DX アナハイム" &&
      vansConfirmEnTitle === "Vans Authentic 44 DX Anaheim" &&
      vansFloorCand.price === 16500 &&
      vansFloorCand.price_basis === "gross_margin_floor" &&
      vansFloorCand.cost_calculation.floor_price === 16500 &&
      vansFloorCand.price_note.indexOf("最低粗利率30%") !== -1
    );
  })();

})();

console.log(`\n========================================`);
console.log(`=== 全テスト完了: ${passed}/${total} 通過 (失敗: ${failed}) ===`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}
