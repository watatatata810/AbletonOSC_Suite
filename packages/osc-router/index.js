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

const { loadConfig } = require('../shared-utils/configLoader');
const configPath = path.join(__dirname, '..', '..', 'config.json');
const parsed = loadConfig(configPath);

// 各アプリケーションの OSC ポート設定を動的に収集
const targetPorts = [];
if (parsed.viewWaves?.oscPort) targetPorts.push(Number(parsed.viewWaves.oscPort));
if (parsed.daihonTrigger?.oscPort) targetPorts.push(Number(parsed.daihonTrigger.oscPort));
if (parsed.oscTester?.oscPort) targetPorts.push(Number(parsed.oscTester.oscPort));

config = {
  host: parsed.oscRouter?.host || DEFAULT_CONFIG.host,
  listenPort: parsed.oscRouter?.listenPort !== undefined ? Number(parsed.oscRouter.listenPort) : DEFAULT_CONFIG.listenPort,
  targetPorts: targetPorts.length > 0 ? targetPorts : DEFAULT_CONFIG.targetPorts
};

const LISTEN_PORT = config.listenPort;
const HOST = config.host;

// 転送先（デフォルト: 波形ビューアーアプリ: 11002, 台本トリガーアプリ: 11003）
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
