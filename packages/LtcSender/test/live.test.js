const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { Client, Server } = require('node-osc');
const { Live, f32 } = require('../lib/live');

const freePort = () => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

/**
 * AbletonOSC の代わり。受け取ったものを記録し、get には決まった値を返す。
 * 返信は osc-router と同じく、Live クラスの listenPort へ送る。
 */
const startFakeAbleton = async (replies) => {
    const port = await freePort();
    const listenPort = await freePort();
    const received = [];
    const server = new Server(port, '127.0.0.1');
    const back = new Client('127.0.0.1', listenPort);
    await new Promise((r) => server.on('listening', r));
    server.on('message', (msg) => {
        received.push(msg);
        const reply = replies[msg[0]];
        if (reply) back.send(msg[0], ...reply(msg.slice(1)));
    });
    server.on('bundle', (b) => received.push({ bundle: b.elements }));
    return { port, listenPort, received, close: () => { server.close(); back.close(); } };
};

test('query: 送った引数と一致する返信の残りの値を返す', async () => {
    const fake = await startFakeAbleton({
        '/live/clip/get/playing_position': ([t, c]) => [t, c, 960.5],
        '/live/clip/get/is_playing': ([t, c]) => [t, c, true],
        '/live/song/get/tempo': () => [120.0]
    });
    const live = new Live({ host: '127.0.0.1', port: fake.port, listenPort: fake.listenPort, timeout: 500 });
    live.start();
    try {
        assert.deepEqual(await live.query('/live/clip/get/playing_position', 4, 12), [960.5]);
        assert.equal(await live.value('/live/clip/get/is_playing', [0, 12]), true);
        assert.equal(await live.getTempo(), 120);
    } finally {
        live.close();
        fake.close();
    }
});

test('query: 返信が無ければ null (タイムアウト)', async () => {
    const fake = await startFakeAbleton({});
    const live = new Live({ host: '127.0.0.1', port: fake.port, listenPort: fake.listenPort, timeout: 100 });
    live.start();
    try {
        assert.equal(await live.query('/live/song/get/tempo'), null);
    } finally {
        live.close();
        fake.close();
    }
});

test('sendBundle: 1 つのバンドルで届き、f32 は整数の値でも float で送られる', async () => {
    const fake = await startFakeAbleton({});
    const live = new Live({ host: '127.0.0.1', port: fake.port, listenPort: fake.listenPort });
    live.start();
    try {
        await live.sendBundle([
            ['/live/clip/scrub', 0, 12, f32(960)],
            ['/live/clip/stop_scrub', 0, 12]
        ]);
        await new Promise((r) => setTimeout(r, 100));
        const bundle = fake.received.find((m) => m.bundle);
        assert.ok(bundle, 'バンドルが届いていない');
        assert.deepEqual(bundle.bundle, [['/live/clip/scrub', 0, 12, 960], ['/live/clip/stop_scrub', 0, 12]]);
    } finally {
        live.close();
        fake.close();
    }
});

test('f32: 型タグが f になる (Live の scrub / move_playing_pos は拍を小数で受ける)', async () => {
    const port = await freePort();
    const raw = dgram.createSocket('udp4');
    await new Promise((r) => raw.bind(port, '127.0.0.1', r));
    const got = new Promise((r) => raw.once('message', r));
    const live = new Live({ host: '127.0.0.1', port, listenPort: await freePort() });
    live.start();
    try {
        await live.send('/live/clip/move_playing_pos', 0, 12, f32(-20));
        const buf = await got;
        assert.ok(buf.includes(Buffer.from(',iif\0')), buf.toString('latin1'));
    } finally {
        live.close();
        raw.close();
    }
});
