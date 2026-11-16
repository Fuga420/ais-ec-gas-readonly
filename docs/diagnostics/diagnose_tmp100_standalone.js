/**
 * docs/diagnostics/diagnose_tmp100_standalone.js
 * 
 * 【検索グラウンディング実機診断専用コード (TMP-000100 1件限定 / 完全READ-ONLY)】
 * 
 * 目的:
 * - ワーカー本体 (llm_product_draft.js 等) や Script Properties (AI_DRAFT_MODEL) を一切変更せず、
 *   既存の GAS HEAD に本ファイルのみを追加して TMP-000100 の1件に限定した
 *   Google Search Grounding 実機診断を実施する。
 * - 診断時のみモデルとして `gemini-2.5-flash` を明示指定し、通常環境（lite系等）との認識精度
 *   （黒い箱の赤い「BIKE」の文字認識・検索クエリ・参照元・候補名・所要時間）を客観比較する。
 * 
 * 安全性・READ-ONLY性:
 * - 本票スプレッドシートへの書き込み (setValue, appendRow 等) は一切行いません。
 * - ドラフト履歴シート (product_ai_drafts) への書き込みは一切行いません。
 * - Square 連携へのリクエストは一切行いません。
 * - 既存の定期実行バッチワーカー (processAiBatchQueue) の動作ロジックに影響を与えません。
 * - APIキーやシークレットは一切ハードコードせず、既存の getLlmApiKey_() より取得し、エラー時も伏字化します。
 * 
 * 依存する既存 HEAD 関数 (4関数):
 * 1. getLlmApiKey_()                  (llm_translation.js L65)
 * 2. getAiDraftModelName_()           (llm_product_draft.js L932)
 * 3. inspectTargetProductBeforeAiDraft() (tests.js L2686)
 * 4. getValidatedProductDriveImages_()  (llm_product_draft.js L711)
 * 
 * 安全ガード & 設計仕様:
 * 1. HTTP 429 即時停止サーキットブレーカー:
 *    - 429（クォータ超過/レート制限）検知時は後続の全 Gemini API 呼び出しを直ちに中止。
 * 2. 診断時モデル指定（既存設定保護）:
 *    - 既存の `AI_DRAFT_MODEL` は変更せず、診断用として `gemini-2.5-flash` を指定可能。
 * 3. 検索実行有無・参照元有無・候補有効性の厳格判定:
 *    - HTTP 200 でも search_executed: false（検索クエリ0件）の場合は「グラウンディング未達成」と判定。
 *    - 検索クエリがあっても参照元（groundingChunks）が0件の場合は「商品一致未確認」とし、グラウンディング達成とは判定しない。
 *    - 2段階方式でも Stage A で検索クエリが空（webSearchQueries: 0件）なら Stage B を呼ばず検索未実行として終了。
 *    - JSONパース失敗またはタイトル欠損の場合も「候補解析失敗」と判定し、overall_success: false と返却。
 * 4. 人間確認特徴（「BIKE」）との客観照合:
 *    - プロンプトには「BIKE」等の事前ヒントを一切与えず、モデルが出力した観察テキストおよび検索クエリと人間確認の「BIKE」を事後照合して客観記録。
 * 5. グラウンディング精度に関する免責・明示:
 *    - 「グラウンディング達成」は Web 検索ツールが実行され候補が生成された状態を示し、現物との商品一致や真正性を保証するものではないことを明記。
 * 6. SKU・ラベル「現物ラベル未検証」の客観的表現:
 *    - 画像の自動認識判定を行ったかのような表現を避け、現物ラベル未検証の事実を明示。出力項目は「モデル出力SKU」と表記。
 * 7. 公式 REST 仕様準拠:
 *    - REST API 送信時のツール定義キーを公式仕様 `google_search`（スネークケース）に統一。
 */

/**
 * GAS HEADワーカーの稼働状態、検索フラグ・モデル実効値、未完了バッチを確認するエントリーポイント (引数なし)
 * @return {Object}
 */
function checkGasHeadEnvironmentAndQueue() {
  console.log("==================================================");
  console.log("=== 【GAS HEAD 稼働環境・バッチ状態検査】 開始 ===");
  console.log("==================================================");

  // 1. トリガー稼働状態
  const triggers = ScriptApp.getProjectTriggers();
  const workerTriggers = triggers.filter(t => t.getHandlerFunction() === "processAiBatchQueue");
  console.log(`\n1. 【時間トリガー稼働状態】 (登録トリガー総数: ${triggers.length}件)`);
  console.log(`   - processAiBatchQueue トリガー件数: ${workerTriggers.length}件 (推奨: 1件)`);
  workerTriggers.forEach((t, i) => {
    console.log(`     [Trigger ${i + 1}] ID: ${t.getUniqueId()}, Handler: ${t.getHandlerFunction()}, EventType: ${t.getEventType()}`);
  });

  // 2. 検索フラグ・モデル実効値
  const props = PropertiesService.getScriptProperties();
  const rawModelProp = props.getProperty("AI_DRAFT_MODEL");
  const rawSearchProp = props.getProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING");
  const rawModeProp = props.getProperty("AI_DRAFT_SEARCH_GROUNDING_MODE");
  const apiKeySet = Boolean(props.getProperty("LLM_API_KEY"));
  const adminKeySet = Boolean(props.getProperty("ADMIN_API_KEY"));

  const effectiveModel = typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : AI_DRAFT_CONFIG.DEFAULT_MODEL;
  const effectiveSearchEnabled = typeof isAiDraftSearchGroundingEnabled_ === "function" ? isAiDraftSearchGroundingEnabled_() : true;
  const effectiveMode = typeof getAiDraftSearchGroundingMode_ === "function" ? getAiDraftSearchGroundingMode_() : "two_stage";

  console.log(`\n2. 【プロパティおよび実効値】`);
  console.log(`   - AI_DRAFT_MODEL (設定値): ${rawModelProp !== null ? `'${rawModelProp}'` : "(未設定 -> 既定値適用)"}`);
  console.log(`     => 実効モデル名: '${effectiveModel}'`);
  console.log(`   - AI_DRAFT_ENABLE_SEARCH_GROUNDING (設定値): ${rawSearchProp !== null ? `'${rawSearchProp}'` : "(未設定 -> 既定値適用)"}`);
  console.log(`     => 検索グラウンディング実効状態: ${effectiveSearchEnabled ? "有効 (true / 必須)" : "無効 (false)"}`);
  console.log(`   - AI_DRAFT_SEARCH_GROUNDING_MODE (設定値): ${rawModeProp !== null ? `'${rawModeProp}'` : "(未設定 -> 既定値適用)"}`);
  console.log(`     => 検索グラウンディング実効モード: '${effectiveMode}'`);
  console.log(`   - LLM_API_KEY 存在確認: ${apiKeySet ? "設定済み (OK)" : "未設定 (NG)"}`);
  console.log(`   - ADMIN_API_KEY 存在確認: ${adminKeySet ? "設定済み (OK)" : "未設定 (NG)"}`);

  // 3. 未完了バッチ確認 (ai_batch_jobs & ai_batch_items)
  console.log(`\n3. 【バッチキューおよび未完了アイテム確認】`);
  const queueStatus = checkCurrentAiBatchQueueStatus();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const itemsSheet = ss.getSheetByName("ai_batch_items");
  let activeItems = [];
  if (itemsSheet && itemsSheet.getLastRow() > 1) {
    const itemData = itemsSheet.getRange(2, 1, itemsSheet.getLastRow() - 1, itemsSheet.getLastColumn()).getValues();
    const itemHeaders = itemsSheet.getRange(1, 1, 1, itemsSheet.getLastColumn()).getValues()[0];
    const sIdx = itemHeaders.indexOf("status");
    const bIdx = itemHeaders.indexOf("batch_id");
    const pIdx = itemHeaders.indexOf("product_id");
    itemData.forEach((row, i) => {
      const st = String(row[sIdx] || "").trim();
      if (st === "processing" || st === "pending") {
        activeItems.push({ row: i + 2, batch_id: String(row[bIdx] || ""), product_id: String(row[pIdx] || ""), status: st });
      }
    });
  }
  console.log(`   - ai_batch_items 未完了アイテム件数: ${activeItems.length}件`);
  activeItems.forEach(item => {
    console.log(`     - Row ${item.row}: batch_id=${item.batch_id}, product_id=${item.product_id}, status=${item.status}`);
  });

  return {
    triggers: { total: triggers.length, worker_triggers_count: workerTriggers.length },
    properties: {
      raw_model: rawModelProp,
      effective_model: effectiveModel,
      raw_search_enabled: rawSearchProp,
      effective_search_enabled: effectiveSearchEnabled,
      raw_mode: rawModeProp,
      effective_mode: effectiveMode,
      llm_api_key_configured: apiKeySet,
      admin_api_key_configured: adminKeySet
    },
    uncompleted_batches: queueStatus,
    uncompleted_items: { count: activeItems.length, items: activeItems }
  };
}

/**
 * Script Properties を検索必須・gemini-3.8-flash方針に整合させ、実効値を確認するエントリーポイント (引数なし)
 * - AI_DRAFT_MODEL を "gemini-3.8-flash" に設定
 * - AI_DRAFT_ENABLE_SEARCH_GROUNDING を "true" に設定
 * - AI_DRAFT_SEARCH_GROUNDING_MODE を "two_stage" に設定
 * @return {Object}
 */
function alignAndVerifyScriptPropertiesForSearchGrounding() {
  console.log("==================================================");
  console.log("=== 【Script Properties 整合・実効値確認】 開始 ===");
  console.log("==================================================");

  const props = PropertiesService.getScriptProperties();
  const beforeModel = props.getProperty("AI_DRAFT_MODEL");
  const beforeSearch = props.getProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING");
  const beforeMode = props.getProperty("AI_DRAFT_SEARCH_GROUNDING_MODE");

  console.log("[変更前の設定値]");
  console.log(`  AI_DRAFT_MODEL: ${beforeModel !== null ? `'${beforeModel}'` : "(未設定)"}`);
  console.log(`  AI_DRAFT_ENABLE_SEARCH_GROUNDING: ${beforeSearch !== null ? `'${beforeSearch}'` : "(未設定)"}`);
  console.log(`  AI_DRAFT_SEARCH_GROUNDING_MODE: ${beforeMode !== null ? `'${beforeMode}'` : "(未設定)"}`);

  const changesMade = [];
  const timestamp = new Date().toISOString();

  // 1. AI_DRAFT_MODEL: 承認済み方針により gemini-3.8-flash を明示設定
  if (beforeModel !== "gemini-3.8-flash") {
    props.setProperty("AI_DRAFT_MODEL", "gemini-3.8-flash");
    changesMade.push(`AI_DRAFT_MODEL: '${beforeModel}' -> 'gemini-3.8-flash'`);
  }

  // 2. AI_DRAFT_ENABLE_SEARCH_GROUNDING: 検索グラウンディング必須化 (true)
  if (beforeSearch !== "true") {
    props.setProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING", "true");
    changesMade.push(`AI_DRAFT_ENABLE_SEARCH_GROUNDING: '${beforeSearch}' -> 'true'`);
  }

  // 3. AI_DRAFT_SEARCH_GROUNDING_MODE: 2段階方式標準化 (two_stage)
  if (beforeMode !== "two_stage") {
    props.setProperty("AI_DRAFT_SEARCH_GROUNDING_MODE", "two_stage");
    changesMade.push(`AI_DRAFT_SEARCH_GROUNDING_MODE: '${beforeMode}' -> 'two_stage'`);
  }

  // 変更後の実効値確認
  const afterRawModel = props.getProperty("AI_DRAFT_MODEL");
  const afterRawSearch = props.getProperty("AI_DRAFT_ENABLE_SEARCH_GROUNDING");
  const afterRawMode = props.getProperty("AI_DRAFT_SEARCH_GROUNDING_MODE");

  const effectiveModel = typeof getAiDraftModelName_ === "function" ? getAiDraftModelName_() : "gemini-3.8-flash";
  const effectiveSearch = typeof isAiDraftSearchGroundingEnabled_ === "function" ? isAiDraftSearchGroundingEnabled_() : true;
  const effectiveMode = typeof getAiDraftSearchGroundingMode_ === "function" ? getAiDraftSearchGroundingMode_() : "two_stage";

  console.log("\n[変更後の設定値および実効値]");
  console.log(`  AI_DRAFT_MODEL (設定値): '${afterRawModel}' => 実効モデル名: '${effectiveModel}'`);
  console.log(`  AI_DRAFT_ENABLE_SEARCH_GROUNDING (設定値): '${afterRawSearch}' => 実効状態: ${effectiveSearch ? "有効 (true / 必須)" : "無効"}`);
  console.log(`  AI_DRAFT_SEARCH_GROUNDING_MODE (設定値): '${afterRawMode}' => 実効モード: '${effectiveMode}'`);
  console.log(`  実行日時: ${timestamp}`);
  console.log(`  実施変更: ${changesMade.length > 0 ? changesMade.join(", ") : "(既に最新設定と一致・変更なし)"}`);

  return {
    timestamp: timestamp,
    changes_made: changesMade,
    before: {
      raw_model: beforeModel,
      raw_search_enabled: beforeSearch,
      raw_mode: beforeMode
    },
    after: {
      raw_model: afterRawModel,
      raw_search_enabled: afterRawSearch,
      raw_mode: afterRawMode,
      effective_model: effectiveModel,
      effective_search_enabled: effectiveSearch,
      effective_mode: effectiveMode
    }
  };
}

/**
 * GAS HEAD の実機において、改修済み 2段階検索グラウンディング (callGeminiTwoStageSearchGrounding_) を
 * 少数件 (TMP-000100, TMP-000095) で実行し、実APIで検索クエリ・参照元が返ることを確認するエントリーポイント (引数なし)
 * ※完全READ-ONLY: 本票・ドラフト・Square への書込みは一切行いません
 * @return {Object}
 */
function verifyLiveSearchGroundingWithProductionCode() {
  console.log("==================================================");
  console.log("=== 【GAS HEAD 実API 2段階検索グラウンディング実機検証】 開始 ===");
  console.log("  検証対象: callGeminiTwoStageSearchGrounding_ (本番通常コード)");
  console.log("  ツール仕様: google_search (REST公式仕様準拠)");
  console.log("  対象商品: TMP-000100, TMP-000095 (少数件確認)");
  console.log("  安全性: 完全READ-ONLY (本票・ドラフト履歴・Square への書込みゼロ)");
  console.log("==================================================");

  const targetPids = ["TMP-000100", "TMP-000095"];
  const results = {};

  targetPids.forEach(pid => {
    console.log(`\n>>> [実機確認] ${pid} >>>`);
    const preCheck = inspectTargetProductBeforeAiDraft(pid);
    if (!preCheck || !preCheck.success || !preCheck.product) {
      console.warn(`  [事前確認失敗] ${pid}`);
      results[pid] = { success: false, error: "Product not found" };
      return;
    }

    const rawImages = Array.isArray(preCheck.images) ? preCheck.images.slice() : [];
    if (rawImages.length === 0) {
      console.warn(`  [画像未検出] ${pid}`);
      results[pid] = { success: false, error: "No images" };
      return;
    }
    rawImages.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true }));
    const selectedImageIds = rawImages.slice(0, 3).map(img => img.id);

    const validatedImages = getValidatedProductDriveImages_(
      pid,
      preCheck.product.drive_folder_url,
      selectedImageIds
    );

    const productMeta = {
      productId: pid,
      category: preCheck.product.category,
      brand: preCheck.product.brand,
      productName: "",
      sneakerSku: ""
    };

    const tStart = Date.now();
    try {
      const res = callGeminiTwoStageSearchGrounding_(
        validatedImages.images,
        productMeta,
        "gemini-3.8-flash",
        { ignore_existing_identity: true, stage_a_max_output_tokens: 4096 }
      );
      const totalElapsed = Date.now() - tStart;

      const g = res.grounding || {};
      const queries = g.queries || [];
      const sources = g.sources || [];
      const cand = res.candidate || {};

      console.log(`  [実行結果] 成功: ${res.success}, 所要時間: ${totalElapsed}ms (Stage A: ${res.stage_a_elapsed_ms}ms, Stage B: ${res.stage_b_elapsed_ms}ms)`);
      console.log(`  [検索クエリ (${queries.length}件)]: ${queries.join(", ")}`);
      console.log(`  [参照元 (${sources.length}件)]: ${sources.map(s => s.title || s.url).slice(0, 3).join(" / ")}`);
      console.log(`  [生成商品名(日)]: ${cand.title_ja}`);
      console.log(`  [生成商品名(英)]: ${cand.title_en}`);
      console.log(`  [SKU保護状態]: '${cand.sku}' (空文字であれば正常保護)`);
      console.log(`  [Stage A finishReason]: ${res.stage_a_finish_reason}`);

      results[pid] = {
        success: true,
        total_elapsed_ms: totalElapsed,
        stage_a_elapsed_ms: res.stage_a_elapsed_ms,
        stage_b_elapsed_ms: res.stage_b_elapsed_ms,
        queries_count: queries.length,
        queries: queries,
        sources_count: sources.length,
        sources: sources,
        title_ja: cand.title_ja,
        title_en: cand.title_en,
        sku_protected: cand.sku === "",
        finish_reason: res.stage_a_finish_reason,
        stage_a_usage: res.stage_a_usage,
        stage_b_usage: res.stage_b_usage
      };
    } catch (callErr) {
      const totalElapsed = Date.now() - tStart;
      console.error(`  [実行エラー] ${pid}: ${callErr.error_code || "ERROR"} - ${callErr.message} (${totalElapsed}ms)`);
      results[pid] = {
        success: false,
        error_code: callErr.error_code || "ERROR",
        message: callErr.message,
        total_elapsed_ms: totalElapsed
      };
    }
  });

  return results;
}

/**
 * GAS エディタの関数選択プルダウンからワンクリックで引数なし実行するためのエントリーポイント (TMP-000100)
 * 既定で 2段階方式 + gemini-3.8-flash を指定して実行（1回方式スキップ、通常環境設定は無変更）
 * @param {Object=} options オプション ({ twoStageOnly: boolean, modelName: string })
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100Standalone(options) {
  options = options || {};
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: options.twoStageOnly !== undefined ? !!options.twoStageOnly : true,
    modelName: options.modelName || "gemini-3.8-flash"
  });
}

/**
 * TMP-000100 専用 2段階方式 + gemini-3.8-flash 診断エントリーポイント
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100Gemini38Flash() {
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash"
  });
}

/**
 * TMP-000102 専用 2段階方式 + gemini-3.8-flash 診断エントリーポイント (Trial 1: 現在設定 maxOutputTokens=1024)
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000102Gemini38Flash() {
  return runProductSearchGroundingDiagnosis_("TMP-000102", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash",
    stageAMaxOutputTokens: 1024
  });
}

/**
 * TMP-000102 専用 詳細原因調査エントリーポイント (GASエディタ用 引数なし)
 * 1回目: 現在の設定 (maxOutputTokens: 1024) で診断し、finishReason やトークン内訳を検査。
 * MAX_TOKENS 等の証拠が得られた場合のみ、出力上限 (maxOutputTokens: 4096) を1点だけ変更して2回目を比較実行。
 * 再実行は合計2回まで。
 * @return {Object} 調査結果サマリー
 */
function diagnoseTmp000102Investigation() {
  console.log("==================================================================================");
  console.log("=== 【TMP-000102 詳細原因調査】 開始 (gemini-3.8-flash) ===");
  console.log("  調査目的: Stage A が HTTP 200 にもかかわらず Web 検索未実行・114秒要した原因の究明");
  console.log("  安全性: 完全READ-ONLY (本票・ドラフト・Square 書込みなし / プロンプト正解ヒントなし)");
  console.log("==================================================================================");

  // Trial 1: 現在の設定 (maxOutputTokens: 1024)
  console.log("\n>>> [Trial 1 / 最大2回] 現在の設定 (maxOutputTokens: 1024) で実機診断を実行します >>>");
  const trial1Report = runProductSearchGroundingDiagnosis_("TMP-000102", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash",
    stageAMaxOutputTokens: 1024
  });

  const t1Diag = trial1Report.stage_a_diagnostic || (trial1Report.pattern2_two_stage && trial1Report.pattern2_two_stage.stage_a_diagnostic) || {};
  const t1FinishReason = t1Diag.finish_reason || "UNKNOWN";
  const t1CandidatesTokens = t1Diag.candidates_token_count || 0;
  const isMaxTokens = (t1FinishReason === "MAX_TOKENS") || (t1CandidatesTokens >= 1024);

  console.log("\n----------------------------------------------------------------------------------");
  console.log(`[Trial 1 終了理由確認] finishReason='${t1FinishReason}', candidatesTokenCount=${t1CandidatesTokens}/1024, thoughtsTokenCount=${t1Diag.thoughts_token_count || 0}`);
  console.log("----------------------------------------------------------------------------------");

  let trial2Report = null;

  if (isMaxTokens) {
    console.log("\n>>> [MAX_TOKENS 証拠確認] 出力トークン上限への到達を確認しました。");
    console.log(">>> ルールに基づき、設定を【一度に一方だけ】変更 (maxOutputTokens: 1024 -> 4096) して Trial 2 を実行します >>>");
    if (typeof Utilities !== "undefined" && Utilities.sleep) {
      Utilities.sleep(3000);
    }

    trial2Report = runProductSearchGroundingDiagnosis_("TMP-000102", {
      twoStageOnly: true,
      modelName: "gemini-3.8-flash",
      stageAMaxOutputTokens: 4096
    });
  } else {
    console.log(`\n>>> [追加試行スキップ] finishReason='${t1FinishReason}' であり、MAX_TOKENS は検知されませんでした。`);
    console.log(">>> ルールに基づき、設定変更による Trial 2 は実行せず終了します。");
  }

  // 比較一覧表と分析サマリーの出力
  return formatAndLogTmp000102InvestigationReport_(trial1Report, trial2Report);
}

/**
 * TMP-000102 専用 比較用 Trial 2 エントリーポイント (単一変更: maxOutputTokens=4096 のみ変更)
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000102Trial2MaxTokens4096() {
  return runProductSearchGroundingDiagnosis_("TMP-000102", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash",
    stageAMaxOutputTokens: 4096
  });
}

/**
 * TMP-000095 専用 2段階方式 + gemini-3.8-flash 診断エントリーポイント
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000095Gemini38Flash() {
  return runProductSearchGroundingDiagnosis_("TMP-000095", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash"
  });
}

/**
 * TMP-000027 (スタッフ確認可能商品) 専用 2段階方式 + gemini-3.8-flash 診断エントリーポイント
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000027Gemini38Flash() {
  return runProductSearchGroundingDiagnosis_("TMP-000027", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash"
  });
}

/**
 * 任意の商品IDを指定して 2段階方式 + gemini-3.8-flash で実行する汎用関数
 * @param {string} productId 商品ID (例: "TMP-000100", "TMP-000102", "TMP-000095", "TMP-000027")
 * @param {Object=} options オプション ({ twoStageOnly: boolean, modelName: string })
 * @return {Object} 診断結果サマリー
 */
function diagnoseProductGemini38Flash(productId, options) {
  options = options || {};
  return runProductSearchGroundingDiagnosis_(productId, {
    twoStageOnly: options.twoStageOnly !== undefined ? !!options.twoStageOnly : true,
    modelName: options.modelName || "gemini-3.8-flash"
  });
}

/**
 * 対象4商品 (TMP-000100, TMP-000102, TMP-000095, TMP-000027) を
 * 順次 2段階方式 + gemini-3.8-flash で一括診断し、比較一覧表および集計を出力する関数
 * @return {Object} 総合診断結果・集計サマリー
 */
function diagnoseAllTargetProductsGemini38Flash() {
  const targetPids = ["TMP-000100", "TMP-000102", "TMP-000095", "TMP-000027"];
  const results = [];
  console.log("==================================================");
  console.log("=== [Gemini Search Grounding 対象4商品一括実機診断] 開始 ===");
  console.log("  検証モデル: gemini-3.8-flash");
  console.log("  対象商品: " + targetPids.join(", "));
  console.log("  安全性: 完全READ-ONLY (本票・ドラフト・Square 書込みなし)");
  console.log("  ガード: 429即時停止 / 検索未実行時はStage B中止 / 参照元検証");
  console.log("==================================================");

  for (let i = 0; i < targetPids.length; i++) {
    const pid = targetPids[i];
    console.log("\n--------------------------------------------------");
    console.log(">>> [商品 " + (i + 1) + "/" + targetPids.length + "] " + pid + " 実機診断開始 >>>");
    console.log("--------------------------------------------------");

    let res = null;
    try {
      res = runProductSearchGroundingDiagnosis_(pid, {
        twoStageOnly: true,
        modelName: "gemini-3.8-flash"
      });
    } catch (err) {
      res = {
        target_product_id: pid,
        model_name: "gemini-3.8-flash",
        success: false,
        error: err.message,
        summary: {
          product_id: pid,
          model_name: "gemini-3.8-flash",
          overall_success: false,
          grounding_status: "例外発生: " + err.message,
          search_executed: false,
          queries_count: 0,
          sources_count: 0,
          proposed_title_ja: null,
          proposed_title_en: null,
          stage_a_elapsed_ms: 0,
          stage_b_elapsed_ms: 0,
          total_elapsed_ms: 0,
          usage_tokens: null,
          staff_verification: "実行例外"
        }
      };
    }
    results.push(res);

    if (res && res.aborted_reason && res.aborted_reason.includes("429")) {
      console.warn("\n[Circuit Breaker] " + pid + " で HTTP 429 レート制限を検知したため、後続商品の診断を中断します。");
      break;
    }

    if (i < targetPids.length - 1) {
      if (typeof Utilities !== "undefined" && Utilities.sleep) {
        Utilities.sleep(2000);
      }
    }
  }

  return generateAndLogDiagnosisAggregateTable_(results, "gemini-3.8-flash");
}

/**
 * 比較用: 明示的に 2段階方式 + gemini-2.5-flash で実行するエントリーポイント
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100Gemini25Flash() {
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: true,
    modelName: "gemini-2.5-flash"
  });
}

/**
 * 2段階方式のみ実行するエントリーポイント (既定で gemini-3.8-flash)
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100TwoStageOnly() {
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: true,
    modelName: "gemini-3.8-flash"
  });
}

/**
 * 比較用: 現行の環境設定モデル (Script Properties AI_DRAFT_MODEL) で2段階方式を実行するエントリーポイント
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100WithCurrentDefaultModel() {
  const currentModel = getAiDraftModelName_();
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: true,
    modelName: currentModel
  });
}

/**
 * 1回呼出方式も含めて実行する場合のエントリーポイント (gemini-3.8-flash)
 * @return {Object} 診断結果サマリー
 */
function diagnoseTmp000100WithSingleRequest() {
  return runProductSearchGroundingDiagnosis_("TMP-000100", {
    twoStageOnly: false,
    modelName: "gemini-3.8-flash"
  });
}

/**
 * 現在のバッチキュー (ai_batch_jobs) に未完了ジョブが存在するか確認する補助関数 (完全READ-ONLY)
 * @return {Object}
 */
function checkCurrentAiBatchQueueStatus() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = ss.getSheetByName("ai_batch_jobs");
  if (!jobsSheet) {
    console.log("[Batch Queue Check] ai_batch_jobs シートは存在しません (未初期化)");
    return { active_jobs: 0, pending_jobs: [] };
  }
  const lastRow = jobsSheet.getLastRow();
  if (lastRow <= 1) {
    console.log("[Batch Queue Check] ai_batch_jobs にジョブ履歴はありません");
    return { active_jobs: 0, pending_jobs: [] };
  }

  // 1行目のヘッダーと全データを読み取り (完全READ-ONLY)
  const data = jobsSheet.getRange(2, 1, lastRow - 1, jobsSheet.getLastColumn()).getValues();
  const headers = jobsSheet.getRange(1, 1, 1, jobsSheet.getLastColumn()).getValues()[0];
  const statusColIdx = headers.indexOf("status");
  const idColIdx = headers.indexOf("batch_id");

  const pendingJobs = [];
  data.forEach((row, i) => {
    const status = String(row[statusColIdx] || "").trim();
    const batchId = String(row[idColIdx] || "").trim();
    if (status === "queued" || status === "processing") {
      pendingJobs.push({ row: i + 2, batch_id: batchId, status: status });
    }
  });

  console.log(`[Batch Queue Check] 未完了ジョブ件数: ${pendingJobs.length}`);
  if (pendingJobs.length > 0) {
    pendingJobs.forEach(j => console.log(`  - Row ${j.row}: batch_id=${j.batch_id}, status=${j.status}`));
  }
  return { active_jobs: pendingJobs.length, pending_jobs: pendingJobs };
}

/**
 * HTTP 429 応答本文から秘密情報を保護しつつクォータ詳細をサニタイズ抽出する補助関数
 * @param {string} bodyText
 * @return {Object}
 */
function extractSanitized429Details_(bodyText) {
  const result = {
    status: "RESOURCE_EXHAUSTED",
    reason: "",
    quota_metric: "",
    quota_limit: "",
    retry_delay: "",
    message: ""
  };
  if (!bodyText || typeof bodyText !== "string") {
    return result;
  }
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed.error || {};
    result.status = err.status || result.status;
    result.message = String(err.message || "").substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
    if (Array.isArray(err.details)) {
      for (const d of err.details) {
        if (d["@type"] && d["@type"].includes("ErrorInfo")) {
          result.reason = d.reason || result.reason;
        }
        if (d["@type"] && d["@type"].includes("QuotaFailure") && Array.isArray(d.violations)) {
          const v0 = d.violations[0] || {};
          result.quota_metric = v0.subject || result.quota_metric;
          result.quota_limit = v0.description || result.quota_limit;
        }
        if (d["@type"] && d["@type"].includes("RetryInfo")) {
          result.retry_delay = d.retryDelay || result.retry_delay;
        }
      }
    }
  } catch (_) {
    result.message = bodyText.substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
  }
  return result;
}

/**
 * groundingMetadata から web sources (URL・タイトル) を安全に抽出する補助関数
 * @param {Object} groundingMetadata
 * @return {Array<{uri: string, title: string}>}
 */
function extractGroundingSources_(groundingMetadata) {
  if (!groundingMetadata || !Array.isArray(groundingMetadata.groundingChunks)) {
    return [];
  }
  const sources = [];
  groundingMetadata.groundingChunks.forEach(chunk => {
    if (!chunk) return;
    if (chunk.web && (chunk.web.uri || chunk.web.title)) {
      sources.push({
        uri: String(chunk.web.uri || "").trim(),
        title: String(chunk.web.title || "").trim()
      });
    } else if (typeof chunk === "string" && chunk.trim()) {
      sources.push({ uri: chunk.trim(), title: "" });
    }
  });
  return sources;
}

/**
 * Stage A の応答テキストから観察された特徴（外観・直接確認文字）を抽出する補助関数
 * @param {string} text
 * @return {string}
 */
function extractObservedFeaturesFromText_(text) {
  if (!text || typeof text !== "string") return "";
  const m = text.match(/###\s*OBSERVED_FEATURES\s*([\s\S]*?)(?=###|$)/i);
  if (m && m[1].trim()) {
    return m[1].trim();
  }
  const m2 = text.match(/(?:(?:Step\s*1|1[\.\)]|直接確認できる文字|外観特徴)[\s\S]*?)(?=(?:Step\s*3|3[\.\)]|Web\s*search|###)|$)/i);
  if (m2 && m2[0].trim()) {
    return m2[0].trim();
  }
  return text.substring(0, 500).trim();
}

/**
 * Stage A の応答テキストから候補タイトルを抽出する補助関数
 * @param {string} text
 * @return {string}
 */
function extractCandidateTitlesFromText_(text) {
  if (!text || typeof text !== "string") return "";
  const m = text.match(/###\s*CANDIDATE_TITLES\s*([\s\S]*?)(?=###|$)/i);
  if (m && m[1].trim()) {
    return m[1].trim();
  }
  const m2 = text.match(/(?:(?:Step\s*4|4[\.\)]|Recommended|推薦商品名|候補タイトル)[\s\S]*?)(?=(?:Step\s*5|5[\.\)]|Physical|###)|$)/i);
  if (m2 && m2[0].trim()) {
    return m2[0].trim();
  }
  return "";
}

/**
 * TMP-000100 1件限定 検索グラウンディング実機診断コア関数 (互換性用)
 * @param {Object=} options オプション ({ twoStageOnly: boolean, modelName: string })
 * @return {Object}
 */
function runTmp000100SearchGroundingDiagnosis_(options) {
  return runProductSearchGroundingDiagnosis_("TMP-000100", options);
}

/**
 * 商品別 検索グラウンディング実機診断コア関数 (完全READ-ONLY)
 * @param {string} productId 商品ID (例: "TMP-000100", "TMP-000102", "TMP-000095", "TMP-000027")
 * @param {Object=} options オプション ({ twoStageOnly: boolean, modelName: string })
 * @return {Object}
 */
function runProductSearchGroundingDiagnosis_(productId, options) {
  options = options || {};
  const TARGET_PID = String(productId || "TMP-000100").trim();
  const twoStageOnly = options.twoStageOnly !== undefined ? !!options.twoStageOnly : (options.mode === "two_stage_only");

  // 1. API キー & 検証モデル名の取得
  const apiKey = getLlmApiKey_();
  if (!apiKey) {
    throw new Error("[Diagnosis Aborted] Script Properties に LLM_API_KEY が設定されていません");
  }
  const currentEnvModel = getAiDraftModelName_();
  const specifiedModel = options.modelName || options.model;
  const testModel = String(specifiedModel || "gemini-3.8-flash").trim();

  console.log("==================================================");
  console.log(`=== [Gemini Search Grounding 診断] 開始: ${TARGET_PID} ===`);
  console.log(`  モード: ${TARGET_PID} 対象` + (twoStageOnly ? " [2段階方式のみ (1回方式スキップ)]" : ""));
  console.log(`  検証モデル (診断指定): '${testModel}'`);
  console.log(`  現行環境モデル: '${currentEnvModel || "(未設定)"}' (※Script Properties AI_DRAFT_MODEL や通常ワーカーは変更していません)`);
  console.log("  安全性: 完全READ-ONLY (本票・ドラフト・Square 書込みなし)");
  console.log("  ガード: 429即時停止 / 検索未実行時はStage B中止 / 参照元検証 / 誤情報・先入観排除");
  console.log("==================================================");

  // 0. バッチキュー状況確認
  checkCurrentAiBatchQueueStatus();

  // 2. 本票商品データ & Drive 画像の取得 (既存 HEAD 関数を利用)
  let preCheck = null;
  try {
    preCheck = inspectTargetProductBeforeAiDraft(TARGET_PID);
  } catch (e) {
    const errText = "本票事前チェック例外: " + e.message;
    return {
      target_product_id: TARGET_PID,
      model_name: testModel,
      success: false,
      overall_success: false,
      error: errText,
      summary: {
        product_id: TARGET_PID,
        model_name: testModel,
        overall_success: false,
        grounding_status: errText,
        search_executed: false,
        queries_count: 0,
        sources_count: 0,
        proposed_title_ja: null,
        proposed_title_en: null,
        stage_a_elapsed_ms: 0,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: 0,
        usage_tokens: null,
        staff_verification: "取得例外"
      }
    };
  }
  if (!preCheck || !preCheck.success || !preCheck.product) {
    const errText = "本票商品データが見つかりません: " + (preCheck ? preCheck.error : "");
    return {
      target_product_id: TARGET_PID,
      model_name: testModel,
      success: false,
      overall_success: false,
      error: errText,
      summary: {
        product_id: TARGET_PID,
        model_name: testModel,
        overall_success: false,
        grounding_status: errText,
        search_executed: false,
        queries_count: 0,
        sources_count: 0,
        proposed_title_ja: null,
        proposed_title_en: null,
        stage_a_elapsed_ms: 0,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: 0,
        usage_tokens: null,
        staff_verification: "商品不在"
      }
    };
  }

  const p = preCheck.product;
  console.log(`  既存本票データ: 商品名='${p.product_name || "(未設定)"}', SKU='${p.sneaker_sku || "(未設定)"}', ブランド='${p.brand || "-"}', カテゴリ='${p.category || "-"}'`);

  const rawImages = Array.isArray(preCheck.images) ? preCheck.images.slice() : [];
  if (rawImages.length === 0) {
    const errText = "画像が見つかりません";
    return {
      target_product_id: TARGET_PID,
      model_name: testModel,
      success: false,
      overall_success: false,
      error: errText,
      summary: {
        product_id: TARGET_PID,
        model_name: testModel,
        overall_success: false,
        grounding_status: errText,
        search_executed: false,
        queries_count: 0,
        sources_count: 0,
        proposed_title_ja: null,
        proposed_title_en: null,
        stage_a_elapsed_ms: 0,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: 0,
        usage_tokens: null,
        staff_verification: "画像不在"
      }
    };
  }
  rawImages.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true }));
  const firstImageId = rawImages[0].id;

  let validated = null;
  try {
    validated = getValidatedProductDriveImages_(TARGET_PID, p.drive_folder_url, [firstImageId]);
  } catch (imgErr) {
    const errText = "Drive画像取得例外: " + imgErr.message;
    return {
      target_product_id: TARGET_PID,
      model_name: testModel,
      success: false,
      overall_success: false,
      error: errText,
      summary: {
        product_id: TARGET_PID,
        model_name: testModel,
        overall_success: false,
        grounding_status: errText,
        search_executed: false,
        queries_count: 0,
        sources_count: 0,
        proposed_title_ja: null,
        proposed_title_en: null,
        stage_a_elapsed_ms: 0,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: 0,
        usage_tokens: null,
        staff_verification: "Drive画像例外"
      }
    };
  }

  if (!validated || !validated.images || validated.images.length === 0) {
    const errText = "有効な画像が取得できませんでした";
    return {
      target_product_id: TARGET_PID,
      model_name: testModel,
      success: false,
      overall_success: false,
      error: errText,
      summary: {
        product_id: TARGET_PID,
        model_name: testModel,
        overall_success: false,
        grounding_status: errText,
        search_executed: false,
        queries_count: 0,
        sources_count: 0,
        proposed_title_ja: null,
        proposed_title_en: null,
        stage_a_elapsed_ms: 0,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: 0,
        usage_tokens: null,
        staff_verification: "有効画像なし"
      }
    };
  }

  const img0 = validated.images[0];
  const imgKb = Math.round(((img0.base64 ? img0.base64.length : 0) * 0.75) / 1024);
  console.log(`  解析対象画像: ID='${firstImageId}', MIME='${img0.mimeType}', 約${imgKb}KB`);

  // 現物ラベルの状態: 自動判定は行わず、未検証であることを明示
  const physicalLabelStatus = "現物ラベル未検証";
  const physicalLabelNote = "現物ラベル未検証（画像内のタグ・箱ラベルの有無や印字内容は自動検証されていません）";
  console.log(`  現物ラベル状態: ${physicalLabelStatus} (${physicalLabelNote})`);

  // 3. プロンプト生成 (既存商品名・SKUは渡さず、画像・ブランド・カテゴリのみを渡す)
  const promptLines = [
    "You are an expert sneaker authenticator and catalog specialist.",
    "Analyze the attached sneaker image carefully. Use Google Search to actively identify the concrete model name, official colorway, collaboration details, and edition.",
    "If web search results match the visual features of the sneaker in the image (silhouette, colors, unique logos, box text), propose the specific product title in Japanese and English."
  ];
  if (p.brand) {
    promptLines.push(`Brand constraint: ${p.brand}`);
  }
  if (p.category) {
    promptLines.push(`Category: ${p.category}`);
  }
  promptLines.push("");
  promptLines.push("CRITICAL RULES ON SKU & TITLE:");
  promptLines.push("- Only output an SKU in the `sku` field if a style code / SKU is clearly and directly legible from a physical box label or inner shoe tag in the image.");
  promptLines.push("- If no label/tag is clearly visible in the image, you MUST output an empty string (\"\") for sku. Do NOT output a search-discovered SKU into the sku field.");
  promptLines.push("- Propose specific, concrete title_ja and title_en reflecting the identified model/collaboration.");

  const promptText = promptLines.join("\n");
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(testModel) + ":generateContent";

  const diagnosisReport = {
    target_product_id: TARGET_PID,
    model_name: testModel,
    env_default_model: currentEnvModel,
    existing_product_name: p.product_name || "",
    existing_sku: p.sneaker_sku || "",
    physical_label_status: physicalLabelStatus,
    physical_label_note: physicalLabelNote,
    api_calls_count: 0,
    aborted_reason: null,
    pattern1_single_request: null,
    pattern2_two_stage: null,
    summary: null
  };

  let isSchemaConflict = false;
  let shouldProceedToPattern2 = false;

  if (twoStageOnly) {
    console.log("\n--------------------------------------------------");
    console.log(`>>> [1回方式スキップ] 2段階方式のみ実行モード (検証モデル: ${testModel}) >>>`);
    diagnosisReport.pattern1_single_request = {
      skipped: true,
      reason: "TWO_STAGE_ONLY_MODE"
    };
    shouldProceedToPattern2 = true;
  } else {
    // 4. パターン1: 1回呼出方式 (tools: [{google_search: {}}] + responseSchema)
    console.log("\n--------------------------------------------------");
    console.log(`>>> [パターン1: 1回呼出方式] tools (google_search) + responseSchema (モデル: ${testModel}) >>>`);
    const p1Payload = {
      contents: [{
        role: "user",
        parts: [
          { text: promptText },
          { inlineData: { mimeType: img0.mimeType, data: img0.base64 } }
        ]
      }],
      tools: [
        { google_search: {} }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title_ja: { type: "STRING" },
            title_en: { type: "STRING" },
            brand: { type: "STRING" },
            category: { type: "STRING" },
            sku: { type: "STRING" },
            colorway: { type: "STRING" },
            identification_rationale: { type: "STRING" }
          },
          required: ["title_ja", "title_en"]
        },
        temperature: 0.2,
        maxOutputTokens: 2048
      }
    };

    const p1Start = Date.now();
    let p1Status = 0;
    let p1Body = "";
    try {
      diagnosisReport.api_calls_count += 1;
      const res = UrlFetchApp.fetch(endpoint, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(p1Payload),
        muteHttpExceptions: true
      });
      p1Status = res.getResponseCode();
      p1Body = res.getContentText();
    } catch (netErr) {
      p1Status = 0;
      p1Body = netErr.message;
    }
    const p1Elapsed = Date.now() - p1Start;

    if (p1Status === 200) {
      try {
        const parsed = JSON.parse(p1Body);
        const cand0 = (parsed.candidates && parsed.candidates[0]) || {};
        const gMeta = cand0.groundingMetadata || {};
        const uMeta = parsed.usageMetadata || {};

        let candData = null;
        let candidateValid = false;
        const partText = (cand0.content && cand0.content.parts && cand0.content.parts[0] && cand0.content.parts[0].text) || "";
        try {
          const parsedJson = JSON.parse(partText);
          if (parsedJson && typeof parsedJson === "object" && parsedJson.title_ja && String(parsedJson.title_ja).trim()) {
            candData = parsedJson;
            candidateValid = true;
          } else {
            candData = parsedJson;
            candidateValid = false;
          }
        } catch (_) {
          candData = { raw_text: partText.substring(0, 300) };
          candidateValid = false;
        }

        const queries = Array.isArray(gMeta.webSearchQueries) ? gMeta.webSearchQueries : [];
        const sources = extractGroundingSources_(gMeta);
        const searchExecuted = queries.length > 0;
        const hasSources = sources.length > 0;
        const groundingSuccess = searchExecuted && hasSources && candidateValid;

        let groundingStatus = "";
        if (!candidateValid) {
          groundingStatus = "候補解析失敗（JSONパース失敗またはタイトルなし）";
        } else if (!searchExecuted) {
          groundingStatus = "グラウンディング未達成（Web検索未実行）";
        } else if (!hasSources) {
          groundingStatus = "グラウンディング未確認（検索クエリ発行あり・参照元ページ0件のため商品一致未確認）";
        } else {
          groundingStatus = "グラウンディング達成（検索実行あり）";
        }

        // SKU 判定: 自動画像判定を装わず、「現物ラベル未検証」としてモデル出力を客観記録
        const rawSku = candData ? String(candData.sku || "").trim() : "";
        let skuStatus = "";
        let skuDisplay = "";
        if (!rawSku) {
          skuStatus = "現物ラベル未検証（モデル出力SKU: 空欄）";
          skuDisplay = "(現物ラベル未検証 - 空欄)";
        } else {
          skuStatus = `現物ラベル未検証（モデル出力SKU: '${rawSku}' - 現物ラベル未検証のため要確認）`;
          skuDisplay = `${rawSku} [現物ラベル未検証]`;
          console.warn(`  [SKU留意] 現物ラベル未検証ですが、モデルからSKUが出力されました: "${rawSku}" (Web検索や事前学習由来の可能性があります。現物ラベルとの照合が必要です)`);
        }

        diagnosisReport.pattern1_single_request = {
          success: groundingSuccess,
          grounding_success: groundingSuccess,
          grounding_status: groundingStatus,
          candidate_valid: candidateValid,
          http_status: 200,
          elapsed_ms: p1Elapsed,
          search_executed: searchExecuted,
          has_sources: hasSources,
          queries: queries,
          sources: sources,
          candidate: candidateValid ? candData : null,
          error: candidateValid ? null : (candData && candData.raw_text ? "JSONパース失敗" : "有効なタイトルなし"),
          usage_tokens: uMeta,
          physical_label_status: physicalLabelStatus,
          sku_status: skuStatus
        };

        // 検索実行有無および候補妥当性に応じた表示
        if (groundingSuccess) {
          console.log(`  [1回呼出 成功 (検索実行あり)] HTTP 200, 所要時間: ${p1Elapsed}ms`);
          console.log(`  検索実行有無: 実行あり (search_executed=true, クエリ件数: ${queries.length}件, 参照元: ${sources.length}件)`);
          console.log(`  検索クエリ: ${JSON.stringify(queries)}`);
          console.log(`  提案タイトル(日): "${candData.title_ja || ''}"`);
          console.log(`  提案タイトル(英): "${candData.title_en || ''}"`);
          console.log(`  モデル出力SKU: "${skuDisplay}"`);
          console.log(`  SKU状態: ${skuStatus}`);
          console.log(`  特定根拠: "${candData.identification_rationale || ''}"`);
        } else if (!candidateValid) {
          console.warn(`  [1回呼出 失敗 (候補解析不可)] HTTP 200, 所要時間: ${p1Elapsed}ms`);
          console.warn(`  判定: ${groundingStatus}`);
        } else {
          console.log(`  [1回呼出 完了 (検索未実行/参照元0件)] HTTP 200, 所要時間: ${p1Elapsed}ms`);
          console.log(`  検索実行有無: ${searchExecuted ? "検索実行あり (参照元0件)" : "未実行 (search_executed=false, webSearchQueries: 0件)"}`);
          console.log(`  グラウンディング判定: ${groundingStatus}`);
          console.log(`  提案タイトル(日): "${candData.title_ja || ''}"`);
          console.log(`  モデル出力SKU: "${skuDisplay}"`);
          console.log(`  SKU状態: ${skuStatus}`);
        }

        if (groundingSuccess) {
          console.log(`  => 1回呼出で検索グラウンディングが成功したため、2段階方式への移行は不要です（Gemini呼び出し終了）。`);
          shouldProceedToPattern2 = false;
        } else if (!searchExecuted) {
          console.log(`  => 1回呼出でWeb検索が実行されなかったため (search_executed=false)、2段階方式のStage Aへ進みます。`);
          shouldProceedToPattern2 = true;
        } else if (!hasSources) {
          console.log(`  => 1回呼出で検索クエリは発行されましたが参照元が0件のため (hasSources=false)、2段階方式のStage Aへ進みます。`);
          shouldProceedToPattern2 = true;
        } else {
          console.warn(`  => 検索は実行されましたが候補解析に失敗したため、2段階方式へ進まず終了します。`);
          shouldProceedToPattern2 = false;
        }
      } catch (parseErr) {
        diagnosisReport.pattern1_single_request = {
          success: false,
          grounding_success: false,
          grounding_status: "候補解析失敗（レスポンスパース例外）",
          candidate_valid: false,
          http_status: 200,
          elapsed_ms: p1Elapsed,
          error: "レスポンスJSONパース失敗: " + parseErr.message
        };
        console.warn(`  [1回呼出 パース失敗] ${parseErr.message}`);
        diagnosisReport.aborted_reason = "RESPONSE_PARSE_FAILURE";
        shouldProceedToPattern2 = false;
      }
    } else if (p1Status === 429) {
      // 【ガード①】HTTP 429 なら以降の Gemini 呼び出しを即停止
      const sDetails = extractSanitized429Details_(p1Body);
      diagnosisReport.pattern1_single_request = {
        success: false,
        grounding_success: false,
        grounding_status: "429制限により未実行",
        candidate_valid: false,
        http_status: 429,
        elapsed_ms: p1Elapsed,
        rate_limit_details: sDetails
      };
      console.warn(`  [即時停止] HTTP 429 を検知したため、以降の Gemini API 呼び出しを中止します。`);
      console.warn(`  理由: ${sDetails.reason || sDetails.status}, リトライ推奨: ${sDetails.retry_delay || '不明'}`);
      diagnosisReport.aborted_reason = "HTTP_429_RATE_LIMIT";
      shouldProceedToPattern2 = false;
    } else if (p1Status === 400) {
      // 【ガード②】HTTP 400 の判定: 明確な tools+schema 併用非互換エラーのみ2段階方式へ進む
      const isSchemaUnsupported = /tools.*not supported with (responseSchema|json)/i.test(p1Body);
      const isToolConflict = /mode.*unsupported.*schema|schema.*unsupported.*tools/i.test(p1Body);
      isSchemaConflict = isSchemaUnsupported || isToolConflict;

      diagnosisReport.pattern1_single_request = {
        success: false,
        grounding_success: false,
        grounding_status: isSchemaConflict ? "1回方式競合エラー (2段階へ移行)" : "一般400エラー",
        candidate_valid: false,
        http_status: 400,
        elapsed_ms: p1Elapsed,
        is_schema_conflict: isSchemaConflict,
        error: p1Body.substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]")
      };

      if (isSchemaConflict) {
        console.warn(`  [1回呼出 失敗] HTTP 400, 所要時間: ${p1Elapsed}ms`);
        console.warn(`  エラー判定: 【仕様エラー: tools+schema併用非互換】`);
        console.warn(`  => 明確な tools/schema 競合 400 を検知したため、2段階方式へ進みます。`);
        shouldProceedToPattern2 = true;
      } else {
        console.warn(`  [1回呼出 失敗] HTTP 400, 所要時間: ${p1Elapsed}ms`);
        console.warn(`  エラー判定: 【一般エラー (パラメータ不正/制限等)】`);
        console.warn(`  => 一般的な 400 エラーのため、2段階方式へ進まず終了します。`);
        diagnosisReport.aborted_reason = "HTTP_400_GENERAL_ERROR";
        shouldProceedToPattern2 = false;
      }
    } else {
      // その他のエラー (HTTP 5xx 等)
      diagnosisReport.pattern1_single_request = {
        success: false,
        grounding_success: false,
        grounding_status: `HTTP_${p1Status}_エラー`,
        candidate_valid: false,
        http_status: p1Status,
        elapsed_ms: p1Elapsed,
        error: String(p1Body || "").substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]")
      };
      console.warn(`  [1回呼出 失敗] HTTP ${p1Status}, 所要時間: ${p1Elapsed}ms`);
      console.warn(`  => エラー発生のため、2段階方式へ進まず終了します。`);
      diagnosisReport.aborted_reason = `HTTP_${p1Status}_ERROR`;
      shouldProceedToPattern2 = false;
    }
  }

  // 5. パターン2: 2段階方式の検証 (1回方式で検索未実行、または明確な tools/schema 競合 400 の場合に実行)
  if (shouldProceedToPattern2) {
    console.log("\n--------------------------------------------------");
    console.log(`>>> [パターン2: 2段階方式] Stage A (自由文検索) + Stage B (構造化JSON) 検証 (モデル: ${testModel}) >>>`);

    // Stage A: 自由文検索 & 画像照合 (responseSchema なし, tools: [{ google_search: {} }])
    // モデル自身が画像から文字と外観特徴を観察・記述してからWeb検索で照合するよう指示（事前ヒントは除外）
    const s2aPromptLines = [
      "You are an expert sneaker authenticator and catalog specialist.",
      "Carefully examine the attached sneaker image. Do NOT make assumptions based on brand alone.",
      "",
      "TASK INSTRUCTIONS (follow in order):",
      "Step 1. VISIBLE TEXT & MARKS: Transcribe and describe any text, numbers, words, or distinct emblems directly visible on the sneaker, box, tongue, heel, or insole.",
      "Step 2. VISUAL APPEARANCE: Describe the sneaker silhouette, color scheme, upper materials, overlays, midsole/outsole design, and structural characteristics.",
      "Step 3. WEB SEARCH & VERIFICATION: Based on the visible text and appearance described above, actively use Google Search to search for and cross-reference candidate sneaker models, official edition/collaboration names, and colorways.",
      "Step 4. CANDIDATE PROPOSAL: Propose the corroborated product title in Japanese and English supported by your web search findings.",
      "Step 5. PHYSICAL LABEL CHECK: Check whether a style code / SKU is directly legible from a physical box label or shoe tag in the image. If not legible, explicitly state that no physical label SKU was found.",
      ""
    ];
    if (p.brand) {
      s2aPromptLines.push(`Brand constraint: ${p.brand}`);
    }
    if (p.category) {
      s2aPromptLines.push(`Category: ${p.category}`);
    }
    s2aPromptLines.push("");
    s2aPromptLines.push("Format your response with the following sections:");
    s2aPromptLines.push("### OBSERVED_FEATURES");
    s2aPromptLines.push("(Detailed transcription of visible text/logos and description of visual design elements)");
    s2aPromptLines.push("");
    s2aPromptLines.push("### SEARCH_CORROBORATION");
    s2aPromptLines.push("(Web search findings and cross-referencing with observed features)");
    s2aPromptLines.push("");
    s2aPromptLines.push("### CANDIDATE_TITLES");
    s2aPromptLines.push("- Title (JA): Proposed Japanese product title");
    s2aPromptLines.push("- Title (EN): Proposed English product title");
    s2aPromptLines.push("");
    s2aPromptLines.push("### PHYSICAL_LABEL_CHECK");
    s2aPromptLines.push("(Confirmation of whether a physical label SKU was legible)");
    s2aPromptLines.push("");
    s2aPromptLines.push("CRITICAL RULES:");
    s2aPromptLines.push("- Existing product name and SKU are intentionally NOT provided. Identify purely from visual cues and web search.");
    s2aPromptLines.push("- Do NOT guess or hallucinate text that is not visible. Only write text you can see in the image.");
    s2aPromptLines.push("- Do NOT treat search-discovered SKUs as physical SKUs. Only confirm an SKU if directly legible from a physical label in the image.");

    const s2aPromptText = s2aPromptLines.join("\n");

    const s2aPayload = {
      contents: [{
        role: "user",
        parts: [
          { text: s2aPromptText },
          { inlineData: { mimeType: img0.mimeType, data: img0.base64 } }
        ]
      }],
      tools: [
        { google_search: {} }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: options.stageAMaxOutputTokens || 1024
      }
    };

    const s2aStart = Date.now();
    let s2aStatus = 0;
    let s2aBody = "";
    try {
      diagnosisReport.api_calls_count += 1;
      const s2aRes = UrlFetchApp.fetch(endpoint, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(s2aPayload),
        muteHttpExceptions: true
      });
      s2aStatus = s2aRes.getResponseCode();
      s2aBody = s2aRes.getContentText();
    } catch (netErr2) {
      s2aStatus = 0;
      s2aBody = netErr2.message;
    }
    const s2aElapsed = Date.now() - s2aStart;

    let s2aText = "";
    let s2aQueries = [];
    let s2aSources = [];
    let s2aUsage = {};
    let stageADiagnosticDetails = null;

    if (s2aStatus === 200) {
      try {
        const s2aParsed = JSON.parse(s2aBody);
        const cand0 = (s2aParsed.candidates && s2aParsed.candidates[0]) || {};
        
        // 詳細調査メトリクスの抽出 (finishReason, finishMessage, promptFeedback, parts, tokens)
        const finishReason = cand0.finishReason || "(未設定)";
        const finishMessage = cand0.finishMessage || "";
        const promptFeedback = s2aParsed.promptFeedback || null;
        const candidatesCount = (s2aParsed.candidates && s2aParsed.candidates.length) || 0;

        let responseTextParts = [];
        let thoughtTextParts = [];
        let allTextParts = [];
        let functionCalls = [];

        if (cand0.content && Array.isArray(cand0.content.parts)) {
          cand0.content.parts.forEach(p => {
            if (!p) return;
            if (typeof p.text === "string" && p.text) {
              allTextParts.push(p.text);
              if (p.thought === true) {
                thoughtTextParts.push(p.text);
              } else {
                responseTextParts.push(p.text);
              }
            }
            if (p.functionCall) {
              functionCalls.push(p.functionCall.name || "functionCall");
            }
          });
        }

        // 複数 parts や思考 part の読み取り漏れ防止
        s2aText = responseTextParts.length > 0 ? responseTextParts.join("\n") : allTextParts.join("\n");
        const thoughtText = thoughtTextParts.join("\n");

        const gMeta = cand0.groundingMetadata || {};
        s2aQueries = Array.isArray(gMeta.webSearchQueries) ? gMeta.webSearchQueries : [];
        s2aSources = extractGroundingSources_(gMeta);
        s2aUsage = s2aParsed.usageMetadata || {};

        let thoughtsTokenCount = 0;
        if (typeof s2aUsage.thoughtsTokenCount === "number") {
          thoughtsTokenCount = s2aUsage.thoughtsTokenCount;
        } else if (Array.isArray(s2aUsage.candidatesTokensDetails)) {
          const tDetail = s2aUsage.candidatesTokensDetails.find(d => d && (d.modality === "THINKING" || d.modality === "thought"));
          if (tDetail && typeof tDetail.tokenCount === "number") {
            thoughtsTokenCount = tDetail.tokenCount;
          }
        }

        stageADiagnosticDetails = {
          http_status: s2aStatus,
          finish_reason: finishReason,
          finish_message: finishMessage,
          prompt_feedback: promptFeedback ? JSON.stringify(promptFeedback).substring(0, 300).replace(/key=[^&\s]+/gi, "key=[REDACTED]") : "なし",
          prompt_token_count: s2aUsage.promptTokenCount || 0,
          candidates_token_count: s2aUsage.candidatesTokenCount || 0,
          thoughts_token_count: thoughtsTokenCount,
          total_token_count: s2aUsage.totalTokenCount || 0,
          candidates_count: candidatesCount,
          parts_count: cand0.content && Array.isArray(cand0.content.parts) ? cand0.content.parts.length : 0,
          thought_parts_count: thoughtTextParts.length,
          response_parts_count: responseTextParts.length,
          function_calls_count: functionCalls.length,
          text_present: Boolean(s2aText && s2aText.trim().length > 0),
          text_length: s2aText ? s2aText.length : 0,
          thought_text_length: thoughtText ? thoughtText.length : 0,
          queries_count: s2aQueries.length,
          queries: s2aQueries,
          sources_count: s2aSources.length,
          elapsed_ms: s2aElapsed,
          max_output_tokens_setting: options.stageAMaxOutputTokens || 1024
        };

        diagnosisReport.stage_a_diagnostic = stageADiagnosticDetails;

        console.log(`\n【Stage A 詳細調査ログ - ${TARGET_PID}】`);
        console.log(`  HTTPステータス: ${s2aStatus}, 所要時間: ${s2aElapsed}ms (${(s2aElapsed / 1000).toFixed(1)}秒)`);
        console.log(`  終了理由 (finishReason): '${finishReason}'` + (finishMessage ? `, メッセージ: '${finishMessage}'` : ""));
        if (promptFeedback) {
          console.log(`  promptFeedback: ${stageADiagnosticDetails.prompt_feedback}`);
        }
        console.log(`  トークン内訳: promptTokenCount=${stageADiagnosticDetails.prompt_token_count}, candidatesTokenCount=${stageADiagnosticDetails.candidates_token_count}, thoughtsTokenCount=${thoughtsTokenCount}, totalTokenCount=${stageADiagnosticDetails.total_token_count}`);
        console.log(`  出力設定上限 (maxOutputTokens): ${stageADiagnosticDetails.max_output_tokens_setting}`);
        console.log(`  レスポンス構造: candidate数=${candidatesCount}, parts数=${stageADiagnosticDetails.parts_count} (回答part=${responseTextParts.length}件 [${s2aText.length}文字], 思考part=${thoughtTextParts.length}件 [${thoughtText.length}文字], functionCall=${functionCalls.length}件)`);
        console.log(`  返却テキスト有無: ${stageADiagnosticDetails.text_present ? "あり (" + s2aText.length + "文字)" : "なし (0文字)"}`);
        console.log(`  Web検索実行有無: ${s2aQueries.length > 0 ? "実行あり (クエリ=" + s2aQueries.length + "件, 参照元=" + s2aSources.length + "件)" : "未実行 (クエリ0件)"}`);
        if (s2aQueries.length > 0) {
          console.log(`  Stage A 検索クエリ: ${JSON.stringify(s2aQueries)}`);
        }
        if (s2aSources.length > 0) {
          console.log(`  Stage A 参照元ページ (${s2aSources.length}件)`);
        } else if (s2aQueries.length > 0) {
          console.warn(`  ※[参照元留意] Stage A で検索クエリは発行されましたが、参照元ページ (groundingChunks) は 0 件でした。`);
        } else {
          console.log(`  ※Web検索が実行されなかったため、Stage B の呼び出しを中止します。`);
        }
      } catch (pErr) {
        console.warn(`  [Stage A パース失敗] ${pErr.message}`);
      }
    } else if (s2aStatus === 429) {
      // Stage A で 429 検知時は Stage B を直ちに中止
      const s2aDetails = extractSanitized429Details_(s2aBody);
      console.warn(`  [即時停止] Stage A で HTTP 429 を検知したため、Stage B を中止します。`);
      diagnosisReport.aborted_reason = "HTTP_429_RATE_LIMIT_STAGE_A";
      diagnosisReport.stage_a_diagnostic = {
        http_status: 429,
        finish_reason: "HTTP_429_RATE_LIMIT",
        finish_message: s2aDetails.message || "429 RATE LIMIT",
        prompt_feedback: "なし",
        prompt_token_count: 0,
        candidates_token_count: 0,
        thoughts_token_count: 0,
        total_token_count: 0,
        candidates_count: 0,
        parts_count: 0,
        thought_parts_count: 0,
        response_parts_count: 0,
        function_calls_count: 0,
        text_present: false,
        text_length: 0,
        thought_text_length: 0,
        queries_count: 0,
        queries: [],
        sources_count: 0,
        elapsed_ms: s2aElapsed,
        max_output_tokens_setting: options.stageAMaxOutputTokens || 1024
      };
    } else {
      console.warn(`  [Stage A 失敗] HTTP ${s2aStatus}, 所要時間: ${s2aElapsed}ms, error: ${String(s2aBody || "").substring(0, 200).replace(/key=[^&\s]+/gi, "key=[REDACTED]")}`);
      diagnosisReport.stage_a_diagnostic = {
        http_status: s2aStatus,
        finish_reason: `HTTP_${s2aStatus}`,
        finish_message: String(s2aBody || "").substring(0, 200).replace(/key=[^&\s]+/gi, "key=[REDACTED]"),
        prompt_feedback: "なし",
        prompt_token_count: 0,
        candidates_token_count: 0,
        thoughts_token_count: 0,
        total_token_count: 0,
        candidates_count: 0,
        parts_count: 0,
        thought_parts_count: 0,
        response_parts_count: 0,
        function_calls_count: 0,
        text_present: false,
        text_length: 0,
        thought_text_length: 0,
        queries_count: 0,
        queries: [],
        sources_count: 0,
        elapsed_ms: s2aElapsed,
        max_output_tokens_setting: options.stageAMaxOutputTokens || 1024
      };
    }

    // Stage B: 構造化出力 (Stage A が成功し、かつ Web 検索が実行された場合のみ呼出し)
    let s2bResult = null;
    if (s2aStatus === 200 && s2aText && s2aQueries.length > 0) {
      const s2bPayload = {
        contents: [{
          role: "user",
          parts: [
            { text: [
              "Based on the following sneaker visual analysis and web search grounding, output a structured JSON draft candidate matching the schema.",
              "",
              "Analysis:",
              s2aText,
              "",
              "Rules:",
              "- Propose specific, concrete title_ja and title_en reflecting the identified model/collaboration.",
              "- Output empty string (\"\") for sku if the analysis indicates no SKU was directly read from a physical label.",
              "- Do NOT put search-only SKUs into the sku field."
            ].join("\n") }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              title_ja: { type: "STRING" },
              title_en: { type: "STRING" },
              brand: { type: "STRING" },
              category: { type: "STRING" },
              sku: { type: "STRING" },
              colorway: { type: "STRING" },
              identification_rationale: { type: "STRING" }
            },
            required: ["title_ja", "title_en"]
          },
          temperature: 0.1,
          maxOutputTokens: 1024
        }
      };

      const s2bStart = Date.now();
      let s2bStatus = 0;
      let s2bBody = "";
      try {
        diagnosisReport.api_calls_count += 1;
        const s2bRes = UrlFetchApp.fetch(endpoint, {
          method: "post",
          contentType: "application/json",
          headers: { "x-goog-api-key": apiKey },
          payload: JSON.stringify(s2bPayload),
          muteHttpExceptions: true
        });
        s2bStatus = s2bRes.getResponseCode();
        s2bBody = s2bRes.getContentText();
      } catch (netErr3) {
        s2bStatus = 0;
        s2bBody = netErr3.message;
      }
      const s2bElapsed = Date.now() - s2bStart;

      if (s2bStatus === 200) {
        try {
          const s2bParsed = JSON.parse(s2bBody);
          const cand0 = (s2bParsed.candidates && s2bParsed.candidates[0]) || {};
          const partText = (cand0.content && cand0.content.parts && cand0.content.parts[0] && cand0.content.parts[0].text) || "";
          
          let candData = null;
          let stageBCandidateValid = false;
          try {
            const parsedJson = JSON.parse(partText);
            if (parsedJson && typeof parsedJson === "object" && parsedJson.title_ja && String(parsedJson.title_ja).trim()) {
              candData = parsedJson;
              stageBCandidateValid = true;
            } else {
              candData = parsedJson;
              stageBCandidateValid = false;
            }
          } catch (_) {
            candData = { raw_text: partText.substring(0, 300) };
            stageBCandidateValid = false;
          }
          const uMeta2 = s2bParsed.usageMetadata || {};

          // SKU 判定: 自動画像判定を装わず、「現物ラベル未検証」としてモデル出力を客観記録
          const rawSku2 = candData ? String(candData.sku || "").trim() : "";
          let skuStatus2 = "";
          let skuDisplay2 = "";
          if (!rawSku2) {
            skuStatus2 = "現物ラベル未検証（モデル出力SKU: 空欄）";
            skuDisplay2 = "(現物ラベル未検証 - 空欄)";
          } else {
            skuStatus2 = `現物ラベル未検証（モデル出力SKU: '${rawSku2}' - 現物ラベル未検証のため要確認）`;
            skuDisplay2 = `${rawSku2} [現物ラベル未検証]`;
            console.warn(`  [SKU留意] 現物ラベル未検証ですが、モデルからSKUが出力されました: "${rawSku2}" (Web検索や事前学習由来の可能性があります。現物ラベルとの照合が必要です)`);
          }

          const stageASearchExecuted = s2aQueries.length > 0;
          const stageAHasSources = s2aSources.length > 0;
          // 参照元が空なら「検索クエリあり」だけで商品一致を確認済みとは判定しない
          const stageBGroundingSuccess = stageASearchExecuted && stageAHasSources && stageBCandidateValid;

          let stageBGroundingStatus = "";
          if (!stageBCandidateValid) {
            stageBGroundingStatus = "候補解析失敗（Stage B 構造化失敗）";
          } else if (!stageASearchExecuted) {
            stageBGroundingStatus = "グラウンディング未達成（Stage A Web検索未実行）";
          } else if (!stageAHasSources) {
            stageBGroundingStatus = "グラウンディング未確認（検索クエリ発行あり・参照元0件のため商品一致未確認）";
          } else {
            stageBGroundingStatus = "グラウンディング達成（Stage A 検索実行・参照元確認済み）";
          }

          // 人間確認特徴（黒い箱の赤い「BIKE」）との客観照合 (※モデル入力プロンプトには一切含めず、出力結果とのみ照合)
          let bikeDetectedInObservation = false;
          let nikeMisreadDetected = false;
          let bikeIncludedInQueries = false;
          let flight89MisreadInQueries = false;
          let bikeCorroborationStatus = "対象外";
          let bikeVerificationObj = null;

          const observedFeatures = extractObservedFeaturesFromText_(s2aText);
          const observedTextAll = (s2aText || "").toLowerCase();
          const queriesTextAll = s2aQueries.map(q => String(q).toLowerCase()).join(" ");

          if (TARGET_PID === "TMP-000100") {
            bikeDetectedInObservation = /\bbike\b/i.test(observedTextAll);
            nikeMisreadDetected = /\bnike\b/i.test(observedTextAll) && !bikeDetectedInObservation;
            bikeIncludedInQueries = /\bbike\b/i.test(queriesTextAll);
            flight89MisreadInQueries = /flight\s*89|air\s*flight/i.test(queriesTextAll);

            if (bikeDetectedInObservation && bikeIncludedInQueries) {
              bikeCorroborationStatus = "【照合一致】Stage Aの生成文にBIKEが出現し、検索クエリにも反映されました";
            } else if (bikeDetectedInObservation && !bikeIncludedInQueries) {
              bikeCorroborationStatus = "【一部出現】Stage Aの生成文にBIKEが出現しましたが、検索クエリには含まれませんでした";
            } else if (!bikeDetectedInObservation && bikeIncludedInQueries) {
              bikeCorroborationStatus = "【検索反映】Stage Aの生成文にBIKEの明記はありませんが、検索クエリには含まれました";
            } else if (nikeMisreadDetected || flight89MisreadInQueries) {
              bikeCorroborationStatus = "【誤読検知】Stage Aの生成文にBIKEが出現せず、「NIKE」や「Air Flight 89」等の誤読・誤検索が発生している可能性があります";
            } else {
              bikeCorroborationStatus = "【未検出】Stage Aの生成文・検索クエリのいずれにもBIKEは検出されませんでした";
            }

            bikeVerificationObj = {
              bike_detected_in_stage_a_text: bikeDetectedInObservation,
              bike_detected_in_observation: bikeDetectedInObservation,
              bike_included_in_queries: bikeIncludedInQueries,
              status: bikeCorroborationStatus
            };
          }

          // 商品特定 根拠検証ログ (4要素の分離表示 & BIKE/スタッフ照合)
          console.log("\n--------------------------------------------------");
          console.log(`【商品特定 根拠検証ログ (4要素の分離表示) - ${TARGET_PID}】`);
          console.log("--------------------------------------------------");
          console.log(`検証モデル: ${testModel} (所要時間: Stage A=${s2aElapsed}ms, Stage B=${s2bElapsed}ms, 合計=${s2aElapsed + s2bElapsed}ms)`);

          console.log("\n【1. 画像から観察した特徴 (外観・直接確認文字)】");
          if (observedFeatures) {
            observedFeatures.split("\n").forEach(line => {
              if (line.trim()) console.log(`  ${line}`);
            });
          } else {
            console.log("  (観察特徴テキストなし)");
          }

          console.log(`\n【2. 実行したWeb検索クエリ】 (${s2aQueries.length}件)`);
          if (s2aQueries.length > 0) {
            s2aQueries.forEach((q, i) => {
              console.log(`  [${i + 1}] "${q}"`);
            });
          } else {
            console.log("  (検索クエリなし / 検索未実行)");
          }

          console.log(`\n【3. 参照元ページ (Web Sources: groundingChunks)】 (${s2aSources.length}件)`);
          if (s2aSources.length > 0) {
            s2aSources.forEach((src, i) => {
              console.log(`  [${i + 1}] タイトル: ${src.title || "(タイトルなし)"}`);
              console.log(`      URL: ${src.uri || "(URLなし)"}`);
            });
          } else {
            console.log("  (参照元ページなし: 0件 -> ※「検索クエリあり」だけで商品一致を確認済みとは判定しません)");
          }

          console.log("\n【4. 検索結果に支えられた商品名候補】");
          if (stageBCandidateValid) {
            console.log(`  提案タイトル(日): "${candData.title_ja || ''}"`);
            console.log(`  提案タイトル(英): "${candData.title_en || ''}"`);
            console.log(`  特定根拠: "${candData.identification_rationale || ''}"`);
            console.log(`  モデル出力SKU: "${skuDisplay2}"`);
            console.log(`  SKU状態: ${skuStatus2}`);
          } else {
            console.log("  (Stage B 構造化失敗)");
          }

          if (TARGET_PID === "TMP-000100") {
            console.log("\n【5. 人間確認特徴「BIKE」との客観照合結果】");
            console.log(`  Stage A生成文内「BIKE」出現: ${bikeDetectedInObservation ? "出現あり" : "未検出"}`);
            console.log(`  検索クエリ内「BIKE」含有: ${bikeIncludedInQueries ? "含有あり" : "なし"}`);
            console.log(`  照合判定: ${bikeCorroborationStatus}`);
            console.log("--------------------------------------------------\n");
          } else {
            console.log("\n【5. スタッフ確認欄 (画像・現物照合)】");
            console.log("  照合判定: 要スタッフ目視確認 (※検索実行有無のみで「正解」と自動判定しないこと)");
            console.log("--------------------------------------------------\n");
          }

          const s2aUsagePrompt = s2aUsage.promptTokenCount || 0;
          const s2aUsageCand = s2aUsage.candidatesTokenCount || 0;
          const s2aUsageTot = s2aUsage.totalTokenCount || 0;
          const s2bUsagePrompt = uMeta2.promptTokenCount || 0;
          const s2bUsageCand = uMeta2.candidatesTokenCount || 0;
          const s2bUsageTot = uMeta2.totalTokenCount || 0;

          s2bResult = {
            success: stageBGroundingSuccess,
            grounding_success: stageBGroundingSuccess,
            grounding_status: stageBGroundingStatus,
            candidate_valid: stageBCandidateValid,
            model_name: testModel,
            stage_a_elapsed_ms: s2aElapsed,
            stage_b_elapsed_ms: s2bElapsed,
            total_elapsed_ms: s2aElapsed + s2bElapsed,
            search_executed: stageASearchExecuted,
            has_sources: stageAHasSources,
            queries: s2aQueries,
            sources: s2aSources,
            candidate: stageBCandidateValid ? candData : null,
            error: stageBCandidateValid ? null : "Stage B 構造化パース失敗",
            physical_label_status: physicalLabelStatus,
            sku_status: skuStatus2,
            bike_verification: bikeVerificationObj,
            staff_verification: (TARGET_PID === "TMP-000100" && bikeVerificationObj)
              ? `BIKE照合: ${bikeVerificationObj.status} / 要スタッフ最終確認`
              : "要スタッフ目視確認 (画像・現物照合)",
            usage_tokens: {
              stage_a_prompt: s2aUsagePrompt,
              stage_a_candidates: s2aUsageCand,
              stage_a_total: s2aUsageTot,
              stage_b_prompt: s2bUsagePrompt,
              stage_b_candidates: s2bUsageCand,
              stage_b_total: s2bUsageTot,
              input_tokens: s2aUsagePrompt + s2bUsagePrompt,
              output_tokens: s2aUsageCand + s2bUsageCand,
              total_tokens: s2aUsageTot + s2bUsageTot
            }
          };

          if (stageBGroundingSuccess) {
            console.log(`  [Stage B 成功] HTTP 200, 所要時間: ${s2bElapsed}ms (2段階合計: ${s2aElapsed + s2bElapsed}ms, モデル: ${testModel})`);
            console.log(`  提案タイトル(日): "${candData.title_ja || ''}"`);
            console.log(`  提案タイトル(英): "${candData.title_en || ''}"`);
            console.log(`  モデル出力SKU: "${skuDisplay2}"`);
            console.log(`  SKU状態: ${skuStatus2}`);
            console.log(`  特定根拠: "${candData.identification_rationale || ''}"`);
            console.log(`  トークン使用量: 入力=${s2aUsagePrompt + s2bUsagePrompt}, 出力=${s2aUsageCand + s2bUsageCand}, 合計=${s2aUsageTot + s2bUsageTot}`);
          } else {
            console.warn(`  [Stage B 完了 (グラウンディング未達成/未確認)] 判定: ${stageBGroundingStatus}`);
          }
        } catch (s2bErr) {
          s2bResult = {
            success: false,
            grounding_success: false,
            grounding_status: "候補解析失敗（Stage B 例外）",
            candidate_valid: false,
            error: "Stage B パース失敗: " + s2bErr.message
          };
        }
      } else {
        s2bResult = {
          success: false,
          grounding_success: false,
          grounding_status: `Stage B HTTP ${s2bStatus} エラー`,
          candidate_valid: false,
          http_status: s2bStatus,
          error: s2bBody.substring(0, 200)
        };
      }
    } else if (s2aStatus === 200 && s2aQueries.length === 0) {
      // Stage A は 200 だが webSearchQueries が空のため Stage B を中止
      console.warn(`  [Stage B スキップ] Stage A で Web 検索が実行されなかったため、Stage B は呼び出さず検索未実行として終了します。`);
      
      console.log("\n--------------------------------------------------");
      console.log(`【商品特定 根拠検証ログ (4要素の分離表示) - ${TARGET_PID}】`);
      console.log("--------------------------------------------------");
      console.log(`検証モデル: ${testModel} (所要時間: Stage A=${s2aElapsed}ms)`);
      console.log("【1. 画像から観察した特徴 (外観・直接確認文字)】");
      const observedFeatures = extractObservedFeaturesFromText_(s2aText);
      if (observedFeatures) {
        observedFeatures.split("\n").forEach(line => {
          if (line.trim()) console.log(`  ${line}`);
        });
      } else {
        console.log("  (観察特徴テキストなし)");
      }
      console.log(`\n【2. 実行したWeb検索クエリ】 (0件)`);
      console.log("  (検索クエリなし / 検索未実行のためStage B中止)");
      console.log(`\n【3. 参照元ページ (Web Sources: groundingChunks)】 (0件)`);
      console.log("  (参照元ページなし: 0件)");
      console.log("\n【4. 検索結果に支えられた商品名候補】");
      console.log("  (Stage A Web検索未実行のため候補生成なし)");
      console.log("--------------------------------------------------\n");

      const s2aUsagePrompt = s2aUsage.promptTokenCount || 0;
      const s2aUsageCand = s2aUsage.candidatesTokenCount || 0;
      const s2aUsageTot = s2aUsage.totalTokenCount || 0;

      s2bResult = {
        success: false,
        grounding_success: false,
        grounding_status: "グラウンディング未達成（Stage A Web検索未実行のためStage B中止）",
        candidate_valid: false,
        model_name: testModel,
        search_executed: false,
        has_sources: false,
        stage_a_elapsed_ms: s2aElapsed,
        stage_b_elapsed_ms: 0,
        total_elapsed_ms: s2aElapsed,
        queries: [],
        sources: [],
        candidate: null,
        error: "Stage A で Web 検索が実行されなかったため Stage B を中止",
        physical_label_status: physicalLabelStatus,
        sku_status: "未実行",
        bike_verification: null,
        staff_verification: "Stage A Web検索未実行のため判定不可",
        usage_tokens: {
          stage_a_prompt: s2aUsagePrompt,
          stage_a_candidates: s2aUsageCand,
          stage_a_total: s2aUsageTot,
          stage_b_prompt: 0,
          stage_b_candidates: 0,
          stage_b_total: 0,
          input_tokens: s2aUsagePrompt,
          output_tokens: s2aUsageCand,
          total_tokens: s2aUsageTot
        }
      };
    } else {
      s2bResult = {
        success: false,
        grounding_success: false,
        grounding_status: s2aStatus === 429 ? "Stage A 429制限により中止" : `Stage A 失敗 (HTTP ${s2aStatus}) によりスキップ`,
        candidate_valid: false,
        model_name: testModel,
        stage_a_status: s2aStatus,
        error: s2aStatus === 429 ? "Stage A で HTTP 429 検知のため Stage B 中止" : "Stage A が成功しなかったためスキップ",
        staff_verification: "Stage A 通信例外・制限により中止"
      };
    }

    diagnosisReport.pattern2_two_stage = s2bResult;
  } else {
    diagnosisReport.pattern2_two_stage = null;
  }

  // 6. 診断サマリーの生成 (グラウンディング未達成・候補無効を厳格に判定)
  const singleReq = diagnosisReport.pattern1_single_request;
  const twoStage = diagnosisReport.pattern2_two_stage;

  // 総合結果の判定: どちらかの方式でグラウンディングおよび候補生成が成功しているか
  const overallSuccess = !!((singleReq && singleReq.grounding_success) || (twoStage && twoStage.grounding_success));
  
  // 総合ステータス: 2段階方式が実行されていれば2段階方式の結果を優先採用
  let overallGroundingStatus = "未実行";
  if (twoStage && twoStage.grounding_status) {
    overallGroundingStatus = twoStage.grounding_status;
  } else if (singleReq && singleReq.grounding_status) {
    overallGroundingStatus = singleReq.grounding_status;
  }

  diagnosisReport.summary = {
    product_id: TARGET_PID,
    model_name: testModel,
    env_default_model: currentEnvModel,
    existing_product_name: p.product_name || "(未設定)",
    existing_sku: p.sneaker_sku || "(未設定)",
    overall_success: overallSuccess,
    grounding_status: overallGroundingStatus,
    grounding_accuracy_disclaimer: "「グラウンディング達成」はWeb検索ツールが実行され候補生成された状態を示し、現物との商品一致や真正性を保証するものではありません",
    physical_label_status: physicalLabelStatus,
    physical_label_note: physicalLabelNote,
    api_calls_count: diagnosisReport.api_calls_count,
    aborted_reason: diagnosisReport.aborted_reason,
    bike_verification: twoStage && twoStage.bike_verification ? twoStage.bike_verification : null,
    staff_verification: (TARGET_PID === "TMP-000100" && twoStage && twoStage.bike_verification)
      ? `BIKE照合: ${twoStage.bike_verification.status} / 要スタッフ最終確認`
      : "要スタッフ目視確認 (画像・現物照合)",
    search_executed: (twoStage && twoStage.search_executed) || (singleReq && singleReq.search_executed) || false,
    has_sources: (twoStage && twoStage.has_sources) || (singleReq && singleReq.has_sources) || false,
    queries_count: twoStage ? (twoStage.queries ? twoStage.queries.length : 0) : (singleReq && singleReq.queries ? singleReq.queries.length : 0),
    sources_count: twoStage ? (twoStage.sources ? twoStage.sources.length : 0) : (singleReq && singleReq.sources ? singleReq.sources.length : 0),
    proposed_title_ja: twoStage && twoStage.candidate ? twoStage.candidate.title_ja : (singleReq && singleReq.candidate ? singleReq.candidate.title_ja : null),
    proposed_title_en: twoStage && twoStage.candidate ? twoStage.candidate.title_en : (singleReq && singleReq.candidate ? singleReq.candidate.title_en : null),
    proposed_sku: twoStage && twoStage.candidate ? twoStage.candidate.sku : (singleReq && singleReq.candidate ? singleReq.candidate.sku : ""),
    stage_a_elapsed_ms: twoStage ? twoStage.stage_a_elapsed_ms : 0,
    stage_b_elapsed_ms: twoStage ? twoStage.stage_b_elapsed_ms : 0,
    total_elapsed_ms: twoStage ? twoStage.total_elapsed_ms : (singleReq ? singleReq.elapsed_ms : 0),
    usage_tokens: twoStage ? twoStage.usage_tokens : (singleReq ? singleReq.usage_tokens : null),
    single_request: singleReq && !singleReq.skipped ? {
      success: singleReq.success,
      grounding_success: singleReq.grounding_success,
      grounding_status: singleReq.grounding_status,
      candidate_valid: singleReq.candidate_valid,
      http_status: singleReq.http_status,
      elapsed_ms: singleReq.elapsed_ms,
      search_executed: singleReq.search_executed || false,
      has_sources: singleReq.has_sources || false,
      queries_count: (singleReq.queries && singleReq.queries.length) || 0,
      sources_count: (singleReq.sources && singleReq.sources.length) || 0,
      proposed_title_ja: (singleReq.candidate && singleReq.candidate.title_ja) || null,
      proposed_title_en: (singleReq.candidate && singleReq.candidate.title_en) || null,
      proposed_sku: (singleReq.candidate && singleReq.candidate.sku) || "",
      sku_status: singleReq.sku_status || "未完了",
      usage_tokens: singleReq.usage_tokens || null
    } : (singleReq && singleReq.skipped ? { skipped: true, reason: singleReq.reason } : null),
    two_stage: twoStage ? {
      success: twoStage.success,
      grounding_success: twoStage.grounding_success,
      grounding_status: twoStage.grounding_status,
      candidate_valid: twoStage.candidate_valid,
      model_name: twoStage.model_name,
      stage_a_elapsed_ms: twoStage.stage_a_elapsed_ms,
      stage_b_elapsed_ms: twoStage.stage_b_elapsed_ms,
      total_elapsed_ms: twoStage.total_elapsed_ms,
      search_executed: twoStage.search_executed || false,
      has_sources: twoStage.has_sources || false,
      queries_count: (twoStage.queries && twoStage.queries.length) || 0,
      sources_count: (twoStage.sources && twoStage.sources.length) || 0,
      proposed_title_ja: (twoStage.candidate && twoStage.candidate.title_ja) || null,
      proposed_title_en: (twoStage.candidate && twoStage.candidate.title_en) || null,
      proposed_sku: (twoStage.candidate && twoStage.candidate.sku) || "",
      sku_status: twoStage.sku_status || "未完了",
      bike_verification: twoStage.bike_verification || null,
      staff_verification: twoStage.staff_verification || "要スタッフ目視確認 (画像・現物照合)",
      usage_tokens: twoStage.usage_tokens || null
    } : null
  };

  console.log("\n==================================================");
  console.log(`=== [Gemini Search Grounding 診断完了] ${TARGET_PID} ===`);
  console.log(`  検証モデル: ${testModel} (現行環境設定: ${currentEnvModel || "(未設定)"})`);
  console.log(`  既存本票名: ${diagnosisReport.summary.existing_product_name}`);
  console.log(`  総合結果: ${diagnosisReport.summary.overall_success ? "成功 (グラウンディング達成)" : "未達成 / 未確認 (" + diagnosisReport.summary.grounding_status + ")"}`);
  console.log(`  グラウンディング留意事項: ※「グラウンディング達成」はWeb検索が実行され候補が抽出されたことを示し、現物との商品一致・真正性を保証するものではありません`);
  console.log(`  スタッフ確認欄: ${diagnosisReport.summary.staff_verification}`);
  console.log(`  現物ラベル状態: ${diagnosisReport.summary.physical_label_status} (画像内のタグ・ラベル有無や印字内容の自動照合なし)`);
  console.log(`  Gemini API 呼出回数: ${diagnosisReport.api_calls_count}回`);
  if (diagnosisReport.aborted_reason) {
    console.log(`  中断事由: ${diagnosisReport.aborted_reason}`);
  }
  if (diagnosisReport.summary.single_request) {
    const s = diagnosisReport.summary.single_request;
    if (s.skipped) {
      console.log(`  1回方式: スキップ (2段階方式のみ実行モード)`);
    } else {
      const searchDesc = s.search_executed ? `検索=実行あり(${diagnosisReport.pattern1_single_request.queries ? diagnosisReport.pattern1_single_request.queries.length : 0}件, 参照元=${diagnosisReport.pattern1_single_request.sources ? diagnosisReport.pattern1_single_request.sources.length : 0}件)` : "検索=未実行(グラウンディング未達成)";
      console.log(`  1回方式: status=${s.http_status}, ${searchDesc}, 状態=${s.grounding_status}, 提案名='${s.proposed_title_ja || "-"}', 所要時間=${s.elapsed_ms}ms, SKU判定=${s.sku_status}`);
    }
  }
  if (diagnosisReport.summary.two_stage) {
    const t = diagnosisReport.summary.two_stage;
    const searchDesc = t.search_executed ? `検索=実行あり(${diagnosisReport.pattern2_two_stage.queries ? diagnosisReport.pattern2_two_stage.queries.length : 0}件, 参照元=${diagnosisReport.pattern2_two_stage.sources ? diagnosisReport.pattern2_two_stage.sources.length : 0}件)` : "検索=未実行(グラウンディング未達成)";
    console.log(`  2段階方式: success=${t.success}, ${searchDesc}, 状態=${t.grounding_status}, 提案名='${t.proposed_title_ja || "-"}', 合計所要時間=${t.total_elapsed_ms}ms (A:${t.stage_a_elapsed_ms}ms, B:${t.stage_b_elapsed_ms}ms), SKU判定=${t.sku_status}`);
    if (t.bike_verification) {
      console.log(`  BIKE照合結果: ${t.bike_verification.status} (Stage A生成文:${t.bike_verification.bike_detected_in_stage_a_text ? "出現あり" : "未検出"}, クエリ:${t.bike_verification.bike_included_in_queries ? "含有あり" : "なし"})`);
    }
    if (t.usage_tokens) {
      console.log(`  トークン使用量: 入力=${t.usage_tokens.input_tokens}, 出力=${t.usage_tokens.output_tokens}, 合計=${t.usage_tokens.total_tokens}`);
    }
  } else {
    console.log(`  2段階方式: 未実行 (1回方式完了またはエラー停止のためスキップ)`);
  }
  console.log("  ※スプレッドシート・ドラフト履歴・Square への書き込みは一切行われていません (完全READ-ONLY)");
  console.log("==================================================");

  return diagnosisReport;
}

/**
 * 複数商品の診断結果からMarkdown一覧表および集計サマリーを生成・ログ出力する補助関数
 * @param {Array<Object>} results 診断結果オブジェクト配列
 * @param {string} modelName 検証モデル名
 * @return {Object} 集計サマリー
 */
function generateAndLogDiagnosisAggregateTable_(results, modelName) {
  results = results || [];
  let searchExecutedCount = 0;
  let totalElapsedSum = 0;
  let maxElapsed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokensSum = 0;
  let validElapsedCount = 0;

  const tableRows = [];

  results.forEach(r => {
    const s = (r && r.summary) || {};
    const pid = s.product_id || (r && r.target_product_id) || "UNKNOWN";
    const mName = s.model_name || modelName || "gemini-3.8-flash";
    const searchExec = s.search_executed ? "○ 実行あり" : "× 未実行";
    if (s.search_executed) searchExecutedCount++;

    const qCount = s.queries_count !== undefined ? s.queries_count : "-";
    const sCount = s.sources_count !== undefined ? s.sources_count : "-";
    const titleJa = s.proposed_title_ja ? `"${s.proposed_title_ja}"` : "(なし)";
    const titleEn = s.proposed_title_en ? `"${s.proposed_title_en}"` : "(なし)";

    const aMs = s.stage_a_elapsed_ms || 0;
    const bMs = s.stage_b_elapsed_ms || 0;
    const totMs = s.total_elapsed_ms || 0;

    if (totMs > 0) {
      totalElapsedSum += totMs;
      validElapsedCount++;
      if (totMs > maxElapsed) maxElapsed = totMs;
    }

    const u = s.usage_tokens || {};
    const inTokens = u.input_tokens || 0;
    const outTokens = u.output_tokens || 0;
    const totTokens = u.total_tokens || 0;

    totalInputTokens += inTokens;
    totalOutputTokens += outTokens;
    totalTokensSum += totTokens;

    const staffCol = s.staff_verification || "要スタッフ目視確認 (画像・現物照合)";

    tableRows.push({
      pid,
      mName,
      searchExec,
      qCount,
      sCount,
      titleJa,
      titleEn,
      aMs,
      bMs,
      totMs,
      inTokens,
      outTokens,
      totTokens,
      staffCol
    });
  });

  const avgElapsed = validElapsedCount > 0 ? Math.round(totalElapsedSum / validElapsedCount) : 0;

  console.log("\n==================================================================================");
  console.log("=== 【Gemini Search Grounding 診断結果一覧表 (" + (modelName || "gemini-3.8-flash") + ")】 ===");
  console.log("==================================================================================");
  console.log("| 商品ID | モデル | 検索実行 | クエリ数 | 参照元数 | 提案タイトル(日) | 提案タイトル(英) | Stage A (ms) | Stage B (ms) | 合計所要時間 (ms) | 入力Token | 出力Token | 合計Token | スタッフ確認欄 (画像・現物照合) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

  tableRows.forEach(row => {
    console.log(`| ${row.pid} | ${row.mName} | ${row.searchExec} | ${row.qCount} | ${row.sCount} | ${row.titleJa} | ${row.titleEn} | ${row.aMs} | ${row.bMs} | ${row.totMs} | ${row.inTokens} | ${row.outTokens} | ${row.totTokens} | ${row.staffCol} |`);
  });

  console.log("\n==================================================================================");
  console.log("=== 【診断結果集計サマリー】 ===");
  console.log("==================================================================================");
  console.log(`  対象商品数: ${results.length}件`);
  console.log(`  検索実行数: ${searchExecutedCount} / ${results.length}件 (${Math.round((searchExecutedCount / (results.length || 1)) * 100)}%)`);
  console.log(`  正解数: 要スタッフ目視確認 (※検索実行有無のみで「正解」と自動判定しないこと)`);
  console.log(`  平均所要時間: ${avgElapsed}ms`);
  console.log(`  最大所要時間: ${maxElapsed}ms`);
  console.log(`  総トークン数: 入力=${totalInputTokens}, 出力=${totalOutputTokens}, 総合計=${totalTokensSum}`);
  console.log("  ※スプレッドシート・ドラフト履歴・Square への書き込みは一切行われていません (完全READ-ONLY)");
  console.log("==================================================================================\n");

  return {
    model_name: modelName || "gemini-3.8-flash",
    total_products: results.length,
    search_executed_count: searchExecutedCount,
    avg_elapsed_ms: avgElapsed,
    max_elapsed_ms: maxElapsed,
    total_tokens: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalTokensSum
    },
    items: results
  };
}

/**
 * TMP-000102 調査結果を「確認できた事実」「原因の推定」「まだ不明な点」に整理し、
 * 変更前後の比較表とともにログ出力する関数
 * @param {Object} trial1Report Trial 1 (maxOutputTokens=1024) の結果
 * @param {Object|null} trial2Report Trial 2 (maxOutputTokens=4096) の結果 (未実行時は null)
 * @return {Object} 調査分析サマリー
 */
function formatAndLogTmp000102InvestigationReport_(trial1Report, trial2Report) {
  trial1Report = trial1Report || {};
  const t1Summary = trial1Report.summary || {};
  const t1Diag = trial1Report.stage_a_diagnostic || (trial1Report.pattern2_two_stage && trial1Report.pattern2_two_stage.stage_a_diagnostic) || {};

  const t2Summary = trial2Report ? (trial2Report.summary || {}) : null;
  const t2Diag = trial2Report ? (trial2Report.stage_a_diagnostic || (trial2Report.pattern2_two_stage && trial2Report.pattern2_two_stage.stage_a_diagnostic) || {}) : null;

  const t1MaxTokensSetting = t1Diag.max_output_tokens_setting || 1024;
  const t2MaxTokensSetting = t2Diag ? (t2Diag.max_output_tokens_setting || 4096) : "未実行";

  const t1PartsDesc = `${t1Diag.parts_count || 0} (回答:${t1Diag.response_parts_count || 0}, 思考:${t1Diag.thought_parts_count || 0}, fn:${t1Diag.function_calls_count || 0})`;
  const t2PartsDesc = t2Diag ? `${t2Diag.parts_count || 0} (回答:${t2Diag.response_parts_count || 0}, 思考:${t2Diag.thought_parts_count || 0}, fn:${t2Diag.function_calls_count || 0})` : "-";

  const t1TextDesc = t1Diag.text_present ? `あり (${t1Diag.text_length || 0}文字)` : "なし (0文字)";
  const t2TextDesc = t2Diag ? (t2Diag.text_present ? `あり (${t2Diag.text_length || 0}文字)` : "なし (0文字)") : "-";

  const t1ThoughtLen = t1Diag.thought_text_length !== undefined ? `${t1Diag.thought_text_length}文字` : "-";
  const t2ThoughtLen = t2Diag ? (t2Diag.thought_text_length !== undefined ? `${t2Diag.thought_text_length}文字` : "-") : "-";

  const t1SearchDesc = (t1Diag.queries_count || 0) > 0 ? `○ 実行あり (${t1Diag.queries_count}件)` : "× 未実行 (0件)";
  const t2SearchDesc = t2Diag ? ((t2Diag.queries_count || 0) > 0 ? `○ 実行あり (${t2Diag.queries_count}件)` : "× 未実行 (0件)") : "-";

  const t1ElapsedA = t1Diag.elapsed_ms || t1Summary.stage_a_elapsed_ms || 0;
  const t2ElapsedA = t2Diag ? (t2Diag.elapsed_ms || t2Summary.stage_a_elapsed_ms || 0) : 0;

  const t1ElapsedTot = t1Summary.total_elapsed_ms || t1ElapsedA;
  const t2ElapsedTot = t2Summary ? (t2Summary.total_elapsed_ms || t2ElapsedA) : 0;

  // 比較テーブル行の定義
  const comparisonRows = [
    { item: "設定: 出力トークン上限 (maxOutputTokens)", t1: String(t1MaxTokensSetting), t2: String(t2MaxTokensSetting) },
    { item: "HTTPステータス", t1: String(t1Diag.http_status || "-"), t2: t2Diag ? String(t2Diag.http_status || "-") : "-" },
    { item: "終了理由 (finishReason)", t1: String(t1Diag.finish_reason || "-"), t2: t2Diag ? String(t2Diag.finish_reason || "-") : "-" },
    { item: "終了メッセージ (finishMessage)", t1: String(t1Diag.finish_message || "-"), t2: t2Diag ? String(t2Diag.finish_message || "-") : "-" },
    { item: "promptFeedback", t1: String(t1Diag.prompt_feedback || "なし"), t2: t2Diag ? String(t2Diag.prompt_feedback || "なし") : "-" },
    { item: "入力トークン数 (promptTokenCount)", t1: String(t1Diag.prompt_token_count || 0), t2: t2Diag ? String(t2Diag.prompt_token_count || 0) : "-" },
    { item: "出力トークン数 (candidatesTokenCount)", t1: String(t1Diag.candidates_token_count || 0), t2: t2Diag ? String(t2Diag.candidates_token_count || 0) : "-" },
    { item: "思考トークン数 (thoughtsTokenCount)", t1: String(t1Diag.thoughts_token_count || 0), t2: t2Diag ? String(t2Diag.thoughts_token_count || 0) : "-" },
    { item: "合計トークン数 (totalTokenCount)", t1: String(t1Diag.total_token_count || 0), t2: t2Diag ? String(t2Diag.total_token_count || 0) : "-" },
    { item: "レスポンス parts 数 (全体/回答/思考/fn)", t1: t1PartsDesc, t2: t2PartsDesc },
    { item: "返却テキスト有無・文字数", t1: t1TextDesc, t2: t2TextDesc },
    { item: "思考テキスト文字数", t1: t1ThoughtLen, t2: t2ThoughtLen },
    { item: "Web検索実行有無・クエリ数", t1: t1SearchDesc, t2: t2SearchDesc },
    { item: "参照元数 (groundingChunks)", t1: String(t1Diag.sources_count || 0), t2: t2Diag ? String(t2Diag.sources_count || 0) : "-" },
    { item: "提案タイトル(日)", t1: t1Summary.proposed_title_ja ? `"${t1Summary.proposed_title_ja}"` : "(なし)", t2: t2Summary ? (t2Summary.proposed_title_ja ? `"${t2Summary.proposed_title_ja}"` : "(なし)") : "-" },
    { item: "提案タイトル(英)", t1: t1Summary.proposed_title_en ? `"${t1Summary.proposed_title_en}"` : "(なし)", t2: t2Summary ? (t2Summary.proposed_title_en ? `"${t2Summary.proposed_title_en}"` : "(なし)") : "-" },
    { item: "Stage A 所要時間", t1: `${t1ElapsedA}ms (${(t1ElapsedA / 1000).toFixed(1)}秒)`, t2: t2Diag ? `${t2ElapsedA}ms (${(t2ElapsedA / 1000).toFixed(1)}秒)` : "-" },
    { item: "Stage B 所要時間", t1: `${t1Summary.stage_b_elapsed_ms || 0}ms`, t2: t2Summary ? `${t2Summary.stage_b_elapsed_ms || 0}ms` : "-" },
    { item: "合計所要時間", t1: `${t1ElapsedTot}ms (${(t1ElapsedTot / 1000).toFixed(1)}秒)`, t2: t2Summary ? `${t2ElapsedTot}ms (${(t2ElapsedTot / 1000).toFixed(1)}秒)` : "-" },
    { item: "スタッフ確認欄 (画像・現物照合)", t1: t1Summary.staff_verification || "要スタッフ目視確認", t2: t2Summary ? (t2Summary.staff_verification || "要スタッフ目視確認") : "-" }
  ];

  // 1. 確認できた事実 (Observed Facts) の組み立て
  const facts = [];
  facts.push(`Trial 1 (現在設定 maxOutputTokens: 1024) は HTTP ${t1Diag.http_status || "-"} で終了し、所要時間は ${t1ElapsedA}ms (${(t1ElapsedA / 1000).toFixed(1)}秒) でした。`);
  facts.push(`Trial 1 の finishReason は '${t1Diag.finish_reason || "-"}' であり、promptFeedback によるブロックは ${t1Diag.prompt_feedback && t1Diag.prompt_feedback !== "なし" ? "検知されました" : "ありませんでした"}。`);
  facts.push(`Trial 1 のトークン内訳: 入力=${t1Diag.prompt_token_count || 0}, 出力=${t1Diag.candidates_token_count || 0} (うち思考=${t1Diag.thoughts_token_count || 0}), 合計=${t1Diag.total_token_count || 0}。`);
  facts.push(`Trial 1 のレスポンス parts 内訳: 全体=${t1Diag.parts_count || 0}件 (回答part=${t1Diag.response_parts_count || 0}件 [${t1Diag.text_length || 0}文字], 思考part=${t1Diag.thought_parts_count || 0}件 [${t1Diag.thought_text_length || 0}文字], functionCall=${t1Diag.function_calls_count || 0}件)。`);
  facts.push(`Trial 1 で発行された Web 検索クエリは ${t1Diag.queries_count || 0}件、参照元は ${t1Diag.sources_count || 0}件でした。`);

  if (t2Diag) {
    facts.push(`MAX_TOKENS 到達の証拠に基づき、単一設定変更 (maxOutputTokens: 1024 -> 4096) を適用した Trial 2 を実行しました。`);
    facts.push(`Trial 2 (maxOutputTokens: 4096) は HTTP ${t2Diag.http_status || "-"}、所要時間 ${t2ElapsedA}ms (${(t2ElapsedA / 1000).toFixed(1)}秒)、finishReason は '${t2Diag.finish_reason || "-"}' でした。`);
    facts.push(`Trial 2 のトークン内訳: 入力=${t2Diag.prompt_token_count || 0}, 出力=${t2Diag.candidates_token_count || 0} (うち思考=${t2Diag.thoughts_token_count || 0}), 合計=${t2Diag.total_token_count || 0}。`);
    facts.push(`Trial 2 の Web 検索実行: クエリ=${t2Diag.queries_count || 0}件, 参照元=${t2Diag.sources_count || 0}件, 提案タイトル(日)=${t2Summary && t2Summary.proposed_title_ja ? `"${t2Summary.proposed_title_ja}"` : "(なし)"}。`);
  } else {
    facts.push(`Trial 1 において MAX_TOKENS が検知されなかったため、検証規約に基づき Trial 2 は実行せず終了しました。`);
  }

  // 2. 原因の推定 (Inferred Causes)
  const hypotheses = [];
  const isT1MaxTokens = (t1Diag.finish_reason === "MAX_TOKENS") || ((t1Diag.candidates_token_count || 0) >= (t1MaxTokensSetting || 1024));
  if (isT1MaxTokens) {
    hypotheses.push(`gemini-3.8-flash の思考機能 (Thinking) が画像解析の過程でトークンを消費し、上限 (${t1MaxTokensSetting} tokens) に達して強制打ち切り (MAX_TOKENS) となったことが強く推定されます。`);
    hypotheses.push(`思考トークンが上限を使い果たした結果、Google Search ツールの呼び出し (functionCall) や回答テキスト (responseText) の生成に至る前にモデルのターンが中断されたため、HTTP 200 でありながら Web 検索クエリ 0 件・候補なしとなったと考えられます。`);
    hypotheses.push(`思考プロセスの生成に約1024トークンを要したことが、Stage A の所要時間 (~${(t1ElapsedA / 1000).toFixed(0)}秒) の主な要因であると推定されます。`);
    if (t2Diag && (t2Diag.queries_count || 0) > 0) {
      hypotheses.push(`Trial 2 で maxOutputTokens を 4096 に拡大したことで思考が完了し、Web 検索ツールの呼び出しおよび候補生成が成立したことから、1024トークン上限が直接のボトルネックであったことが裏付けられます。`);
    }
  } else {
    hypotheses.push(`Trial 1 の finishReason は '${t1Diag.finish_reason}' であり、トークン上限ではなくモデルが自発的に検索を不要と判断して終了した、または通信・プロンプト起因の別の要因である可能性があります。`);
  }

  // 3. まだ不明な点 (Remaining Uncertainties)
  const uncertainties = [];
  uncertainties.push("モデル提案の商品名と現物の一致・真正性: Web検索が実行され候補が生成された場合でも、現物画像およびラベルとの目視照合（スタッフ確認欄）が不可欠であり、自動確定はできません。");
  uncertainties.push("gemini-3.8-flash における思考トークン消費量の画像別ばらつき: 他の3商品 (TMP-000100, TMP-000095, TMP-000027) では1024トークン内で検索・完了したのに対し、TMP-000102 の画像でなぜ思考トークンが膨らんだのかの閾値要因。");
  uncertainties.push("GAS UrlFetchApp の通信タイムアウト (最大6分) と思考モデル所要時間の安定性: 思考プロセスが長引いた場合の実行時間管理とワーカー耐性。");

  // ログ出力
  console.log("\n==================================================================================");
  console.log("=== 【TMP-000102 詳細原因調査レポート】 ===");
  console.log("==================================================================================");
  console.log("| 項目 | Trial 1 (現在設定: 1024 tokens) | Trial 2 (単一変更: 4096 tokens) |");
  console.log("|---|---|---|");
  comparisonRows.forEach(row => {
    console.log(`| ${row.item} | ${row.t1} | ${row.t2} |`);
  });

  console.log("\n----------------------------------------------------------------------------------");
  console.log("【1. 確認できた事実 (Observed Facts)】");
  console.log("----------------------------------------------------------------------------------");
  facts.forEach((f, i) => console.log(`  (${i + 1}) ${f}`));

  console.log("\n----------------------------------------------------------------------------------");
  console.log("【2. 原因の推定 (Inferred Causes)】");
  console.log("----------------------------------------------------------------------------------");
  hypotheses.forEach((h, i) => console.log(`  (${i + 1}) ${h}`));

  console.log("\n----------------------------------------------------------------------------------");
  console.log("【3. まだ不明な点 (Remaining Uncertainties)】");
  console.log("----------------------------------------------------------------------------------");
  uncertainties.forEach((u, i) => console.log(`  (${i + 1}) ${u}`));

  console.log("==================================================================================\n");

  return {
    product_id: "TMP-000102",
    model_name: "gemini-3.8-flash",
    trial1: trial1Report,
    trial2: trial2Report,
    comparison_table: comparisonRows,
    facts: facts,
    hypotheses: hypotheses,
    uncertainties: uncertainties
  };
}
