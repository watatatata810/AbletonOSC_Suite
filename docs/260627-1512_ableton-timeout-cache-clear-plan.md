# Abletonタイムアウト時のサーバー側状態キャッシュクリア 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Liveとの通信切断（タイムアウト）時に、サーバー側の古い状態キャッシュ（再生スロット、アクティブクリップ、クリップ長等）を確実にクリアすることで、再接続時に重複処理ガードによって波形描画処理がスキップされ、真っ白な状態が続くバグを修正する。

**Architecture:** 
`server.js` の タイムアウト判定時に、`numTracks` のリセットに加えて、`playingSlots`、`activeClips`、`clipLengths` などのオブジェクトを空に初期化するロジックを追加する。

**Tech Stack:** Node.js, JavaScript, Socket.IO

---

### Task 1: サーバー側タイムアウト処理の修正

**Files:**
- Modify: `packages/viewWaves/server.js`

**Interfaces:**
- Consumes: `lastAbletonMessageTime` (最終受信時刻)
- Produces: タイムアウト時に状態キャッシュオブジェクトが空に初期化される挙動

- [ ] **Step 1: `server.js` の書き換え**
  
  タイムアウト判定時のリセット処理にキャッシュクリアを追加します。
  
  ```javascript
  // 変更前（169-176行目付近）
  if (lastAbletonMessageTime > 0 && Date.now() - lastAbletonMessageTime > 4000) {
      if (abletonConnected) {
          abletonConnected = false;
          numTracks = 0; // 接続復帰時にトラック情報が再読み込みされるようリセット
          io.emit('ableton_status', { connected: false });
          console.log('[Live] Ableton Liveとの通信がタイムアウトしました。疎通待ちに移行します。');
      }
  }
  
  // 変更後
  if (lastAbletonMessageTime > 0 && Date.now() - lastAbletonMessageTime > 4000) {
      if (abletonConnected) {
          abletonConnected = false;
          numTracks = 0; // 接続復帰時にトラック情報が再読み込みされるようリセット
          
          // 接続復帰時に重複ガードを回避し、波形を即座に再ロードさせるためキャッシュをクリア
          for (const key in playingSlots) delete playingSlots[key];
          for (const key in activeClips) delete activeClips[key];
          clipLengths = {};
          
          io.emit('ableton_status', { connected: false });
          console.log('[Live] Ableton Liveとの通信がタイムアウトしました。状態キャッシュをクリアし、疎通待ちに移行します。');
      }
  }
  ```

- [ ] **Step 2: 構文エラーのチェック**
  
  Run: `node -c packages/viewWaves/server.js`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/viewWaves/server.js
  git commit -m "fix: server.jsにてAbletonタイムアウト時に再生情報キャッシュをクリアするように修正"
  ```

---

### Task 2: 統合動作・再接続後の即時波形再描画検証

**Files:**
- None (検証作業)

- [ ] **Step 1: 再接続時の即時再描画テスト**
  
  1. `npm run start:launcher`（またはランチャーアプリ）を起動します。
  2. Ableton Live を起動します（枠線が緑になり、波形が表示される）。
  3. その状態からルーター（`osc-router`）のみを停止するか、Abletonを一度終了します。
  4. 4秒以内に枠線がオレンジ明滅に戻り、画面上の波形が消えることを確認します。
  5. 開発者ツール（デベロッパーツール）の Network タブを開き、通信ログをクリアします。
  6. ルーターを再起動するか、Abletonを再び起動します。
  7. 枠線が緑に切り替わった **その瞬間に**、ネットワークタブに `audio?path=...` の通信が即座に発生し、遅延なく一瞬で波形が描画されることを確認します。
  8. プロセスを終了します。
