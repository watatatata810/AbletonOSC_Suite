# Ableton Live 接続状態インジケータ（枠線色切り替え）実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 波形ビューアーにおいて、Ableton Live との疎通状態をリアルタイムで検知し、枠線の色を「オレンジ（接続待ち）」「緑（疎通中）」「赤（サーバー停止）」の3色に切り替える。

**Architecture:** 
1. `server.js` でパケットの最後の受信時刻を監視し、4秒以上の受信なしで「切断（疎通待ち）」と判断する。
2. 接続状態の変化を WebSocket (`ableton_status` イベント) でブラウザにブロードキャストする。
3. `app.js` と `style.css` でこのステータスを受け取って、枠線のクラスと表示色を切り替える。

**Tech Stack:** Node.js, Socket.IO, CSS, Vanilla JavaScript

## Global Constraints
- `status-waiting` クラスはオレンジ枠（Ableton接続待ち）に変更する。
- `status-connected` クラスを新規追加し、緑枠（Ableton接続中）に設定する。
- Abletonとの疎通が切れた場合、次回接続時に正しく画面情報が読み直されるよう、サーバー側の `numTracks` も `0` にリセットする。

---

### Task 1: スタイルシートの枠線色更新

**Files:**
- Modify: `packages/viewWaves/public/style.css:30-37`

**Interfaces:**
- Consumes: None
- Produces: CSSクラス `status-waiting`（オレンジ色）および `status-connected`（緑色）

- [ ] **Step 1: `style.css` の書き換え**
  
  `packages/viewWaves/public/style.css` を編集し、枠線の色設定を変更・追加します。
  
  ```css
  /* 変更前 */
  body.status-waiting {
      border-color: #4caf50; /* Green: Connected & Waiting */
  }
  
  body.status-disconnected {
      border-color: #f44336; /* Red: Disconnected */
      background-color: #2a1111;
  }
  
  /* 変更後 */
  body.status-waiting {
      border-color: #ff9800; /* Orange: Connected to Server, Waiting for Ableton */
  }
  
  body.status-connected {
      border-color: #4caf50; /* Green: Connected to Server & Ableton */
  }
  
  body.status-disconnected {
      border-color: #f44336; /* Red: Disconnected from Server */
      background-color: #2a1111;
  }
  ```

- [ ] **Step 2: CSS変更の検証**
  
  CSSに構文エラーがないこと、および指定した枠線色定義が正しいことを確認します。

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/public/style.css
  git commit -m "style: 接続枠線色（オレンジと緑）のCSS定義を更新"
  ```

---

### Task 2: サーバー側での Ableton 応答監視と状態配信の実装

**Files:**
- Modify: `packages/viewWaves/server.js`

**Interfaces:**
- Consumes: AbletonからのOSCメッセージ受信
- Produces: WebSocketイベント `ableton_status` (`{ connected: boolean }`) の配信

- [ ] **Step 1: `server.js` の変更**
  
  タイムスタンプ管理、監視処理、受信時更新、接続イベント時の初期通知を実装します。
  
  ```javascript
  // 1. 変数の定義（25行目付近、activeClips宣言の近く）
  const activeClips = {};
  let abletonConnected = false;
  let lastAbletonMessageTime = 0;
  ```
  
  ```javascript
  // 2. 定期監視処理と自動切断判定（130-174行目付近の setInterval の中）
  setInterval(() => {
      pollCounter++;
      
      // タイムアウト監視：最後のパケット受信から4秒以上経過していたら切断と判定
      if (lastAbletonMessageTime > 0 && Date.now() - lastAbletonMessageTime > 4000) {
          if (abletonConnected) {
              abletonConnected = false;
              numTracks = 0; // 接続復帰時にトラック情報が再読み込みされるようリセット
              io.emit('ableton_status', { connected: false });
              console.log('[Live] Ableton Liveとの通信がタイムアウトしました。疎通待ちに移行します。');
          }
      }
      
      // 起動時の初期化パケット（num_tracks）がロスした場合のリトライ処理
      if (numTracks === 0) {
          oscClient.send('/live/song/get/num_tracks');
      }
      // ... (既存のplayingSlots等のポーリング)
  ```
  
  ```javascript
  // 3. OSC受信時のタイムスタンプ更新（177行目付近の oscServer.on('message') 内）
  oscServer.on('message', (msg) => {
      // タイムスタンプを更新
      lastAbletonMessageTime = Date.now();
      if (!abletonConnected) {
          abletonConnected = true;
          io.emit('ableton_status', { connected: true });
          console.log('[Live] Ableton Liveとの通信を確立しました。');
      }
      
      if (config.global?.debug) {
          console.log(`[OSC Received in viewWaves]`, msg);
      }
      // ... (既存のメッセージ解析)
  ```
  
  ```javascript
  // 4. WebSocket接続時の初期状態通知（445行目付近の io.on('connection') 内）
  io.on('connection', (socket) => {
      connectedClients++;
      console.log(`[WebSocket] Client connected: ${socket.id} (Total: ${connectedClients})`);
      
      // 現在のAbleton接続状態を接続直後のクライアントに個別通知
      socket.emit('ableton_status', { connected: abletonConnected });
      // ...
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "feat: server.jsにてAbletonとのOSC応答監視とステータス配信を実装"
  ```

---

### Task 3: フロントエンドでの枠線色切り替え処理の実装

**Files:**
- Modify: `packages/viewWaves/public/app.js`

**Interfaces:**
- Consumes: WebSocketイベント `ableton_status`
- Produces: `document.body.className` の適切な切り替え

- [ ] **Step 1: `app.js` の変更**
  
  接続イベントおよび新規追加の `ableton_status` リスナーを実装します。
  
  ```javascript
  // 変更前（392-398行目付近）
  socket.on('connect', () => {
      document.body.className = 'status-waiting';
  });
  
  socket.on('disconnect', () => {
      document.body.className = 'status-disconnected';
  });
  
  // 変更後
  socket.on('connect', () => {
      document.body.className = 'status-waiting'; // サーバー接続時はまずオレンジ枠
  });
  
  socket.on('disconnect', () => {
      document.body.className = 'status-disconnected'; // サーバー切断時は赤枠
  });
  
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
      }
  });
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/public/app.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/public/app.js
  git commit -m "feat: app.jsにてWebSocketを介したAbleton接続枠線の表示制御を実装"
  ```

---

### Task 4: 単体テストおよび統合動作検証

**Files:**
- None (検証作業)

- [ ] **Step 1: 単体起動でのオレンジ枠検証**
  
  Ableton Live を起動しない状態で、波形ビューアーサーバーのみを立ち上げます。
  
  1. `node packages/viewWaves/server.js` を起動する。
  2. ブラウザで `http://localhost:3000` を開く。
  3. 枠線が「オレンジ色（疎通待ち）」で表示されることを確認する。
  4. サーバーを終了する。

- [ ] **Step 2: 統合連携テスト（Ableton疎通による緑枠検証）**
  
  ルーターと波形ビューアーを起動した状態で、Ableton Live を起動して検証します。
  
  1. `node packages/osc-router/index.js` を起動。
  2. `node packages/viewWaves/server.js` を起動。
  3. ブラウザで `http://localhost:3000` を開く（この時点ではオレンジ枠）。
  4. Ableton Live を起動（または再生）。
  5. 疎通した瞬間、枠線が一瞬で「緑色」に変化することを確認する。

- [ ] **Step 3: タイムアウト切断によるオレンジ枠復帰検証**
  
  1. 上記の状態（緑枠）から、Ableton Live を終了する、またはルーター（`osc-router`）を停止する。
  2. 約4秒後に、ブラウザの枠線が自動的に「オレンジ色」に戻ることを確認する。
  3. `viewWaves/server.js` を停止し、枠線が即座に「赤色」に変わることを確認する。
  4. すべての検証用サーバープロセスを終了させる。
