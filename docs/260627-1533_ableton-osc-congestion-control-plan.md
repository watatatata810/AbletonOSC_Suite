# Ableton OSC通信輻輳制御およびバーストガード 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Live 再生中の過度なOSCパケット（1秒あたり60発）によるバッファ溢れと、タイムラグ後に押し寄せる重複パケットによるバースト（雪崩現象）を防ぎ、再生中であっても遅延なく一瞬で波形を表示できるようにする。

**Architecture:** 
1. `server.js` にて `/live/song/get/num_tracks` の再送周期を 2秒に制限し、応答受信時にすでに `numTracks > 0` なら早期リターンして重複登録を防ぐ。
2. 1秒に60回届く `/playing_position` を、サーバー側で各トラック 100ms（10Hz）に間引いてブラウザに WebSocket 配信する。

**Tech Stack:** Node.js, JavaScript, Socket.IO

---

### Task 1: サーバー側 OSC輻輳制御・バーストガードの実装

**Files:**
- Modify: `packages/viewWaves/server.js`

**Interfaces:**
- Consumes: AbletonからのOSCメッセージ受信
- Produces: 間引かれたWebSocket配信、再接続時のバーストガード

- [ ] **Step 1: `server.js` の書き換え**
  
  デバウンス変数・時間記録変数の追加と、リクエスト送信部、メッセージ受信ハンドラを更新します。
  
  ```javascript
  // 1. 変数宣言の追加（160行目付近）
  let debugRequestStartTime = 0;
  let debugPlayingPositionCount = 0;
  let debugLastLogTime = Date.now();
  
  // 新規追加変数
  let lastNumTracksRequestTime = 0;
  const lastClipPositionEmitTime = {}; // key: trackId, value: timestamp
  ```
  
  ```javascript
  // 2. /live/song/get/num_tracks 送信制限（200-210行目付近、setInterval内）
  // 変更前
  if (numTracks === 0) {
      debugRequestStartTime = Date.now();
      debugLog(`Sending /live/song/get/num_tracks`);
      oscClient.send('/live/song/get/num_tracks');
  }
  
  // 変更後
  if (numTracks === 0) {
      const now = Date.now();
      // 前回の送信から2.0秒以上経過している場合のみ送信（再送スパム防止）
      if (now - lastNumTracksRequestTime > 2000) {
          lastNumTracksRequestTime = now;
          debugRequestStartTime = now;
          debugLog(`Sending /live/song/get/num_tracks`);
          oscClient.send('/live/song/get/num_tracks');
      }
  }
  ```
  
  ```javascript
  // 3. /live/song/get/num_tracks 受信時の重複ガード（240-250行目付近）
  // 変更前
  if (address === '/live/song/get/num_tracks') {
      numTracks = args[0];
      const rtt = Date.now() - debugRequestStartTime;
      debugLog(`Received /live/song/num_tracks: ${numTracks} (RTT: ${rtt}ms)`);
      debugLog(`Detected ${numTracks} tracks in the song. Setting up listeners...`);
      
      // 全体の再生状態（スペースキー等）を監視開始
      // ...
  
  // 変更後
  if (address === '/live/song/get/num_tracks') {
      const val = args[0];
      const rtt = Date.now() - debugRequestStartTime;
      
      // すでにトラック数が確定している場合は、重複してリスナー登録を送らない（バーストガード）
      if (numTracks > 0) {
          numTracks = val; // 値だけ更新
          debugLog(`Received redundant /live/song/num_tracks: ${val} (Skipped listener setup)`);
          return;
      }
      
      numTracks = val;
      debugLog(`Received /live/song/num_tracks: ${numTracks} (RTT: ${rtt}ms)`);
      debugLog(`Detected ${numTracks} tracks in the song. Setting up listeners...`);
      
      // 全体の再生状態（スペースキー等）を監視開始
      // ...
  ```
  
  ```javascript
  // 4. /live/clip/playing_position 受信時のブラウザ送信間引き（350-380行目付近）
  // 変更前
  const length = clipLengths[`${trackId}_${slotIndex}`];
  if (length && length > 0) {
      io.emit('clip_position', {
          trackId: trackId,
          slotIndex: slotIndex,
          progress: Math.min(Math.max(position / length, 0), 1),
          position: position
      });
  }
  
  // 変更後
  const length = clipLengths[`${trackId}_${slotIndex}`];
  if (length && length > 0) {
      const now = Date.now();
      const lastEmit = lastClipPositionEmitTime[trackId] || 0;
      
      // 100ms（10Hz）間隔に間引いてブラウザにWebSocket送信
      if (now - lastEmit >= 100) {
          io.emit('clip_position', {
              trackId: trackId,
              slotIndex: slotIndex,
              progress: Math.min(Math.max(position / length, 0), 1),
              position: position
          });
          lastClipPositionEmitTime[trackId] = now;
      }
  }
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "fix: server.jsにてOSC輻輳制御とバーストガードを実装し再生中の即時復帰を可能に"
  ```

---

### Task 2: 統合動作・再接続後の即時波形再描画検証

**Files:**
- None (検証作業)

- [ ] **Step 1: 再生中の再接続テスト**
  
  1. Ableton Live で曲を再生（音が出ている状態）にします。
  2. アプリを通常の手順で起動します。
  3. `osc-router` のみを一度終了させ、4秒以内に枠線がオレンジ明滅に戻り、画面がクリアされることを確認します。
  4. `osc-router` を再び起動します。
  5. 枠線が緑に切り替わった **その瞬間に（数十秒待つことなく）、即座に波形が表示されること** を確認します。
  6. `server.log` を確認し、`/num_tracks` の重複受信時に `Skipped listener setup` のログが出力され、1回しか `setupSongListeners()` が走っていないことを検証します。
  7. プロセスを終了します。
