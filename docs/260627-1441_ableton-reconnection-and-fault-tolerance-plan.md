# Ableton再接続時復帰ロジック強化および耐障害性向上 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Live が突然終了・再起動した際にフロントエンド画面を綺麗に初期化し、また送信先ポート閉塞時などの一時的なUDP通信エラーによるサーバーのクラッシュを防止して、システムの自動再接続・復帰能力を極限まで高める。

**Architecture:** 
1. `server.js` のグローバルエラーハンドラと、`node-osc` ソケットオブジェクト（`oscClient` / `oscServer`）の個別の `error` リスナーに、`ECONNRESET` などの一時的なネットワークエラーコードを安全に無視するエラーシールドを導入する。
2. フロントエンド（`app.js`）に、すべてのトラック要素の DOM 削除と WaveSurfer リソース解放（`destroy`）を行うクリーンアップ関数 `resetAllTracksUI()` を追加し、切断検知時に自動実行する。

**Tech Stack:** Node.js, JavaScript, WaveSurfer.js, Socket.IO, UDP/OSC

## Global Constraints
- 許容して無視するエラーコードは `ECONNRESET`、`ENETUNREACH`、`EADDRNOTAVAIL`、`EHOSTUNREACH` に限定し、それ以外のバグなどの致命的エラーは通常通り落としてクラッシュログを残す。
- WaveSurfer のリソースリークを防ぐため、トラック削除時には必ず `wavesurfer.destroy()` を個別に実行してから DOM 要素を削除する。

---

### Task 1: サーバー側エラーシールド（クラッシュ防止）の実装

**Files:**
- Modify: `packages/viewWaves/server.js`

**Interfaces:**
- Consumes: `oscClient` および `oscServer` で発生したエラーイベント、プロセス内の未処理例外
- Produces: ネットワークエラー時もプロセスを維持し、ログ出力のみとする挙動

- [ ] **Step 1: `server.js` の書き換え**
  
  グローバルエラーハンドラおよびソケット生成直後のエラーハンドリングを強化します。
  
  ```javascript
  // 1. グローバル例外ハンドラの更新（30-37行目付近）
  // 変更前
  process.on('uncaughtException', (err) => {
      if (err.code === 'EPIPE') {
          process.exit(0); // 親プロセス終了によるパイプ切断時は正常終了
      }
      console.error('Uncaught Exception:', err);
      fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Uncaught Exception: ${err.stack}\n`);
      process.exit(1);
  });
  
  // 変更後
  process.on('uncaughtException', (err) => {
      if (err.code === 'EPIPE') {
          process.exit(0); // 親プロセス終了によるパイプ切断時は正常終了
      }
      
      // UDP一時エラーなどのネットワーク切断に起因する例外は無視してプロセスを維持
      const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
      if (err.code && IGNORE_ERRORS.includes(err.code)) {
          console.warn(`[Network Warning] Ignored temporary UDP socket exception: ${err.code} (${err.message})`);
          return;
      }
      
      console.error('Uncaught Exception:', err);
      try {
          fs.appendFileSync(path.join(__dirname, 'crash.log'), `[${new Date().toISOString()}] Uncaught Exception: ${err.stack}\n`);
      } catch (e) {}
      process.exit(1);
  });
  ```
  
  ```javascript
  // 2. oscClient と oscServer の個別エラーハンドラ追加（120-135行目付近、インスタンス生成直後）
  // 変更前
  const oscClient = new Client(clientHost, clientPort);
  const oscServer = new OscServer(serverPort, clientHost, () => {
      // ...
  });
  
  // 変更後
  const oscClient = new Client(clientHost, clientPort);
  const oscServer = new OscServer(serverPort, clientHost, () => {
      // ...
  });
  
  // エラーハンドラを追加してプロセス終了を防ぐ
  oscClient.on('error', (err) => {
      const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
      if (err.code && IGNORE_ERRORS.includes(err.code)) {
          console.warn(`[OSC Client Warning] Ignored temporary UDP error: ${err.message}`);
      } else {
          console.error('[OSC Client Error]', err);
      }
  });
  
  oscServer.on('error', (err) => {
      const IGNORE_ERRORS = ['ECONNRESET', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH'];
      if (err.code && IGNORE_ERRORS.includes(err.code)) {
          console.warn(`[OSC Server Warning] Ignored temporary UDP error: ${err.message}`);
      } else {
          console.error('[OSC Server Error]', err);
      }
  });
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "feat: server.jsにてUDP一時エラーを許容するエラーシールドを実装"
  ```

---

### Task 2: フロントエンド切断時画面リセットロジックの実装

**Files:**
- Modify: `packages/viewWaves/public/app.js`

**Interfaces:**
- Consumes: WebSocketイベント `ableton_status` (`{ connected: false }`)、`disconnect`
- Produces: WaveSurferインスタンス破棄、DOMクリア、空状態の表示更新

- [ ] **Step 1: `app.js` の書き換え**
  
  UIリセット関数の追加と、イベントハンドラ内での呼び出しを実装します。
  
  ```javascript
  // 1. クリーンアップ関数の定義（55行目付近、const tracks = {}; 宣言の直後）
  const tracks = {};
  
  function resetAllTracksUI() {
      // 既存のトラック要素をDOMから削除し、WaveSurferインスタンスを破棄する
      Object.keys(tracks).forEach(trackId => {
          const t = tracks[trackId];
          // ダブルバッファリングされている両レイヤーの WaveSurfer を破棄
          if (t.wavesurferA) {
              try { t.wavesurferA.destroy(); } catch (e) {}
          }
          if (t.wavesurferB) {
              try { t.wavesurferB.destroy(); } catch (e) {}
          }
          if (t.boxEl) {
              try { t.boxEl.remove(); } catch (e) {}
          }
          delete tracks[trackId];
      });
      
      // 他のUI関連グローバル変数をリセット
      isSongPlaying = false;
      selectedSceneIndex = -1;
      
      // empty-state-message (同期待ち/接続待ち) の表示状態を更新
      updateEmptyState();
      console.log('[UI] Ableton切断に伴い、すべてのトラック表示を初期化しました。');
  }
  ```
  
  ```javascript
  // 2. 各切断イベント発生時に resetAllTracksUI を呼び出すように変更
  // 変更前（392-410行目付近）
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
  
  // 変更後
  socket.on('disconnect', () => {
      document.body.className = 'status-disconnected'; // サーバー切断時は赤枠
      resetAllTracksUI(); // 画面をクリーンアップ
  });
  
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
          resetAllTracksUI(); // 画面をクリーンアップ
      }
  });
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/public/app.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/public/app.js
  git commit -m "feat: app.jsにて切断時にWaveSurferインスタンスとDOMを破棄するリセットロジックを実装"
  ```

---

### Task 3: 統合動作・耐障害性・再接続の検証

**Files:**
- None (検証作業)

- [ ] **Step 1: UDP送信エラー耐久テスト（サーバー単体）**
  
  Ableton Liveおよびルーターを完全に停止させた状態で、波形ビューアーサーバーのみを起動します。
  
  1. `node packages/viewWaves/server.js` を実行。
  2. 数秒間放置し、サーバープロセスがクラッシュせずに稼働し続けることを確認する。
  3. 標準出力（コンソール）に `[OSC Client Warning] Ignored temporary UDP error` などの警告ログが数回出力されていることを確認する。
  4. サーバーを終了する。

- [ ] **Step 2: 再起動時の画面自動リセット＆再構築テスト**
  
  Ableton Live との接続・切断を繰り返し、UIが自動的にクリーンアップ・再構築されるか検証します。
  
  1. `node packages/osc-router/index.js` および `node packages/viewWaves/server.js` を起動。
  2. Ableton Live を起動（枠線が緑になり、トラックや波形が表示される）。
  3. その状態から Ableton Live を終了する。
  4. 4秒以内に、枠線がオレンジのゆっくりとした明滅に戻り、**同時に画面上にあったトラック要素（波形エリアなど）が全て消え、「接続待ち」の初期化された画面に戻ること**を確認する。
  5. 再び Ableton Live を起動する。
  6. 疎通した瞬間、枠線が緑色になり、**再び新しくトラックや波形が正常に描画されること**を確認する。
  7. 検証用プロセスをすべて終了させる。
