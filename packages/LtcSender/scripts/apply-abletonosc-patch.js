/**
 * AbletonOSC の clip.py に、LtcSender が使う 3 つの命令 (move_playing_pos / scrub / stop_scrub) を足す。
 *
 * 使い方: node scripts/apply-abletonosc-patch.js [clip.py のパス]
 * パスを省くと Documents\Ableton\User Library\Remote Scripts\AbletonOSC\abletonosc\clip.py。
 * 足した後は Ableton Live を再起動すると読み込まれる。AbletonOSC を更新したら、もう一度実行する。
 */
const patch = require('../lib/abletonosc-patch');

const target = process.argv[2] || patch.defaultClipPyPath();
const before = patch.checkFile(target);
if (!before.exists) {
    console.error(`[AbletonOSC Patch] clip.py が見つかりません: ${target}`);
    process.exit(1);
}
if (before.missing.length === 0) {
    console.log(`[AbletonOSC Patch] 適用済みです。変更はありません: ${target}`);
    process.exit(0);
}
const result = patch.applyFile(target);
console.log(`[AbletonOSC Patch] ${result.added.join(', ')} を足しました: ${target}`);
console.log(`[AbletonOSC Patch] 元のファイル: ${result.backup}`);
console.log('[AbletonOSC Patch] Ableton Live を再起動すると読み込まれます。');
