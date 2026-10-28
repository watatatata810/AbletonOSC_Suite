const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const patch = require('../lib/abletonosc-patch');

// 上流 (ideoforms/AbletonOSC master, 2025-11) の clip.py の methods 部分と同じ形
// ("duplicate_loop" の後ろに空白が 1 つある)
const UPSTREAM = [
    '        methods = [',
    '            "fire",',
    '            "stop",',
    '            "duplicate_loop", ',
    '            "remove_notes_by_id"',
    '        ]',
    '        properties_r = [',
    '            "end_time",',
    '        ]',
    ''
].join('\n');

test('上流版には 3 つとも足りない', () => {
    assert.deepEqual(patch.missingMethods(UPSTREAM), ['move_playing_pos', 'scrub', 'stop_scrub']);
});

test('当てると methods の一覧だけに 3 行増え、properties は変わらない', () => {
    const out = patch.applyToSource(UPSTREAM);
    assert.deepEqual(patch.missingMethods(out), []);
    assert.equal(out, [
        '        methods = [',
        '            "fire",',
        '            "stop",',
        '            "duplicate_loop", ',
        '            "remove_notes_by_id",',
        '            "move_playing_pos",',
        '            "scrub",',
        '            "stop_scrub"',
        '        ]',
        '        properties_r = [',
        '            "end_time",',
        '        ]',
        ''
    ].join('\n'));
});

test('2 回当てても変わらない', () => {
    const once = patch.applyToSource(UPSTREAM);
    assert.equal(patch.applyToSource(once), once);
});

test('CRLF のファイルは CRLF のまま', () => {
    const crlf = UPSTREAM.replace(/\n/g, '\r\n');
    const out = patch.applyToSource(crlf);
    assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
    assert.deepEqual(patch.missingMethods(out), []);
});

test('一部だけ足りない場合は、その分だけ足す', () => {
    const partial = patch.applyToSource(UPSTREAM).replace(',\n            "stop_scrub"', '');
    assert.deepEqual(patch.missingMethods(partial), ['stop_scrub']);
    assert.deepEqual(patch.missingMethods(patch.applyToSource(partial)), []);
});

test('applyFile: 変更する時だけ退避ファイルを作る', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-patch-'));
    const file = path.join(dir, 'clip.py');
    fs.writeFileSync(file, UPSTREAM);
    const first = patch.applyFile(file, new Date(2026, 9, 28, 23, 0, 0));
    assert.equal(first.changed, true);
    assert.equal(fs.readFileSync(first.backup, 'utf-8'), UPSTREAM);
    assert.equal(path.basename(first.backup), 'clip.py.bak-20261028-230000');
    const second = patch.applyFile(file);
    assert.equal(second.changed, false);
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.deepEqual(patch.checkFile(file).missing, []);
    fs.rmSync(dir, { recursive: true });
});

test('checkFile: ファイルが無ければ全部足りない扱い', () => {
    const r = patch.checkFile(path.join(os.tmpdir(), 'no-such-dir', 'clip.py'));
    assert.equal(r.exists, false);
    assert.equal(r.missing.length, 3);
});
