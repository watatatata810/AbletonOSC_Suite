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
