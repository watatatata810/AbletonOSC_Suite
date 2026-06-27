# Ableton状態同期および切断キャッシュ維持 設計仕様書

## 1. 目的と概要
再生中（Playing）にアプリを再接続した際、AbletonOSC 側が再生位置パケットの送信等でビジーになり、トラック再生スロット取得リクエスト（`/playing_slot_index`）への応答を十数秒以上返さない仕様制限を回避します。

一時的な切断（タイムアウト）の発生時にも、サーバー側で取得済みの再生状態（スロット、アクティブクリップ、クリップ長等）のキャッシュを破棄せずに維持します。疎通が復帰（緑枠に移行）した瞬間に、サーバーが保持しているそのキャッシュ状態をブラウザ（フロントエンド）へ一括して強制再配信（再同期）することで、Ableton へのOSC問い合わせを一切発生させず、復帰した瞬間に即座に波形が表示されるようにします。

また、一時的な疎通切れ（オレンジ明滅）の際にはブラウザ側の波形表示を消去せず維持し、サーバー自体の停止（赤枠）の際のみ画面をクリーンアップするように制限してUXを向上させます。

---

## 2. 設計詳細

### 2.1 サーバー側のキャッシュ維持と復帰時再同期
[packages/viewWaves/server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/server.js)
1. **タイムアウト時のキャッシュクリア処理の削除**
   - `setInterval` 内のタイムアウト監視処理において、`playingSlots` や `activeClips` などの削除処理を廃止し、`numTracks = 0` のリセットのみに戻します。
2. **状態キャッシュ一括再同期関数の追加**
   - キャッシュ情報を接続中の全クライアントに配信する関数 `syncActiveClipsToClients()` を実装します。
   ```javascript
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
3. **疎通確立時の再同期実行**
   - `oscServer.on('message')` で `!abletonConnected` から `abletonConnected = true` に切り替わる（疎通が復帰する）瞬間に、`syncActiveClipsToClients()` を実行してブラウザに状態を再同期します。

### 2.2 フロントエンド（ブラウザ）の一時切断時の画面維持
[packages/viewWaves/public/app.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/public/app.js)
- `socket.on('ableton_status')` にて、`data.connected === false`（オレンジ明滅・疎通待ち）を受け取った際の `resetAllTracksUI()` 呼び出しを削除します（枠線がオレンジに変わるだけで、波形描画は消えずに残ります）。
- `socket.on('disconnect')`（サーバー自体との切断・赤枠）の際の `resetAllTracksUI()` 呼び出しは維持します。

---

## 3. 影響範囲とリスク（デグレ防止）
- **状態の一致**: 一時的な疎通切れ（ルーター再起動など）の間に Ableton 側でクリップの切り替えが行われていたとしても、再接続後に Ableton から新しい状態パケットが届いた時点で差分が上書き更新されるため、表示の不整合は起きません。
- **UXの向上**: ルーターが数秒間再起動した際、画面が真っ白にリセットされるチラつきがなくなり、枠線がオレンジ明滅 ➡️ 緑 に変わるだけで、波形は瞬時に操作可能になります。

---

## 4. 検証計画
1. **再生中の即時復帰検証**:
   - Ableton Live で曲を再生（1秒間に60発のパケットが飛んでいる状態）にします。
   - その状態でルーターを停止し、画面の枠線がオレンジ明滅に変わること（この時波形は消えないこと）を確認します。
   - ルーターを再起動します。
   - 緑枠に切り替わった **その瞬間に（0秒で）**、波形が即座に同期（再生位置が再度動き出すなど）されることを検証します。
2. **サーバー停止時のクリア検証**:
   - 波形が表示されている状態から、波形ビューアーサーバー（`viewWaves/server.js`）自体を停止させます。
   - 画面が赤枠になり、同時にすべての波形表示が消去（リセット）されることを確認します。
