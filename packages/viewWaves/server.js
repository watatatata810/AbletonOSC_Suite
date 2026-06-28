const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, Server: OscServer } = require('node-osc');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('json spaces', 2); // JSON出力のプリティプリントをデフォルトで有効化
const server = http.createServer(app);
const io = new Server(server);

const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = loadConfig(configPath);
const pkgConfig = getPackageConfig(config, 'viewWaves');

const clientHost = config.global?.abletonHost ?? '127.0.0.1';
const clientPort = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000);
const serverPort = pkgConfig.oscPort ?? (process.env.OSC_PORT || 11002);

// 現在再生中のクリップを管理（TrackID -> SlotIndex）
const activeClips = {};
let abletonConnected = false;
let lastAbletonMessageTime = 0;

// 親プロセス（Neutralino）が終了した際に確実に自身も終了するフェイルセーフ
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// グローバルエラーハンドリング（クラッシュ原因の特定用）
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') {
        process.exit(0); // 親プロセス終了によるパイプ切断時は正常終了
    }
    
    // UDP一時エラーなどのネットワーク切断に起因する例外は無視してプロセスを維持
    const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
    if (err.code && IGNORE_ERRORS.includes(err.code)) {
        console.warn(`[Network Warning] Ignored temporary UDP socket exception: ${err.code} (${err.message})`);
        return;
    }
    
    console.error('Uncaught Exception:', err);
    try {
        fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Uncaught Exception: ${err.stack}\n`);
    } catch (e) {}
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`);
});

// stdout/stderr の EPIPE も捕捉して正常終了
process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
});

const WEB_PORT = pkgConfig.httpPort ?? (process.env.PORT || 3000);
const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';

// CORS設定：Neutralinojsの待機画面からのアクセスを許可するため、一番最初に定義する
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use('/vendor/wavesurfer', express.static(path.join(__dirname, '..', '..', 'node_modules', 'wavesurfer.js', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));


app.get('/audio', (req, res) => {
    const audioPath = req.query.path;
    console.log(`[Web] Requested audio file: ${audioPath}`);
    
    if (!audioPath) {
        console.error(`[Web] Missing path parameter`);
        return res.status(400).send('Path is required');
    }

    // セキュリティ対策: AbletonOSCから取得し、現在サーバーが把握しているファイルパスのリスト
    const validPaths = Object.values(clipLengths).filter(val => typeof val === 'string');
    
    // Windows/Macの違いやディレクトリトラバーサル文字(..)を吸収するためにnormalize
    const normalizedRequested = path.normalize(audioPath);
    const isAllowed = validPaths.some(vp => path.normalize(vp) === normalizedRequested);

    if (!isAllowed) {
        console.error(`[Web] Access denied (Path Traversal attempt or invalid clip): ${audioPath}`);
        return res.status(403).send('Forbidden: Access denied');
    }

    if (!fs.existsSync(audioPath)) {
        console.error(`[Web] Audio file not found: ${audioPath}`);
        return res.status(404).send('Audio file not found');
    }
    
    res.sendFile(path.resolve(audioPath));
});

// デバッグ用：サーバーが保持しているクリップ情報をJSON返却する
app.get('/debug/clip', (req, res) => {
    const trackId = req.query.track !== undefined ? req.query.track : null;
    const slotIndex = req.query.slot !== undefined ? req.query.slot : null;
    
    const result = {};
    for (const key in clipLengths) {
        if (
            (trackId === null || key.startsWith(`${trackId}_`)) &&
            (slotIndex === null || key.startsWith(`${trackId}_${slotIndex}`))
        ) {
            result[key] = clipLengths[key];
        }
    }
    res.json({
        playingSlots,
        activeClips,
        serverIsPlaying,
        currentTempo,
        clipData: result
    });
});

const oscClient = new Client(clientHost, clientPort);

// 送信したOSCリクエストのタイムスタンプ記録用
const pendingRequests = new Map();

// oscClient.send をラップして送信時刻を記録する
const originalSend = oscClient.send.bind(oscClient);
oscClient.send = function(address, ...args) {
    if (address.includes('/get/') || address.includes('/start_listen/')) {
        const key = `${address}_${args.join('_')}`;
        pendingRequests.set(key, Date.now());
    }
    originalSend(address, ...args);
};

const oscServer = new OscServer(serverPort, clientHost, () => {
    console.log(`[OSC] Listening for AbletonOSC messages on port ${serverPort}`);
});

// エラーハンドラを追加してプロセス終了を防ぐ
oscClient.on('error', (err) => {
    const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
    if (err.code && IGNORE_ERRORS.includes(err.code)) {
        console.warn(`[OSC Client Warning] Ignored temporary UDP error: ${err.message}`);
    } else {
        console.error('[OSC Client Error]', err);
    }
});

oscServer.on('error', (err) => {
    const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
    if (err.code && IGNORE_ERRORS.includes(err.code)) {
        console.warn(`[OSC Server Warning] Ignored temporary UDP error: ${err.message}`);
    } else {
        console.error('[OSC Server Error]', err);
    }
});

let numTracks = 0;
const playingSlots = {}; // key: trackId, value: slotIndex
let clipLengths = {}; // { "trackId_slotIndex": length, "trackId_slotIndex_start": startMarker, ... }
let currentTempo = 120.0;
let serverIsPlaying = false;
let selectedSceneIndex = -1;
let selectedSceneTimer = null;

// デバッグ用ファイル書き出し定義
const logFilePath = path.join(__dirname, 'server.log');
try {
    fs.writeFileSync(logFilePath, `Server Debug Log Started\n`);
} catch (e) {}

function debugLog(msg) {
    console.log(msg);
    try {
        fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

function syncActiveClipsToClients() {
    debugLog(`[Sync] Syncing current state cache to clients...`);
    for (const trackId in activeClips) {
        const slotIndex = activeClips[trackId];
        const filePath = clipLengths[`${trackId}_${slotIndex}_file_path`];
        if (filePath && filePath !== "NO_AUDIO") {
            io.emit('clip_playing', {
                trackId: parseInt(trackId),
                slotIndex: slotIndex,
                filePath: filePath
            });
            emitMarkersIfReady(parseInt(trackId), slotIndex);
        }
    }
}

let debugRequestStartTime = 0;
let debugPlayingPositionCount = 0;
let debugLastLogTime = Date.now();

// OSC 輻輳制御用変数
let lastNumTracksRequestTime = 0;
const lastClipPositionEmitTime = {}; // key: trackId, value: timestamp

// ポーリング処理：0.5秒に1回実行されるが、マーカー情報は2秒に1回に間引く
let pollCounter = 0;
const POLL_INTERVAL = config.viewWaves?.pollInterval ?? 500;
setInterval(() => {
    pollCounter++;
    
    // タイムアウト監視：最後のパケット受信から4秒以上経過していたら一時切断、20秒以上で完全リセット
    const elapsed = lastAbletonMessageTime > 0 ? Date.now() - lastAbletonMessageTime : 0;
    if (elapsed > 4000) {
        if (abletonConnected) {
            abletonConnected = false;
            // 一時タイムアウト：画面は消さない（reset: false）
            io.emit('ableton_status', { connected: false, reset: false });
            debugLog('Ableton Liveとの通信がタイムアウトしました。一時待機状態（疎通待ち）に移行します。');
        }
        
        // 20秒以上パケットが途絶えた場合、Abletonが再起動または終了されたとみなし、状態を完全クリア
        if (elapsed > 20000 && numTracks > 0) {
            numTracks = 0;
            for (const key in playingSlots) delete playingSlots[key];
            for (const key in activeClips) delete activeClips[key];
            clipLengths = {};
            
            // 完全タイムアウト：画面をクリアさせる（reset: true）
            io.emit('ableton_status', { connected: false, reset: true });
            debugLog('Ableton Liveとの通信が20秒以上途絶えたため、状態キャッシュを完全クリアします。');
        }
    }
    
    // 起動時の初期化パケット（num_tracks）がロスした場合のリトライ処理
    if (numTracks === 0) {
        const now = Date.now();
        // 前回の送信から2.0秒以上経過している場合のみ送信（再送スパム防止）
        if (now - lastNumTracksRequestTime > 2000) {
            lastNumTracksRequestTime = now;
            debugRequestStartTime = now;
            debugLog(`Sending /live/song/get/num_tracks`);
            oscClient.send('/live/song/get/num_tracks');
        }
    }
    
    // playing_slot_indexのロス対策: numTracksがあるのに値が取得できていないトラックがあれば再取得
    if (numTracks > 0 && connectedClients > 0) {
        for (let i = 0; i < numTracks; i++) {
            if (playingSlots[i] === undefined) {
                oscClient.send('/live/track/get/playing_slot_index', i);
            }
        }
    }

    // マーカー情報は再生状態に関係なく、現在ロードされているクリップをポーリングする
    // activeClips は停止時にクリアされるため、playingSlots を使用する
    for (const trackId in playingSlots) {
        const slotIndex = playingSlots[trackId];
        if (slotIndex >= 0) {
            // UDPパケットロス対策: 必要な情報が欠落している場合は再取得
            if (clipLengths[`${trackId}_${slotIndex}_file_path`] === undefined) {
                oscClient.send('/live/clip/get/file_path', parseInt(trackId), slotIndex);
            }
            if (clipLengths[`${trackId}_${slotIndex}`] === undefined) {
                oscClient.send('/live/clip/get/length', parseInt(trackId), slotIndex);
            }

            // マーカー情報は変動が少ないため、2秒に1回 (4ループに1回) のみポーリングする
            if (pollCounter % 4 === 0) {
                oscClient.send('/live/clip/get/start_marker', parseInt(trackId), slotIndex);
                oscClient.send('/live/clip/get/end_marker', parseInt(trackId), slotIndex);
                oscClient.send('/live/clip/get/warping', parseInt(trackId), slotIndex);
                oscClient.send('/live/clip/get/looping', parseInt(trackId), slotIndex);
                oscClient.send('/live/clip/get/loop_end', parseInt(trackId), slotIndex);
            }
        }
    }
}, POLL_INTERVAL);

// AbletonOSCからのメッセージ受信
oscServer.on('message', (msg) => {
    // タイムスタンプを更新
    lastAbletonMessageTime = Date.now();
    if (!abletonConnected) {
        abletonConnected = true;
        io.emit('ableton_status', { connected: true });
        debugLog('Ableton Liveとの通信を確立しました。');
        
        // 疎通が復活したタイミングで、すでにトラック数が確定していればリスナーを再登録する
        if (numTracks > 0) {
            setupAbletonListeners();
        }
        
        // 復活した瞬間、サーバー側で再生中とキャッシュしていれば即座にブラウザに再生開始を通知
        if (serverIsPlaying) {
            io.emit('song_playing');
        }
        
        // 【変更】疎通が復活した瞬間に、現在の状態キャッシュをブラウザに再同期する
        syncActiveClipsToClients();
    }
    
    if (config.global?.debug) {
        console.log(`[OSC Received in viewWaves]`, msg);
    }
    const address = msg[0];
    const args = msg.slice(1);

    // OSCレスポンスのRTT（応答時間）の計測
    if (address.includes('/get/')) {
        const reqArgs = args.slice(0, -1);
        const key = `${address}_${reqArgs.join('_')}`;
        const sendTime = pendingRequests.get(key);
        if (sendTime) {
            const rtt = Date.now() - sendTime;
            debugLog(`[OSC-RTT] ${address} (${reqArgs.join(', ')}): ${rtt} ms`);
            pendingRequests.delete(key);
        }
    }

    if (address === '/live/song/get/num_tracks') {
        const val = args[0];
        
        // すでにトラック数が確定している場合は、重複してリスナー登録を送らない（バーストガード）
        if (numTracks > 0) {
            numTracks = val; // 値だけ更新
            debugLog(`Received redundant /live/song/num_tracks: ${val} (Skipped listener setup)`);
            return;
        }
        
        numTracks = val;
        debugLog(`Received /live/song/num_tracks: ${numTracks}`);
        setupAbletonListeners();
    }
    else if (address === '/live/track/get/name') {
        const trackId = args[0];
        const name = args[1];
        io.emit('track_name', { trackId, name });
    }
    else if (address === '/live/song/get/is_playing' || address === '/live/song/is_playing') {
        const isPlaying = args[0];
        serverIsPlaying = isPlaying;
        if (isPlaying) {
            // 再生開始時、playingSlots に記録されているスロットを activeClips に復帰させる
            // （停止時にクリアされていたポーリング対象を復活させるため）
            for (const trackId in playingSlots) {
                if (playingSlots[trackId] >= 0) {
                    activeClips[trackId] = playingSlots[trackId];
                }
            }
            io.emit('song_playing');
        } else {
            io.emit('song_stopped');
            // 停止時はポーリングを止めるためリストをクリア
            for (const key in activeClips) delete activeClips[key];
        }
    }
    else if (address === '/live/track/get/playing_slot_index' || address === '/live/track/playing_slot_index') {
        const trackId = args[0];
        const slotIndex = args[1];

        // すでに同じスロットが再生中として登録されている場合は重複処理をスキップ（OSCパケットのスパム防止）
        if (playingSlots[trackId] === slotIndex) {
            return;
        }

        console.log(`[Live] Track ${trackId} playing slot changed to ${slotIndex}`);
        
        // 以前のクリップの再生位置の監視を停止
        if (playingSlots[trackId] !== undefined && playingSlots[trackId] >= 0) {
            oscClient.send('/live/clip/stop_listen/playing_position', trackId, playingSlots[trackId]);
        }
        
        playingSlots[trackId] = slotIndex;

        if (slotIndex >= 0) {
            activeClips[trackId] = slotIndex;
            oscClient.send('/live/clip/start_listen/playing_position', trackId, slotIndex);
            oscClient.send('/live/clip/get/length', trackId, slotIndex);
            oscClient.send('/live/clip/get/file_path', trackId, slotIndex);
            // 初回のマーカー位置とWarp情報等の取得
            oscClient.send('/live/clip/get/start_marker', trackId, slotIndex);
            oscClient.send('/live/clip/get/end_marker', trackId, slotIndex);
            oscClient.send('/live/clip/get/warping', trackId, slotIndex);
            oscClient.send('/live/clip/get/looping', trackId, slotIndex);
            oscClient.send('/live/clip/get/loop_end', trackId, slotIndex);
            // シーン名の取得リクエスト
            oscClient.send('/live/scene/get/name', slotIndex);
            
            // 次のシーン（1つ下のスロット）のファイルパスも事前取得する
            const nextSlot = slotIndex + 1;
            oscClient.send('/live/clip/get/file_path', trackId, nextSlot);
        } else {
            delete activeClips[trackId];
            io.emit('clip_stopped', { trackId: trackId });
        }
    }
    else if (address === '/live/scene/get/name') {
        const sceneIndex = args[0];
        const name = args[1];
        io.emit('scene_name', { sceneIndex, name });
    }
    else if (address === '/live/clip/get/length') {
        const trackId = args[0];
        const slotIndex = args[1];
        const length = args[2];
        clipLengths[`${trackId}_${slotIndex}`] = length;
        // clipLengthが確定したので、clip_markersを正しい値で再送信する
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/get/playing_position' || address === '/live/clip/playing_position') {
        // 初期化が完了（トラック数が確定）するまでは、処理をスキップして起動時の過負荷を防ぐ
        if (numTracks === 0) {
            return;
        }

        const trackId = args[0];
        const slotIndex = args[1];
        const position = args[2];
        activeClips[trackId] = slotIndex; // 再生中のクリップとして登録
        
        // 頻度デバッグ
        debugPlayingPositionCount++;
        const now = Date.now();
        if (now - debugLastLogTime >= 1000) {
            debugLog(`Receiving /playing_position at ${debugPlayingPositionCount} pkts/sec`);
            debugPlayingPositionCount = 0;
            debugLastLogTime = now;
        }

        const length = clipLengths[`${trackId}_${slotIndex}`];
        if (length && length > 0) {
            const now = Date.now();
            const lastEmit = lastClipPositionEmitTime[trackId] || 0;
            
            // 100ms（10Hz）間隔に間引いてブラウザにWebSocket送信
            if (now - lastEmit >= 100) {
                io.emit('clip_position', {
                    trackId: trackId,
                    slotIndex: slotIndex,
                    progress: Math.min(Math.max(position / length, 0), 1),
                    position: position
                });
                lastClipPositionEmitTime[trackId] = now;
            }
        }
    }
    else if (address === '/live/song/get/tempo') {
        currentTempo = args[0];
        console.log(`[Live] Song tempo changed: ${currentTempo}`);
    }
    else if (address === '/live/clip/start_marker' || address === '/live/clip/get/start_marker') {
        const trackId = args[0];
        const slotIndex = args[1];
        clipLengths[`${trackId}_${slotIndex}_start`] = args[2];
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/end_marker' || address === '/live/clip/get/end_marker') {
        const trackId = args[0];
        const slotIndex = args[1];
        clipLengths[`${trackId}_${slotIndex}_end`] = args[2];
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/warping' || address === '/live/clip/get/warping') {
        const trackId = args[0];
        const slotIndex = args[1];
        clipLengths[`${trackId}_${slotIndex}_warping`] = args[2];
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/get/looping' || address === '/live/clip/looping') {
        const trackId = args[0];
        const slotIndex = args[1];
        clipLengths[`${trackId}_${slotIndex}_looping`] = args[2];
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/get/loop_end' || address === '/live/clip/loop_end') {
        const trackId = args[0];
        const slotIndex = args[1];
        clipLengths[`${trackId}_${slotIndex}_loop_end`] = args[2];
        emitMarkersIfReady(trackId, slotIndex);
    }
    else if (address === '/live/clip/get/file_path') {
        const trackId = args[0];
        const slotIndex = args[1];
        let filePath = args[2];
        
        if (filePath === undefined || filePath === "") {
            filePath = "NO_AUDIO";
        }
        
        console.log(`[Live] Track ${trackId} Slot ${slotIndex} file path received: ${filePath}`);
        
        // パケットロス対策のリトライ条件解除のために保存
        clipLengths[`${trackId}_${slotIndex}_file_path`] = filePath;
        
        if (playingSlots[trackId] === slotIndex && filePath !== "NO_AUDIO") {
            // 現在再生中のクリップの場合
            io.emit('clip_playing', {
                trackId: trackId,
                slotIndex: slotIndex,
                filePath: filePath
            });
        } else if (playingSlots[trackId] === slotIndex - 1 && filePath !== "NO_AUDIO") {
            // 1つ下のクリップ（次のシーン）の場合、プリロード用イベントを送信
            io.emit('clip_preload', {
                trackId: trackId,
                slotIndex: slotIndex,
                filePath: filePath
            });
        }
        
        // 選択されたシーンのパスが取得できた場合、プリロード用イベントを送信
        if (selectedSceneIndex === slotIndex) {
            if (filePath !== "NO_AUDIO") {
                io.emit('clip_selected_preload', {
                    trackId: trackId,
                    slotIndex: slotIndex,
                    filePath: filePath
                });
            } else {
                io.emit('clip_selected_preload_empty', {
                    trackId: trackId,
                    slotIndex: slotIndex
                });
            }
        }
    }
    else if (address === '/live/view/get/selected_scene' || address === '/live/view/selected_scene') {
        const sceneIndex = args[0];
        handleSelectedSceneChanged(sceneIndex);
    }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function setupAbletonListeners() {
    debugLog(`Setting up listeners for ${numTracks} tracks with 20ms staggered interval...`);
    
    try {
        // 全体の再生状態（スペースキー等）を監視開始
        oscClient.send('/live/song/start_listen/is_playing');
        oscClient.send('/live/song/get/is_playing');
        await sleep(20);

        // テンポ的監視開始
        oscClient.send('/live/song/start_listen/tempo');
        oscClient.send('/live/song/get/tempo');
        await sleep(20);
        
        // 選択中シーンの監視と初期値取得
        oscClient.send('/live/view/start_listen/selected_scene');
        oscClient.send('/live/view/get/selected_scene');
        await sleep(20);
        
        // 全トラックの再生状態を監視開始
        for (let i = 0; i < numTracks; i++) {
            oscClient.send('/live/track/start_listen/playing_slot_index', i);
            oscClient.send('/live/track/get/playing_slot_index', i);
            await sleep(20);
            
            // トラック名の監視も開始
            oscClient.send('/live/track/start_listen/name', i);
            oscClient.send('/live/track/get/name', i);
            await sleep(20);
        }
        debugLog(`Finished setting up listeners for ${numTracks} tracks.`);
    } catch (e) {
        console.error('Failed to setup Ableton listeners:', e);
    }
}

function handleSelectedSceneChanged(sceneIndex) {
    if (selectedSceneIndex === sceneIndex) return;
    
    selectedSceneIndex = sceneIndex;
    
    if (selectedSceneTimer) {
        clearTimeout(selectedSceneTimer);
    }
    
    // 即時バッジ消去のためにクライアントに選択変更を通知
    io.emit('selected_scene_changed', { sceneIndex });
    
    selectedSceneTimer = setTimeout(() => {
        console.log(`[Live] Debounce expired. Preloading scene ${sceneIndex}`);
        preloadSelectedScene(sceneIndex);
    }, 300);
}

function preloadSelectedScene(sceneIndex) {
    if (sceneIndex < 0) return;
    
    for (let trackId = 0; trackId < numTracks; trackId++) {
        const cachedPath = clipLengths[`${trackId}_${sceneIndex}_file_path`];
        
        if (cachedPath !== undefined) {
            if (cachedPath !== "NO_AUDIO") {
                io.emit('clip_selected_preload', {
                    trackId: trackId,
                    slotIndex: sceneIndex,
                    filePath: cachedPath
                });
            } else {
                io.emit('clip_selected_preload_empty', {
                    trackId: trackId,
                    slotIndex: sceneIndex
                });
            }
        } else {
            // キャッシュがなければAbletonへパスと長さを問い合わせ
            oscClient.send('/live/clip/get/file_path', trackId, sceneIndex);
            oscClient.send('/live/clip/get/length', trackId, sceneIndex);
        }
    }
}

function emitMarkersIfReady(trackId, slotIndex, targetSocket = io) {
    const start = clipLengths[`${trackId}_${slotIndex}_start`];
    const end = clipLengths[`${trackId}_${slotIndex}_end`];
    const warping = clipLengths[`${trackId}_${slotIndex}_warping`];
    const looping = clipLengths[`${trackId}_${slotIndex}_looping`];
    const loopEnd = clipLengths[`${trackId}_${slotIndex}_loop_end`];
    const clipLength = clipLengths[`${trackId}_${slotIndex}`]; // Abletonが管理するクリップ全長（beats）
    
    if (start !== undefined && end !== undefined) {
        targetSocket.emit('clip_markers', {
            trackId: trackId,
            slotIndex: slotIndex,
            startMarker: start,
            endMarker: end,
            isWarped: warping !== undefined ? warping : true,
            isLooping: looping || false,
            loopEnd: loopEnd || end,
            tempo: currentTempo,
            clipLength: clipLength  // ワープ時のtotalBeats計算に使用
        });
    }
}

let connectedClients = 0;

io.on('connection', (socket) => {
    connectedClients++;
    console.log(`[Web] Browser connected. Total: ${connectedClients}`);
    
    // 現在のAbleton接続状態を接続直後のクライアントに個別通知
    socket.emit('ableton_status', { connected: abletonConnected });
    
    // ブラウザ接続直後に、サーバーが保持している現在の再生状態を即座に同期する
    // (OSCの冗長更新を弾くようにしたため、新規接続クライアントにはキャッシュを送信する必要がある)
    if (serverIsPlaying) {
        socket.emit('song_playing');
    } else {
        socket.emit('song_stopped');
    }
    
    if (selectedSceneIndex >= 0) {
        socket.emit('selected_scene_changed', { sceneIndex: selectedSceneIndex });
    }
    
    for (const trackId in activeClips) {
        const slotIndex = activeClips[trackId];
        const filePath = clipLengths[`${trackId}_${slotIndex}_file_path`];
        if (filePath && filePath !== "NO_AUDIO") {
            socket.emit('clip_playing', {
                trackId: parseInt(trackId),
                slotIndex: slotIndex,
                filePath: filePath
            });
            emitMarkersIfReady(parseInt(trackId), slotIndex, socket);
        }
    }
    
    // ブラウザ接続時に現在のトラック数を取得し直す
    oscClient.send('/live/song/get/num_tracks');

    socket.on('force_sync', () => {
        console.log('[Web] force_sync requested. Clearing cache and re-querying state.');
        numTracks = 0;
        for (const key in playingSlots) delete playingSlots[key];
        for (const key in activeClips) delete activeClips[key];
        clipLengths = {};
        
        // 再取得シーケンスの開始
        oscClient.send('/live/song/get/num_tracks');
        oscClient.send('/live/song/get/is_playing');
    });

    socket.on('disconnect', () => {
        connectedClients--;
        console.log(`[Web] Browser disconnected. Total: ${connectedClients}`);
    });
});

function startServer(port, host, retries) {
    server.listen(port, host, () => {
        console.log(`[Server] Web server running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
        console.log(`[Server] Waiting for browser to connect...`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
            console.log(`[Server] Port ${port} in use. Retrying in 500ms... (${retries} retries left)`);
            setTimeout(() => startServer(port, retries - 1), 500);
        } else {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n[Error] ポート ${port} はすでに使用されています。`);
                console.error(`リトライ上限（10回）を超えたため起動を停止します。古いプロセス（ゾンビプロセス）が残っていないか確認してください。\n`);
            } else {
                console.error('Failed to start server:', err);
            }
            fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Server listen error: ${err.stack}\n`);
            
            // 多重起動時のフェイルセーフ: ポートが使用中の場合、親プロセス(Neutralino)も強制終了させる
            if (process.ppid) {
                try {
                    process.kill(process.ppid, 'SIGKILL');
                } catch (e) {
                    console.error('Failed to kill parent process:', e);
                }
            }
            process.exit(1);
        }
    });
}

startServer(WEB_PORT, HTTP_HOST, 10); // 最大5秒間（500ms x 10回）リトライする
