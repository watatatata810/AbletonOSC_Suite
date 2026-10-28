/**
 * AbletonOSC に、LtcSender が使う改造を当てる。
 * - clip.py: 3 つの命令 (move_playing_pos / scrub / stop_scrub) を足す
 * - osc_server.py: Windows の WSAECONNRESET で問い合わせが数十秒止まる問題の対策
 *
 * 使い方: node scripts/apply-abletonosc-patch.js [clip.py のパス]
 * パスを省くと Documents\Ableton\User Library\Remote Scripts\AbletonOSC\abletonosc\clip.py。
 * 当てた後は Ableton Live を再起動すると読み込まれる。AbletonOSC を更新したら、もう一度実行する。
 */
const patch = require('../lib/abletonosc-patch');

const target = process.argv[2] || patch.defaultClipPyPath();
const before = patch.checkInstall(target);
if (!before.clip.exists || !before.oscServer.exists) {
    console.error(`[AbletonOSC Patch] AbletonOSC のファイルが見つかりません: ${target}`);
    process.exit(1);
}
if (before.missing.length === 0) {
    console.log(`[AbletonOSC Patch] 適用済みです。変更はありません: ${target}`);
    process.exit(0);
}
const result = patch.applyInstall(target);
for (const r of [result.clip, result.oscServer]) {
    if (!r.changed) continue;
    console.log(`[AbletonOSC Patch] ${r.added.join(', ')} を当てました: ${r.path}`);
    console.log(`[AbletonOSC Patch] 元のファイル: ${r.backup}`);
}
console.log('[AbletonOSC Patch] Ableton Live を再起動すると読み込まれます。');
