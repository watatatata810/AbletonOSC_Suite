const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Client, Server: OscServer } = require('node-osc');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ======= 設定 =======
const { loadConfig } = require('../shared-utils/configLoader');
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = loadConfig(configPath);

const HTTP_PORT = config.oscTester?.httpPort ?? 3010;
const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
const ABLETON_OSC_PORT = config.global?.abletonPort ?? 11000;
const NODE_OSC_PORT = config.oscTester?.oscPort ?? 11004;

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'public')));

// OSC送受信用クライアント＆サーバー
const oscClient = new Client(ABLETON_OSC_HOST, ABLETON_OSC_PORT);
const oscServer = new OscServer(NODE_OSC_PORT, '0.0.0.0');

console.log(`[OSC Tester] Sending to Ableton Live: ${ABLETON_OSC_HOST}:${ABLETON_OSC_PORT}`);
console.log(`[OSC Tester] Listening from Ableton Live: Port ${NODE_OSC_PORT}`);

// OSCメッセージを受信してブラウザに転送
oscServer.on('message', (msg) => {
    if (config.global?.debug) {
        console.log('[OSC Received in Tester]', msg);
    }
    io.emit('osc_raw_message', msg);
});

// WebSocket connection
io.on('connection', (socket) => {
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    // Request from browser
    socket.on('send_custom_osc', (data) => {
        const { address, args } = data;
        if (address) {
            const oscArgs = Array.isArray(args) ? args : (args ? [args] : []);
            
            // 型推論してキャスト
            const parsedArgs = oscArgs.map(arg => {
                if (typeof arg === 'string') {
                    if (arg.toLowerCase() === 'true') return true;
                    if (arg.toLowerCase() === 'false') return false;
                    const num = Number(arg);
                    if (arg.trim() !== '' && !isNaN(num)) return num;
                }
                return arg;
            });

            console.log(`[WebSocket -> OSC] ${address} args:`, parsedArgs);
            oscClient.send(address, ...parsedArgs, (err) => {
                if (err) console.error('[OSC Send Error]', err);
            });
        }
    });
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`\n=============================================`);
    console.log(` OSC Tester Server Started`);
    console.log(` Please access the following URL in your browser:`);
    console.log(` http://localhost:${HTTP_PORT}`);
    console.log(`=============================================\n`);
});

process.on('SIGINT', () => {
    oscClient.close();
    oscServer.close();
    process.exit();
});
