# viewWaves 品質監査・修正状況

**監査日**: 2026-07-29
**対象**: `packages/viewWaves`（server.js / public/app.js / public/webgl-waveform.js）
**行番号**: 2026-07-29 時点のもの。以後の変更でずれる可能性あり

## 進捗サマリ

| 区分 | 件数 |
|---|---|
| ✅ 完了（実機検証済み） | 13 |
| ⬜ 未着手 | 12 |

未着手のうち優先度Aは3件（テスト基盤・依存固定・同期I/O）。

---

## ✅ 完了

いずれも Ableton Live 実接続または Playwright での実測で検証済み。

- [x] **C-1: WaveSurfer が一度も破棄されていなかった**
  `resetAllTracksUI` が存在しないプロパティ `t.wavesurferA/B` を参照しており、git履歴上**一度も代入されたことがなかった**。切断のたびに トラックあたり WaveSurfer 3インスタンス + GPUリソースがリーク。
  → `destroyTrack()` を新設し `t.layers[A|B|C].ws` を破棄。**検証**: 25トラック / 75インスタンスすべて破棄を確認（修正前は 0/75）。

- [x] **C-2: WebGLコンテキストがトラック数だけ確保される**
  `track_name` 受信で全トラックのUIを生成し、各々が `getContext('webgl')` を消費。ブラウザの上限（概ね16）を超えると古い順にロストし、`waveColor: transparent` のため**波形が完全に不可視**になる。
  → WebGLコンテキストをアプリ全体で1個に集約（`SharedWaveformRenderer`）。オフスクリーン描画 → 各トラックの2Dキャンバスへ `drawImage` 転送。**検証**: 25トラック生成時、DOM側のWebGLコンテキスト数 0（共有1個のみ）。

- [x] **C-3: 2段階タイムアウトがクライアント側で無効化されていた**
  設計書 `260627-1548_ableton-two-stage-timeout-design.md` §2.2 は `reset === true` の時のみ画面クリアと規定。実装は無条件クリアで、4秒の瞬断でも全波形が破棄・再ロードされていた（`0749f7d` → `3717348` → `84a5c04` と3回往復）。
  → `reset` フラグでガード。**検証**: 一時切断で波形維持・枠オレンジ、完全切断で初期化。

- [x] **C-4: 起動リトライの引数欠落**
  `startServer(port, retries - 1)` と host が抜けており、1回目の再試行で `retries` が `undefined` になり即座に打ち切られていた。
  → 引数を補正。**検証**: ポート占有下で10回リトライ後に exit(1)。

- [x] **C-5: 起動失敗時に親プロセスを無条件 SIGKILL**
  `npm start` 経由だと親はユーザーのシェル / npm であり、それを SIGKILL していた。
  → Neutralino 拡張として起動された場合のみに限定（判定は stdin のハンドシェイクJSON受信）。**検証**: 親シェル生存を確認。

- [x] **C-6: listen リトライでリスナーが積み増しされる**
  同一 `server` インスタンスに `listen(cb)` と `on('error')` を再登録し続けており、`MaxListenersExceededWarning` が出てハンドラが多重発火していた（実行して初めて表面化）。
  → `once()` + 決着側で相方を `removeListener`。**検証**: 警告消滅。

- [x] **C-7: ウィンドウリサイズに波形が追従しない**
  `resize()` がバッキングストアの再測定しかせず、フィット表示の倍率（コンテナ幅 ÷ 再生時間）を再計算していなかった。キャンバスだけ広がり中身は旧幅のまま。
  → `onResize` コールバック + `syncWebGLView()` を追加。**検証**: 実ファイル133.87秒で 872/1180/612px すべて全幅描画、pxPerSec も期待値と一致。

- [x] **C-8: リサイズ時にマーカーのグレーアウトが追従しない**
  C-7 と同根。`updateOverlayUI()` がリサイズ経路から呼ばれていなかった。
  → `onResize` から呼び出し。**検証**: 幅1180pxで left 236 / right 354（期待値と完全一致）。

以下は C-2 の書き換えに伴って同時に解消:

- [x] **C-9: LOD0 が全長を1本の LINE_STRIP で描画** → 可視範囲のみ描画。最大ズーム時 220,500 → 39,780 頂点
- [x] **C-10: インデックスバッファでVRAM 2倍** → 共有頂点IDバッファ + uniform でシェーダ内合成し、トラック毎のインデックスバッファを廃止
- [x] **C-11: devicePixelRatio 無視で HiDPI でボケる**（コメントは "avoid blurring" だが実態は逆）→ dpr 対応
- [x] **C-12: `window.resize` リスナーがインスタンス毎にリーク** → 共有側に1本化 + `ResizeObserver`
- [x] **C-13: `webglcontextlost` 未処理** → ハンドラ追加。復帰時は WaveSurfer のデコード済みデータからGPUバッファを再構築

---

## ⬜ 未着手

### 優先度 A

- [ ] **A-1: テストが0本**
  `npm test` は `exit 1`。純粋関数 `calculateAbsoluteProgress` / `calculateMarkerPercentages` / `calculateTimeDisplay`（[app.js:124-214](../packages/viewWaves/public/app.js#L124-L214)）は「テスト容易性のため」分離済みなのに、テストが存在しない。
  C-3 の3往復は、まさに回帰テストが防ぐ類のもの。
  **対応**: まず上記3関数のユニットテスト + `ableton_status` の reset フラグ挙動を固定するテスト。

- [ ] **A-2: wavesurfer.js のバージョンが固定されていない**
  `package.json` は `"wavesurfer.js": "^7.12.8"`（caret）。一方で `renderer.reRender` / `unsubscribeOnScroll` / `renderer.scrollContainer` / `renderer.scrollIntoView` という**非公開API**をモンキーパッチしている（[app.js:347](../packages/viewWaves/public/app.js#L347) の `patchReRenderForZoom` ほか）。パッチリリース1つで無言で壊れる。
  **対応**: caret を外して固定。低コスト・高効果。

- [ ] **A-3: 同期I/Oのデバッグログが常時ON**
  [server.js:209](../packages/viewWaves/server.js#L209) の `debugLog` は `appendFileSync`（ブロッキング）で、`config.global.debug` に関係なく常時実行。RTT計測が全 `/get/` 応答で呼ぶため、毎秒30〜60発の位置パケットを捌く同じイベントループ上で走る。
  実測: 74,190行 / 5.5MB / 実働5時間57分 = 平均 **3.5回/秒の同期syscall**。ローテーションも無し。
  **対応**: `debug` フラグでゲート + 非同期化（`fs.createWriteStream`）+ サイズ上限。

### 優先度 B

- [ ] **B-1: 公開範囲が広すぎる**
  `httpHost: "0.0.0.0"`（[config.json:5](../config.json#L5)）+ `Access-Control-Allow-Origin: *`（[server.js:93](../packages/viewWaves/server.js#L93)）+ 無認証の `/debug/clip`（絶対パスを含む全キャッシュを返す）。
  結果、①同一LAN上の任意の端末（会場の共有Wi-Fi等）、②ユーザーがブラウザで開いた任意のWebサイト から、再生中クリップの一覧と音声ファイル本体が取得できる。
  なお `/audio` のパス検証自体（AbletonOSC由来の既知パスとのホワイトリスト照合）は**正しく実装されている**。
  **対応**: 既定を `127.0.0.1` バインドに、CORS を Neutralino オリジンに限定、`/debug/*` を `debug` フラグでゲート。

- [ ] **B-2: プレイヘッドが完全オープンループでドリフトする**
  速度を `1 / ファイル実時間` に固定（[app.js:1045](../packages/viewWaves/public/app.js#L1045)）し、再同期は5%以上のジャンプか巻き戻り検出時のみ。Warp有効かつ曲テンポ ≠ クリップ原テンポの場合、Ableton の実再生速度と一致せず恒常的にずれ、5%に達するまで補正されない。
  残り時間カウントダウンを本番で信頼する用途では効いてくる。
  **対応**: 要設計判断。①テンポ比で velocity を補正、②緩やかな連続補正（現在値へ徐々に寄せる）のどちらか。実測でずれ量を先に確認したい。

- [ ] **B-3: 親プロセスの死活監視が正式な方式でない**
  stdin は**使えない**ことが確定（Neutralino はハンドシェイクJSONを書いた直後に stdin を閉じるため、終了判定に使うとサーバーが自死する）。現状の実効的なフェイルセーフは stdout/stderr の `EPIPE` ハンドラのみで、これは**ログ出力を止めた瞬間に失われる**（＝A-3 を直すと顕在化する結合がある）。
  **対応**: Neutralino 公式仕様どおり WebSocket IPC の切断（`client.onclose`）で検知する。A-3 と同時に対応するのが望ましい。

### 優先度 C

- [ ] **C-a: `pollInterval` 設定が死んでいる**
  [server.js:239](../packages/viewWaves/server.js#L239) は `config.viewWaves?.pollInterval` を読むが、実際の定義位置は `packages[]` 配下（[config.json:24](../config.json#L24)）。正しくは既に算出済みの `pkgConfig.pollInterval`。既定値と同値のため症状が出ていないだけ。

- [ ] **C-b: レイヤーC だけ `scrollIntoView` の無効化が漏れている**
  [app.js:649-650](../packages/viewWaves/public/app.js#L649-L650) で A/B のみ実施。C がアクティブな時だけジャンプスクロールする。

- [ ] **C-c: pxPerSec 計算が6箇所に重複**
  `currentZoom === 0 ? (scrollContainer.clientWidth / ws.getDuration()) : currentZoom` が同一の形で6回書かれている。C-7 の修正で `syncWebGLView()` に同じ式を用意したので、そこへ集約できる。

- [ ] **C-d: README の記述が実装と不一致**
  README は「トラック番号の昇順でソート」と書いているが、実装は**曲の長さ順**（`sortVisibleTracks`）。

- [ ] **C-e: サーバー側のリスナー再登録が設計書と矛盾（要経緯確認）**
  [server.js:321-323](../packages/viewWaves/server.js#L321-L323) は疎通復帰時に無条件で `setupAbletonListeners()` を呼ぶ。設計書は「一時切断では `/start_listen` を送信しない」としているが、この処理は `84a5c04` で**意図的に**追加されたもの。実症状があった可能性が高いため未変更のまま残している。
  **対応**: 触る前に当時の症状を確認する。

- [ ] **C-f: `seekTo` の呼び出し頻度（要計測）**
  `animateCursor` が毎フレーム `t.ws.seekTo()` を呼ぶ = トラック数 × 60回/秒 で MediaElement の `currentTime` を設定している。実負荷は未計測。まず測ってから判断する。

---

## 参考

- 設計書: `260627-1548_ableton-two-stage-timeout-design.md`（2段階タイムアウトの正本）
- 監査時に確認した外部仕様: Neutralino 拡張は接続情報JSON（`nlPort` / `nlToken` / `nlConnectToken` / `nlExtensionId`）を **stdin 経由**で受け取る（コマンドライン引数ではない）
