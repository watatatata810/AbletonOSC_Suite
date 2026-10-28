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

// ---- osc_server.py (Windows の WSAECONNRESET 対策) ----
const UPSTREAM_OSC_SERVER = fs.readFileSync(path.join(__dirname, 'fixtures', 'abletonosc-osc_server.py'), 'utf-8');

test('osc_server.py: 上流版には 2 つとも当たっていない', () => {
    assert.deepEqual(patch.missingOscServerPatches(UPSTREAM_OSC_SERVER), ['osc_server:recv_reset', 'osc_server:send_reset']);
});

test('osc_server.py: 受信はエラーを読み飛ばして続け、送信はエラーを無視する', () => {
    const out = patch.applyOscServerToSource(UPSTREAM_OSC_SERVER);
    assert.deepEqual(patch.missingOscServerPatches(out), []);
    // 受信: recvfrom を try で包み、ConnectionResetError なら continue (ループを抜けない)
    assert.match(out, /\n( +)try:\n\1    data, remote_addr = self\._socket\.recvfrom\(65536\)\n\1except ConnectionResetError:\n(?:\1    #.*\n)+\1    continue\n/);
    // 送信: sendto を try で包み、ConnectionResetError なら何もしない
    assert.match(out, /\n( +)try:\n\1    self\._socket\.sendto\(msg\.dgram, remote_addr\)\n\1except ConnectionResetError:\n(?:\1    #.*\n)+\1    pass\n/);
    // 元の行で変わる (try の中へ字下げされる) のは、recvfrom と sendto の 2 行だけ
    const removed = UPSTREAM_OSC_SERVER.split('\n').filter((l) => !out.split('\n').includes(l)).map((l) => l.trim());
    assert.deepEqual(removed.sort(), [
        'data, remote_addr = self._socket.recvfrom(65536)',
        'self._socket.sendto(msg.dgram, remote_addr)'
    ]);
});

test('osc_server.py: 2 回当てても変わらない / CRLF は CRLF のまま', () => {
    const once = patch.applyOscServerToSource(UPSTREAM_OSC_SERVER);
    assert.equal(patch.applyOscServerToSource(once), once);
    const crlf = patch.applyOscServerToSource(UPSTREAM_OSC_SERVER.replace(/\n/g, '\r\n'));
    assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);
});

test('checkInstall / applyInstall: clip.py と osc_server.py をまとめて確かめて当てる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcsender-install-'));
    const clip = path.join(dir, 'clip.py');
    fs.writeFileSync(clip, UPSTREAM);
    fs.writeFileSync(path.join(dir, 'osc_server.py'), UPSTREAM_OSC_SERVER);
    assert.equal(patch.checkInstall(clip).missing.length, 5);
    const r = patch.applyInstall(clip, new Date(2026, 9, 29, 1, 0, 0));
    assert.equal(r.clip.changed, true);
    assert.equal(r.oscServer.changed, true);
    assert.equal(path.basename(r.oscServer.backup), 'osc_server.py.bak-20261029-010000');
    assert.deepEqual(patch.checkInstall(clip).missing, []);
    assert.equal(patch.applyInstall(clip).oscServer.changed, false);
    fs.rmSync(dir, { recursive: true });
});
