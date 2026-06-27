# Ableton状態同期および切断キャッシュ維持 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Live 再生中のOSCレスポンス遅延の影響を受けないよう、一時切断時もサーバーの再生状態キャッシュを維持し、通信復帰時にブラウザへキャッシュから強制再同期をかけることで、再生中であっても0秒で波形表示を復帰させる。また、一時的な疎通待ち時はブラウザ側の波形表示をクリアせず残し、サーバー停止時のみ画面クリアを行うようにする。

**Architecture:** 
1. `server.js` にて、タイムアウト時のキャッシュクリア処理（`playingSlots` / `activeClips` / `clipLengths` の削除）を廃止し、復帰時にキャッシュデータをブラウザに一括再送信する `syncActiveClipsToClients()` を実行する。
2. `app.js` の `socket.on('ableton_status')` ハンドラから、`connected === false` 時の `resetAllTracksUI()` 実行を削除する。

**Tech Stack:** Node.js, JavaScript, Socket.IO

---

### Task 1: サーバー側キャッシュ維持と復帰時再同期の実装

**Files:**
- Modify: `packages/viewWaves/server.js`

**Interfaces:**
- Consumes: `abletonConnected` の `false` ➡️ `true` 切り替え
- Produces: 復帰時の一括WebSocket再同期配信

- [ ] **Step 1: `server.js` の書き換え**
  
  タイムアウト判定時キャッシュクリアの削除、一括再同期関数の定義、および疎通復帰時の呼び出しを実装します。
  
  ```javascript
  // 1. タイムアウト時のキャッシュクリアの削除（180-185行目付近、setInterval内）
  // 変更前
  if (lastAbletonMessageTime > 0 && Date.now() - lastAbletonMessageTime > 4000) {
      if (abletonConnected) {
          abletonConnected = false;
          numTracks = 0; // 接続復帰時にトラック情報が再読み込みされるようリセット
          
          // 接続復帰時に重複ガードを回避し、波形を即座に再ロードさせるためキャッシュをクリア
          for (const key in playingSlots) delete playingSlots[key];
          for (const key in activeClips) delete activeClips[key];
          clipLengths = {};
          
          io.emit('ableton_status', { connected: false });
          debugLog('Ableton Liveとの通信がタイムアウトしました。状態キャッシュをクリアし、疎通待ちに移行します。');
      }
  }
  
  // 変更後
  if (lastAbletonMessageTime > 0 && Date.now() - lastAbletonMessageTime > 4000) {
      if (abletonConnected) {
          abletonConnected = false;
          numTracks = 0; // 接続復帰時にトラック情報が再読み込みされるようリセット
          
          // 【変更】一時的な通信遮断ではキャッシュを消さず維持（Abletonへの再問い合わせの遅延を回避するため）
          io.emit('ableton_status', { connected: false });
          debugLog('Ableton Liveとの通信がタイムアウトしました。疎通待ちに移行します。');
      }
  }
  ```
  
  ```javascript
  // 2. 状態キャッシュ一括再同期関数の定義（485行目付近、emitMarkersIfReadyの直前）
  function syncActiveClipsToClients() {
      debugLog(`[Sync] Syncing current state cache to clients...`);
      for (const trackId in activeClips) {
          const slotIndex = activeClips[trackId];
          const filePath = clipLengths[`${trackId}_${slotIndex}_file_path`];
          if (filePath && filePath !== "NO_AUDIO") {
              io.emit('clip_playing', {
                  trackId: parseInt(trackId),
                  slotIndex: slotIndex,
                  filePath: filePath
              });
              emitMarkersIfReady(parseInt(trackId), slotIndex);
          }
      }
  }
  ```
  
  ```javascript
  // 3. 疎通確立時の再同期実行（230-245行目付近、oscServer.on('message') 内）
  // 変更前
  lastAbletonMessageTime = Date.now();
  if (!abletonConnected) {
      abletonConnected = true;
      io.emit('ableton_status', { connected: true });
      debugLog('Ableton Liveとの通信を確立しました。');
  }
  
  // 変更後
  lastAbletonMessageTime = Date.now();
  if (!abletonConnected) {
      abletonConnected = true;
      io.emit('ableton_status', { connected: true });
      debugLog('Ableton Liveとの通信を確立しました。');
      
      // 【変更】疎通が復活した瞬間に、現在の状態キャッシュをブラウザに再同期する
      syncActiveClipsToClients();
  }
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "fix: server.jsにて切断時のキャッシュを維持し復帰時にブラウザへ再同期する処理を実装"
  ```

---

### Task 2: フロントエンド切断時画面リセット条件の緩和

**Files:**
- Modify: `packages/viewWaves/public/app.js`

**Interfaces:**
- Consumes: WebSocketイベント `ableton_status`
- Produces: 疎通待ち（ connected: false ）時は画面消去を行わず枠線変更のみとする挙動

- [ ] **Step 1: `app.js` の書き換え**
  
  `ableton_status` イベントハンドラから `resetAllTracksUI()` の呼び出しを削除します。
  
  ```javascript
  // 変更前（400行目付近）
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
          resetAllTracksUI(); // 画面をクリーンアップ
      }
  });
  
  // 変更後
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
          // 【変更】一時的な疎通待ち時には画面を消さずに残す（ルーター再起動後の即時復旧とUX向上のため）
      }
  });
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/public/app.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/public/app.js
  git commit -m "fix: app.jsにて一時的な疎通待ち時は波形表示をクリアしないように修正"
  ```

---

### Task 3: 統合動作・再接続後の即時波形再描画検証

**Files:**
- None (検証作業)

- [ ] **Step 1: 再生中の再接続テスト**
  
  1. Ableton Live で曲を再生（音が出ている状態）にします。
  2. アプリを通常の手順で起動します。
  3. `osc-router` のみを一度終了させ、4秒以内に枠線がオレンジ明滅に戻り、**波形は画面に残っていること**を確認します。
  4. `osc-router` を再び起動します。
  5. 枠線が緑に切り替わった **その瞬間に（0秒で）**、波形が即座に同期（再生位置が再度動き出すなど）されることを検証します。
  6. 波形が表示されている状態から、波形ビューアーサーバー（`viewWaves/server.js`）自体を停止させ、画面が赤枠になり、**同時にすべての波形表示が消去されること**を確認します。
  7. プロセスを終了します。
