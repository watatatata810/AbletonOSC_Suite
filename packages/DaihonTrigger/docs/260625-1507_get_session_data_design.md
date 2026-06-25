# get_session_data の並行取得化（高速化・安定化）設計書

## 1. 理解の要約 (Understanding Summary)
* **目的**: `DaihonTrigger` 起動時におけるセッションデータ（全トラック・全シーン・全クリップ名）取得処理の高速化と安定性の向上。
* **背景**: 現状は全クリップ情報を1件ずつ直列で待機しながら取得しているため、プロジェクトの規模が大きい場合にフリーズやタイムアウトが発生する。
* **解決策**: 同時リクエスト数に上限を設けた並行処理（チャンク分割）を実装し、取得処理を高速化する。
* **調整機能**: 現場のネットワーク環境やPCのスペックに合わせて、同時実行制限数およびタイムアウト時間を環境変数で外部から調整できるようにする。
* **非目標（Non-goals）**: UIの起動シーケンスの変更や、Ableton Live側のOSCプラグインの修正は行わない。

## 2. 前提条件 (Assumptions)
* **使用する環境変数**:
  * `OSC_CONCURRENCY_LIMIT` (デフォルト値: 20)
  * `OSC_TIMEOUT` (デフォルト値: 1000) (単位: ms)
* **並行処理への対応**: 
  * `queryOsc` 内のレスポンス検知ロジックで「送信したすべての引数」がレスポンスメッセージと完全一致するかを確認する仕組みに拡張する。

## 3. 決定ログ (Decision Log)
* **決定事項**: 外部ライブラリを使用しないチャンク分割並行処理を採用し、`OSC_CONCURRENCY_LIMIT` および `OSC_TIMEOUT` を環境変数で可変にする。
* **理由**: 新たなパッケージを追加することなく保守性を高めつつ、現場のネットワーク環境やPCの処理能力に合わせた調整を可能にし、パケットロス時のフリーズを防止するため。

## 4. 詳細設計 (Detailed Design)

### 4.1. 環境変数と `queryOsc` の修正
`server.js` に環境変数読み込みを追加し、`queryOsc` の一致検証ロジックを以下のように変更します。

```javascript
// 設定の追加
const OSC_CONCURRENCY_LIMIT = parseInt(process.env.OSC_CONCURRENCY_LIMIT, 10) || 20;
const OSC_TIMEOUT = parseInt(process.env.OSC_TIMEOUT, 10) || 1000;

// queryOsc の修正
const queryOsc = (address, ...args) => {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            oscServer.removeListener('message', listener);
            resolve(null);
        }, OSC_TIMEOUT);

        const listener = (msg) => {
            if (msg[0] === address) {
                // 送信した引数がレスポンスの引数とすべて一致するか確認 (msg[1] 以降と比較)
                const isMatch = args.every((arg, index) => msg[1 + index] === arg);
                if (!isMatch) return; // 一致しない場合は他のリクエストのレスポンスなので無視
                
                clearTimeout(timeout);
                oscServer.removeListener('message', listener);
                resolve(msg.slice(1));
            } else if (msg[0] === '/live/error') {
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
```

### 4.2. `get_session_data` のチャンク分割並行化
`get_session_data` 内のクリップ名取得ループを、以下のように平坦化してチャンク処理化します。

```javascript
            // クリップ名の取得 (チャンク分割並行処理)
            const clipTasks = [];
            for (let t = 0; t < numTracks; t++) {
                sessionData.clips[t] = [];
                for (let s = 0; s < numScenes; s++) {
                    clipTasks.push({ track: t, scene: s });
                }
            }

            for (let i = 0; i < clipTasks.length; i += OSC_CONCURRENCY_LIMIT) {
                const chunk = clipTasks.slice(i, i + OSC_CONCURRENCY_LIMIT);
                await Promise.all(chunk.map(async (task) => {
                    const clipNameRes = await queryOsc('/live/clip/get/name', task.track, task.scene);
                    sessionData.clips[task.track][task.scene] = clipNameRes ? clipNameRes[2] : null;
                }));
            }
```

## 5. テストプラン (Verification Plan)
1. **通常接続テスト**: Ableton Live 起動時に同期がエラーなく数秒で完了することを確認。
2. **環境変数調整テスト**: `OSC_CONCURRENCY_LIMIT` の値を変更してパフォーマンスと安定性を比較。
3. **タイムアウトテスト**: Ableton Live 未起動状態でフリーズせず、タイムアウトで正常終了することを確認。
