# AGENTS.md

AIS-EC-GAS (Google Apps Script) 開発リポジトリにおけるAIエージェント向け運用ガイドラインです。

## 開発・コミット原則
1. **秘密情報の保護**
   - APIキー、トークン、Webhook URL、署名秘密鍵等の機密情報をコード、ログ、コミット、PR、日報に出力・記録しないこと。
2. **GASデプロイ管理と.claspignore**
   - GAS本番環境へアップロードする対象はGAS実行コード（`コード.js`, `llm_product_draft.js`, `tests.js`等）および`appsscript.json`に限定する。
   - `docs/**`, `AGENTS.md`, `*.md`, `test_harness_standalone.js`, バックアップファイル等は`.claspignore`に含め、GASへアップロードしない。
3. **安全・冪等性設計**
   - 外部連携（Square、Drive、Gemini等）は冪等性（Idempotency）を担保し、再試行時に二重作成やデータ不整合を起こさない設計とする。
   - 削除済みオブジェクトの再作成と未確認通信の再送を区別し、generation-awareなキー管理を行う。
   - 読み取り例外時はフェイルクローズ（Fail-closed）とし、未確認データでの確定・公開を防ぐ。
4. **テスト・検証**
   - コード変更時は必ずローカルテスト（`node test_harness_standalone.js`）およびGASテストを実行し、全件PASSを確認する。

## 作業日報ルール
- **日報の作成・更新**: 作業終了時に日本時間の日付で日報（`docs/worklogs/YYYY-MM-DD.md`）を作成・更新する。
- **同日追記**: 同日中は新規作成せず同じファイルへ追記する。
- **機密保護**: 秘密値（APIキーやシークレット）を一切記載しない。
- **引き継ぎ**: 引き継ぎ時やセッション開始時は [`docs/handoff.md`](docs/handoff.md)（構成・承認済み仕様・ブランチ/SHA・未コミット変更・本番バージョン・既知の問題・次の作業）と最新の日報を確認して現状と課題を把握する。
- **引き継ぎの更新**: 作業終了時に日報と合わせて `docs/handoff.md` を更新する（Secrets の値は記載しない）。
