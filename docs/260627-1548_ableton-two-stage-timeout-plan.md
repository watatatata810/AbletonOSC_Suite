# Ableton 2段階タイムアウトおよびリスナー再登録抑制 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一時切断時（4〜20秒）はリスナーの再登録やキャッシュクリアを行わず、復帰時に0秒で即時同期復旧させ、20秒以上の完全切断時のみキャッシュと画面をクリアする「2段階タイムアウト」を実装する。

**Architecture:** 
1. `server.js` にて、最後の受信から4秒経過時は `connected: false, reset: false` を送信して一時待機、20秒経過した場合は `numTracks = 0` にしキャッシュをクリアして `connected: false, reset: true` を送信する。
2. `app.js` の `socket.on('ableton_status')` ハンドラにて、`data.reset === true` の場合のみ `resetAllTracksUI()` を実行して画面をクリアする。

**Tech Stack:** Node.js, JavaScript, Socket.IO

---

### Task 1: サーバー側 2段階タイムアウト処理の実装

**Files:**
- Modify: `packages/viewWaves/server.js`

- [ ] **Step 1: `server.js` の書き換え**
  
  `setInterval` 内のタイムアウト監視ブロック（195〜209行目付近）を2段階タイムアウト処理に書き換えます。
  
  ```javascript
  // タイムアウト監視：最後のパケット受信から4秒以上経過していたら一時切断、20秒以上で完全リセット
  const elapsed = lastAbletonMessageTime > 0 ? Date.now() - lastAbletonMessageTime : 0;
  if (elapsed > 4000) {
      if (abletonConnected) {
          abletonConnected = false;
          // 一時タイムアウト：画面は消さない（reset: false）
          io.emit('ableton_status', { connected: false, reset: false });
          debugLog('Ableton Liveとの通信がタイムアウトしました。一時待機状態（疎通待ち）に移行します。');
      }
      
      // 20秒以上パケットが途絶えた場合、Abletonが再起動または終了されたとみなし、状態を完全クリア
      if (elapsed > 20000 && numTracks > 0) {
          numTracks = 0;
          for (const key in playingSlots) delete playingSlots[key];
          for (const key in activeClips) delete activeClips[key];
          clipLengths = {};
          
          // 完全タイムアウト：画面をクリアさせる（reset: true）
          io.emit('ableton_status', { connected: false, reset: true });
          debugLog('Ableton Liveとの通信が20秒以上途絶えたため、状態キャッシュを完全クリアします。');
      }
  }
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "fix: server.jsにて最後の受信経過時間に応じた2段階タイムアウト処理を実装"
  ```

---

### Task 2: フロントエンド切断時画面リセット条件の緩和

**Files:**
- Modify: `packages/viewWaves/public/app.js`

- [ ] **Step 1: `app.js` の書き換え**
  
  `ableton_status` イベントハンドラを更新し、`data.reset === true` の場合のみ画面をリセットするようにします。
  
  ```javascript
  // 変更前（425-430行目付近）
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
      }
  });
  
  // 変更後
  socket.on('ableton_status', (data) => {
      if (data.connected) {
          document.body.className = 'status-connected'; // Ableton疎通時は緑枠
      } else {
          document.body.className = 'status-waiting'; // 疎通待ち時はオレンジ枠
          if (data.reset) {
              resetAllTracksUI(); // 20秒以上の完全切断時のみ画面をクリア
          }
      }
  });
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/public/app.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/public/app.js
  git commit -m "fix: app.jsにてableton_statusのresetフラグが真のときのみ画面をクリアするように修正"
  ```

---

### Task 3: 統合動作・再接続後の即時波形再描画検証

**Files:**
- None (検証作業)

- [ ] **Step 1: 再生中の再接続および完全タイムアウトテスト**
  
  1. Ableton Live で曲を再生（音が出ている状態）にします。
  2. アプリを通常の手順で起動します。
  3. `osc-router` のみを終了させ、4秒後に枠線がオレンジ明滅に変わること、**波形は画面に残っていること**を確認します。
  4. そのまま **20秒以上** 放置します。
  5. 20秒経過した時点で、**画面上の波形が完全に消去（リセット）されること**を確認します。
  6. `osc-router` を再び起動します。
  7. 枠線が緑に切り替わり、一から正常に波形が取得・表示されることを検証します。
  8. 再度、`osc-router` を終了し、オレンジ明滅になってから **10秒後（20秒未満）** に `osc-router` を再起動します。
  9. 緑枠に切り替わった **その瞬間に（0秒で）**、波形が即座に同期し、4秒おきにオレンジになるループが発生しないことを検証します。
  10. プロセスを終了します。
