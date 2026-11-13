/**
 * この PC で使う Neutralino の実行ファイル名 (各パッケージの bin/ の中のファイル名) を返す。
 * Mac は Apple Silicon (arm64) と Intel (x64) で分ける。x64 版は Apple Silicon でも
 * Rosetta があれば動くが、無い Mac では起動できないため、CPU に合う方を選ぶ。
 * @param {string} [platform=process.platform]
 * @param {string} [arch=process.arch]
 * @returns {string}
 */
const neutralinoBinaryName = (platform = process.platform, arch = process.arch) => {
    if (platform === 'win32') return 'neutralino-win_x64.exe';
    if (platform === 'darwin') return arch === 'arm64' ? 'neutralino-mac_arm64' : 'neutralino-mac_x64';
    if (arch === 'arm64') return 'neutralino-linux_arm64';
    if (arch === 'arm') return 'neutralino-linux_armhf';
    return 'neutralino-linux_x64';
};

module.exports = { neutralinoBinaryName };
