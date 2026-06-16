const dgram = require('dgram');

const LISTEN_PORT = 11001; // AbletonOSCからの受信ポート
const HOST = '127.0.0.1';

// 転送先（波形ビューアーアプリ: 11002, 台本トリガーアプリ: 11003）
const TARGET_PORTS = [11002, 11003];

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
