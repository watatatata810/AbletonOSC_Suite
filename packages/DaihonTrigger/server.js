const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Client, Server: OscServer } = require('node-osc');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// データの保存先ファイル
const DATA_FILE = path.join(__dirname, 'project_data.json');

// ======= 設定 =======
const HTTP_PORT = process.env.PORT || 3001; 
// AbletonOSCが待ち受けるポート（Ableton Live側で設定されている受信ポート）
const ABLETON_OSC_HOST = '127.0.0.1';
const ABLETON_OSC_PORT = process.env.ABLETON_PORT || 11000; 

// Node.jsがAbletonOSCからのメッセージを受け取るためのポート
const NODE_OSC_PORT = process.env.OSC_PORT || 11001;
const oscServer = new OscServer(NODE_OSC_PORT, '0.0.0.0');
console.log(`[OSC] AbletonLiveからの受信用サーバーを起動しました (Port: ${NODE_OSC_PORT})`);
// ====================

// 静的ファイルの配信（フロントエンド用）
app.use(express.static(path.join(__dirname, 'public')));

// Ableton送信用クライアント
const oscClient = new Client(ABLETON_OSC_HOST, ABLETON_OSC_PORT);
console.log(`[OSC] Ableton LiveへのOSC送信用クライアントを準備しました (${ABLETON_OSC_HOST}:${ABLETON_OSC_PORT})`);

/**
 * AbletonOSCへリクエストを送り、返答を待機するヘルパー関数
 * @param {string} address OSCアドレス (例: /live/song/get/num_tracks)
 * @param {...any} args 引数
 * @returns {Promise<any[]>} 返答の配列 (タイムアウト時はnull)
 */
const queryOsc = (address, ...args) => {
    return new Promise((resolve) => {
        // 空のクリップなどを取得した際にLiveから返答がない場合があるため、タイムアウトを設定
        const timeout = setTimeout(() => {
            oscServer.removeListener('message', listener);
            resolve(null);
        }, 1000); // 1000ms に延長

        const listener = (msg) => {
            // msg[0] はアドレス (例: /live/song/get/num_tracks)
            if (msg[0] === address) {
                // 他のアプリ（viewWaves等）へのレスポンスを誤検知しないように引数をチェック
                if (args.length > 0 && msg.length > 1 && msg[1] !== args[0]) {
                    return; // 無視して次を待つ
                }
                clearTimeout(timeout);
                oscServer.removeListener('message', listener);
                resolve(msg.slice(1)); // 引数部分を返す
            } else if (msg[0] === '/live/error') {
                // 空のクリップ等でエラーが返ってきた場合はタイムアウトを待たずにnullを返す
                clearTimeout(timeout);
                oscServer.removeListener('message', listener);
                resolve(null);
            }
        };
        oscServer.on('message', listener);

        oscClient.send(address, ...args, (err) => {
            if (err) {
                clearTimeout(timeout);
                oscServer.removeListener('message', listener);
                resolve(null);
            }
        });
    });
};

// OSCメッセージ全体を監視（他のアプリからの影響確認用）
oscServer.on('message', (msg) => {
    // console.log(`[OSC Received] ${msg}`); // デバッグ用のためコメントアウト
});

// WebSocket (Socket.IO) の接続処理
io.on('connection', (socket) => {
    console.log(`[WebSocket] クライアントが接続しました: ${socket.id}`);

    // OSC経由でクリップを再生するリクエスト
    socket.on('fire_clip', (data) => {
        const { track, scene } = data;
        if (track !== undefined && scene !== undefined) {
            // 自動的に -1 して AbletonOSC（0始まり）の仕様に合わせる
            const tIndex = parseInt(track, 10) - 1;
            const sIndex = parseInt(scene, 10) - 1;
            
            // もし計算結果がマイナスになるなど不正な場合は 0 に丸める（安全対策）
            const safeTrack = Math.max(0, tIndex);
            const safeScene = Math.max(0, sIndex);

            const oscAddress = '/live/clip/fire';
            console.log(`[WebSocket -> OSC] Clip Fire 要求を受信: UI表示(T${track}, S${scene}) -> OSC送信(T${safeTrack}, S${safeScene})`);
            oscClient.send(oscAddress, safeTrack, safeScene, (err) => {
                if (err) {
                    console.error('[OSC Error] 送信エラー:', err);
                } else {
                    console.log(`[OSC Success] ${oscAddress} 送信完了`);
                }
            });
        }
    });

    // OSC経由でシーン全体を再生するリクエスト
    socket.on('fire_scene', (data) => {
        const { scene } = data;
        if (scene !== undefined) {
            const sIndex = parseInt(scene, 10) - 1;
            const safeScene = Math.max(0, sIndex);
            
            const oscAddress = '/live/scene/fire';
            console.log(`[WebSocket -> OSC] Scene Fire 要求を受信: UI表示(S${scene}) -> OSC送信(S${safeScene})`);
            oscClient.send(oscAddress, safeScene, (err) => {
                if (err) {
                    console.error('[OSC Error] Scene 送信エラー:', err);
                } else {
                    console.log(`[OSC Success] ${oscAddress} 送信完了`);
                }
            });
        }
    });

    // AbletonLiveからセッションデータ（トラック・シーン一覧）を取得する
    socket.on('get_session_data', async () => {
        console.log('[OSC] セッションデータの取得を開始します...');
        try {
            // トラック数とシーン数を取得
            const tracksRes = await queryOsc('/live/song/get/num_tracks');
            const scenesRes = await queryOsc('/live/song/get/num_scenes');
            
            const numTracks = tracksRes ? tracksRes[0] : 0;
            const numScenes = scenesRes ? scenesRes[0] : 0;
            
            const sessionData = {
                numTracks,
                numScenes,
                tracks: [],
                scenes: [],
                clips: [] // clips[trackIndex][sceneIndex] の2次元配列
            };

            // トラック名の取得
            for (let t = 0; t < numTracks; t++) {
                const nameRes = await queryOsc('/live/track/get/name', t);
                // 返答は [track_index, name] となるため、インデックス1を取得
                sessionData.tracks.push({
                    index: t,
                    name: nameRes ? nameRes[1] : `Track ${t + 1}`
                });
            }

            // シーン名の取得
            for (let s = 0; s < numScenes; s++) {
                const nameRes = await queryOsc('/live/scene/get/name', s);
                // 返答は [scene_index, name] となるため、インデックス1を取得
                sessionData.scenes.push({
                    index: s,
                    name: nameRes ? nameRes[1] : `Scene ${s + 1}`
                });
            }

            // クリップ名の取得 (時間がかかる場合はタイムアウトでスキップされる)
            for (let t = 0; t < numTracks; t++) {
                sessionData.clips[t] = [];
                for (let s = 0; s < numScenes; s++) {
                    const clipNameRes = await queryOsc('/live/clip/get/name', t, s);
                    // 返答は [track_index, scene_index, name] となるため、インデックス2を取得
                    sessionData.clips[t][s] = clipNameRes ? clipNameRes[2] : null;
                }
            }

            console.log(`[OSC] データ取得完了: トラック${numTracks}件, シーン${numScenes}件`);
            socket.emit('session_data_result', sessionData);
        } catch (err) {
            console.error('[OSC] セッションデータの取得中にエラーが発生:', err);
            socket.emit('session_data_result', { error: true });
        }
    });

    // データの読み込みリクエスト
    socket.on('load_all_data', () => {
        if (fs.existsSync(DATA_FILE)) {
            try {
                const data = fs.readFileSync(DATA_FILE, 'utf-8');
                socket.emit('all_data_loaded', JSON.parse(data));
            } catch (err) {
                console.error('[File Error] データ読み込みエラー:', err);
                socket.emit('all_data_loaded', {});
            }
        } else {
            socket.emit('all_data_loaded', {});
        }
    });

    // データ保存リクエスト
    socket.on('save_data', (payload) => {
        // payload = { pageNum: 1, fabricData: { ... } }
        let currentData = {};
        if (fs.existsSync(DATA_FILE)) {
            try {
                currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
            } catch (e) {}
        }
        
        currentData[payload.pageNum] = payload.fabricData;
        
        fs.writeFile(DATA_FILE, JSON.stringify(currentData), (err) => {
            if (err) console.error('[File Error] データ保存エラー:', err);
        });
    });

    socket.on('disconnect', () => {
        console.log(`[WebSocket] クライアントが切断しました: ${socket.id}`);
    });
});

// サーバー起動処理
server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log('\n=============================================');
    console.log(`台本トリガーサーバーが起動しました`);
    console.log('=============================================');
    console.log(`【ホストPCからのアクセス】`);
    console.log(`http://localhost:${HTTP_PORT}`);
    console.log(`\n【iPad / Androidなど同一LAN内からのアクセスURL】`);
    
    // 全てのネットワークインターフェースのIPを取得して表示
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // IPv4で、ローカルループバック(127.0.0.1)以外のIPを表示
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`http://${iface.address}:${HTTP_PORT}`);
            }
        }
    }
    console.log('=============================================\n');
});

// アプリケーション終了時のクリーンアップ
process.on('SIGINT', () => {
    oscClient.close();
    // oscServer.close();
    process.exit();
});
