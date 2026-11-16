/**
 * メルカリShops API 連携スクリプト
 */

const MERCARI_CONFIG = {
  ENDPOINT: 'https://api.mercari-shops.com/v1/graphql',
  TOKEN_PROPERTY: 'MERCARI_SHOPS_TOKEN',
  USER_AGENT: 'ais-ec-gas/1.0'
};

/**
 * スクリプトプロパティからメルカリShops APIトークンを取得する
 * @returns {string} APIアクセストークン
 */
function getMercariShopsToken() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const token = scriptProperties.getProperty(MERCARI_CONFIG.TOKEN_PROPERTY);

  if (!token || String(token).trim() === '') {
    throw new Error(
      `スクリプトプロパティ [${MERCARI_CONFIG.TOKEN_PROPERTY}] が設定されていません。\n` +
      `GASエディタの「プロジェクトの設定」>「スクリプト プロパティ」に登録してください。`
    );
  }

  return String(token).trim();
}

/**
 * メルカリShops API 導通テスト関数
 * 
 * 発行されたAPIトークン（個人アクセストークン）の認証が通るかを確認します。
 * データ変更を伴わない安全なクエリ（自身のショップ情報取得）を送信します。
 * ※ メルカリShops APIはGraphQL仕様のため、参照クエリをPOSTで送信します。
 * 
 * @returns {Object} 実行結果オブジェクト（success, statusCode, data等）
 */
function testMercariApiConnection() {
  console.log('--- [メルカリShops API 導通テスト開始] ---');

  try {
    // 1. スクリプトプロパティからトークンを取得（ハードコード禁止）
    const token = getMercariShopsToken();
    const maskedToken = token.length > 8 
      ? token.substring(0, 4) + '...' + token.substring(token.length - 4) 
      : '****';
    console.log(`✓ スクリプトプロパティ [${MERCARI_CONFIG.TOKEN_PROPERTY}] を取得しました。(Token: ${maskedToken})`);

    // 2. データ変更を伴わない安全な参照クエリ（自身のショップ情報の取得）
    const query = `
      query getShopInfo {
        shop {
          id
          name
          businessKind
          createdAt
          description
        }
      }
    `;

    // 3. リクエストオプションの構築
    const options = {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': MERCARI_CONFIG.USER_AGENT
      },
      payload: JSON.stringify({ query: query }),
      muteHttpExceptions: true // エラー時も例外をスローせずステータスコード・エラー詳細を取得
    };

    console.log(`リクエスト送信先: ${MERCARI_CONFIG.ENDPOINT}`);
    const response = UrlFetchApp.fetch(MERCARI_CONFIG.ENDPOINT, options);
    const statusCode = response.getResponseCode();
    const responseBody = response.getContentText();

    console.log(`HTTPステータスコード: ${statusCode}`);

    // レスポンスのJSONパース
    let responseJson;
    try {
      responseJson = JSON.parse(responseBody || '{}');
    } catch (parseError) {
      console.error('× レスポンスが有効なJSON形式ではありません。');
      console.error('レスポンス本文:', responseBody);
      return {
        success: false,
        statusCode: statusCode,
        error: 'INVALID_JSON_RESPONSE',
        rawBody: responseBody
      };
    }

    // 4. 実行結果の判定およびログ出力
    if (statusCode >= 200 && statusCode < 300) {
      // GraphQLレベルのエラーチェック
      if (responseJson.errors && responseJson.errors.length > 0) {
        console.error('× GraphQLエラーレスポンスが返却されました:');
        console.error(JSON.stringify(responseJson.errors, null, 2));
        return {
          success: false,
          statusCode: statusCode,
          errors: responseJson.errors
        };
      }

      const shopData = responseJson.data && responseJson.data.shop;
      console.log('=============================================');
      console.log('✓ 導通テスト成功！');
      console.log('メルカリShops APIの認証およびショップ情報取得に成功しました。');
      console.log('ショップ情報:', JSON.stringify(shopData, null, 2));
      console.log('=============================================');

      return {
        success: true,
        statusCode: statusCode,
        shop: shopData
      };
    } else {
      console.error('=============================================');
      console.error(`× APIリクエスト失敗 (HTTPステータス: ${statusCode})`);
      console.error('エラー詳細:', JSON.stringify(responseJson, null, 2));
      console.error('=============================================');

      return {
        success: false,
        statusCode: statusCode,
        response: responseJson
      };
    }

  } catch (error) {
    console.error('=============================================');
    console.error('× 導通テスト実行中に例外が発生しました:');
    console.error(error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    console.error('=============================================');

    return {
      success: false,
      error: error.message
    };
  } finally {
    console.log('--- [メルカリShops API 導通テスト終了] ---');
  }
}
