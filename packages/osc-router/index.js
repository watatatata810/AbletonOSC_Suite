const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'router.log');
// ローテーション先も *.log にする（.gitignore の `*.log` に確実に一致させるため）
const PREV_LOG_FILE = path.join(__dirname, 'router.prev.log');
const LOG_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

// --- ログ出力 ---
// 以前は appendFileSync（ブロッキング）をパケットごとに最大4回（受信1回+転送3回）
// 実行していた。応答フラッシュのバースト時（実測129パケット/秒）には毎秒数百回の
// 同期syscallがイベントループを塞ぎ、UDP受信バッファ溢れ＝転送取りこぼしの
// 原因になるため、WriteStream（非同期）+ サイズ上限に変更した。
let logStream = null;
let logBytesWritten = 0;

function openLogStream() {
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    logStream.on('error', (err) => {
      console.error('[Router] ログファイルへの書き込みに失敗しました。ファイル出力を停止します:', err.message);
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
    fs.renameSync(LOG_FILE, PREV_LOG_FILE);
  } catch (e) {
    // 退避に失敗した場合も、新しいストリームを開き直せば書き込みは継続できる
  }
  openLogStream();
}

function logToFile(msg) {
  if (!logStream) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logBytesWritten += Buffer.byteLength(line);
  logStream.write(line);
  rotateLogIfNeeded();
}

openLogStream();
logToFile(`=== OSC Router Debug Log Started ===`);

/**
 * 終了理由を記録してからプロセスを終了する。
 * ログは WriteStream（非同期）のため、書き込み完了を待たずに exit すると
 * 最後の行が失われる。ストリームが詰まった場合に備えて待ち時間には上限を設ける。
 */
let shuttingDown = false;

function shutdownWithLog(msg, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(msg);
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

// OSCメッセージのBufferから簡易的にアドレスを抽出する
function getOscAddress(msgBuffer) {
  if (msgBuffer.length === 0 || msgBuffer[0] !== 0x2f) return 'Unknown'; // 0x2f is '/'
  let end = 0;
  while (end < msgBuffer.length && msgBuffer[end] !== 0x00) {
    end++;
  }
  return msgBuffer.toString('utf8', 0, end);
}

// デフォルト設定値
const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  listenPort: 11001,
  targetPorts: [11002, 11003]
};

let config = { ...DEFAULT_CONFIG };

const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
const configPath = path.join(__dirname, '..', '..', 'config.json');
const parsed = loadConfig(configPath);
const routerConfig = getPackageConfig(parsed, 'osc-router');

// 転送成功ログ（受信ログの3倍量になる）は debug 有効時のみ出す
const DEBUG_ENABLED = parsed.global?.debug === true;

// 各アプリケーションの OSC ポート設定を動的に収集
const targetPorts = [];
if (parsed.packages && Array.isArray(parsed.packages)) {
  parsed.packages.forEach(pkg => {
    if (pkg.name !== 'osc-router' && pkg.oscPort) {
      targetPorts.push(Number(pkg.oscPort));
    }
  });
}

config = {
  host: routerConfig.host || DEFAULT_CONFIG.host,
  listenPort: routerConfig.listenPort !== undefined ? Number(routerConfig.listenPort) : DEFAULT_CONFIG.listenPort,
  targetPorts: targetPorts.length > 0 ? targetPorts : DEFAULT_CONFIG.targetPorts
};

const LISTEN_PORT = config.listenPort;
const HOST = config.host;

// 転送先
const TARGET_PORTS = config.targetPorts;

// 一時的なUDPエラー。転送先アプリが起動していない場合、Windows は ICMP Port Unreachable を
// ECONNRESET としてソケットに報告してくるため、これで落ちてはいけない
// （router が死ぬと自動復旧はなく、各アプリは応答を二度と受け取れなくなる）。
const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];

const client = dgram.createSocket('udp4');

client.on('error', (err) => {
  if (err.code && IGNORE_ERRORS.includes(err.code)) {
    console.warn(`[Router Client Warning] Ignored temporary UDP error: ${err.message}`);
    return;
  }
  console.error(`[Router Client Error] ${err.stack}`);
  logToFile(`[Client Error] ${err.message}`);
});

function onMessage(msg, rinfo) {
  const address = getOscAddress(msg);
  const isPosition = address.includes('playing_position');

  if (!isPosition) {
    logToFile(`[Received] From: ${rinfo.address}:${rinfo.port} | Address: ${address}`);
  }

  // 受信したパケットを各ターゲットポートに複製して送信
  TARGET_PORTS.forEach(targetPort => {
    client.send(msg, targetPort, HOST, (err) => {
      if (err) {
        console.error(`[Router Forward Error -> ${targetPort}]`, err);
        logToFile(`[Forward Error -> ${targetPort}] ${err.message}`);
      } else if (DEBUG_ENABLED && !isPosition) {
        logToFile(`[Forwarded] To: ${HOST}:${targetPort} | Address: ${address}`);
      }
    });
  });
}

// 受信ソケット。bind に失敗した場合はリトライし、上限に達したら明示的に終了する。
// 一時的なUDPエラーでは終了しない（以前はあらゆるエラーで exit(1) しており、
// 転送経路が黙って消えると全アプリが「波形が出ない」状態のまま復旧しなかった）。
let server = null;

function startRouter(retries) {
  server = dgram.createSocket('udp4');

  server.on('message', onMessage);

  server.on('listening', () => {
    const address = server.address();
    console.log(`\n==============================================`);
    console.log(` [OSC Router] 起動完了`);
    console.log(`==============================================`);
    console.log(` 受信ポート: ${address.port} (AbletonOSCから)`);
    console.log(` 転送ポート: ${TARGET_PORTS.join(', ')} へ複製転送中`);
    console.log(`==============================================\n`);
    logToFile(`[Startup] Listening on ${address.port}, forwarding to ${TARGET_PORTS.join(', ')}`);
  });

  server.on('error', (err) => {
    if (err.code && IGNORE_ERRORS.includes(err.code)) {
      console.warn(`[Router Server Warning] Ignored temporary UDP error: ${err.message}`);
      return;
    }

    // Windows は UDP ポートの競合を EADDRINUSE ではなく EACCES で報告する
    const isBindConflict = err.code === 'EADDRINUSE'
      || (err.code === 'EACCES' && err.syscall === 'bind');

    if (isBindConflict && retries > 0) {
      console.log(`[Router] Port ${LISTEN_PORT} in use (${err.code}). Retrying in 500ms... (${retries} retries left)`);
      try { server.close(); } catch (e) {}
      setTimeout(() => startRouter(retries - 1), 500);
      return;
    }

    console.error(`[Router Error] ${err.stack}`);
    try { server.close(); } catch (e) {}
    try { client.close(); } catch (e) {}
    shutdownWithLog(`[Fatal] ${err.code || 'Error'}: ${err.message}`, 1);
  });

  server.bind(LISTEN_PORT, HOST);
}

startRouter(10); // 最大5秒間（500ms x 10回）リトライする

// 終了時のクリーンアップ
const cleanup = () => {
  console.log('\n[OSC Router] クリーンアップ処理を実行中...');
  try {
    if (server) server.close();
  } catch (e) {}
  try {
    client.close();
  } catch (e) {}
  shutdownWithLog('[OSC Router] 終了しました。', 0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
