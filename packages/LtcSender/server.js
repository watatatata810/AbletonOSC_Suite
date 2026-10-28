const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
const { Live } = require('./lib/live');
const { Controller } = require('./lib/controller');
const cues = require('./lib/cues');

// ======= 設定 =======
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = loadConfig(configPath);
const pkgConfig = getPackageConfig(config, 'LtcSender');

const HTTP_PORT = pkgConfig.httpPort ?? 3002;
const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
const ABLETON_OSC_PORT = config.global?.abletonPort ?? 11000;
// osc-router が AbletonOSC からの返信を複製転送してくるポート
const NODE_OSC_PORT = pkgConfig.oscPort ?? 11005;
const OSC_TIMEOUT = pkgConfig.oscTimeout ?? 1000;
// 台帳の保存先
const DATA_FILE = path.join(__dirname, 'project_data.json');
// ====================

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const live = new Live({ host: ABLETON_OSC_HOST, port: ABLETON_OSC_PORT, listenPort: NODE_OSC_PORT, timeout: OSC_TIMEOUT });
live.on('error', (err) => console.error('[OSC] エラー:', err.message));
live.start();
console.log(`[OSC] AbletonOSC (${ABLETON_OSC_HOST}:${ABLETON_OSC_PORT}) へ送信、返信は ${NODE_OSC_PORT} で受信します`);

const controller = new Controller({ live, dataFile: DATA_FILE, clipPyPath: pkgConfig.abletonOscClipPy });
controller.on('state', (state) => io.emit('state', state));
controller.on('status', (status) => io.emit('status', status));
controller.on('tc', (display) => io.volatile.emit('tc', display));
controller.start();
if (controller.patchMissing.length > 0) {
    console.warn(`[AbletonOSC Patch] 足りない命令: ${controller.patchMissing.join(', ')}。node scripts/apply-abletonosc-patch.js を実行してください`);
}

/**
 * 画面からの操作を受け付ける。結果は ack で返し、失敗はメッセージにして返す
 */
const handle = (socket, event, fn) => {
    socket.on(event, async (payload = {}, ack = () => {}) => {
        try {
            const result = await fn(payload);
            ack({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
        } catch (err) {
            console.error(`[LtcSender] ${event} に失敗しました:`, err.message);
            ack({ ok: false, problems: [err.message] });
        }
    });
};

io.on('connection', (socket) => {
    console.log(`[WebSocket] クライアントが接続しました: ${socket.id}`);
    socket.emit('state', controller.publicState());
    if (controller.status) socket.emit('status', controller.status);

    handle(socket, 'set_mode', ({ mode }) => controller.setMode(mode));
    handle(socket, 'refresh', async () => {
        controller.checkPatch();
        await controller.refreshStructure(true);
        socket.emit('state', controller.publicState());
    });

    // ---- 台帳 ----
    handle(socket, 'create_show', ({ name, settings }) => controller.editLedger((data) => {
        cues.createShow(data, name, settings);
    }));
    handle(socket, 'select_show', ({ name }) => controller.editLedger((data) => {
        if (!data.shows[name]) throw new Error(`ショーがありません: ${name}`);
        data.active = name;
    }));
    handle(socket, 'update_show', ({ settings }) => controller.editLedger((data, show) => {
        if (!show) throw new Error('ショーが選ばれていません');
        const allowed = ['rate', 'tempo', 'levelDb', 'ltcTrack', 'bgmTrack', 'outputDir'];
        for (const key of allowed) {
            if (settings[key] !== undefined) show[key] = settings[key];
        }
    }));
    handle(socket, 'upsert_cue', ({ cue }) => controller.editLedger((data, show) => {
        if (!show) throw new Error('ショーが選ばれていません');
        cues.upsertCue(show, cue);
    }));
    handle(socket, 'remove_cue', ({ scene }) => controller.editLedger((data, show) => {
        if (show) cues.removeCue(show, scene);
    }));
    handle(socket, 'auto_assign', ({ firstHour }) => controller.editLedger((data, show) => {
        if (!show) throw new Error('ショーが選ばれていません');
        return { warnings: cues.autoAssignHours(show, firstHour ?? 1) };
    }));
    handle(socket, 'create_file', ({ scene }) => controller.createFile(scene));

    // ---- 途中から再生・飛ばす ----
    handle(socket, 'start_from', ({ scene, seconds, confirmed }) => controller.startFrom(scene, seconds, confirmed));
    handle(socket, 'jump', ({ seconds, deltaSeconds, confirmed }) => controller.jump(
        seconds !== undefined ? { seconds } : { deltaSeconds }, confirmed
    ));

    socket.on('disconnect', () => {
        console.log(`[WebSocket] クライアントが切断しました: ${socket.id}`);
    });
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`[LtcSender] http://localhost:${HTTP_PORT} で起動しました`);
});
