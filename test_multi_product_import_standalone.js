// ==================================================
// 複数商品・画像インポート (Multi-Product Image Import)
// 冪等性・三重照合・4地点リカバリ・後方互換テスト
// ==================================================

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const mainCode = fs.readFileSync('./コード.js', 'utf8');

// モック環境構築
function createMockEnvironment() {
  const store = {
    props: {
      PRODUCT_ID_SEQUENCE: "100"
    },
    sheets: {},
    driveFolders: {},
    driveFiles: {}
  };

  class MockRange {
    constructor(sheet, startRow, startCol, numRows = 1, numCols = 1) {
      this.sheet = sheet;
      this.startRow = startRow;
      this.startCol = startCol;
      this.numRows = numRows;
      this.numCols = numCols;
    }

    getValue() {
      const r = this.sheet.data[this.startRow - 1];
      return (r && r[this.startCol - 1] !== undefined) ? r[this.startCol - 1] : "";
    }

    setValue(val) {
      while (this.sheet.data.length < this.startRow) {
        this.sheet.data.push([]);
      }
      const r = this.sheet.data[this.startRow - 1];
      while (r.length < this.startCol) {
        r.push("");
      }
      r[this.startCol - 1] = val;
    }

    getValues() {
      const res = [];
      for (let i = 0; i < this.numRows; i++) {
        const rowIdx = this.startRow - 1 + i;
        const row = this.sheet.data[rowIdx] || [];
        const rVals = [];
        for (let j = 0; j < this.numCols; j++) {
          const colIdx = this.startCol - 1 + j;
          rVals.push(row[colIdx] !== undefined ? row[colIdx] : "");
        }
        res.push(rVals);
      }
      return res;
    }
  }

  class MockSheet {
    constructor(name, headers = []) {
      this.name = name;
      this.data = headers.length > 0 ? [[...headers]] : [];
      this.parent = null;
    }

    getParent() {
      return this.parent;
    }

    getLastRow() {
      return this.data.length;
    }

    appendRow(row) {
      this.data.push([...row]);
    }

    getRange(startRow, startCol, numRows = 1, numCols = 1) {
      return new MockRange(this, startRow, startCol, numRows, numCols);
    }
  }

  class MockSpreadsheet {
    constructor() {
      this.sheets = {};
      const mainSheet = new MockSheet("商品マスタ", [
        "登録日時", "商品ID", "カテゴリ", "ブランド", "商品名", "状態",
        "仕入価格", "予定販売価格", "保管場所", "商品説明", "社内備考",
        "スニーカーSKU", "スニーカーサイズ", "スニーカーカラー", "箱", "付属品", "発売年",
        "ジュエリー種別", "素材", "カラット", "シェイプ", "カラー", "クラリティ", "カット",
        "メインストーン", "サイズ", "重量", "鑑定書有無", "鑑別書番号",
        "DriveフォルダURL", "メイン画像URL", "公開状態", "在庫状態", "レコード状態"
      ]);
      mainSheet.parent = this;
      this.sheets["商品マスタ"] = mainSheet;
      this.mainSheet = mainSheet;
    }

    getSheets() {
      return [this.mainSheet];
    }

    getSheetByName(name) {
      return this.sheets[name] || null;
    }

    insertSheet(name) {
      const s = new MockSheet(name);
      s.parent = this;
      this.sheets[name] = s;
      return s;
    }
  }

  const ss = new MockSpreadsheet();

  class MockDriveFolder {
    constructor(id, name) {
      this.id = id;
      this.name = name;
      this.trashed = false;
      this.files = [];
      this.subfolders = [];
    }

    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return `https://drive.google.com/drive/folders/${this.id}`; }
    isTrashed() { return this.trashed; }
    setTrashed(t) { this.trashed = t; }

    getFiles() {
      let idx = 0;
      const list = this.files.filter(f => !f.trashed);
      return {
        hasNext: () => idx < list.length,
        next: () => list[idx++]
      };
    }

    getFoldersByName(name) {
      let idx = 0;
      const list = this.subfolders.filter(f => !f.trashed && f.name === name);
      return {
        hasNext: () => idx < list.length,
        next: () => list[idx++]
      };
    }

    createFolder(name) {
      const newId = `folder_${name}_${Math.random().toString(36).substring(2, 7)}`;
      const sub = new MockDriveFolder(newId, name);
      this.subfolders.push(sub);
      store.driveFolders[newId] = sub;
      return sub;
    }

    createFile(blob) {
      const fileId = `file_${Math.random().toString(36).substring(2, 7)}`;
      const file = {
        getId: () => fileId,
        getUrl: () => `https://drive.google.com/uc?id=${fileId}&name=${blob.name}`,
        getName: () => blob.name,
        getMimeType: () => blob.mime,
        getBlob: () => ({
          getName: () => blob.name,
          getBytes: () => blob.bytes,
          getContentType: () => blob.mime
        }),
        trashed: false,
        isTrashed: function() { return this.trashed; },
        setTrashed: function(t) { this.trashed = t; }
      };
      this.files.push(file);
      store.driveFiles[fileId] = file;
      return file;
    }
  }

  const rootFolder = new MockDriveFolder("1HoDrdlNNGCsPpGMPWCej3sA5CqWv24xV", "ROOT");
  store.driveFolders[rootFolder.id] = rootFolder;

  const pokemonCardsStore = {};

  const sandbox = {
    console: console,
    CacheService: {
      getScriptCache: () => ({
        get: () => null,
        put: () => {}
      })
    },
    pokemonCardsStore,
    getPokemonCardByProductId: (pid) => pokemonCardsStore[pid] || null,
    savePokemonCardByProductId: (pid, data) => {
      pokemonCardsStore[pid] = data;
      return { status: "created", product_id: pid };
    },
    deletePokemonCardByProductId_: (pid) => {
      delete pokemonCardsStore[pid];
      return true;
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => store.props[key] || null,
        setProperty: (key, val) => { store.props[key] = String(val); }
      })
    },
    DriveApp: {
      getFolderById: (id) => {
        const f = store.driveFolders[id];
        if (!f) throw new Error("Folder not found: " + id);
        return f;
      }
    },
    Utilities: {
      base64Decode: (str) => Buffer.from(str, 'base64'),
      base64Encode: (bytes) => {
        if (Buffer.isBuffer(bytes)) return bytes.toString('base64');
        return Buffer.from(bytes).toString('base64');
      },
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      computeDigest: (algo, str) => {
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(str, 'utf8').digest();
        return Array.from(hash).map(b => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' }
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => true,
        releaseLock: () => true
      })
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
    jsonResponse: (obj) => ({
      getContent: () => JSON.stringify(obj),
      data: obj
    })
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(mainCode, context);

  return { sandbox, store, ss };
}

function parseResponse(res) {
  if (!res) return null;
  if (typeof res.getContent === 'function') {
    return JSON.parse(res.getContent());
  }
  return res.data || res;
}

console.log("==================================================");
console.log("=== 複数商品・画像インポート 冪等性テスト開始 ===");
console.log("==================================================");

// ----------------------------------------------------
// テスト 1: 指紋計算（Fingerprint）の一貫性と感度テスト
// ----------------------------------------------------
{
  const { sandbox } = createMockEnvironment();

  const payloadA1 = {
    images: [
      { base64: "dGVzdDFh", file_name: "01.jpg", mime_type: "image/jpeg" },
      { base64: "dGVzdDFi", file_name: "02.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "Sneaker A",
    category: "sneakers",
    purchase_price: 10000
  };

  const payloadA2 = {
    images: [
      { base64: "dGVzdDFh", file_name: "01.jpg", mime_type: "image/jpeg" },
      { base64: "dGVzdDFi", file_name: "02.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "Sneaker A",
    category: "sneakers",
    purchase_price: 10000
  };

  // 画像順序入替
  const payloadOrderSwap = {
    images: [
      { base64: "dGVzdDFi", file_name: "02.jpg", mime_type: "image/jpeg" },
      { base64: "dGVzdDFh", file_name: "01.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "Sneaker A",
    category: "sneakers",
    purchase_price: 10000
  };

  // 画像改変
  const payloadImageModified = {
    images: [
      { base64: "dGVzdDFhX01PRElGSUVE", file_name: "01.jpg", mime_type: "image/jpeg" },
      { base64: "dGVzdDFi", file_name: "02.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "Sneaker A",
    category: "sneakers",
    purchase_price: 10000
  };

  // 属性改変
  const payloadAttrModified = {
    images: payloadA1.images,
    product_name: "Sneaker A Modified",
    category: "sneakers",
    purchase_price: 10000
  };

  const fpA1 = sandbox.computeImportPayloadFingerprint_(payloadA1);
  const fpA2 = sandbox.computeImportPayloadFingerprint_(payloadA2);
  const fpOrder = sandbox.computeImportPayloadFingerprint_(payloadOrderSwap);
  const fpImgMod = sandbox.computeImportPayloadFingerprint_(payloadImageModified);
  const fpAttrMod = sandbox.computeImportPayloadFingerprint_(payloadAttrModified);

  assert.strictEqual(fpA1, fpA2, "同一データは同一の指紋になること");
  assert.notStrictEqual(fpA1, fpOrder, "画像順序が変われば指紋が変わること");
  assert.notStrictEqual(fpA1, fpImgMod, "画像内容が変われば指紋が変わること");
  assert.notStrictEqual(fpA1, fpAttrMod, "属性が変われば指紋が変わること");

  console.log("✓ Test 1: 指紋計算（Fingerprint）テスト通過 (同一性・順序・内容・属性の変更検出)");
}

// ----------------------------------------------------
// テスト 2: 初回インポート正常系
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_001",
    images: [
      { base64: "aW1hZ2Ux", file_name: "img1.jpg" },
      { base64: "aW1hZ2Uy", file_name: "img2.jpg" }
    ],
    product_name: "Air Jordan 1",
    category: "sneakers",
    sneaker_sku: "DZ5485-612",
    purchase_price: 15000,
    planned_sale_price: 25000,
    publish_status: "draft"
  };

  const res = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data = parseResponse(res);

  assert.strictEqual(data.success, true, "初回インポートが成功すること");
  assert.strictEqual(data.version, "product-import-v1");
  assert.strictEqual(data.is_reused, false, "初回は is_reused: false であること");
  assert.strictEqual(data.product_id, "TMP-000101", "商品IDが採番されること");
  assert.strictEqual(data.image_count, 2, "画像2枚が登録されること");
  assert.strictEqual(data.publish_status, "draft");

  // 本票行の検証 (ヘッダー1行 + 商品1行 = 2行)
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票に1行だけ追加されること");
  assert.strictEqual(ss.mainSheet.getRange(2, 2).getValue(), "TMP-000101");
  assert.strictEqual(ss.mainSheet.getRange(2, 32).getValue(), "draft");
  assert.strictEqual(ss.mainSheet.getRange(2, 33).getValue(), "in_stock");
  assert.strictEqual(ss.mainSheet.getRange(2, 34).getValue(), "active");

  // 台帳シートの検証
  const attemptsSheet = ss.getSheetByName("import_attempts");
  assert.ok(attemptsSheet, "import_attempts シートが作成されていること");
  assert.strictEqual(attemptsSheet.getLastRow(), 2, "台帳に1行追加されていること");
  assert.strictEqual(attemptsSheet.getRange(2, 1).getValue(), "IMP_TEST_001");
  assert.strictEqual(attemptsSheet.getRange(2, 2).getValue(), "completed");
  assert.strictEqual(attemptsSheet.getRange(2, 4).getValue(), "TMP-000101");

  console.log("✓ Test 2: 初回インポート正常系テスト通過 (Drive保存・本票登録・台帳記録)");
}

// ----------------------------------------------------
// テスト 3: 同一ID・同一内容の再送（地点4: 応答喪失後の再送）
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_002",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Sneaker Retry 4",
    category: "sneakers"
  };

  // 初回登録
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "初回登録後は本票2行(ヘッダー+1)");

  // 再送 (同一ID・同一内容)
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true);
  assert.strictEqual(data2.is_reused, true, "同一内容の再送は is_reused: true であること");
  assert.strictEqual(data2.product_id, data1.product_id, "同じ商品IDが返却されること");
  assert.strictEqual(data2.drive_folder_url, data1.drive_folder_url);

  // 重要: 本票行数が変わっていないこと（重複ゼロ）
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "再送後も本票行が増えず2行(重複ゼロ)であること");

  console.log("✓ Test 3: 地点4 (応答喪失後の同一ID再送) テスト通過 (三重照合・is_reused: true・重複ゼロ)");
}

// ----------------------------------------------------
// テスト 4: 同一IDで異なる内容の送信（指紋不一致の拒絶）
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  const req1 = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_003",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Original Name"
  };

  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req1);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);

  // 異なる商品名で同じIDを再利用
  const req2 = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_003",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Changed Name"
  };

  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req2);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, false, "異なる内容でのID再利用は拒絶されること");
  assert.strictEqual(data2.error_code, "IMPORT_IDEMPOTENCY_PAYLOAD_MISMATCH");

  // 本票行数が増えていないこと
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと");

  console.log("✓ Test 4: 同一ID・異なる内容の再利用拒絶テスト通過 (Fail-Closed)");
}

// ----------------------------------------------------
// テスト 5: 地点1のリカバリ（画像保存途中で失敗した後の再送）
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_LOC1",
    images: [
      { base64: "aW1hZ2Ux", file_name: "img1.jpg" },
      { base64: "aW1hZ2Uy", file_name: "img2.jpg" }
    ],
    product_name: "Crash Point 1"
  };

  // 初回: testOptions 経由で地点1例外をシミュレーション
  let errOccurred = false;
  try {
    sandbox.handleImportProductByImages(ss.mainSheet, req, { interruptStage: "during_image_save" });
  } catch (e) {
    errOccurred = true;
    assert.ok(e.message.includes("Simulated failure during image save"));
  }
  assert.strictEqual(errOccurred, true, "地点1で例外が発生したこと");

  // 本票行は未作成であること
  assert.strictEqual(ss.mainSheet.getLastRow(), 1, "本票にはまだ商品行が作成されていないこと");

  // 台帳シートには status: failed が記録されていること
  const attemptsSheet = ss.getSheetByName("import_attempts");
  assert.strictEqual(attemptsSheet.getRange(2, 2).getValue(), "failed");
  const reservedPid = attemptsSheet.getRange(2, 4).getValue();
  assert.strictEqual(reservedPid, "TMP-000101", "IDが予約されていること");

  // 再送: 正常送信 (中断オプションなし)
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true, "再送で成功すること");
  assert.strictEqual(data2.product_id, reservedPid, "予約されていた商品IDが引き継がれること");
  assert.strictEqual(data2.image_count, 2, "2枚の画像が保存されること");

  // 本票行の検証: 1行だけ作成され重複しないこと！
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票に1行だけ商品行が作成され重複ゼロであること");
  assert.strictEqual(ss.mainSheet.getRange(2, 2).getValue(), reservedPid);

  // Drive実ファイル数とメイン画像URLの検証 (再送時の重複ファイル作成を防止)
  const folderId = attemptsSheet.getRange(2, 5).getValue();
  const folder = store.driveFolders[folderId];
  assert.ok(folder, "Driveフォルダが存在すること");
  const nonTrashedFiles = folder.files.filter(f => !f.trashed);
  assert.strictEqual(nonTrashedFiles.length, 2, "再送後もDrive実ファイル数は重複せず2件であること");
  assert.strictEqual(nonTrashedFiles[0].getName(), "01_main_img1.jpg");
  assert.strictEqual(nonTrashedFiles[1].getName(), "02_img2.jpg");
  assert.strictEqual(data2.main_image_url, nonTrashedFiles[0].getUrl(), "メイン画像URLが初回保存ファイルと一致すること");

  console.log("✓ Test 5: 地点1 (画像保存途中での失敗) リカバリテスト通過 (予約ID引継ぎ・商品行重複ゼロ・Drive重複保存防止)");
}

// ----------------------------------------------------
// テスト 6: 地点2のリカバリ（行追加後・状態列前での失敗後の再送）
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_LOC2",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Crash Point 2"
  };

  // 初回: testOptions 経由で地点2例外をシミュレーション
  let errOccurred = false;
  try {
    sandbox.handleImportProductByImages(ss.mainSheet, req, { interruptStage: "after_sheet_append" });
  } catch (e) {
    errOccurred = true;
    assert.ok(e.message.includes("Simulated failure after sheet append"));
  }
  assert.strictEqual(errOccurred, true);

  // 本票行は追加されたが、状態列(32, 33, 34)は未書き込み
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票に行は追加された");
  assert.strictEqual(ss.mainSheet.getRange(2, 32).getValue(), "", "公開状態は未設定");
  assert.strictEqual(ss.mainSheet.getRange(2, 33).getValue(), "", "在庫状態は未設定");

  // 再送: 正常送信
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true);
  assert.strictEqual(data2.is_reused, true);

  // 重要: 新規行は追加されず、既存行が補修されていること
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行数は2行のままで新規行は追加されないこと(重複ゼロ)");
  assert.strictEqual(ss.mainSheet.getRange(2, 32).getValue(), "draft", "公開状態が補完されたこと");
  assert.strictEqual(ss.mainSheet.getRange(2, 33).getValue(), "in_stock", "在庫状態が補完されたこと");
  assert.strictEqual(ss.mainSheet.getRange(2, 34).getValue(), "active", "レコード状態が補完されたこと");

  console.log("✓ Test 6: 地点2 (行追加後・状態列前での失敗) リカバリテスト通過 (既存行補修・商品行重複ゼロ)");
}

// ----------------------------------------------------
// テスト 7: 地点3のリカバリ（状態列書込み途中での失敗後の再送）
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_LOC3",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Crash Point 3"
  };

  // 初回: testOptions 経由で地点3例外をシミュレーション
  let errOccurred = false;
  try {
    sandbox.handleImportProductByImages(ss.mainSheet, req, { interruptStage: "during_status_write" });
  } catch (e) {
    errOccurred = true;
    assert.ok(e.message.includes("Simulated failure during status write"));
  }
  assert.strictEqual(errOccurred, true);

  // AF(32)は書き込まれたが AG(33)/AH(34)は未書き込み
  assert.strictEqual(ss.mainSheet.getRange(2, 32).getValue(), "draft");
  assert.strictEqual(ss.mainSheet.getRange(2, 33).getValue(), "", "在庫状態は未書き込み");

  // 再送
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true);

  // 新規行は追加されず、AG/AHが補完されていること
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行数は2行のままで重複ゼロ");
  assert.strictEqual(ss.mainSheet.getRange(2, 33).getValue(), "in_stock", "在庫状態が補完されたこと");
  assert.strictEqual(ss.mainSheet.getRange(2, 34).getValue(), "active", "レコード状態が補完されたこと");

  console.log("✓ Test 7: 地点3 (状態列書込み途中での失敗) リカバリテスト通過 (状態補完・商品行重複ゼロ)");
}

// ----------------------------------------------------
// テスト 8: 既存の1商品登録の後方互換性テスト
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  // actionなし、import_attempt_idなしの従来の登録リクエスト
  const req = {
    images: [{ base64: "b2xkaW1hZ2U=", file_name: "legacy.jpg" }],
    product_name: "Legacy Product",
    category: "sneakers",
    purchase_price: 5000,
    publish_status: "draft"
  };

  const res = sandbox.handleCreateProduct(ss.mainSheet, req);
  const data = parseResponse(res);

  assert.strictEqual(data.success, true, "従来のhandleCreateProductが動作すること");
  assert.strictEqual(data.version, "product-create-v2", "従来のversionが返ること");
  assert.strictEqual(data.product_id, "TMP-000101");
  assert.strictEqual(data.publish_status, "draft");
  assert.strictEqual(data.inventory_status, "in_stock");
  assert.ok(data.drive_folder_url);
  assert.ok(data.main_image_url);

  // 本票に1行追加
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);
  // 台帳シートは作成されない（または行が追加されない）こと
  const attemptsSheet = ss.getSheetByName("import_attempts");
  assert.strictEqual(attemptsSheet, null, "従来の登録ではimport_attemptsシートは作られないこと");

  console.log("✓ Test 8: 既存の1商品登録 (後方互換性) テスト通過 (version: product-create-v2 保持)");
}

// ----------------------------------------------------
// テスト 9: action なしでも import_attempt_id があれば新インポート動作するテスト (doPost経由)
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();

  const postEvent = {
    postData: {
      contents: JSON.stringify({
        import_attempt_id: "IMP_AUTO_DETECT_001",
        images: [{ base64: "YXV0b2RldGVjdA==", file_name: "auto.jpg" }],
        product_name: "Auto Detect Product"
      })
    }
  };

  const res = sandbox.doPost(postEvent);
  const resObj = JSON.parse(res.getContent());

  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.version, "product-import-v1", "action省略でもimport_attempt_idがあれば新インポートになること");
  assert.strictEqual(resObj.import_attempt_id, "IMP_AUTO_DETECT_001");

  console.log("✓ Test 9: action 省略時の import_attempt_id 自動判定テスト通過 (doPost経由)");
}

// ----------------------------------------------------
// テスト 10: publish_status="published" を指定しても draft 固定になるテスト
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();

  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_DRAFT_ENFORCE",
    images: [{ base64: "dGVzdF9kcmFmdA==", file_name: "draft.jpg" }],
    product_name: "Draft Enforced Product",
    publish_status: "published" // 外部から published を指定！
  };

  const res = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data = parseResponse(res);

  assert.strictEqual(data.success, true);
  assert.strictEqual(data.publish_status, "draft", "レスポンスの publish_status は draft に固定されること");
  assert.strictEqual(ss.mainSheet.getRange(2, 32).getValue(), "draft", "本票AF列の値も draft に固定されること");

  console.log("✓ Test 10: publish_status='draft' 固定テスト通過 (外部指定の published を無視)");
}

// ----------------------------------------------------
// テスト 11: 外部POSTから _testInterruptStage を指定しても無視されるテスト (セキュリティ)
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();

  const postEvent = {
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "IMP_TEST_SECURITY_STAGE",
        images: [
          { base64: "c2VjdXJpdHkx", file_name: "s1.jpg" },
          { base64: "c2VjdXJpdHky", file_name: "s2.jpg" }
        ],
        product_name: "Security Stage Test",
        _testInterruptStage: "during_image_save" // 外部POSTからの悪意ある障害注入！
      })
    }
  };

  // 外部からの _testInterruptStage 指定は無視され、例外にならず正常に完了すること
  const res = sandbox.doPost(postEvent);
  const resObj = JSON.parse(res.getContent());

  assert.strictEqual(resObj.success, true, "外部POSTからの _testInterruptStage は無視され成功すること");
  assert.strictEqual(resObj.product_id, "TMP-000101");
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票に1行作成されること");

  console.log("✓ Test 11: 外部POSTからの _testInterruptStage 遮断テスト通過 (セキュリティ防御)");
}

// ----------------------------------------------------
// テスト 12: 本票行あり・Driveフォルダなし (欠損) では成功を返さずエラー (Fail-Closed)
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_MISSING_DRIVE",
    images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
    product_name: "Drive Missing Product"
  };

  // 初回登録 (成功)
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);

  // Driveフォルダを欠損状態にする (ゴミ箱移動)
  const attemptsSheet = ss.getSheetByName("import_attempts");
  const folderId = attemptsSheet.getRange(2, 5).getValue();
  const folder = store.driveFolders[folderId];
  assert.ok(folder);
  folder.setTrashed(true);

  // 再送: 本票行はあるが Drive フォルダが欠損
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);

  assert.strictEqual(data2.success, false, "本票行があってもDriveフォルダ欠損時は成功を返さないこと");
  assert.strictEqual(data2.error_code, "IMPORT_DRIVE_FOLDER_NOT_FOUND");
  assert.strictEqual(data2.product_id, "TMP-000101");
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと (重複ゼロ)");

  console.log("✓ Test 12: 本票行あり・Driveフォルダ欠損時の Fail-Closed エラーテスト通過 (IMPORT_DRIVE_FOLDER_NOT_FOUND)");
}

// ----------------------------------------------------
// テスト 13: 通常登録における既存ポケカ属性衝突時のエラー復元テスト
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();

  // 次に採番される product_id は TMP-000101
  const targetPid = "TMP-000101";

  // pokemonCardsStore にあらかじめ TMP-000101 のレコードを存在させておく (衝突状態)
  sandbox.pokemonCardsStore[targetPid] = {
    card_name: "Existing Pikachu",
    set_name: "Base Set"
  };

  const req = {
    images: [{ base64: "cG9rZW1vbg==", file_name: "pkm.jpg" }],
    product_name: "Pokemon Conflict Product",
    category: "pokemon_card",
    pokemon_card: {
      card_name: "New Pikachu",
      set_name: "Neo Genesis"
    }
  };

  // 通常登録を実行 -> 既存ポケカレコードがあるため例外がスローされること (元の挙動の復元)
  let conflictErrorThrown = false;
  try {
    sandbox.handleCreateProduct(ss.mainSheet, req);
  } catch (err) {
    conflictErrorThrown = true;
    assert.ok(
      err.message.includes("pokemon card record already exists for new product_id: " + targetPid),
      "ポケカ衝突エラーメッセージが正確に復元されていること: " + err.message
    );
  }

  assert.strictEqual(conflictErrorThrown, true, "既存ポケカ属性の衝突エラーがスローされること");
  assert.strictEqual(ss.mainSheet.getLastRow(), 1, "エラー時は本票に行が残らないこと");

  console.log("✓ Test 13: 通常登録における既存ポケカ衝突時のエラー復元テスト通過");
}

// ----------------------------------------------------
// テスト 14: 空の base64 の検証テスト (台帳作成・採番前に即時拒絶)
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();

  // 単一の空 base64
  const req1 = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_EMPTY_B64_1",
    images: [{ base64: "", file_name: "empty.jpg" }],
    product_name: "Empty B64 Product"
  };

  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req1);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, false, "空のbase64は失敗すること");
  assert.strictEqual(data1.error_code, "EMPTY_IMAGE_BASE64");

  // 台帳シートが作成されていないこと (または行が追加されていないこと)
  const attemptsSheet1 = ss.getSheetByName("import_attempts");
  assert.strictEqual(attemptsSheet1, null, "台帳作成前に拒絶されるためimport_attemptsは未作成");
  assert.strictEqual(ss.mainSheet.getLastRow(), 1, "商品行が追加されていないこと");

  // 複数画像のうち一部が空白文字 base64
  const req2 = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_EMPTY_B64_2",
    images: [
      { base64: "aW1hZ2Ux", file_name: "ok.jpg" },
      { base64: "   ", file_name: "empty.jpg" }
    ],
    product_name: "Partial Empty B64 Product"
  };

  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req2);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, false);
  assert.strictEqual(data2.error_code, "EMPTY_IMAGE_BASE64");
  assert.strictEqual(ss.getSheetByName("import_attempts"), null, "台帳未作成");
  assert.strictEqual(ss.mainSheet.getLastRow(), 1, "採番・行追加なし");

  console.log("✓ Test 14: 空の base64 事前検証テスト通過 (台帳作成・採番前の即時拒絶)");
}

// ----------------------------------------------------
// テスト 15: 完了済み再送におけるフォルダ内画像欠損テスト (Fail-Closed)
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_IMAGE_MISSING",
    images: [
      { base64: "aW1hZ2Ux", file_name: "img1.jpg" },
      { base64: "aW1hZ2Uy", file_name: "img2.jpg" }
    ],
    product_name: "Image Missing Test"
  };

  // 初回登録 (成功: 2枚画像)
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);

  // Driveフォルダ内の1枚の画像を欠損 (ゴミ箱移動) させる
  const attemptsSheet = ss.getSheetByName("import_attempts");
  const folderId = attemptsSheet.getRange(2, 5).getValue();
  const folder = store.driveFolders[folderId];
  assert.ok(folder);
  assert.strictEqual(folder.files.length, 2);
  folder.files[1].setTrashed(true); // 2枚目の画像をゴミ箱へ

  // 再送: 本票行はあるが、フォルダ内の画像が欠損
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);

  assert.strictEqual(data2.success, false, "フォルダ内の画像欠損時は成功を返さないこと");
  assert.strictEqual(data2.error_code, "IMPORT_DRIVE_IMAGES_NOT_FOUND");
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと");

  console.log("✓ Test 15: フォルダ内画像欠損時の Fail-Closed エラーテスト通過 (IMPORT_DRIVE_IMAGES_NOT_FOUND)");
}

// ----------------------------------------------------
// テスト 16: 同名で内容が異なる画像の競合検知テスト (自動流用・自動ゴミ箱移動を行わず Fail-Closed)
// ----------------------------------------------------
{
  // シナリオ A: 本票行なし (部分アップロードからの回復時)
  {
    const { sandbox, ss, store } = createMockEnvironment();
    const reqA = {
      action: "import_product_by_images",
      import_attempt_id: "IMP_TEST_DIFF_CONTENT_PARTIAL",
      images: [
        { base64: "aW1hZ2Ux", file_name: "img1.jpg" },
        { base64: "aW1hZ2Uy", file_name: "img2.jpg" }
      ],
      product_name: "Diff Content Partial"
    };

    // 初回: 地点1 (画像1保存途中) で例外発生
    try {
      sandbox.handleImportProductByImages(ss.mainSheet, reqA, { interruptStage: "during_image_save" });
    } catch (_) {}
    assert.strictEqual(ss.mainSheet.getLastRow(), 1, "本票行は未作成");

    // 保存された01_main_img1.jpgの内容を改ざん (同名だが内容が異なる)
    const attemptsSheet = ss.getSheetByName("import_attempts");
    const folderId = attemptsSheet.getRange(2, 5).getValue();
    const folder = store.driveFolders[folderId];
    assert.ok(folder);
    assert.strictEqual(folder.files.length, 1);
    const existingFile = folder.files[0];
    assert.strictEqual(existingFile.getName(), "01_main_img1.jpg");
    // 内容を別のバイト列に差し替え
    existingFile.blob = {
      name: "01_main_img1.jpg",
      bytes: Buffer.from("completely_different_image_bytes"),
      mime: "image/jpeg"
    };
    existingFile.getBlob = () => ({
      getName: () => existingFile.blob.name,
      getBytes: () => existingFile.blob.bytes,
      getContentType: () => existingFile.blob.mime
    });

    // 再送: 同名で内容が異なる画像が存在
    const resA2 = sandbox.handleImportProductByImages(ss.mainSheet, reqA);
    const dataA2 = parseResponse(resA2);

    assert.strictEqual(dataA2.success, false, "同名で内容が異なる場合は成功としないこと");
    assert.strictEqual(dataA2.error_code, "IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH");
    assert.strictEqual(existingFile.isTrashed(), false, "既存ファイルを自動でゴミ箱に移していないこと");
    assert.strictEqual(ss.mainSheet.getLastRow(), 1, "本票に行が追加されていないこと");
  }

  // シナリオ B: 本票行あり (完了済み再送時)
  {
    const { sandbox, ss, store } = createMockEnvironment();
    const reqB = {
      action: "import_product_by_images",
      import_attempt_id: "IMP_TEST_DIFF_CONTENT_COMPLETED",
      images: [{ base64: "aW1hZ2Ux", file_name: "img1.jpg" }],
      product_name: "Diff Content Completed"
    };

    const resB1 = sandbox.handleImportProductByImages(ss.mainSheet, reqB);
    const dataB1 = parseResponse(resB1);
    assert.strictEqual(dataB1.success, true);
    assert.strictEqual(ss.mainSheet.getLastRow(), 2);

    // 完了後、Drive内の画像内容を改ざん
    const attemptsSheet = ss.getSheetByName("import_attempts");
    const folderId = attemptsSheet.getRange(2, 5).getValue();
    const folderB = store.driveFolders[folderId];
    const fileB = folderB.files[0];
    fileB.blob = {
      name: "01_main_img1.jpg",
      bytes: Buffer.from("tampered_after_completed"),
      mime: "image/jpeg"
    };
    fileB.getBlob = () => ({
      getName: () => fileB.blob.name,
      getBytes: () => fileB.blob.bytes,
      getContentType: () => fileB.blob.mime
    });

    // 再送
    const resB2 = sandbox.handleImportProductByImages(ss.mainSheet, reqB);
    const dataB2 = parseResponse(resB2);

    assert.strictEqual(dataB2.success, false, "完了済みでも内容改ざん時は成功としないこと");
    assert.strictEqual(dataB2.error_code, "IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH");
    assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行数は増加しないこと");
  }

  console.log("✓ Test 16: 同名で内容が異なる画像の競合検知テスト通過 (IMPORT_DRIVE_IMAGE_CONTENT_MISMATCH・自動流用/自動ゴミ箱移動なし)");
}

// ----------------------------------------------------
// テスト 17: 従来の接頭辞なし Base64 形式での初回登録と同一ID再送テスト
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  const rawBase64_1 = "aW1hZ2UxX2NvbnRlbnQ=";
  const rawBase64_2 = "aW1hZ2UyX2NvbnRlbnQ=";

  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_RAW_B64",
    images: [
      { base64: rawBase64_1, file_name: "raw1.jpg", mime_type: "image/jpeg" },
      { base64: rawBase64_2, file_name: "raw2.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "Raw Base64 Product",
    category: "sneakers"
  };

  // 初回登録 (成功)
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);
  assert.strictEqual(data1.is_reused, false);
  assert.strictEqual(data1.image_count, 2);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);

  // Driveファイルの検証: 保存されたバイト列が rawBase64 のデコード結果と完全一致すること
  const attemptsSheet = ss.getSheetByName("import_attempts");
  const folderId = attemptsSheet.getRange(2, 5).getValue();
  const folder = store.driveFolders[folderId];
  assert.ok(folder);
  assert.strictEqual(folder.files.length, 2);
  assert.strictEqual(folder.files[0].getBlob().getBytes().toString('base64'), rawBase64_1);
  assert.strictEqual(folder.files[1].getBlob().getBytes().toString('base64'), rawBase64_2);

  // 同一ID再送 (成功: is_reused: true, 本票重複ゼロ, Driveファイル数不変)
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true);
  assert.strictEqual(data2.is_reused, true);
  assert.strictEqual(data2.product_id, data1.product_id);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと(重複ゼロ)");
  assert.strictEqual(folder.files.length, 2, "再送後もDriveファイル数が増えていないこと");

  console.log("✓ Test 17: 従来の接頭辞なし形式での初回登録・同一ID再送テスト通過 (保存内容・再送照合完全一致)");
}

// ----------------------------------------------------
// テスト 18: data URI 形式での初回登録と同一ID再送テスト (事前検証・Drive保存・再送照合の共通本体利用)
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  const rawBody1 = "ZGF0YV91cmlfaW1hZ2Ux";
  const rawBody2 = "ZGF0YV91cmlfaW1hZ2Uy";
  const dataUri1 = `data:image/jpeg;base64,${rawBody1}`;
  const dataUri2 = `data:image/png;base64,${rawBody2}`;

  const req = {
    action: "import_product_by_images",
    import_attempt_id: "IMP_TEST_DATA_URI",
    images: [
      { base64: dataUri1, file_name: "uri1.jpg" },
      { base64: dataUri2, file_name: "uri2.png" }
    ],
    product_name: "Data URI Product",
    category: "sneakers"
  };

  // 初回登録 (成功: data URI が事前検証を通過し、Driveに保存されること)
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data1 = parseResponse(res1);
  assert.strictEqual(data1.success, true);
  assert.strictEqual(data1.is_reused, false);
  assert.strictEqual(data1.image_count, 2);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);

  // Driveファイルの検証: 接頭辞 (data:...;base64,) が保存されず、純粋なBase64本体がデコード保存されていること
  const attemptsSheet = ss.getSheetByName("import_attempts");
  const folderId = attemptsSheet.getRange(2, 5).getValue();
  const folder = store.driveFolders[folderId];
  assert.ok(folder);
  assert.strictEqual(folder.files.length, 2);
  assert.strictEqual(folder.files[0].getBlob().getBytes().toString('base64'), rawBody1, "DriveにはBase64本体のバイト列のみが保存されること");
  assert.strictEqual(folder.files[1].getBlob().getBytes().toString('base64'), rawBody2, "DriveにはBase64本体のバイト列のみが保存されること");

  // 同一ID再送 (成功: is_reused: true, 本票重複ゼロ, Driveファイル数不変)
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, req);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.success, true);
  assert.strictEqual(data2.is_reused, true);
  assert.strictEqual(data2.product_id, data1.product_id);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと(重複ゼロ)");
  assert.strictEqual(folder.files.length, 2, "再送後もDriveファイル数が増えていないこと");

  console.log("✓ Test 18: data URI 形式での初回登録・同一ID再送テスト通過 (Base64本体の統一利用・Drive保存・再送照合完全一致)");
}

// ----------------------------------------------------
// テスト 19: 商品登録完了後の書類添付 (attach_product_document) 一連フロー
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  // 1. 商品を画像取込で登録
  const importReq = {
    import_attempt_id: "att-imp-flow-001",
    images: [
      { base64: "dGVzdF9pbWcx", file_name: "01.jpg", mime_type: "image/jpeg" }
    ],
    product_name: "書類添付テスト商品",
    category: "sneaker"
  };
  const impRes = sandbox.handleImportProductByImages(ss.mainSheet, importReq);
  const impData = parseResponse(impRes);
  assert.strictEqual(impData.success, true);
  const productId = impData.product_id;
  assert.ok(productId);

  // 2. 登録後に書類添付 API を呼び出し (PDF 請求書)
  const docReq = {
    action: "attach_product_document",
    product_id: productId,
    idempotency_key: "att-doc-flow-001",
    document_type: "invoice",
    file_name: "invoice_20261012.pdf",
    mime_type: "application/pdf",
    base64: "JVBERi0xLjQKJ_mock_pdf_stream"
  };
  const docRes = sandbox.handleAttachProductDocument(ss.mainSheet, docReq);
  const docData = parseResponse(docRes);

  assert.strictEqual(docData.success, true);
  assert.strictEqual(docData.is_reused, false);
  assert.strictEqual(docData.product_id, productId);
  assert.strictEqual(docData.document_type, "invoice");
  assert.strictEqual(docData.mime_type, "application/pdf");
  assert.ok(docData.file_id);
  assert.ok(docData.view_url);

  // 3. 台帳確認
  const docSheet = ss.getSheetByName("product_documents");
  assert.ok(docSheet);
  assert.strictEqual(docSheet.getLastRow(), 2);
  assert.strictEqual(docSheet.getRange(2, 1).getValue(), productId);
  assert.strictEqual(docSheet.getRange(2, 2).getValue(), docData.file_id);
  assert.strictEqual(docSheet.getRange(2, 3).getValue(), "invoice");

  console.log("✓ Test 19: 商品登録完了後の書類添付 (attach_product_document) 一連フロー通過");
}

// ----------------------------------------------------
// テスト 20: 書類の有無・再試行による import_attempt_id 指紋不変と商品再作成ゼロ
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  const reqA = {
    import_attempt_id: "att-fp-test-001",
    images: [{ base64: "dGVzdF9pbWcx", file_name: "01.jpg", mime_type: "image/jpeg" }],
    product_name: "指紋検証スニーカー",
    category: "sneaker"
  };

  // 書類なし時の指紋
  const fpWithoutDoc = sandbox.computeImportPayloadFingerprint_(reqA, true);

  // 書類情報が含まれたオブジェクトを渡しても指紋が変わらないこと
  const reqWithDoc = {
    ...reqA,
    document: {
      document_type: "invoice",
      file_name: "test.pdf"
    }
  };
  const fpWithDoc = sandbox.computeImportPayloadFingerprint_(reqWithDoc, true);
  assert.strictEqual(fpWithoutDoc, fpWithDoc, "書類プロパティによって import_attempt_id の指紋が変わらないこと");

  // 商品登録実行
  const res1 = sandbox.handleImportProductByImages(ss.mainSheet, reqA);
  const data1 = parseResponse(res1);
  const prodId = data1.product_id;

  // 書類添付
  const docRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "doc-key-fp-01",
    document_type: "invoice",
    file_name: "test.pdf",
    mime_type: "application/pdf",
    base64: "cGRmX2Jhc2U2NA=="
  });
  assert.strictEqual(parseResponse(docRes).success, true);

  // 再度 import_product_by_images を同一 attempt_id で呼んでも商品は再作成されず同一のまま
  const res2 = sandbox.handleImportProductByImages(ss.mainSheet, reqA);
  const data2 = parseResponse(res2);
  assert.strictEqual(data2.is_reused, true);
  assert.strictEqual(data2.product_id, prodId);
  assert.strictEqual(ss.mainSheet.getLastRow(), 2, "本票行が増えていないこと");

  console.log("✓ Test 20: 書類の有無・再試行による import_attempt_id 指紋不変と商品再作成ゼロ通過");
}

// ----------------------------------------------------
// テスト 21: JPG/PNG 書類の添付と商品画像一覧・商品詳細からの厳格隔離
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  // 1. 商品登録 (画像1枚)
  const impRes = sandbox.handleImportProductByImages(ss.mainSheet, {
    import_attempt_id: "att-jpg-iso-001",
    images: [{ base64: "aW1hZ2VfamVnMQ==", file_name: "01_main_sneaker.jpg", mime_type: "image/jpeg" }],
    product_name: "画像隔離テストスニーカー",
    category: "sneaker"
  });
  const prodId = parseResponse(impRes).product_id;

  // 2. JPG領収書を添付
  const docRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "doc-receipt-jpg-01",
    document_type: "receipt",
    file_name: "receipt.jpg",
    mime_type: "image/jpeg",
    base64: "cmVjZWlwdF9qcGdfYmFzZTY0"
  });
  const docData = parseResponse(docRes);
  assert.strictEqual(docData.success, true);
  const docFileId = docData.file_id;

  // 3. buildProductDetail で商品画像一覧に書類が含まれていないことを確認
  const productRow = ss.mainSheet.getRange(2, 1, 1, 40).getValues()[0];
  const prodDetail = sandbox.buildProductDetail(productRow, true, true);
  assert.ok(prodDetail.images);
  assert.strictEqual(prodDetail.images.length, 1, "商品画像は登録された1枚のみであること");
  assert.strictEqual(prodDetail.images[0].file_id !== docFileId, true, "商品画像に書類ファイルIDが含まれないこと");

  // 4. 管理者向け商品詳細には document が含まれること
  assert.ok(prodDetail.document);
  assert.strictEqual(prodDetail.document.file_id, docFileId);
  assert.strictEqual(prodDetail.document.document_type, "receipt");

  // 5. 公開向け (非管理者) 商品詳細には document が含まれないこと
  const publicDetail = sandbox.buildProductDetail(productRow, false, false);
  assert.strictEqual(publicDetail.document, undefined, "公開向けには書類情報が漏洩しないこと");

  console.log("✓ Test 21: JPG/PNG 書類の添付と商品画像一覧・商品詳細からの厳格隔離通過");
}

// ----------------------------------------------------
// テスト 22: 1商品1件制限 (別書類送信時の DOCUMENT_ALREADY_EXISTS 競合検知)
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  const impRes = sandbox.handleImportProductByImages(ss.mainSheet, {
    import_attempt_id: "att-conflict-001",
    images: [{ base64: "aW1nMQ==", file_name: "01.jpg", mime_type: "image/jpeg" }],
    product_name: "競合テスト商品"
  });
  const prodId = parseResponse(impRes).product_id;

  // 初回添付
  const doc1 = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-doc-1",
    document_type: "invoice",
    file_name: "doc1.pdf",
    mime_type: "application/pdf",
    base64: "cGRmMQ=="
  });
  assert.strictEqual(parseResponse(doc1).success, true);

  // 同一キー・同一内容の再送 -> 成功 (is_reused: true)
  const docReplay = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-doc-1",
    document_type: "invoice",
    file_name: "doc1.pdf",
    mime_type: "application/pdf",
    base64: "cGRmMQ=="
  });
  const replayData = parseResponse(docReplay);
  assert.strictEqual(replayData.success, true);
  assert.strictEqual(replayData.is_reused, true);

  // 異なるキーまたは異なる内容での送信 -> 競合拒絶 (DOCUMENT_ALREADY_EXISTS)
  const docConflict = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-doc-DIFFERENT-2",
    document_type: "receipt",
    file_name: "doc2.pdf",
    mime_type: "application/pdf",
    base64: "cGRmX2RpZmZlcmVudA=="
  });
  const conflictData = parseResponse(docConflict);
  assert.strictEqual(conflictData.success, false);
  assert.strictEqual(conflictData.error_code, "DOCUMENT_ALREADY_EXISTS");
  assert.ok(conflictData.existing_document);
  assert.strictEqual(conflictData.existing_document.original_file_name, "doc1.pdf");

  console.log("✓ Test 22: 1商品1件制限 (別書類送信時の DOCUMENT_ALREADY_EXISTS 競合検知) 通過");
}

// ----------------------------------------------------
// テスト 23: 書類添付失敗時の独立エラー返却と商品登録維持・書類のみ再試行
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  const impRes = sandbox.handleImportProductByImages(ss.mainSheet, {
    import_attempt_id: "att-retry-001",
    images: [{ base64: "aW1nMQ==", file_name: "01.jpg", mime_type: "image/jpeg" }],
    product_name: "再試行テスト商品"
  });
  const prodId = parseResponse(impRes).product_id;

  // 1. 不正な MIME タイプで失敗
  const failRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-bad-mime",
    document_type: "invoice",
    file_name: "bad.exe",
    mime_type: "application/x-msdownload",
    base64: "YmFkX2V4ZQ=="
  });
  const failData = parseResponse(failRes);
  assert.strictEqual(failData.success, false);
  assert.strictEqual(failData.error_code, "INVALID_DOCUMENT_MIME_TYPE");
  assert.strictEqual(failData.product_id, prodId);

  // 商品登録自体は維持されていること (本票行は有効)
  assert.strictEqual(ss.mainSheet.getLastRow(), 2);
  assert.strictEqual(ss.mainSheet.getRange(2, 2).getValue(), prodId);

  // 2. 正しい形式で書類のみ再試行
  const retryRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-retry-success",
    document_type: "invoice",
    file_name: "valid.png",
    mime_type: "image/png",
    base64: "dmFsaWRfcG5n"
  });
  const retryData = parseResponse(retryRes);
  assert.strictEqual(retryData.success, true);
  assert.strictEqual(retryData.product_id, prodId);
  assert.strictEqual(retryData.mime_type, "image/png");

  console.log("✓ Test 23: 書類添付失敗時の独立エラー返却と商品登録維持・書類のみ再試行通過");
}

// ----------------------------------------------------
// テスト 24: 書類容量上限検査・パラメータ柔軟性・documentレスポンス契約
// ----------------------------------------------------
{
  const { sandbox, store, ss } = createMockEnvironment();

  const impRes = sandbox.handleImportProductByImages(ss.mainSheet, {
    import_attempt_id: "att-flex-001",
    images: [{ base64: "aW1nMQ==", file_name: "01.jpg", mime_type: "image/jpeg" }],
    product_name: "柔軟性テスト商品"
  });
  const prodId = parseResponse(impRes).product_id;

  // 1. 容量超過 (15MB超)
  const hugeBytes = Buffer.alloc(16 * 1024 * 1024); // 16MB
  const hugeB64 = hugeBytes.toString("base64");
  const sizeRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    product_id: prodId,
    idempotency_key: "key-oversize-001",
    document_type: "receipt",
    file_name: "huge_receipt.pdf",
    base64: hugeB64
  });
  const sizeData = parseResponse(sizeRes);
  assert.strictEqual(sizeData.success, false);
  assert.strictEqual(sizeData.error_code, "DOCUMENT_SIZE_EXCEEDED");

  // 2. パラメータ柔軟性 (camelCase, fileName, mime省略・magic bytes判定, document オブジェクト)
  const flexRes = sandbox.handleAttachProductDocument(ss.mainSheet, {
    productId: prodId,
    idempotencyKey: "key-flex-001",
    documentType: "receipt",
    fileName: "my_receipt.jpg",
    base64: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
  });
  const flexData = parseResponse(flexRes);
  assert.strictEqual(flexData.success, true);
  assert.strictEqual(flexData.document_type, "receipt");
  assert.strictEqual(flexData.mime_type, "image/jpeg");
  assert.ok(flexData.document);
  assert.strictEqual(flexData.document.product_id, prodId);
  assert.strictEqual(flexData.document.document_type, "receipt");
  assert.strictEqual(flexData.document.mime_type, "image/jpeg");
  assert.ok(flexData.document.open_url);
  assert.ok(flexData.document.view_url);

  console.log("✓ Test 24: 書類容量超過検知・パラメータ柔軟性・documentレスポンス契約通過");
}

// ----------------------------------------------------
// テスト 25: オークション等の商品番号 (auction_item_number / AR列:44列目) 一連契約テスト
//   画像登録で1件作成 → 詳細取得 → 商品番号の編集 → 再取得（先頭ゼロ・ハイフン・空欄・重複許可・専用列分離）
// ----------------------------------------------------
{
  const { sandbox, ss } = createMockEnvironment();
  ss.mainSheet.getLastColumn = function() {
    let m = 0;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] && this.data[i].length > m) m = this.data[i].length;
    }
    return Math.max(m, 44);
  };
  ss.mainSheet.getMaxColumns = function() { return 44; };
  ss.mainSheet.getDataRange = function() {
    return this.getRange(1, 1, Math.max(this.data.length, 1), 44);
  };

  // 1. 画像登録で1件作成 (先頭ゼロ＋ハイフン付き)
  const createRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-auction-e2e-001",
        images: [{ base64: "aW1nX2F1Y3Rpb25fMDE=", file_name: "01.jpg", mime_type: "image/jpeg" }],
        category: "apparel",
        official_sku: "MFG-MODEL-01",
        notes: "検品メモ",
        auction_item_number: "00842-33225"
      })
    }
  }));
  assert.strictEqual(createRes.success, true);
  assert.strictEqual(createRes.product_id, "TMP-000101");
  assert.strictEqual(createRes.auction_item_number, "00842-33225");

  // AR列 (44列目) に保存され、official_sku (43列目)・product_id (2列目)・備考 (11列目) は無変更であること
  assert.strictEqual(ss.mainSheet.getRange(2, 44).getValue(), "00842-33225");
  assert.strictEqual(ss.mainSheet.getRange(2, 43).getValue(), "MFG-MODEL-01");
  assert.strictEqual(ss.mainSheet.getRange(2, 11).getValue(), "検品メモ");

  // 2. 詳細取得 (GET ?mode=admin&product_id=...)
  const detailBefore = parseResponse(sandbox.doGet({
    parameter: { mode: "admin", product_id: createRes.product_id }
  }));
  assert.strictEqual(detailBefore.success, true);
  assert.strictEqual(detailBefore.product.auction_item_number, "00842-33225");
  assert.strictEqual(detailBefore.product.official_sku, "MFG-MODEL-01");
  assert.strictEqual(detailBefore.product.notes, "検品メモ");

  // 3. 商品番号の編集 (POST action: "update_product")
  const editRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "update_product",
        product_id: createRes.product_id,
        auction_item_number: "0099-01-A"
      })
    }
  }));
  assert.strictEqual(editRes.success, true);
  assert.strictEqual(editRes.auction_item_number, "0099-01-A");

  // 4. 再取得 (詳細取得 & 一覧取得)
  const detailAfter = parseResponse(sandbox.doGet({
    parameter: { mode: "admin", product_id: createRes.product_id }
  }));
  assert.strictEqual(detailAfter.success, true);
  assert.strictEqual(detailAfter.product.auction_item_number, "0099-01-A");
  assert.strictEqual(detailAfter.product.category, "apparel", "既存カテゴリの値が変更されないこと");

  const listAfter = parseResponse(sandbox.doGet({
    parameter: { mode: "admin", page: "1", page_size: "20" }
  }));
  assert.strictEqual(listAfter.success, true);
  assert.strictEqual(listAfter.products[0].auction_item_number, "0099-01-A");

  // 5. 重複登録の許容 & 空欄へのクリア許容
  const dupCreateRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-auction-e2e-002",
        images: [{ base64: "aW1nX2F1Y3Rpb25fMDI=", file_name: "02.jpg", mime_type: "image/jpeg" }],
        auction_item_number: "0099-01-A"
      })
    }
  }));
  assert.strictEqual(dupCreateRes.success, true, "重複する商品番号でも登録拒否しないこと");
  assert.strictEqual(dupCreateRes.auction_item_number, "0099-01-A");

  const clearRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "update_product",
        product_id: createRes.product_id,
        auction_item_number: ""
      })
    }
  }));
  assert.strictEqual(clearRes.success, true);
  assert.strictEqual(clearRes.auction_item_number, "");

  const detailCleared = parseResponse(sandbox.doGet({
    parameter: { mode: "admin", product_id: createRes.product_id }
  }));
  assert.strictEqual(detailCleared.product.auction_item_number, "");

  console.log("✓ Test 25: オークション等の商品番号 (auction_item_number) 作成→詳細取得→編集→再取得・重複・空欄契約通過");
}

// ----------------------------------------------------
// テスト 26: Cloud Run 予約済みID (reserved_product_id) インポート & 画像メタデータ返却 & シート競合再採番テスト
// ----------------------------------------------------
{
  const { sandbox, ss, store } = createMockEnvironment();
  store.props["PRODUCT_ID_SEQUENCE"] = "164";

  // 既存行 TMP-000164 を事前に作成
  const existingRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-reserved-pre-164",
        reserved_product_id: "TMP-000164",
        images: [
          { base64: "aW1nXzE2NF9h", file_name: "front.jpg", mime_type: "image/jpeg" },
          { base64: "aW1nXzE2NF9i", file_name: "back.png", mime_type: "image/png" }
        ]
      })
    }
  }));
  assert.strictEqual(existingRes.success, true);
  assert.strictEqual(existingRes.product_id, "TMP-000164");
  assert.strictEqual(Array.isArray(existingRes.images), true);
  assert.strictEqual(existingRes.images.length, 2);
  assert.strictEqual(existingRes.images[0].name, "01_main_front.jpg");
  assert.strictEqual(existingRes.images[1].name, "02_back.png");
  assert.ok(existingRes.drive_folder_id, "drive_folder_id が返却されること");

  // 別 attempt で既にシートに存在する TMP-000164 を予約した場合、台帳を作る前に PRODUCT_ID_ALREADY_IN_SHEETS で返却すること
  const conflictRes = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-reserved-conflict-then-165",
        reserved_product_id: "TMP-000164",
        images: [
          { base64: "aW1nXzE2NV9h", file_name: "side.jpg", mime_type: "image/jpeg" }
        ]
      })
    }
  }));
  assert.strictEqual(conflictRes.success, false);
  assert.strictEqual(conflictRes.error_code, "PRODUCT_ID_ALREADY_IN_SHEETS");
  assert.strictEqual(conflictRes.max_sheet_sequence, 164);

  // 同じ import_attempt_id のまま再採番した TMP-000165 で再実行 → 成功し、再送でも images メタデータが返ること
  const retry165 = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-reserved-conflict-then-165",
        reserved_product_id: "TMP-000165",
        images: [
          { base64: "aW1nXzE2NV9h", file_name: "side.jpg", mime_type: "image/jpeg" }
        ]
      })
    }
  }));
  assert.strictEqual(retry165.success, true);
  assert.strictEqual(retry165.product_id, "TMP-000165");
  assert.strictEqual(retry165.is_reused, false);
  assert.strictEqual(retry165.images.length, 1);
  assert.strictEqual(store.props["PRODUCT_ID_SEQUENCE"], "165");

  const replay165 = parseResponse(sandbox.doPost({
    postData: {
      contents: JSON.stringify({
        action: "import_product_by_images",
        import_attempt_id: "att-reserved-conflict-then-165",
        reserved_product_id: "TMP-000165",
        images: [
          { base64: "aW1nXzE2NV9h", file_name: "side.jpg", mime_type: "image/jpeg" }
        ]
      })
    }
  }));
  assert.strictEqual(replay165.success, true);
  assert.strictEqual(replay165.is_reused, true);
  assert.strictEqual(replay165.product_id, "TMP-000165");
  assert.strictEqual(Array.isArray(replay165.images), true);
  assert.strictEqual(replay165.images.length, 1);
  assert.strictEqual(replay165.images[0].file_id, retry165.images[0].file_id);
  assert.strictEqual(ss.mainSheet.getLastRow(), 3, "商品行が重複していないこと");

  console.log("✓ Test 26: Cloud Run 予約済みID (reserved_product_id) インポート & 画像メタデータ返却 & シート競合再採番テスト通過");
}

console.log("\n==================================================");
console.log("=== 全26シナリオのインポート・書類添付・商品番号契約テストが正常に通過しました ===");
console.log("==================================================");


