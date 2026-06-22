const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// デフォルト設定値
const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  listenPort: 11001,
  targetPorts: [11002, 11003]
};

let config = { ...DEFAULT_CONFIG };

const configPath = path.join(__dirname, 'config.json');
try {
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawData);
    config = {
      host: parsed.host || DEFAULT_CONFIG.host,
      listenPort: parsed.listenPort !== undefined ? Number(parsed.listenPort) : DEFAULT_CONFIG.listenPort,
      targetPorts: Array.isArray(parsed.targetPorts) ? parsed.targetPorts.map(Number) : DEFAULT_CONFIG.targetPorts
    };
  } else {
    console.log(`[OSC Router] 設定ファイル (config.json) が見つかりません。デフォルト値を使用します。`);
  }
} catch (err) {
  console.warn(`[OSC Router Warning] 設定ファイルの読み込みまたはパースに失敗しました。デフォルト値を使用します。:`, err.message);
}

const LISTEN_PORT = config.listenPort;
const HOST = config.host;

// 転送先（デフォルト: 波形ビューアーアプリ: 11002, 台本トリガーアプリ: 11003）
const TARGET_PORTS = config.targetPorts;

const server = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');

server.on('error', (err) => {
  console.log(`[Router Error] ${err.stack}`);
  server.close();
});

server.on('message', (msg, rinfo) => {
  // 受信したパケットを各ターゲットポートに複製して送信
  TARGET_PORTS.forEach(targetPort => {
    client.send(msg, targetPort, HOST, (err) => {
      if (err) {
        console.error(`[Router Forward Error -> ${targetPort}]`, err);
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
process.on('SIGINT', () => {
    server.close();
    client.close();
    process.exit();
});
