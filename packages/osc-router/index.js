const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'router.log');

// ログファイルを新規作成（上書き）して初期化
try {
  const timestamp = new Date().toISOString();
  fs.writeFileSync(LOG_FILE, `=== OSC Router Debug Log Started at ${timestamp} ===\n`);
} catch (e) {
  console.error('[Router] Failed to initialize log file', e);
}

function logToFile(msg) {
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
  } catch (e) {
    console.error('[Router] Failed to write to log file', e);
  }
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

const server = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');

client.on('error', (err) => {
  console.error(`[Router Client Error] ${err.stack}`);
});

server.on('error', (err) => {
  console.error(`[Router Error] ${err.stack}`);
  try {
    server.close();
  } catch (e) {}
  try {
    client.close();
  } catch (e) {}
  process.exit(1);
});

server.on('message', (msg, rinfo) => {
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
      } else if (!isPosition) {
        logToFile(`[Forwarded] To: ${HOST}:${targetPort} | Address: ${address}`);
      }
    });
  });
});

server.on('listening', () => {
  const address = server.address();
  console.log(`\n==============================================`);
  console.log(` [OSC Router] 起動完了`);
  console.log(`==============================================`);
  console.log(` 受信ポート: ${address.port} (AbletonOSCから)`);
  console.log(` 転送ポート: ${TARGET_PORTS.join(', ')} へ複製転送中`);
  console.log(`==============================================\n`);
  console.log(`※注意: 波形ビューアー側の受信ポートを 11002 に変更してください。\n`);
});

server.bind(LISTEN_PORT, HOST);

// 終了時のクリーンアップ
const cleanup = () => {
  console.log('\n[OSC Router] クリーンアップ処理を実行中...');
  try {
    server.close();
  } catch (e) {}
  try {
    client.close();
  } catch (e) {}
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
