/**
 * docs/diagnostics/test_diagnose_tmp100_mock.js
 * 
 * diagnose_tmp100_standalone.js の静的モック検証テストスイート
 * 
 * 検証シナリオ:
 * 1. HTTP 429: Pattern 1 で即時停止 (呼出回数: 1回, パターン2未実行, overall_success: false)
 * 2. 一般 400: Pattern 1 で停止 (呼出回数: 1回, パターン2未実行, overall_success: false)
 * 3. スキーマ競合 400: Pattern 1 失敗 -> 2段階方式成功 (呼出回数: 3回, overall_success: true, summary.grounding_status: "グラウンディング達成（Stage A 検索実行・参照元確認済み）")
 * 4. HTTP 200 (検索実行あり): Pattern 1 で検索グラウンディング成功 (呼出回数: 1回, search_executed: true, overall_success: true)
 * 5. 1回方式200・検索なし -> Stage A検索あり -> Stage B (呼出回数: 3回, search_executed: true, overall_success: true, grounding_status: "グラウンディング達成（Stage A 検索実行・参照元確認済み）")
 * 6. 1回方式200・検索なし -> Stage A検索なし -> Stage Bなし (呼出回数: 2回, search_executed: false, overall_success: false, grounding_status: "グラウンディング未達成（Stage A Web検索未実行のためStage B中止）")
 * 7. Stage A での HTTP 429: Stage A で 429 検知し Stage B 中止 (呼出回数: 2回, overall_success: false)
 * 8. HTTP 200 (JSONパース失敗 / 候補なし): Pattern 1 応答はあるが JSON 解析不可 (呼出回数: 1回, candidate_valid: false, overall_success: false)
 * 9. スキーマ競合 400 -> Stage A での検索未実行 (HTTP 200, webSearchQueries 空): Stage B を呼ばず検索未実行として終了 (呼出回数: 2回, overall_success: false)
 * 10. 2段階方式のみ実行 (diagnoseTmp000100Standalone 既定 / diagnoseTmp000100TwoStageOnly): Pattern 1 スキップ, 合計2回呼出, overall_success: true
 * 11. 参照元ゼロ件 (検索クエリあり・参照元0件): Stage A検索クエリありだが参照元0件のため overall_success: false, 「商品一致未確認」
 * 12. 2段階方式のみ実行時に Stage A で検索未実行: Stage B を呼ばず合計1回呼出で終了, overall_success: false
 * 13. 4要素分離ログ出力 & Stage A プロンプト特徴量リークなし検証
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const targetScriptPath = path.join(__dirname, "diagnose_tmp100_standalone.js");
const scriptCode = fs.readFileSync(targetScriptPath, "utf8");

function runDiagnosticMock(scenarioName, mockFetchHandler, entryPointName = "diagnoseTmp000100WithSingleRequest") {
  const apiCalls = [];
  const logs = [];
  const warns = [];

  const sandbox = {
    console: {
      log: (...args) => logs.push(args.join(" ")),
      warn: (...args) => warns.push(args.join(" ")),
      error: (...args) => warns.push(args.join(" "))
    },
    Date: {
      now: () => 1000
    },
    Utilities: {
      sleep: () => {}
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        apiCalls.push({ url, options, payload });
        return mockFetchHandler(apiCalls.length, url, options, payload);
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => null
      })
    },
    getLlmApiKey_: () => "mock-test-api-key",
    getAiDraftModelName_: () => "gemini-2.5-flash",
    inspectTargetProductBeforeAiDraft: (pid) => ({
      success: true,
      product: {
        product_id: pid,
        product_name: "NIKE スニーカー シューズ 箱付き",
        sneaker_sku: "",
        brand: "NIKE",
        category: "スニーカー",
        drive_folder_url: "https://drive.google.com/drive/folders/mock_test_folder"
      },
      images: [{ id: "img-001", name: "01_main.png" }]
    }),
    getValidatedProductDriveImages_: (pid, folderUrl, imageIds) => ({
      images: [{ id: "img-001", mimeType: "image/png", base64: "aGVsbG8=" }]
    })
  };

  vm.createContext(sandbox);
  vm.runInContext(scriptCode, sandbox);

  const entryFn = sandbox[entryPointName] || sandbox.diagnoseTmp000100Standalone;
  const report = entryFn();
  return {
    scenario: scenarioName,
    apiCallCount: apiCalls.length,
    apiCalls: apiCalls,
    report: report,
    logs: logs,
    warns: warns
  };
}

console.log("==================================================");
console.log("=== diagnose_tmp100_standalone.js モック検証開始 ===");
console.log("==================================================\n");

// ----------------------------------------------------
// シナリオ 1: HTTP 429 (Pattern 1 で即時停止)
// ----------------------------------------------------
const s1 = runDiagnosticMock("Scenario 1: HTTP 429 (即時停止)", (idx, url, opt, payload) => {
  return {
    getResponseCode: () => 429,
    getContentText: () => JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded for quota metric 'Generate Content API requests'",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" },
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ subject: "generativelanguage.googleapis.com/requests", description: "Request limit exceeded" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }
        ]
      }
    })
  };
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s1.apiCallCount, 1, "Scenario 1: API呼び出しは1回のみであること");
assert.strictEqual(s1.report.aborted_reason, "HTTP_429_RATE_LIMIT", "Scenario 1: aborted_reason が HTTP_429_RATE_LIMIT であること");
assert.strictEqual(s1.report.summary.overall_success, false, "Scenario 1: overall_success が false であること");
assert.strictEqual(s1.report.pattern2_two_stage, null, "Scenario 1: パターン2は実行されないこと");
console.log("✓ Scenario 1: HTTP 429 検証成功 (呼出回数: 1回, 即時停止, overall_success: false)");

// ----------------------------------------------------
// シナリオ 2: 一般 400 (パラメータ不正等で停止)
// ----------------------------------------------------
const s2 = runDiagnosticMock("Scenario 2: 一般 400 (停止)", (idx, url, opt, payload) => {
  return {
    getResponseCode: () => 400,
    getContentText: () => JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Invalid field mask or bad request format."
      }
    })
  };
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s2.apiCallCount, 1, "Scenario 2: API呼び出しは1回のみであること");
assert.strictEqual(s2.report.aborted_reason, "HTTP_400_GENERAL_ERROR", "Scenario 2: aborted_reason が HTTP_400_GENERAL_ERROR であること");
assert.strictEqual(s2.report.summary.overall_success, false, "Scenario 2: overall_success が false であること");
assert.strictEqual(s2.report.pattern2_two_stage, null, "Scenario 2: パターン2は実行されないこと");
console.log("✓ Scenario 2: 一般 400 検証成功 (呼出回数: 1回, 停止, overall_success: false)");

// ----------------------------------------------------
// シナリオ 3: スキーマ競合 400 (2段階方式へフォールバック)
// ----------------------------------------------------
const s3 = runDiagnosticMock("Scenario 3: スキーマ競合 400 (2段階方式フォールバック)", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Pattern 1: スキーマ競合エラー
    return {
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "tools are not supported with responseSchema"
        }
      })
    };
  } else if (idx === 2) {
    // Stage A: 自由文検索成功
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nDirectly visible text: BIKE on heel\n\n### SEARCH_CORROBORATION\nMatches Nigel Sylvester collab\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR JORDAN 4 RM SP\n\n### PHYSICAL_LABEL_CHECK\nNo physical label found" }] },
          groundingMetadata: {
            webSearchQueries: ["nike bike air jordan 4 rm anthracite"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike AJ4 RM" } }]
          }
        }],
        usageMetadata: { totalTokenCount: 500 }
      })
    };
  } else if (idx === 3) {
    // Stage B: 構造化出力成功
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR / NIGEL SYLVESTER\" ANTHRACITE",
                title_en: "Nike Air Jordan 4 RM SP \"Bike Air / Nigel Sylvester\" Anthracite",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Anthracite/Bicycle Yellow",
                identification_rationale: "Box has distinct BIKE logo matching Nigel Sylvester collab."
              })
            }]
          }
        }],
        usageMetadata: { totalTokenCount: 300 }
      })
    };
  }
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s3.apiCallCount, 3, "Scenario 3: API呼び出しは合計3回 (P1 + Stage A + Stage B)");
assert.strictEqual(s3.report.pattern1_single_request.is_schema_conflict, true, "Scenario 3: P1 で is_schema_conflict が true であること");
assert.strictEqual(s3.report.pattern2_two_stage.success, true, "Scenario 3: パターン2が成功すること");
assert.strictEqual(s3.report.pattern2_two_stage.grounding_success, true, "Scenario 3: パターン2の grounding_success が true であること");
assert.strictEqual(s3.report.summary.overall_success, true, "Scenario 3: overall_success が true であること");
assert.strictEqual(s3.report.summary.grounding_status, "グラウンディング達成（Stage A 検索実行・参照元確認済み）", "Scenario 3: summary.grounding_status に2段階方式の成功結果が反映されていること");
console.log("✓ Scenario 3: スキーマ競合 400 検証成功 (呼出回数: 3回, overall_success: true, summary.grounding_status=「グラウンディング達成（Stage A 検索実行・参照元確認済み）」採用確認)");

// ----------------------------------------------------
// シナリオ 4: HTTP 200 (検索実行あり, 参照元あり, 有効な候補)
// ----------------------------------------------------
const s4 = runDiagnosticMock("Scenario 4: HTTP 200 (検索実行あり)", (idx, url, opt, payload) => {
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR / NIGEL SYLVESTER\" ANTHRACITE",
              title_en: "Nike Air Jordan 4 RM SP \"Bike Air / Nigel Sylvester\" Anthracite",
              brand: "NIKE",
              category: "スニーカー",
              sku: "",
              colorway: "Anthracite/Bicycle Yellow",
              identification_rationale: "Box has distinct BIKE logo matching Nigel Sylvester collab."
            })
          }]
        },
        groundingMetadata: {
          webSearchQueries: ["nike shoebox bike red swoosh air jordan 4 rm"],
          groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike Launch" } }]
        }
      }],
      usageMetadata: { totalTokenCount: 600 }
    })
  };
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s4.apiCallCount, 1, "Scenario 4: API呼び出しは1回のみ (P2スキップ)");
assert.strictEqual(s4.report.pattern1_single_request.search_executed, true, "Scenario 4: search_executed が true であること");
assert.strictEqual(s4.report.pattern1_single_request.has_sources, true, "Scenario 4: has_sources が true であること");
assert.strictEqual(s4.report.pattern1_single_request.candidate_valid, true, "Scenario 4: candidate_valid が true であること");
assert.strictEqual(s4.report.pattern1_single_request.grounding_success, true, "Scenario 4: grounding_success が true であること");
assert.strictEqual(s4.report.pattern1_single_request.grounding_status, "グラウンディング達成（検索実行あり）", "Scenario 4: grounding_status が達成であること");
assert.strictEqual(s4.report.summary.overall_success, true, "Scenario 4: overall_success が true であること");
assert.strictEqual(s4.report.pattern2_two_stage, null, "Scenario 4: パターン2はスキップされること");
const s4LogFound = s4.logs.some(l => l.includes("[1回呼出 成功 (検索実行あり)]"));
assert.strictEqual(s4LogFound, true, "Scenario 4: 「検索実行あり」がログに明記されること");
console.log("✓ Scenario 4: HTTP 200 (検索実行あり) 検証成功 (呼出回数: 1回, overall_success: true, 達成判定)");

// ----------------------------------------------------
// シナリオ 5: 1回方式200・検索なし -> Stage A検索あり -> Stage B
// ----------------------------------------------------
const s5 = runDiagnosticMock("Scenario 5: 1回方式200・検索なし -> Stage A検索あり -> Stage B", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Pattern 1: HTTP 200 だが webSearchQueries が空 (検索未実行)
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM",
                title_en: "Nike Air Jordan 4 RM",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Black",
                identification_rationale: "Model deduced without search."
              })
            }]
          },
          groundingMetadata: {
            webSearchQueries: [] // 検索未実行
          }
        }],
        usageMetadata: { totalTokenCount: 400 }
      })
    };
  } else if (idx === 2) {
    // Stage A: 自由文検索 & 画像照合 (検索実行あり)
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nText: BIKE\nSilhouette: low-cut\n\n### SEARCH_CORROBORATION\nNigel Sylvester collaboration\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR JORDAN 4 RM SP\n\n### PHYSICAL_LABEL_CHECK\nNo physical label" }] },
          groundingMetadata: {
            webSearchQueries: ["nike bike air jordan 4 rm anthracite"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike AJ4 RM" } }]
          }
        }],
        usageMetadata: { totalTokenCount: 500 }
      })
    };
  } else if (idx === 3) {
    // Stage B: 構造化出力成功
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR / NIGEL SYLVESTER\" ANTHRACITE",
                title_en: "Nike Air Jordan 4 RM SP \"Bike Air / Nigel Sylvester\" Anthracite",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Anthracite/Bicycle Yellow",
                identification_rationale: "Box has distinct BIKE logo matching Nigel Sylvester collab."
              })
            }]
          }
        }],
        usageMetadata: { totalTokenCount: 300 }
      })
    };
  } else {
    throw new Error("Unexpected API call index: " + idx);
  }
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s5.apiCallCount, 3, "Scenario 5: 1回方式200検索なし時は Stage A と Stage B を呼び出し合計3回であること");
assert.strictEqual(s5.report.pattern1_single_request.search_executed, false, "Scenario 5: Pattern 1 は search_executed: false であること");
assert.strictEqual(s5.report.pattern1_single_request.grounding_success, false, "Scenario 5: Pattern 1 は grounding_success: false であること");
assert.strictEqual(s5.report.pattern1_single_request.grounding_status, "グラウンディング未達成（Web検索未実行）", "Scenario 5: Pattern 1 はグラウンディング未達成であること");
assert.strictEqual(s5.report.pattern2_two_stage.success, true, "Scenario 5: パターン2が成功すること");
assert.strictEqual(s5.report.pattern2_two_stage.search_executed, true, "Scenario 5: パターン2の search_executed が true であること");
assert.strictEqual(s5.report.pattern2_two_stage.has_sources, true, "Scenario 5: パターン2の has_sources が true であること");
assert.strictEqual(s5.report.pattern2_two_stage.grounding_success, true, "Scenario 5: パターン2の grounding_success が true であること");
assert.strictEqual(s5.report.summary.overall_success, true, "Scenario 5: overall_success が true であること (2段階方式成功を採用)");
assert.strictEqual(s5.report.summary.grounding_status, "グラウンディング達成（Stage A 検索実行・参照元確認済み）", "Scenario 5: summary.grounding_status に2段階方式の成功結果が反映されていること");
const s5StageALogFound = s5.logs.some(l => l.includes("2段階方式のStage Aへ進みます"));
assert.strictEqual(s5StageALogFound, true, "Scenario 5: 1回方式検索未実行時にStage Aへの遷移ログが出力されること");
console.log("✓ Scenario 5: 「1回方式200・検索なし→Stage A検索あり→Stage B」検証成功 (呼出回数: 3回, overall_success: true, 2段階方式達成)");

// ----------------------------------------------------
// シナリオ 6: 1回方式200・検索なし -> Stage A検索なし -> Stage Bなし
// ----------------------------------------------------
const s6 = runDiagnosticMock("Scenario 6: 1回方式200・検索なし -> Stage A検索なし -> Stage Bなし", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Pattern 1: HTTP 200 だが webSearchQueries が空
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM",
                title_en: "Nike Air Jordan 4 RM",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Black",
                identification_rationale: "Deduced from training data."
              })
            }]
          },
          groundingMetadata: {
            webSearchQueries: []
          }
        }],
        usageMetadata: { totalTokenCount: 400 }
      })
    };
  } else if (idx === 2) {
    // Stage A: HTTP 200 だが webSearchQueries が空 (検索未実行)
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "Analysis: Model identified from visual priors without web search." }] },
          groundingMetadata: {
            webSearchQueries: [] // 空！
          }
        }],
        usageMetadata: { totalTokenCount: 300 }
      })
    };
  } else {
    throw new Error("Stage B should NOT be called when Stage A webSearchQueries is empty!");
  }
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s6.apiCallCount, 2, "Scenario 6: Stage A で検索未実行時は Stage B を呼ばず合計2回であること");
assert.strictEqual(s6.report.pattern1_single_request.search_executed, false, "Scenario 6: Pattern 1 は search_executed: false であること");
assert.strictEqual(s6.report.pattern2_two_stage.search_executed, false, "Scenario 6: Pattern 2 は search_executed: false であること");
assert.strictEqual(s6.report.pattern2_two_stage.grounding_success, false, "Scenario 6: Pattern 2 は grounding_success: false であること");
assert.strictEqual(s6.report.summary.overall_success, false, "Scenario 6: overall_success が false であること");
assert.strictEqual(s6.report.summary.grounding_status, "グラウンディング未達成（Stage A Web検索未実行のためStage B中止）", "Scenario 6: grounding_status が検索未実行による中止であること");
console.log("✓ Scenario 6: 「Stage A検索なし→Stage Bなし」検証成功 (呼出回数: 2回 [Stage Bスキップ], overall_success: false, 検索未実行終了)");

// ----------------------------------------------------
// シナリオ 7: Stage A での HTTP 429 (即時停止)
// ----------------------------------------------------
const s7 = runDiagnosticMock("Scenario 7: Stage A での HTTP 429", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "tools are not supported with responseSchema"
        }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded during search grounding"
        }
      })
    };
  } else {
    throw new Error("Stage B should not be called when Stage A returns 429!");
  }
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s7.apiCallCount, 2, "Scenario 7: API呼び出しは合計2回 (P1 + Stage A, Stage Bは中止)");
assert.strictEqual(s7.report.aborted_reason, "HTTP_429_RATE_LIMIT_STAGE_A", "Scenario 7: aborted_reason が HTTP_429_RATE_LIMIT_STAGE_A であること");
assert.strictEqual(s7.report.pattern2_two_stage.success, false, "Scenario 7: パターン2は失敗 (中止) となること");
assert.strictEqual(s7.report.summary.overall_success, false, "Scenario 7: overall_success が false であること");
console.log("✓ Scenario 7: Stage A での HTTP 429 検証成功 (呼出回数: 2回, Stage B中止, overall_success: false)");

// ----------------------------------------------------
// シナリオ 8: HTTP 200 (JSONパース失敗 / 候補なし)
// ----------------------------------------------------
const s8 = runDiagnosticMock("Scenario 8: HTTP 200 (JSONパース失敗)", (idx, url, opt, payload) => {
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: "I could not format the output as JSON."
          }]
        },
        groundingMetadata: {
          webSearchQueries: ["nike shoes"],
          groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike" } }]
        }
      }]
    })
  };
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s8.apiCallCount, 1, "Scenario 8: API呼び出しは1回のみ");
assert.strictEqual(s8.report.pattern1_single_request.candidate_valid, false, "Scenario 8: candidate_valid が false であること");
assert.strictEqual(s8.report.pattern1_single_request.grounding_success, false, "Scenario 8: grounding_success が false であること");
assert.strictEqual(s8.report.summary.overall_success, false, "Scenario 8: JSONパース失敗時は overall_success が false であること (総合成功と誤認しない)");
assert.strictEqual(s8.report.summary.grounding_status, "候補解析失敗（JSONパース失敗またはタイトルなし）", "Scenario 8: grounding_status が候補解析失敗であること");
console.log("✓ Scenario 8: HTTP 200 (JSONパース失敗) 検証成功 (呼出回数: 1回, candidate_valid: false, overall_success: false)");

// ----------------------------------------------------
// シナリオ 9: スキーマ競合 400 -> Stage A で検索未実行 (webSearchQueries 空)
// ----------------------------------------------------
const s9 = runDiagnosticMock("Scenario 9: スキーマ競合 400 -> Stage A で検索未実行 (webSearchQueries 空)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "tools are not supported with responseSchema"
        }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "Analysis: Model identified from visual priors without search." }] },
          groundingMetadata: {
            webSearchQueries: [] // 空！
          }
        }],
        usageMetadata: { totalTokenCount: 300 }
      })
    };
  } else {
    throw new Error("Stage B should NOT be called when Stage A webSearchQueries is empty!");
  }
}, "diagnoseTmp000100WithSingleRequest");

assert.strictEqual(s9.apiCallCount, 2, "Scenario 9: Stage A で検索未実行時は Stage B を呼ばず合計2回であること");
assert.strictEqual(s9.report.pattern2_two_stage.search_executed, false, "Scenario 9: search_executed が false であること");
assert.strictEqual(s9.report.pattern2_two_stage.grounding_success, false, "Scenario 9: grounding_success が false であること");
assert.strictEqual(s9.report.summary.overall_success, false, "Scenario 9: overall_success が false であること");
assert.strictEqual(s9.report.summary.grounding_status, "グラウンディング未達成（Stage A Web検索未実行のためStage B中止）", "Scenario 9: grounding_status が検索未実行による中止であること");
console.log("✓ Scenario 9: スキーマ競合 400 -> Stage A で検索未実行の検証成功 (呼出回数: 2回 [Stage Bスキップ], overall_success: false, 検索未実行終了)");

// ----------------------------------------------------
// シナリオ 10: 2段階方式のみ実行 (diagnoseTmp000100Standalone 既定呼出)
// ----------------------------------------------------
const s10 = runDiagnosticMock("Scenario 10: 2段階方式のみ実行 (Pattern 1スキップ)", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Stage A: 自由文検索成功
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nDirect text: BIKE on heel\nColorway: Anthracite and Yellow\n\n### SEARCH_CORROBORATION\nCorroborated with Nigel Sylvester AJ4 RM edition\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR JORDAN 4 RM SP\n\n### PHYSICAL_LABEL_CHECK\nNo physical box label SKU legible" }] },
          groundingMetadata: {
            webSearchQueries: ["nike bike air jordan 4 rm anthracite"],
            groundingChunks: [{ web: { uri: "https://nike.com/aj4-rm", title: "Air Jordan 4 RM Nigel Sylvester" } }]
          }
        }],
        usageMetadata: { totalTokenCount: 450 }
      })
    };
  } else if (idx === 2) {
    // Stage B: 構造化出力成功
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR / NIGEL SYLVESTER\" ANTHRACITE",
                title_en: "Nike Air Jordan 4 RM SP \"Bike Air / Nigel Sylvester\" Anthracite",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Anthracite/Bicycle Yellow",
                identification_rationale: "Box shows BIKE logo and sneaker design corresponds to Nigel Sylvester collaboration."
              })
            }]
          }
        }],
        usageMetadata: { totalTokenCount: 250 }
      })
    };
  } else {
    throw new Error("Unexpected API call in Scenario 10: " + idx);
  }
}, "diagnoseTmp000100Standalone");

assert.strictEqual(s10.apiCallCount, 2, "Scenario 10: Pattern 1がスキップされAPI呼出しは2回のみであること");
assert.strictEqual(s10.report.pattern1_single_request.skipped, true, "Scenario 10: Pattern 1 が skipped であること");
assert.strictEqual(s10.report.pattern2_two_stage.success, true, "Scenario 10: パターン2が成功すること");
assert.strictEqual(s10.report.pattern2_two_stage.grounding_success, true, "Scenario 10: grounding_success が true であること");
assert.strictEqual(s10.report.summary.overall_success, true, "Scenario 10: overall_success が true であること");
assert.strictEqual(s10.report.summary.grounding_status, "グラウンディング達成（Stage A 検索実行・参照元確認済み）", "Scenario 10: 成功ステータスが反映されること");
const s10SkipLogFound = s10.logs.some(l => l.includes("[1回方式スキップ]"));
assert.strictEqual(s10SkipLogFound, true, "Scenario 10: 「1回方式スキップ」ログが出力されること");
console.log("✓ Scenario 10: 2段階方式のみ実行 (Pattern 1スキップ) 検証成功 (呼出回数: 2回, overall_success: true)");

// ----------------------------------------------------
// シナリオ 11: 参照元ゼロ件 (検索クエリあり・参照元0件) の検証
// ----------------------------------------------------
const s11 = runDiagnosticMock("Scenario 11: 参照元ゼロ件 (検索クエリあり・参照元0件)", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Stage A: 検索クエリはあるが groundingChunks が空 (0件)
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nDirect text: BIKE on heel\n\n### SEARCH_CORROBORATION\nSearched but no web sources grounded\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR JORDAN 4 RM SP\n\n### PHYSICAL_LABEL_CHECK\nNo label" }] },
          groundingMetadata: {
            webSearchQueries: ["nike bike air jordan 4 rm anthracite"],
            groundingChunks: [] // 参照元0件！
          }
        }],
        usageMetadata: { totalTokenCount: 450 }
      })
    };
  } else if (idx === 2) {
    // Stage B: 構造化出力
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR / NIGEL SYLVESTER\" ANTHRACITE",
                title_en: "Nike Air Jordan 4 RM SP \"Bike Air / Nigel Sylvester\" Anthracite",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Anthracite/Bicycle Yellow",
                identification_rationale: "Deduced from search query though sources were empty."
              })
            }]
          }
        }],
        usageMetadata: { totalTokenCount: 250 }
      })
    };
  }
}, "diagnoseTmp000100Standalone");

assert.strictEqual(s11.apiCallCount, 2, "Scenario 11: Stage A + Stage B 呼出 (2回)");
assert.strictEqual(s11.report.pattern2_two_stage.search_executed, true, "Scenario 11: search_executed は true であること");
assert.strictEqual(s11.report.pattern2_two_stage.has_sources, false, "Scenario 11: has_sources は false であること (参照元0件)");
assert.strictEqual(s11.report.pattern2_two_stage.grounding_success, false, "Scenario 11: 参照元0件のため grounding_success は false であること");
assert.strictEqual(s11.report.summary.overall_success, false, "Scenario 11: 参照元0件時は overall_success が false であること");
assert.strictEqual(s11.report.summary.grounding_status, "グラウンディング未確認（検索クエリ発行あり・参照元0件のため商品一致未確認）", "Scenario 11: grounding_status が商品一致未確認であること");
const s11WarnFound = s11.logs.some(l => l.includes("※「検索クエリあり」だけで商品一致を確認済みとは判定しません"));
assert.strictEqual(s11WarnFound, true, "Scenario 11: 参照元ゼロ件時の明示ログが出力されること");
console.log("✓ Scenario 11: 参照元ゼロ件 (検索クエリあり・参照元0件) 検証成功 (overall_success: false, 商品一致未確認判定)");

// ----------------------------------------------------
// シナリオ 12: 2段階方式のみ実行時に Stage A で検索未実行 (Stage B中止)
// ----------------------------------------------------
const s12 = runDiagnosticMock("Scenario 12: 2段階方式のみ実行で Stage A 検索未実行", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Stage A: 検索未実行
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "Analysis without search." }] },
          groundingMetadata: {
            webSearchQueries: []
          }
        }]
      })
    };
  } else {
    throw new Error("Stage B should NOT be called in Scenario 12!");
  }
}, "diagnoseTmp000100Standalone");

assert.strictEqual(s12.apiCallCount, 1, "Scenario 12: Stage A 検索未実行時は Stage B を呼ばず1回のみであること");
assert.strictEqual(s12.report.pattern2_two_stage.search_executed, false, "Scenario 12: search_executed が false であること");
assert.strictEqual(s12.report.summary.overall_success, false, "Scenario 12: overall_success が false であること");
assert.strictEqual(s12.report.summary.grounding_status, "グラウンディング未達成（Stage A Web検索未実行のためStage B中止）", "Scenario 12: grounding_status が中止であること");
console.log("✓ Scenario 12: 2段階方式のみ実行で Stage A 検索未実行 検証成功 (呼出回数: 1回 [Stage Bスキップ], overall_success: false)");

// ----------------------------------------------------
// シナリオ 13: 4要素分離ログ出力 & Stage A プロンプト特徴量リークなし検証
// ----------------------------------------------------
// ログ内の4要素分離表示検証 (Scenario 10 のログをチェック)
const hasElement1 = s10.logs.some(l => l.includes("【1. 画像から観察した特徴 (外観・直接確認文字)】"));
const hasElement2 = s10.logs.some(l => l.includes("【2. 実行したWeb検索クエリ】"));
const hasElement3 = s10.logs.some(l => l.includes("【3. 参照元ページ (Web Sources: groundingChunks)】"));
const hasElement4 = s10.logs.some(l => l.includes("【4. 検索結果に支えられた商品名候補】"));

assert.strictEqual(hasElement1, true, "要素1 (画像から観察した特徴) のログ出力ヘッダーが存在すること");
assert.strictEqual(hasElement2, true, "要素2 (実行したWeb検索クエリ) のログ出力ヘッダーが存在すること");
assert.strictEqual(hasElement3, true, "要素3 (参照元ページ) のログ出力ヘッダーが存在すること");
assert.strictEqual(hasElement4, true, "要素4 (検索結果に支えられた商品名候補) のログ出力ヘッダーが存在すること");

// Stage A 送信プロンプトの検証: モデルが観察すべき具体的特徴 ("BIKE", "Air Jordan", "TPU cage", "Swoosh") や既存本票データが漏れていないこと
const stageAPayloadText = s10.apiCalls[0].payload.contents[0].parts[0].text;
assert.strictEqual(/BIKE/i.test(stageAPayloadText), false, "Stage A プロンプトに 'BIKE' が含まれていないこと");
assert.strictEqual(/Air Jordan/i.test(stageAPayloadText), false, "Stage A プロンプトに 'Air Jordan' が含まれていないこと");
assert.strictEqual(/TPU cage/i.test(stageAPayloadText), false, "Stage A プロンプトに 'TPU cage' が含まれていないこと");
assert.strictEqual(/Swoosh/i.test(stageAPayloadText), false, "Stage A プロンプトに 'Swoosh' が含まれていないこと");
assert.strictEqual(/Nigel/i.test(stageAPayloadText), false, "Stage A プロンプトに 'Nigel' が含まれていないこと");
assert.strictEqual(stageAPayloadText.includes("NIKE スニーカー シューズ 箱付き"), false, "Stage A プロンプトに既存本票名が含まれていないこと");
console.log("✓ Scenario 13: 4要素分離ログ出力 & Stage A プロンプト特徴量リークなし検証成功");

// ----------------------------------------------------
// 追加検証: 「モデル出力SKU」表記・免責文言・REST ツール仕様
// ----------------------------------------------------
assert.strictEqual(s4.report.summary.physical_label_status, "現物ラベル未検証", "physical_label_status が「現物ラベル未検証」であること");
assert.strictEqual(s4.report.summary.single_request.sku_status, "現物ラベル未検証（モデル出力SKU: 空欄）", "SKU判定が「現物ラベル未検証」であること");
assert.strictEqual(typeof s4.report.summary.grounding_accuracy_disclaimer, "string", "grounding_accuracy_disclaimer が存在すること");

// ログ出力の「モデル出力SKU」検証
const s4SkuLogFound = s4.logs.some(l => l.includes("モデル出力SKU:"));
assert.strictEqual(s4SkuLogFound, true, "「モデル出力SKU:」表記がログに含まれること");
const s4OldSkuLogFound = s4.logs.some(l => l.includes("確定SKU:"));
assert.strictEqual(s4OldSkuLogFound, false, "「確定SKU:」表記がログに含まれないこと");

// REST ツールキー検証
const p1Tool = s4.apiCalls[0].payload.tools;
assert.strictEqual(JSON.stringify(p1Tool), '[{"google_search":{}}]', "Pattern 1 のツールキーが google_search であること");
const stageATool = s3.apiCalls[1].payload.tools;
assert.strictEqual(JSON.stringify(stageATool), '[{"google_search":{}}]', "Stage A のツールキーが google_search であること");
console.log("✓ 追加検証: 「モデル出力SKU」表記・免責事項・REST ツールキー (google_search) の整合確認完了");

// ----------------------------------------------------
// シナリオ 14: 診断時モデル指定 (gemini-3.8-flash) & 人間確認特徴「BIKE」客観照合検証
// ----------------------------------------------------
// 14-a: BIKE 照合一致ケース (Stage A生成文にBIKE出現 & クエリにBIKE含有)
const s14a = runDiagnosticMock("Scenario 14-a: BIKE照合一致 (gemini-3.8-flash 指定)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nDirect text: Red BIKE logo on black box and heel\n\n### SEARCH_CORROBORATION\nMatches Nigel Sylvester Bike Air\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR JORDAN 4 RM SP\n\n### PHYSICAL_LABEL_CHECK\nNo SKU" }] },
          groundingMetadata: {
            webSearchQueries: ["nike bike air jordan 4 rm sp nigel sylvester"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Bike Air" } }]
          }
        }]
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE AIR JORDAN 4 RM SP \"BIKE AIR\"", title_en: "Nike Air Jordan 4 RM SP \"Bike Air\"" }) }] }
        }]
      })
    };
  }
}, "diagnoseTmp000100Gemini38Flash");

assert.strictEqual(s14a.apiCalls[0].url.includes("models/gemini-3.8-flash:generateContent"), true, "Scenario 14-a: APIエンドポイントに gemini-3.8-flash が指定されていること");
assert.strictEqual(s14a.report.summary.model_name, "gemini-3.8-flash", "Scenario 14-a: summary.model_name が gemini-3.8-flash であること");
assert.strictEqual(s14a.report.summary.two_stage.bike_verification.bike_detected_in_stage_a_text, true, "Scenario 14-a: bike_detected_in_stage_a_text が true であること");
assert.strictEqual(s14a.report.summary.two_stage.bike_verification.bike_included_in_queries, true, "Scenario 14-a: bike_included_in_queries が true であること");
assert.strictEqual(s14a.report.summary.two_stage.bike_verification.status, "【照合一致】Stage Aの生成文にBIKEが出現し、検索クエリにも反映されました", "Scenario 14-a: 照合判定文言が「Stage Aの生成文にBIKEが出現」となっていること");

// 14-b: 誤読検知ケース (モデルが「BIKE」を落として「Air Flight 89」を検索)
const s14b = runDiagnosticMock("Scenario 14-b: 誤読検知ケース (NIKE/Air Flight 89)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nDirect text: NIKE swoosh on black box\n\n### SEARCH_CORROBORATION\nSearched Air Flight\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR FLIGHT 89\n\n### PHYSICAL_LABEL_CHECK\nNo SKU" }] },
          groundingMetadata: {
            webSearchQueries: ["nike air flight 89 black red"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Air Flight" } }]
          }
        }]
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE AIR FLIGHT 89", title_en: "Nike Air Flight 89" }) }] }
        }]
      })
    };
  }
}, "diagnoseTmp000100Gemini38Flash");

assert.strictEqual(s14b.report.summary.two_stage.bike_verification.bike_detected_in_stage_a_text, false, "Scenario 14-b: 誤読時は bike_detected_in_stage_a_text が false であること");
assert.strictEqual(s14b.report.summary.two_stage.bike_verification.bike_included_in_queries, false, "Scenario 14-b: 誤読時は bike_included_in_queries が false であること");
assert.strictEqual(s14b.report.summary.two_stage.bike_verification.status, "【誤読検知】Stage Aの生成文にBIKEが出現せず、「NIKE」や「Air Flight 89」等の誤読・誤検索が発生している可能性があります", "Scenario 14-b: 誤読判定文言が正しいこと");
console.log("✓ Scenario 14: gemini-3.8-flash 指定 & 人間確認特徴「BIKE」客観照合検証成功 (Stage A生成文文言確認)");

// ----------------------------------------------------
// シナリオ 15: 個別商品エントリーポイント (TMP-000102, TMP-000095, TMP-000027) の個別引数なし実行検証
// ----------------------------------------------------
const s15_102 = runDiagnosticMock("Scenario 15-a: TMP-000102 診断 (gemini-3.8-flash)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nBrown green low cut sneaker, green swoosh\n\n### SEARCH_CORROBORATION\nSearched Nike Low Brown Green\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR FORCE 1 '07\n\n### PHYSICAL_LABEL_CHECK\nNo SKU" }] },
          groundingMetadata: {
            webSearchQueries: ["nike air low brown green"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Nike Air Low" } }]
          }
        }],
        usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 150, totalTokenCount: 750 }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE AIR FORCE 1 '07 OLIVE/BROWN", title_en: "Nike Air Force 1 '07 Olive/Brown" }) }] }
        }],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 80, totalTokenCount: 480 }
      })
    };
  }
}, "diagnoseTmp000102Gemini38Flash");

assert.strictEqual(s15_102.report.summary.product_id, "TMP-000102", "Scenario 15-a: product_id が TMP-000102 であること");
assert.strictEqual(s15_102.report.summary.model_name, "gemini-3.8-flash", "Scenario 15-a: model_name が gemini-3.8-flash であること");
assert.strictEqual(s15_102.report.summary.search_executed, true, "Scenario 15-a: search_executed が true であること");
assert.strictEqual(s15_102.report.summary.two_stage.bike_verification, null, "Scenario 15-a: TMP-000102 では bike_verification が null であること");
assert.strictEqual(s15_102.report.summary.staff_verification, "要スタッフ目視確認 (画像・現物照合)", "Scenario 15-a: staff_verification がスタッフ目視確認であること");
assert.strictEqual(s15_102.report.summary.two_stage.usage_tokens.input_tokens, 1000, "Scenario 15-a: 入力トークンが合算 (600 + 400) されていること");
assert.strictEqual(s15_102.report.summary.two_stage.usage_tokens.output_tokens, 230, "Scenario 15-a: 出力トークンが合算 (150 + 80) されていること");
assert.strictEqual(s15_102.report.summary.two_stage.usage_tokens.total_tokens, 1230, "Scenario 15-a: 合計トークンが合算 (750 + 480) されていること");

// TMP-000095
const s15_095 = runDiagnosticMock("Scenario 15-b: TMP-000095 診断 (gemini-3.8-flash)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nAll black dunk low sneaker\n\n### SEARCH_CORROBORATION\nSearched Nike Dunk Low Triple Black\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE DUNK LOW RETRO TRIPLE BLACK\n\n### PHYSICAL_LABEL_CHECK\nTag suffix -001" }] },
          groundingMetadata: {
            webSearchQueries: ["nike dunk low triple black 001"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Dunk Low Black" } }]
          }
        }],
        usageMetadata: { promptTokenCount: 550, candidatesTokenCount: 120, totalTokenCount: 670 }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE DUNK LOW RETRO \"TRIPLE BLACK\"", title_en: "Nike Dunk Low Retro \"Triple Black\"" }) }] }
        }],
        usageMetadata: { promptTokenCount: 350, candidatesTokenCount: 70, totalTokenCount: 420 }
      })
    };
  }
}, "diagnoseTmp000095Gemini38Flash");

assert.strictEqual(s15_095.report.summary.product_id, "TMP-000095", "Scenario 15-b: product_id が TMP-000095 であること");
assert.strictEqual(s15_095.report.summary.model_name, "gemini-3.8-flash", "Scenario 15-b: model_name が gemini-3.8-flash であること");

// TMP-000027
const s15_027 = runDiagnosticMock("Scenario 15-c: TMP-000027 診断 (gemini-3.8-flash)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nClassic sneaker\n\n### SEARCH_CORROBORATION\nSearched classic sneaker\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR MAX 90\n\n### PHYSICAL_LABEL_CHECK\nNo SKU" }] },
          groundingMetadata: {
            webSearchQueries: ["nike air max 90 white"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Air Max 90" } }]
          }
        }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, totalTokenCount: 600 }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE AIR MAX 90 WHITE", title_en: "Nike Air Max 90 White" }) }] }
        }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, totalTokenCount: 360 }
      })
    };
  }
}, "diagnoseTmp000027Gemini38Flash");

assert.strictEqual(s15_027.report.summary.product_id, "TMP-000027", "Scenario 15-c: product_id が TMP-000027 であること");
assert.strictEqual(s15_027.report.summary.model_name, "gemini-3.8-flash", "Scenario 15-c: model_name が gemini-3.8-flash であること");
console.log("✓ Scenario 15: 個別商品エントリーポイント (TMP-000102, TMP-000095, TMP-000027) の個別引数なし実行検証成功");

// ----------------------------------------------------
// シナリオ 16: 対象4商品一括実行 (diagnoseAllTargetProductsGemini38Flash) の検証
// ----------------------------------------------------
const s16 = runDiagnosticMock("Scenario 16: 対象4商品一括実行", (idx, url, opt, payload) => {
  // 各商品につき 2回 (Stage A + Stage B) 呼出 -> 4商品で計8回
  if (idx % 2 === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "### OBSERVED_FEATURES\nSneaker\n\n### SEARCH_CORROBORATION\nSearched sneaker\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE SNEAKER\n\n### PHYSICAL_LABEL_CHECK\nNo SKU" }] },
          groundingMetadata: {
            webSearchQueries: ["nike sneaker candidate"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Sneaker" } }]
          }
        }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, totalTokenCount: 600 }
      })
    };
  } else {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE CANDIDATE SNEAKER", title_en: "Nike Candidate Sneaker" }) }] }
        }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50, totalTokenCount: 350 }
      })
    };
  }
}, "diagnoseAllTargetProductsGemini38Flash");

assert.strictEqual(s16.apiCallCount, 8, "Scenario 16: 4商品 × 2段階 = 計8回のAPI呼出し");
assert.strictEqual(s16.report.total_products, 4, "Scenario 16: total_products が 4 であること");
assert.strictEqual(s16.report.search_executed_count, 4, "Scenario 16: search_executed_count が 4 であること");
assert.strictEqual(s16.report.total_tokens.input_tokens, (500 + 300) * 4, "Scenario 16: 入力トークン合計が一致すること");
assert.strictEqual(s16.report.total_tokens.output_tokens, (100 + 50) * 4, "Scenario 16: 出力トークン合計が一致すること");
console.log("✓ Scenario 16: 対象4商品一括実行 (diagnoseAllTargetProductsGemini38Flash) の検証成功");

// ----------------------------------------------------
// シナリオ 17: TMP-000102 詳細原因調査 (diagnoseTmp000102Investigation)
// Trial 1 で MAX_TOKENS 検知 -> Trial 2 で maxOutputTokens=4096 比較実行 (計3回呼出)
// ----------------------------------------------------
const s17 = runDiagnosticMock("Scenario 17: TMP-000102 詳細原因調査 (MAX_TOKENS -> Trial 2 実行)", (idx, url, opt, payload) => {
  if (idx === 1) {
    // Trial 1: Stage A (maxOutputTokens: 1024)
    // 思考トークンが1024に達し、MAX_TOKENS で打ち切られた状態を模擬
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: "MAX_TOKENS",
          content: {
            parts: [{
              thought: true,
              text: "Evaluating sneaker appearance, color scheme, outsole pattern, checking box details..."
            }]
          },
          groundingMetadata: {
            webSearchQueries: [] // 打ち切りのため検索ツール呼出に至らず
          }
        }],
        usageMetadata: {
          promptTokenCount: 260,
          candidatesTokenCount: 1024,
          thoughtsTokenCount: 1024,
          totalTokenCount: 1284
        }
      })
    };
  } else if (idx === 2) {
    // Trial 2: Stage A (maxOutputTokens: 4096)
    // 上限拡大により思考が完了し、検索クエリと回答テキストが生成された状態を模擬
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: {
            parts: [
              {
                thought: true,
                text: "Completed thinking: silhouette is Nike Air Max 97 Metallic Gold."
              },
              {
                text: "### OBSERVED_FEATURES\nGold upper with reflective wavy lines.\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR MAX 97 OG METALLIC GOLD"
              }
            ]
          },
          groundingMetadata: {
            webSearchQueries: ["nike air max 97 metallic gold"],
            groundingChunks: [{ web: { uri: "https://nike.com/am97", title: "Air Max 97 OG" } }]
          }
        }],
        usageMetadata: {
          promptTokenCount: 260,
          candidatesTokenCount: 1800,
          thoughtsTokenCount: 1400,
          totalTokenCount: 2060
        }
      })
    };
  } else if (idx === 3) {
    // Trial 2: Stage B (構造化出力)
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                title_ja: "NIKE AIR MAX 97 OG \"METALLIC GOLD\"",
                title_en: "Nike Air Max 97 OG \"Metallic Gold\"",
                brand: "NIKE",
                category: "スニーカー",
                sku: "",
                colorway: "Metallic Gold/Varsity Red",
                identification_rationale: "Matched wavy reflective lines and metallic gold finish via search."
              })
            }]
          }
        }],
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 80,
          totalTokenCount: 380
        }
      })
    };
  }
}, "diagnoseTmp000102Investigation");

assert.strictEqual(s17.apiCallCount, 3, "Scenario 17: Trial 1(Stage A) + Trial 2(Stage A + Stage B) = 計3回の呼出");
assert.strictEqual(s17.apiCalls[0].payload.generationConfig.maxOutputTokens, 1024, "Scenario 17: Trial 1 の maxOutputTokens は 1024 であること");
assert.strictEqual(s17.apiCalls[1].payload.generationConfig.maxOutputTokens, 4096, "Scenario 17: Trial 2 の maxOutputTokens は 4096 であること");
assert.strictEqual(s17.report.product_id, "TMP-000102", "Scenario 17: 対象商品IDは TMP-000102");
assert.strictEqual(s17.report.trial1.stage_a_diagnostic.finish_reason, "MAX_TOKENS", "Scenario 17: Trial 1 finishReason は MAX_TOKENS");
assert.strictEqual(s17.report.trial1.stage_a_diagnostic.thoughts_token_count, 1024, "Scenario 17: Trial 1 thoughtsTokenCount は 1024");
assert.strictEqual(s17.report.trial1.stage_a_diagnostic.parts_count, 1, "Scenario 17: Trial 1 parts数は1");
assert.strictEqual(s17.report.trial1.stage_a_diagnostic.thought_parts_count, 1, "Scenario 17: Trial 1 思考part数は1");
assert.strictEqual(s17.report.trial1.stage_a_diagnostic.response_parts_count, 0, "Scenario 17: Trial 1 回答part数は0");
assert.strictEqual(s17.report.trial2.stage_a_diagnostic.finish_reason, "STOP", "Scenario 17: Trial 2 finishReason は STOP");
assert.strictEqual(s17.report.trial2.stage_a_diagnostic.max_output_tokens_setting, 4096, "Scenario 17: Trial 2 設定は 4096");
assert.strictEqual(s17.report.trial2.summary.overall_success, true, "Scenario 17: Trial 2 は成功");
assert.ok(s17.report.facts.length >= 5, "Scenario 17: 事実が整理されていること");
assert.ok(s17.report.hypotheses.length >= 3, "Scenario 17: 推定原因が整理されていること");
assert.ok(s17.report.uncertainties.length >= 2, "Scenario 17: 不明点が整理されていること");

// 機密情報ログ非出力確認
const allS17Logs = s17.logs.join("\n");
assert.strictEqual(/mock-test-api-key/.test(allS17Logs), false, "Scenario 17: APIキーがログに出力されていないこと");
assert.strictEqual(/aGVsbG8=/.test(allS17Logs), false, "Scenario 17: 画像Base64がログに出力されていないこと");
console.log("✓ Scenario 17: TMP-000102 詳細原因調査 (MAX_TOKENS -> Trial 2 実行) 検証成功");

// ----------------------------------------------------
// シナリオ 18: TMP-000102 詳細原因調査 (diagnoseTmp000102Investigation)
// Trial 1 で STOP (MAX_TOKENS なし) -> Trial 2 スキップ (最大1回で終了)
// ----------------------------------------------------
const s18 = runDiagnosticMock("Scenario 18: TMP-000102 詳細原因調査 (STOP -> Trial 2 スキップ)", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: {
            parts: [{
              text: "Analysis completed normally without web search needed."
            }]
          },
          groundingMetadata: {
            webSearchQueries: []
          }
        }],
        usageMetadata: {
          promptTokenCount: 260,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 150,
          totalTokenCount: 560
        }
      })
    };
  } else {
    throw new Error("Trial 2 should NOT be called when Trial 1 finishReason is STOP!");
  }
}, "diagnoseTmp000102Investigation");

assert.strictEqual(s18.apiCallCount, 1, "Scenario 18: MAX_TOKENS なしの場合は Trial 2 は呼ばれず計1回の呼出");
assert.strictEqual(s18.report.trial2, null, "Scenario 18: Trial 2 は null であること");
assert.strictEqual(s18.logs.some(l => l.includes("MAX_TOKENS は検知されませんでした")), true, "Scenario 18: スキップ理由がログ出力されていること");
console.log("✓ Scenario 18: TMP-000102 詳細原因調査 (STOP -> Trial 2 スキップ) 検証成功");

// ----------------------------------------------------
// シナリオ 19: TMP-000102 Trial 2 直接実行 (diagnoseTmp000102Trial2MaxTokens4096)
// ----------------------------------------------------
const s19 = runDiagnosticMock("Scenario 19: TMP-000102 Trial 2 直接実行", (idx, url, opt, payload) => {
  if (idx === 1) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "### OBSERVED_FEATURES\nGold sneaker\n\n### CANDIDATE_TITLES\n- Title (JA): NIKE AIR MAX 97" }] },
          groundingMetadata: {
            webSearchQueries: ["nike air max 97 gold"],
            groundingChunks: [{ web: { uri: "https://nike.com", title: "Air Max 97" } }]
          }
        }],
        usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 500, totalTokenCount: 760 }
      })
    };
  } else if (idx === 2) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ title_ja: "NIKE AIR MAX 97 GOLD", title_en: "Nike Air Max 97 Gold" }) }] }
        }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50, totalTokenCount: 350 }
      })
    };
  }
}, "diagnoseTmp000102Trial2MaxTokens4096");

assert.strictEqual(s19.apiCalls[0].payload.generationConfig.maxOutputTokens, 4096, "Scenario 19: maxOutputTokens に 4096 が指定されていること");
console.log("✓ Scenario 19: TMP-000102 Trial 2 直接実行 (diagnoseTmp000102Trial2MaxTokens4096) 検証成功");

console.log("\n==================================================");
console.log("=== 全19シナリオのモックテストが正常に通過しました ===");
console.log("==================================================");



