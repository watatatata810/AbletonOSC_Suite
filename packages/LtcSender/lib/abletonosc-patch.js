/**
 * AbletonOSC (ideoforms/AbletonOSC、MIT ライセンス) の改造の確認と適用。
 *
 * 上流の abletonosc/clip.py は Clip の move_playing_pos / scrub / stop_scrub を OSC に出していない。
 * `methods = [...]` の一覧に名前を足すと、/live/clip/<名前> <track> <clip> [引数] で呼べるようになる
 * (handler.py の _call_method が引数をそのまま Live API に渡す)。
 * あわせて abletonosc/osc_server.py に Windows の WSAECONNRESET 対策を当てる (下の OSC_SERVER_PATCHES)。
 * AbletonOSC を更新すると改造は消えるので、起動時に checkInstall で確かめる。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED_METHODS = ['move_playing_pos', 'scrub', 'stop_scrub'];

const defaultClipPyPath = () => path.join(
    os.homedir(), 'Documents', 'Ableton', 'User Library', 'Remote Scripts', 'AbletonOSC', 'abletonosc', 'clip.py'
);

/** `methods = [` から最初の `]` までを探す */
const findMethodsBlock = (src) => {
    const start = src.search(/methods\s*=\s*\[/);
    if (start < 0) return null;
    const open = src.indexOf('[', start);
    const close = src.indexOf(']', open);
    if (close < 0) return null;
    return { open, close, body: src.slice(open + 1, close) };
};

/** @returns {string[]} 足りない名前の一覧 */
const missingMethods = (src) => {
    const block = findMethodsBlock(src);
    if (!block) throw new Error('clip.py に methods の一覧が見つかりません');
    const names = [...block.body.matchAll(/["']([A-Za-z_]+)["']/g)].map((m) => m[1]);
    return REQUIRED_METHODS.filter((n) => !names.includes(n));
};

/**
 * 足りない名前を methods の一覧の末尾に足した文字列を返す。改行コードと字下げは元に合わせる
 */
const applyToSource = (src) => {
    const missing = missingMethods(src);
    if (missing.length === 0) return src;
    const block = findMethodsBlock(src);
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const items = [...block.body.matchAll(/^([ \t]*)["'][A-Za-z_]+["']/gm)];
    const indent = items.length > 0 ? items[items.length - 1][1] : '            ';
    // 最後の要素の直後 (末尾の空白・改行の前) に ",<改行><字下げ>"名前"" を足していく
    const body = block.body.replace(/\s*$/, '');
    const trailing = block.body.slice(body.length);
    const sep = body.trim().length === 0 ? '' : ',';
    const added = missing.map((n) => `${indent}"${n}"`).join(`,${eol}`);
    const newBody = `${body}${sep}${eol}${added}${trailing}`;
    return src.slice(0, block.open + 1) + newBody + src.slice(block.close);
};

/**
 * @returns {{path:string, exists:boolean, missing:string[], error?:string}}
 */
const checkFile = (filePath = defaultClipPyPath()) => {
    if (!fs.existsSync(filePath)) return { path: filePath, exists: false, missing: [...REQUIRED_METHODS] };
    try {
        return { path: filePath, exists: true, missing: missingMethods(fs.readFileSync(filePath, 'utf-8')) };
    } catch (err) {
        return { path: filePath, exists: true, missing: [...REQUIRED_METHODS], error: err.message };
    }
};

/**
 * 改造を当てる。変更が要る時だけ、元のファイルを clip.py.bak-<日時> に残してから書き換える
 * @returns {{path:string, changed:boolean, backup:string|null, added:string[]}}
 */
const applyFile = (filePath = defaultClipPyPath(), now = new Date()) => {
    const src = fs.readFileSync(filePath, 'utf-8');
    const added = missingMethods(src);
    if (added.length === 0) return { path: filePath, changed: false, backup: null, added };
    const backup = backupPath(filePath, now);
    fs.copyFileSync(filePath, backup);
    fs.writeFileSync(filePath, applyToSource(src), 'utf-8');
    return { path: filePath, changed: true, backup, added };
};

// ---- osc_server.py: Windows の WSAECONNRESET 対策 ----
//
// Windows では、閉じたポートへ送った UDP のデータグラム 1 件ごとに WSAECONNRESET (10054) が
// 1 件ためられ、次の recvfrom で報告される。上流の process() はこれを「無害」として記録したうえで
// その回の受信を打ち切るため、0.1 秒ごとに 1 件ずつしか消化できない。
// osc-router の再起動中 (返信の送り先 11001 が閉じている約 10 秒) に再生位置の通知などが
// 約 1,000 件ためられ、その後 80 秒以上、問い合わせが 1 件も処理されなかった (2026-10-29 実測)。
// 受信側はエラーを読み飛ばして受信を続け、送信側は上流 PR #214 と同じくエラーを無視する。
const OSC_SERVER_PATCHES = [
    {
        id: 'osc_server:recv_reset',
        marker: 'LtcSender patch: recv reset',
        pattern: /^([ \t]*)data, remote_addr = self\._socket\.recvfrom\(65536\)[ \t]*$/m,
        build: (i, eol) => [
            `${i}try:`,
            `${i}    data, remote_addr = self._socket.recvfrom(65536)`,
            `${i}except ConnectionResetError:`,
            `${i}    # LtcSender patch: recv reset`,
            `${i}    # On Windows, each datagram sent to a closed port queues one WSAECONNRESET.`,
            `${i}    # Skip them all in this tick instead of stopping, or queued requests stall for minutes.`,
            `${i}    continue`
        ].join(eol)
    },
    {
        id: 'osc_server:send_reset',
        marker: 'LtcSender patch: send reset',
        pattern: /^([ \t]*)self\._socket\.sendto\(msg\.dgram, remote_addr\)[ \t]*$/m,
        build: (i, eol) => [
            `${i}try:`,
            `${i}    self._socket.sendto(msg.dgram, remote_addr)`,
            `${i}except ConnectionResetError:`,
            `${i}    # LtcSender patch: send reset (same as upstream PR #214)`,
            `${i}    pass`
        ].join(eol)
    }
];

const oscServerPathFor = (clipPyPath) => path.join(path.dirname(clipPyPath), 'osc_server.py');

/** @returns {string[]} 当たっていない osc_server.py の修正の id */
const missingOscServerPatches = (src) => OSC_SERVER_PATCHES.filter((p) => !src.includes(p.marker)).map((p) => p.id);

const applyOscServerToSource = (src) => {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    let out = src;
    for (const p of OSC_SERVER_PATCHES) {
        if (out.includes(p.marker)) continue;
        const m = p.pattern.exec(out);
        if (!m) throw new Error(`osc_server.py に ${p.id} を当てる場所が見つかりません (AbletonOSC の版が違う可能性があります)`);
        out = out.slice(0, m.index) + p.build(m[1], eol) + out.slice(m.index + m[0].length);
    }
    return out;
};

const backupPath = (filePath, now) => {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `${filePath}.bak-${stamp}`;
};

/**
 * clip.py と osc_server.py の改造をまとめて確かめる
 * @returns {{missing:string[], clip:object, oscServer:{path:string, exists:boolean, missing:string[]}}}
 */
const checkInstall = (clipPyPath = defaultClipPyPath()) => {
    const clip = checkFile(clipPyPath);
    const oscPath = oscServerPathFor(clipPyPath);
    const oscServer = fs.existsSync(oscPath)
        ? { path: oscPath, exists: true, missing: missingOscServerPatches(fs.readFileSync(oscPath, 'utf-8')) }
        : { path: oscPath, exists: false, missing: OSC_SERVER_PATCHES.map((p) => p.id) };
    return { missing: [...clip.missing, ...oscServer.missing], clip, oscServer };
};

/**
 * clip.py と osc_server.py の改造をまとめて当てる。変更が要るファイルだけ、元を .bak-<日時> に残す
 */
const applyInstall = (clipPyPath = defaultClipPyPath(), now = new Date()) => {
    const clip = applyFile(clipPyPath, now);
    const oscPath = oscServerPathFor(clipPyPath);
    const src = fs.readFileSync(oscPath, 'utf-8');
    const added = missingOscServerPatches(src);
    let oscServer = { path: oscPath, changed: false, backup: null, added };
    if (added.length > 0) {
        const out = applyOscServerToSource(src);
        const backup = backupPath(oscPath, now);
        fs.copyFileSync(oscPath, backup);
        fs.writeFileSync(oscPath, out, 'utf-8');
        oscServer = { path: oscPath, changed: true, backup, added };
    }
    return { clip, oscServer };
};

module.exports = {
    REQUIRED_METHODS,
    OSC_SERVER_PATCHES,
    defaultClipPyPath,
    missingMethods,
    applyToSource,
    checkFile,
    applyFile,
    missingOscServerPatches,
    applyOscServerToSource,
    checkInstall,
    applyInstall
};
