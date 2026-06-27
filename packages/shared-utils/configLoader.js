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

/**
 * config.json から指定したパッケージの設定を取得するヘルパー。
 * インライン（packages内の該当要素）と、下位互換性のため古い個別オブジェクトの両方をマージして返します。
 * @param {Object} config - loadConfig でロードされた設定オブジェクト
 * @param {string} pkgName - 取得したいパッケージ名 (例: 'viewWaves')
 * @returns {Object} パッケージ固有の設定
 */
const getPackageConfig = (config, pkgName) => {
    if (!config) return {};
    const pkg = (config.packages || []).find(p => p.name === pkgName) || {};
    
    // 後方互換性：古い個別オブジェクトが存在する場合はマージする
    const legacyKey = Object.keys(config).find(
        key => key.toLowerCase() === pkgName.toLowerCase() && key !== 'packages' && key !== 'global'
    );
    const legacyConfig = legacyKey ? config[legacyKey] : {};

    return {
        ...legacyConfig,
        ...pkg
    };
};

module.exports = {
    loadConfig,
    getPackageConfig
};
