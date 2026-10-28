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

// 高頻度の診断ログ（RTT計測・パケット頻度など）を出すかどうか。
// ホットパスの分岐で参照するため、他の定義より先に確定させる。
const DEBUG_ENABLED = config.global?.debug === true;

// 現在再生中のクリップを管理（TrackID -> SlotIndex）
const activeClips = {};
let abletonConnected = false;
let lastAbletonMessageTime = 0;

// --- 起動経路の判定 ---
// Neutralino は拡張プロセスの起動時、接続情報（nlPort / nlToken / nlConnectToken /
// nlExtensionId）を JSON で stdin に流し込む。これを受け取れたかどうかで
// 「Neutralino 配下で動いているか」を判定する（起動時のみ使用）。
//
// 【重要】stdin の終了を「親プロセスが死んだ」合図に使ってはいけない。
// Neutralino はこの JSON を書き込んだ直後に stdin を閉じるため、
// 'end' / 'close' で終了するとサーバーが起動直後に自死し、
// Neutralino 側は待機画面のスピナーが回り続ける。
// 親の終了検知は、公式仕様どおり WebSocket IPC の切断で行う（connectNeutralinoIPC）。
let isNeutralinoExtension = false;

process.stdin.on('data', (chunk) => {
    try {
        const payload = JSON.parse(chunk.toString());
        if (payload && payload.nlExtensionId) {
            isNeutralinoExtension = true;
            console.log(`[Server] Running as a Neutralino extension (${payload.nlExtensionId}).`);
            connectNeutralinoIPC(payload);
        }
    } catch (e) {
        // 接続情報以外は使わないため、パースできない入力は無視してよい
    }
});
process.stdin.resume(); // resume() しないと 'data' が流れてこない

// --- 親プロセス（Neutralino）の死活監視 ---
// Neutralino は終了時に拡張プロセスへ kill シグナルを送らないため、拡張側が
// IPC の切断を検知して自分で終了しないとゾンビプロセスが残り、
// 次回起動時に EADDRINUSE を起こす。
//
// 【重要】「接続に失敗した」場合に終了してはいけない。
// close は接続成功前にも発火するため、無条件に exit するとサーバーが起動直後に
// 自死する（stdin を使っていた時に実際に起きた事象と同じ）。
// そのため open を一度でも通った場合に限って終了する。
const IPC_MAX_ATTEMPTS = 3;
const IPC_RETRY_INTERVAL = 1000;

function connectNeutralinoIPC(payload, attempt = 1) {
    if (!payload.nlPort) return;

    const url = `ws://localhost:${payload.nlPort}?extensionId=${encodeURIComponent(payload.nlExtensionId)}`
        + `&connectToken=${encodeURIComponent(payload.nlConnectToken || '')}`;

    let opened = false;

    let socket;
    try {
        socket = new WebSocket(url);
    } catch (e) {
        console.warn('[Server] Neutralino IPC への接続を開始できませんでした:', e.message);
        return;
    }

    socket.onopen = () => {
        opened = true;
        debugLog('[Server] Neutralino IPC に接続しました。親プロセスの終了を監視します。');
    };

    socket.onclose = () => {
        if (opened) {
            shutdownWithLog('[Server] Neutralino IPC が切断されました。親が終了したためサーバーも終了します。');
            return;
        }

        // 接続確立前の close は「つながらなかった」だけ。ここで終了してはいけない
        if (attempt < IPC_MAX_ATTEMPTS) {
            setTimeout(() => connectNeutralinoIPC(payload, attempt + 1), IPC_RETRY_INTERVAL);
        } else {
            console.warn(
                `[Server] Neutralino IPC へ接続できませんでした（${IPC_MAX_ATTEMPTS}回試行）。`
                + '親プロセスの終了監視は無効のまま動作を継続します。'
            );
        }
    };

    // onclose も併せて発火するため、ここでは記録のみ行う
    socket.onerror = () => {};
}

process.on('SIGINT', () => shutdownWithLog('[Server] SIGINT を受信したため終了します。'));
process.on('SIGTERM', () => shutdownWithLog('[Server] SIGTERM を受信したため終了します。'));

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

// stdout/stderr の EPIPE も捕捉して正常終了する。
// 親が落ちた時は IPC切断とこちらがほぼ同時に発火するが、
// どちらが先でも shutdownWithLog 側で一本化される。
// 即 exit せずログを残すのは、どちらの経路で終了したかを事後に判別するため。
process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') {
        stdoutBroken = true;
        shutdownWithLog('[Server] 標準出力のパイプが閉じられたため終了します（親プロセス終了）。');
    }
});
process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE') {
        stdoutBroken = true;
        shutdownWithLog('[Server] 標準エラー出力のパイプが閉じられたため終了します（親プロセス終了）。');
    }
});

const WEB_PORT = pkgConfig.httpPort ?? (process.env.PORT || 3000);
// 待ち受けアドレス。既定は同一マシンのみ（127.0.0.1）。
// 0.0.0.0 にするとLAN内の任意の端末から、再生中クリップの一覧や音声ファイルへ
// アクセスできてしまうため、必要な場合だけ明示的に開く運用にする。
// パッケージ個別の設定を優先し、global は他パッケージと共有のため後段で見る。
const HTTP_HOST = pkgConfig.httpHost ?? config.global?.httpHost ?? '127.0.0.1';

/**
 * ローカル（同一マシン）から来たリクエストかどうかを Origin ヘッダで判定する。
 * Neutralino の待機画面は自身のローカルサーバー（ポートは起動ごとに変わる）から
 * fetch してくるため、ポートは限定できない。ホスト名だけで判定する。
 */
function isLocalOrigin(origin) {
    if (!origin) return false;
    try {
        const hostname = new URL(origin).hostname;
        return hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]';
    } catch (e) {
        return false;
    }
}

// CORS設定：Neutralinojsの待機画面からのアクセスを許可するため、一番最初に定義する。
// 以前は Access-Control-Allow-Origin: * だったため、ユーザーがブラウザで開いた
// 任意のWebサイトから再生中クリップの一覧や音声ファイルを読み取れる状態だった。
// 用途上必要なのはローカルオリジンだけなので、そこに限定する。
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isLocalOrigin(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin'); // オリジンごとに応答が変わるためキャッシュを分離する
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    }
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

// デバッグ用：サーバーが保持しているクリップ情報をJSON返却する。
// 音源の絶対パスを含むため、config.global.debug が真のときだけ有効にする。
// （存在自体を知らせないよう、無効時は 403 ではなく 404 を返す）
app.get('/debug/clip', (req, res) => {
    if (!DEBUG_ENABLED) {
        return res.status(404).send('Not Found');
    }
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

// 送信したOSCリクエストのタイムスタンプ記録用（RTT計測専用）
const pendingRequests = new Map();

// oscClient.send をラップして送信時刻を記録する。
// RTT計測は debug 有効時のみ行うため、記録側も同じ条件でゲートする
// （受信側だけ止めると、記録したエントリが二度と削除されず Map に溜まり続ける）。
const originalSend = oscClient.send.bind(oscClient);
oscClient.send = function(address, ...args) {
    if (DEBUG_ENABLED && (address.includes('/get/') || address.includes('/start_listen/'))) {
        const key = `${address}_${args.join('_')}`;
        pendingRequests.set(key, Date.now());
    }
    originalSend(address, ...args);
};

// エラーハンドラを追加してプロセス終了を防ぐ
oscClient.on('error', (err) => {
    const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
    if (err.code && IGNORE_ERRORS.includes(err.code)) {
        console.warn(`[OSC Client Warning] Ignored temporary UDP error: ${err.message}`);
    } else {
        console.error('[OSC Client Error]', err);
    }
});

// OSC受信サーバー。bind に失敗した場合はリトライし、上限に達したら明示的に終了する。
// 以前は console.error のみで動き続けたため、ゾンビプロセスが 11002 を握っていると
// 「HTTPは生きているのに波形が一切出ない」状態になり、原因に気づけなかった。
let oscServer = null;

function startOscServer(retries) {
    oscServer = new OscServer(serverPort, clientHost, () => {
        console.log(`[OSC] Listening for AbletonOSC messages on port ${serverPort}`);
    });

    oscServer.on('message', handleAbletonOscMessage);

    oscServer.on('error', (err) => {
        const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
        if (err.code && IGNORE_ERRORS.includes(err.code)) {
            console.warn(`[OSC Server Warning] Ignored temporary UDP error: ${err.message}`);
            return;
        }

        // Windows は UDP ポートの競合を EADDRINUSE ではなく EACCES で報告する
        // （TCP は EADDRINUSE のまま）。どちらも「ポートを取れなかった」として扱う。
        const isBindConflict = err.code === 'EADDRINUSE'
            || (err.code === 'EACCES' && err.syscall === 'bind');

        if (isBindConflict) {
            try { oscServer.close(); } catch (e) {}
            if (retries > 0) {
                console.log(`[OSC] Port ${serverPort} in use (${err.code}). Retrying in 500ms... (${retries} retries left)`);
                setTimeout(() => startOscServer(retries - 1), 500);
                return;
            }
            // HTTP側の EADDRINUSE と同じ扱いで明示的に落とす
            console.error(`\n[Error] OSC受信ポート ${serverPort} はすでに使用されています。`);
            console.error(`リトライ上限（10回）を超えたため起動を停止します。古いプロセス（ゾンビプロセス）が残っていないか確認してください。\n`);
            try {
                fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] OSC server bind error: ${err.stack}\n`);
            } catch (e) {}
            if (isNeutralinoExtension && process.ppid) {
                try {
                    process.kill(process.ppid, 'SIGKILL');
                } catch (e) {
                    console.error('Failed to kill parent process:', e);
                }
            }
            process.exit(1);
            return;
        }

        console.error('[OSC Server Error]', err);
    });
}

startOscServer(10); // 最大5秒間（500ms x 10回）リトライする

let numTracks = 0;
const playingSlots = {}; // key: trackId, value: slotIndex
// file_path の返信で最後に送った clip_playing (key: trackId, value: "slotIndex|filePath")。
// AbletonOSC の返信は osc-router が全パッケージに配るため、他のパッケージ (LtcSender 等) が
// 同じクリップの file_path を問い合わせるたびに clip_playing を送り直すと、画面の波形が
// 毎回アニメーションしてしまう。同じ再生中のクリップへの 2 回目以降は送らない
const lastPlayingEmit = {};
let clipLengths = {}; // { "trackId_slotIndex": length, "trackId_slotIndex_start": startMarker, ... }
let currentTempo = 120.0;
// シーン名のキャッシュ（key: sceneIndex, value: name）。
// 以前はシーンが「再生を開始した」ときにしか名前を取得していなかったため、
// スタンバイ中のシーンは名前が付いていても "Scene N" と表示されていた。
// 起動時に一括取得して全シーンぶん保持する。
let sceneNames = {};
// トラック名も同様に保持する（接続直後のクライアントに一括で渡し、
// メニューのトラック表示リストとトラックタイトルを名前ありで初期化する）
let trackNames = {};
let serverIsPlaying = false;
let selectedSceneIndex = -1;
let selectedSceneTimer = null;

// --- ログ出力 ---
// 以前は appendFileSync（ブロッキング）を全ログで実行しており、毎秒30〜60発の
// OSCパケットを捌くイベントループ上で同期syscallが平均3.5回/秒走っていた。
// また出力量に上限が無く、6時間の稼働で5.5MBまで肥大していた。
//
// 対策:
//   - 書き込みを WriteStream（非同期）に変更する
//   - 高頻度の診断ログ（RTT・パケット頻度など）は traceLog に分け、
//     config.global.debug が真のときだけ出す
//   - ファイルサイズに上限を設け、超えたら1世代だけ退避して切り替える
const logFilePath = path.join(__dirname, 'server.log');
// ローテーション先も *.log にする（.gitignore の `*.log` に確実に一致させるため）
const prevLogFilePath = path.join(__dirname, 'server.prev.log');
const LOG_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

let logStream = null;
let logBytesWritten = 0;

function openLogStream() {
    try {
        logStream = fs.createWriteStream(logFilePath, { flags: 'w' });
        // 書き込みに失敗してもアプリ本体は動かし続ける（ログのために落とさない）
        logStream.on('error', (err) => {
            console.error('[Log] ログファイルへの書き込みに失敗しました。ファイル出力を停止します:', err.message);
            logStream = null;
        });
        logBytesWritten = 0;
    } catch (e) {
        logStream = null;
    }
}

function rotateLogIfNeeded() {
    if (logBytesWritten < LOG_SIZE_LIMIT) return;
    try {
        const finished = logStream;
        logStream = null;
        if (finished) finished.end();
        fs.renameSync(logFilePath, prevLogFilePath);
    } catch (e) {
        // 退避に失敗した場合も、新しいストリームを開き直せば書き込みは継続できる
    }
    openLogStream();
}

function writeLogLine(msg) {
    if (!logStream) return;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logBytesWritten += Buffer.byteLength(line);
    logStream.write(line);
    rotateLogIfNeeded();
}

openLogStream();
writeLogLine(`Server Debug Log Started (debug=${DEBUG_ENABLED})`);

/**
 * 常時記録するログ。接続確立・タイムアウト・初期化など、
 * 事後に不具合を追うために必要な低頻度のイベントに限って使う。
 */
function debugLog(msg) {
    console.log(msg);
    writeLogLine(msg);
}

/**
 * 高頻度の診断ログ。config.global.debug が真のときだけ出力する。
 * OSCのホットパスから呼ばれるため、無効時は文字列生成以外の負荷をかけない。
 */
function traceLog(msg) {
    if (!DEBUG_ENABLED) return;
    console.log(msg);
    writeLogLine(msg);
}

/**
 * 終了理由を記録してからプロセスを終了する。
 *
 * ログは WriteStream（非同期）で書いているため、debugLog した直後に
 * process.exit() すると最後の行がバッファに残ったまま失われる。
 * 終了理由は事後調査で最も重要なので、書き込み完了を待ってから終了する。
 * ストリームが詰まった場合に備えて待ち時間には上限を設ける。
 */
let shuttingDown = false;
let stdoutBroken = false;

function shutdownWithLog(msg, code = 0) {
    // 親プロセス終了時は IPC切断・stdoutのEPIPE がほぼ同時に起きるため、
    // 先に到達した方だけを処理する（二重終了とストリームの二重closeを防ぐ）
    if (shuttingDown) return;
    shuttingDown = true;

    // stdout が壊れている状態で書くと EPIPE が再発するだけなので書かない
    if (!stdoutBroken) console.log(msg);

    const line = `[${new Date().toISOString()}] ${msg}\n`;

    const stream = logStream;
    logStream = null;

    if (!stream) {
        process.exit(code);
        return;
    }

    let exited = false;
    const done = () => {
        if (exited) return;
        exited = true;
        process.exit(code);
    };

    setTimeout(done, 300).unref();
    stream.end(line, done);
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
// config.json では packages[] 配下に定義されているため、pkgConfig から読む
// （config.viewWaves という階層は存在せず、設定値が常に無視されていた）
const POLL_INTERVAL = pkgConfig.pollInterval ?? 500;
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
            for (const key in lastPlayingEmit) delete lastPlayingEmit[key];
            clipLengths = {};
            // 別プロジェクトが開かれた可能性があるため、シーン名・トラック名も捨てる
            // （古い名前を出し続けるより "Scene N" のほうが誤解が無い）
            sceneNames = {};
            trackNames = {};
            
            // 完全タイムアウト：画面をクリアさせる（reset: true）
            io.emit('ableton_status', { connected: false, reset: true });
            debugLog('Ableton Liveとの通信が20秒以上途絶えたため、状態キャッシュを完全クリアします。');
        }
    }
    
    // 起動時の初期化パケット（num_tracks）がロスした場合のリトライ処理。
    // 加えて、無操作の Ableton はリスナー登録済みでもパケットを一切送ってこないため
    // （リスナーは値の変化時のみ発火する。router.log 実測で4分間無通信を確認）、
    // 受信が2秒以上途絶えたら同じ num_tracks を keepalive として送り、
    // 無通信をタイムアウトと誤認して画面を周期的にクリアしないようにする。
    // 再生中は playing_position（毎秒60発）が生存信号になるためこの送信は発生せず、
    // ビジーな Ableton への追加負荷はない（B-4 を悪化させない）。
    if (numTracks === 0 || elapsed > 2000) {
        const now = Date.now();
        // 前回の送信から2.0秒以上経過している場合のみ送信（再送スパム防止）
        if (now - lastNumTracksRequestTime > 2000) {
            lastNumTracksRequestTime = now;
            debugRequestStartTime = now;
            traceLog(`Sending /live/song/get/num_tracks`);
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

// AbletonOSCからのメッセージ受信（oscServer 生成時に 'message' ハンドラとして登録される）
function handleAbletonOscMessage(msg) {
    // タイムスタンプを更新
    lastAbletonMessageTime = Date.now();
    if (!abletonConnected) {
        abletonConnected = true;
        io.emit('ableton_status', { connected: true });
        debugLog('Ableton Liveとの通信を確立しました。');
        
        // ここでリスナーの再登録（setupAbletonListeners）は行わない。
        //
        // 実測（2026-07-29）: osc-router を9秒停止して復帰させる試験を2回行い、
        // 再登録なしでも復帰直後から playing_position が 10Hz で再開することを確認した。
        // AbletonOSC 側のリスナー登録は Python 側のメモリに残るため、
        // 経路が復旧すればそのまま流れてくる（設計書 260627-1548 §2 の想定どおり）。
        //
        // むしろ再生中の Ableton は毎秒60発の playing_position を送出していて
        // ビジーなため、ここで start_listen を 2×トラック数+6 発まとめて撃つと
        // 取りこぼしを増やす方向に働く（設計書 §1 が解消しようとした事象そのもの）。

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
    // 全 /get/ 応答で走るホットパスなので、計測ごとブロック単位で無効化する
    // （文字列生成・Map操作も含めて debug 無効時はコストをかけない）
    if (DEBUG_ENABLED && address.includes('/get/')) {
        const reqArgs = args.slice(0, -1);
        const key = `${address}_${reqArgs.join('_')}`;
        const sendTime = pendingRequests.get(key);
        if (sendTime) {
            const rtt = Date.now() - sendTime;
            traceLog(`[OSC-RTT] ${address} (${reqArgs.join(', ')}): ${rtt} ms`);
            pendingRequests.delete(key);
        }
    }

    if (address === '/live/song/get/num_tracks') {
        const val = args[0];
        
        // すでにトラック数が確定している場合、同数ならリスナー登録を送らない（バーストガード）。
        // 数が変わった場合はセッション中のトラック追加・削除なので差分だけ追従する
        // （追加トラックはリスナー未登録のままだと、何を再生しても永久に表示されない）。
        if (numTracks > 0) {
            if (val !== numTracks) {
                const prev = numTracks;
                numTracks = val;
                debugLog(`Track count changed: ${prev} -> ${val}`);
                if (val > prev) {
                    registerTrackListeners(prev, val).catch(e =>
                        console.error('Failed to register listeners for added tracks:', e));
                } else {
                    // 消えたトラックの状態を破棄する（存在しないトラックへのポーリング防止）
                    for (const key in playingSlots) {
                        if (parseInt(key, 10) >= val) delete playingSlots[key];
                    }
                    for (const key in activeClips) {
                        if (parseInt(key, 10) >= val) {
                            delete activeClips[key];
                            io.emit('clip_stopped', { trackId: parseInt(key, 10) });
                        }
                    }
                }
            } else {
                traceLog(`Received redundant /live/song/num_tracks: ${val} (Skipped listener setup)`);
            }
            return;
        }
        
        numTracks = val;
        debugLog(`Received /live/song/num_tracks: ${numTracks}`);
        setupAbletonListeners();
    }
    else if (address === '/live/track/get/name') {
        const trackId = args[0];
        const name = args[1];
        trackNames[trackId] = name;
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
        // 再生するスロットが変わったので、次の file_path の返信では必ず clip_playing を送る
        // (前に鳴らしたシーンに戻った時も、波形を切り替えるため)
        delete lastPlayingEmit[trackId];

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
        sceneNames[sceneIndex] = name;
        io.emit('scene_name', { sceneIndex, name });
    }
    else if (address === '/live/song/get/scenes/name') {
        // 全シーン名が index 0 から順に並んで返る（AbletonOSC の一括取得API）
        const names = {};
        args.forEach((name, index) => {
            names[index] = name;
            sceneNames[index] = name;
        });
        debugLog(`Received ${args.length} scene names.`);
        io.emit('scene_names', names);
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
        // 再生中のクリップとして登録する。
        // 停止直後は、遅延・並べ替えで届いた古い position パケットがクリア済みの
        // activeClips を復活させ、停止中なのに clip_playing が再同期されてしまうため、
        // サーバーが再生中と認識している間だけ登録する。
        if (serverIsPlaying) {
            activeClips[trackId] = slotIndex;
        }
        
        // 頻度デバッグ
        debugPlayingPositionCount++;
        const now = Date.now();
        if (now - debugLastLogTime >= 1000) {
            traceLog(`Receiving /playing_position at ${debugPlayingPositionCount} pkts/sec`);
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
            // 現在再生中のクリップの場合 (同じクリップ・同じファイルを送り済みなら送らない)
            const emitKey = `${slotIndex}|${filePath}`;
            if (lastPlayingEmit[trackId] !== emitKey) {
                lastPlayingEmit[trackId] = emitKey;
                io.emit('clip_playing', {
                    trackId: trackId,
                    slotIndex: slotIndex,
                    filePath: filePath
                });
            }
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
}

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
        
        // 全シーン名を一括取得する（引数なしで index 0 から全件が返る）。
        // スタンバイ中のシーンにも付けた名前を表示するために必要。
        oscClient.send('/live/song/get/scenes/name');
        await sleep(20);

        // 選択中シーンの監視と初期値取得
        oscClient.send('/live/view/start_listen/selected_scene');
        oscClient.send('/live/view/get/selected_scene');
        await sleep(20);
        
        // 全トラックの再生状態を監視開始
        await registerTrackListeners(0, numTracks);
        debugLog(`Finished setting up listeners for ${numTracks} tracks.`);
    } catch (e) {
        console.error('Failed to setup Ableton listeners:', e);
    }
}

/**
 * [fromTrack, toTrack) のトラックにリスナー登録と初期値取得を行う。
 * 起動時の一括登録と、セッション中にトラックが追加された場合の差分登録から使う。
 */
async function registerTrackListeners(fromTrack, toTrack) {
    for (let i = fromTrack; i < toTrack; i++) {
        oscClient.send('/live/track/start_listen/playing_slot_index', i);
        oscClient.send('/live/track/get/playing_slot_index', i);
        await sleep(20);

        // トラック名の監視も開始
        oscClient.send('/live/track/start_listen/name', i);
        oscClient.send('/live/track/get/name', i);
        await sleep(20);
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

    // 取得済みのシーン名をまとめて渡す（再取得を待たせない）
    if (Object.keys(sceneNames).length > 0) {
        socket.emit('scene_names', sceneNames);
    }

    // 取得済みのトラック名も渡す（リロード後もメニューのトラック一覧と
    // トラックタイトルを名前ありで初期化できるようにする）
    for (const trackId in trackNames) {
        socket.emit('track_name', { trackId: parseInt(trackId, 10), name: trackNames[trackId] });
    }
    
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
        for (const key in lastPlayingEmit) delete lastPlayingEmit[key];
        clipLengths = {};
        sceneNames = {};
        trackNames = {};
        
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
    // リトライは同一の server インスタンスに対して行うため、リスナーは必ず once() で
    // 登録し、決着がついた時点で相方を外す。
    // （listen(cb) や on() のまま再試行すると、試行回数ぶんリスナーが積み増しされ
    //   MaxListenersExceededWarning を出したうえでハンドラが多重発火する）
    const onListening = () => {
        server.removeListener('error', onError);
        console.log(`[Server] Web server running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
        console.log(`[Server] Waiting for browser to connect...`);
    };

    const onError = (err) => {
        server.removeListener('listening', onListening);

        if (err.code === 'EADDRINUSE' && retries > 0) {
            console.log(`[Server] Port ${port} in use. Retrying in 500ms... (${retries} retries left)`);
            setTimeout(() => startServer(port, host, retries - 1), 500);
        } else {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n[Error] ポート ${port} はすでに使用されています。`);
                console.error(`リトライ上限（10回）を超えたため起動を停止します。古いプロセス（ゾンビプロセス）が残っていないか確認してください。\n`);
            } else {
                console.error('Failed to start server:', err);
            }
            fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Server listen error: ${err.stack}\n`);
            
            // 多重起動時のフェイルセーフ: Neutralino の待機画面はサーバー応答を無限に
            // ポーリングし続けるため、起動できないまま放置するとスピナーが回り続ける。
            // そのため親（Neutralino本体）ごと終了させる。
            // ただし npm start 等で直接起動された場合、親はユーザーのシェルや npm であり、
            // それを SIGKILL するのは明確に有害なので、拡張として起動された時に限定する。
            if (isNeutralinoExtension && process.ppid) {
                try {
                    process.kill(process.ppid, 'SIGKILL');
                } catch (e) {
                    console.error('Failed to kill parent process:', e);
                }
            }
            process.exit(1);
        }
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, host);
}

startServer(WEB_PORT, HTTP_HOST, 10); // 最大5秒間（500ms x 10回）リトライする
