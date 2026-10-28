/**
 * AbletonOSC (ideoforms/AbletonOSC、MIT ライセンス) の改造の確認と適用。
 *
 * 上流の abletonosc/clip.py は Clip の move_playing_pos / scrub / stop_scrub を OSC に出していない。
 * `methods = [...]` の一覧に名前を足すと、/live/clip/<名前> <track> <clip> [引数] で呼べるようになる
 * (handler.py の _call_method が引数をそのまま Live API に渡す)。
 * AbletonOSC を更新すると改造は消えるので、起動時に checkFile で確かめる。
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
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const backup = `${filePath}.bak-${stamp}`;
    fs.copyFileSync(filePath, backup);
    fs.writeFileSync(filePath, applyToSource(src), 'utf-8');
    return { path: filePath, changed: true, backup, added };
};

module.exports = {
    REQUIRED_METHODS,
    defaultClipPyPath,
    missingMethods,
    applyToSource,
    checkFile,
    applyFile
};
