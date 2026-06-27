# Ableton Live 接続状態インジケータ（枠線色切り替え）設計仕様書

## 1. 目的と概要
波形ビューアー（`viewWaves`）において、現在の接続枠線（緑枠）はブラウザとNode.jsサーバー間の接続のみを表しており、Ableton Liveが起動していない状態でも緑色で表示されていました。
本設計では、Ableton Live からのパケット応答の有無を監視し、Ableton Live との疎通状態に応じて枠線の色を「オレンジ（接続待ち）」「緑（疎通完了）」「赤（サーバー未起動）」の3色に変化させ、実際の通信状態を正確に確認できるようにします。

---

## 2. 設計詳細

### 2.1 ステータス状態と枠線色のマッピング

| CSSクラス | 枠線の色 | 状態の定義 |
| :--- | :--- | :--- |
| `status-disconnected` | 🔴 赤 (`#f44336`) | ブラウザと波形ビューアーのNode.jsサーバー自体の接続が切れている状態 |
| `status-waiting` | 🟡 オレンジ (`#ff9800`) | サーバーには繋がっているが、Ableton Liveとの疎通がまだ確立していない状態 |
| `status-connected` | 🟢 緑 (`#4caf50`) | サーバーに繋がり、かつ Ableton Live との正常な通信往復が確認できている状態 |

### 2.2 バックエンドの処理変更 (`packages/viewWaves/server.js`)
1. **ステータス変数の定義**
   - `let abletonConnected = false;` (Abletonとの疎通状態フラグ)
   - `let lastAbletonMessageTime = 0;` (最後にAbletonからパケットを受信したミリ秒タイムスタンプ)

2. **受信時のタイムスタンプ更新と通知**
   - AbletonOSC からのメッセージを受信した際（`oscServer.on('message')` の冒頭）：
     - `lastAbletonMessageTime = Date.now();`
     - もし `abletonConnected === false` であれば、`abletonConnected = true` に更新し、WebSocketでクライアント全員に `ableton_status` イベントをブロードキャストする：
       `io.emit('ableton_status', { connected: true });`

3. **タイムアウト監視と自動切断判定**
   - 既存のポーリング処理（500msの `setInterval`）の中に、タイムアウト監視を追加：
     - `lastAbletonMessageTime > 0` かつ `Date.now() - lastAbletonMessageTime > 4000`（4秒以上パケットを受信していない場合）のとき：
       - `abletonConnected = false;`
       - `numTracks = 0;` (接続復帰時に再読み込みを促すため、トラック数をリセット)
       - クライアント全員に状態変化を通知する：
         `io.emit('ableton_status', { connected: false });`

4. **新規クライアント接続時の初期状態通知**
   - クライアント接続イベント（`io.on('connection')`）のハンドラ内：
     - 現在の `abletonConnected` の値を、接続したクライアントに個別送信する：
       `socket.emit('ableton_status', { connected: abletonConnected });`

### 2.3 フロントエンドの処理変更 (`packages/viewWaves/public/app.js`)
- `socket.on('connect')` 時：
  - `document.body.className = 'status-waiting';` （まずは疎通待ち状態にする）
- 新規イベント `socket.on('ableton_status', (data) => { ... })` を追加：
  - `data.connected === true` の場合： `document.body.className = 'status-connected';`
  - `data.connected === false` の場合： `document.body.className = 'status-waiting';`
- `socket.on('disconnect')` 時：
  - `document.body.className = 'status-disconnected';`

### 2.4 スタイルの変更 (`packages/viewWaves/public/style.css`)
- 枠線色の割り当てを変更します。
  - `body.status-waiting` の色をオレンジに変更：
    ```css
    body.status-waiting {
        border-color: #ff9800; /* Orange: Connected to Server, Waiting for Ableton */
    }
    ```
  - 新たに `body.status-connected` を定義し、緑に設定：
    ```css
    body.status-connected {
        border-color: #4caf50; /* Green: Connected to Server & Ableton */
    }
    ```

---

## 3. 影響範囲
- 枠線の追加表示およびWebSocketメッセージの変更のみのため、既存の波形レンダリングロジックや再生位置同期への影響はありません。
- タイムアウト監視は500msごとに軽量なタイムスタンプ比較を行うのみのため、サーバーのCPU負荷への影響は無視できるレベルです。

---

## 4. 検証計画
1. **初期状態（疎通待ち）のテスト**:
   - `viewWaves/server.js` のみを起動し、ブラウザで開いた際、枠線が「オレンジ色（status-waiting）」になっていることを確認する。
2. **疎通完了状態のテスト**:
   - Ableton Live を起動し、波形ビューアーと疎通した（num_tracks が返ってきた）瞬間、枠線が「緑色（status-connected）」に変化することを確認する。
3. **切断状態のテスト**:
   - Ableton Live を終了する、あるいは `osc-router` を停止させた際、4秒以内に枠線が「オレンジ色」に戻ることを確認する。
   - `viewWaves` サーバー自体を停止した際、枠線が「赤色（status-disconnected）」に変化することを確認する。
