# Ableton 2段階タイムアウトおよびリスナー再登録抑制 設計仕様書

## 1. 目的と概要
再生中（Playing）の再接続時、AbletonOSC への `/start_listen`（監視開始要求）が一斉に送られた際、Ableton側が再生中でビジー状態であるためにコマンドを全て無視（ドロップ）してしまい、再生位置パケットが一切来なくなって4秒タイムアウトを無限に繰り返す問題を解決します。

一時的な切断（ルーターの再起動など）の際、Ableton 側は起動したままであり、AbletonOSC 内部のリスナー登録（Pythonのメモリ）は消えずに残っています。そのため、数秒の瞬断のたびに `/start_listen` を送り直す必要はありません。

タイムアウト判定を **「2段階（一時待機と完全リセット）」** に設計変更し、一時切断時にはリスナーの再登録要求を抑制することで、復帰時の無限ループを防ぎ、0秒での完全同期復帰を実現します。

---

## 2. 設計詳細

### 2.1 サーバー側の2段階タイムアウト処理
[packages/viewWaves/server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/server.js)
- 最後のパケット受信からの経過時間（`elapsed = Date.now() - lastAbletonMessageTime`）をもとに、以下の2段階で処理を行います。

1. **第1段階：一時タイムアウト（4秒以上経過）**
   - `abletonConnected = false` にします。
   - クライアントへ `ableton_status` `{ connected: false, reset: false }` を通知します。
   - **`numTracks` はリセットせず、キャッシュも維持します。**
   - リスナーの再登録要求（`/start_listen`）は送信しません。
2. **第2段階：完全タイムアウト（20秒以上経過）**
   - Ableton Live 自体が終了した、または別のプロジェクトファイルを開いたと判断します。
   - **`numTracks = 0` にリセットし、キャッシュもすべてクリアします。**
   - クライアントへ `ableton_status` `{ connected: false, reset: true }` を通知し、画面の完全初期化を促します。

### 2.2 フロントエンド（ブラウザ）のタイムアウト時リセット制御
[packages/viewWaves/public/app.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/app.js)
- `socket.on('ableton_status')` ハンドラにて、`data.connected === false` かつ **`data.reset === true`** の場合のみ `resetAllTracksUI()` を実行して画面をクリアします。
- 一時的なタイムアウト（`data.reset === false`）の際は、画面に波形を残したまま、枠線のみをオレンジ明滅に変えて疎通待ちにします。

---

## 3. 影響範囲とリスク（デグレ防止）
- **Ableton再起動時の対応**: Ableton 自体が本当に再起動された場合は、20秒経過した時点で自動的に完全タイムアウトとなり、キャッシュと画面が綺麗にリセットされ、次の接続時に一から正常に初期化（`/start_listen`）が行われます。
- **瞬断時の復旧性能**: 数秒のルーター瞬断であれば、復帰した瞬間に Ableton への余分な要求を送ることなく、既存のリスナーとキャッシュ情報のみで **0秒で即座に波形と再生位置が復帰** します。

---

## 4. 検証計画
1. **再生中の瞬断復帰ループ解消検証**:
   - Ableton Live で曲を再生（1秒間に60発のパケットが飛んでいる状態）にします。
   - アプリを起動し、一度 `osc-router` を終了させ、4秒後にオレンジ明滅に変わることを確認します（この時波形は消えないこと）。
   - `osc-router` を再起動します。
   - **緑枠に復帰した瞬間、即座に波形と再生位置のカーソル移動が再開し、4秒おきにオレンジ枠に戻る無限ループが完全に解消していること** を検証します。
2. **完全タイムアウト（20秒）検証**:
   - `osc-router` を停止させたまま **20秒以上** 放置します。
   - 20秒経過した時点で、ブラウザの波形表示が完全に消去（リセット）されることを確認します。
   - その後 `osc-router` を再起動し、一から正常に波形が取得・表示されることを検証します。
