const fs = require('fs');
const path = require('path');

/**
 * 指定されたパスの JSON 設定ファイルを読み込み、パースして返します。
 * ファイルが存在しない、またはパースエラーの場合は空のオブジェクトを返します。
 * @param {string} configPath - 読み込むJSONファイルの絶対パス
 * @returns {Object} パースされた設定オブジェクト、または {}
 */
const loadConfig = (configPath) => {
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (err) {
            console.error(`\n[Config Error] ${path.basename(configPath)} の解析に失敗しました。`);
            console.error(`記述に誤り（カンマや引用符の不足など）がないか確認してください。デフォルト値を使用します。\n`);
        }
    } else {
        console.log(`[Config Info] 設定ファイル (${path.basename(configPath)}) が見つかりません。デフォルト値を使用します。`);
    }
    return {};
};

module.exports = {
    loadConfig
};
