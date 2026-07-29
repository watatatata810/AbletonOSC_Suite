# viewWaves 品質監査・修正状況

**監査日**: 2026-07-29
**対象**: `packages/viewWaves`（server.js / public/app.js / public/webgl-waveform.js）
**行番号**: 2026-07-29 時点のもの。以後の変更でずれる可能性あり

## 進捗サマリ

| 区分 | 件数 |
|---|---|
| ✅ 完了（実機検証済み） | 17 |
| ⬜ 未着手 | 9 |

優先度A・Bは B-1（公開範囲）と B-2（プレイヘッドのドリフト）を残すのみ。

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

- [x] **A-2: wavesurfer.js のバージョンが固定されていなかった**
  `"^7.12.8"`（caret）指定だったが、app.js は `renderer.reRender` / `render` /
  `scrollIntoView` / `unsubscribeOnScroll` / `scrollContainer` / `audioData` という**非公開API**に依存しており、パッチリリースでも壊れ得た。
  → `7.12.8` に完全固定。さらに `assertWaveSurferInternals()` を追加し、固定が外れて内部APIが消えた場合に**無言で壊れず**コンソールで原因が分かるようにした。
  **検証**: 正常系で誤検知なし、`reRender` 欠落／`renderer` 自体の欠落をどちらも検知。

- [x] **A-1: テストが0本だった**
  純粋関数は「テスト容易性のため」分離済みなのにテストが存在せず、C-3 の判定は実装が3回往復していた。
  → 純粋関数を `public/waveform-math.js` へ抽出（ブラウザではグローバル関数、Nodeでは `module.exports`）。`node:test` で **30ケース**を追加（追加依存ゼロ）。`npm test` で実行できる。
  reset フラグの判定は `shouldResetTracksUI()` として切り出し、テストで固定した。
  **検証**: 30/30 パス。さらに変異テストで「無条件クリアに戻す」「残り時間の丸めを切り捨て→四捨五入に変える」の両方を検知できることを確認済み。

- [x] **A-3 + B-3: 同期I/Oの除去と親プロセス死活監視の正式実装**（依存関係があるためセットで対応）
  `debugLog` が `appendFileSync`（ブロッキング）を常時実行しており、OSCホットパス上で平均3.5回/秒の同期syscallが走っていた。一方でログ出力を止めると、それまで実効的に唯一機能していた stdout の EPIPE フェイルセーフが失われ、Neutralino 終了時にゾンビプロセスが残るようになる。そのため2件をセットで対応した。
  → ログを WriteStream（非同期）化し、高頻度の診断ログを `traceLog` に分離して `config.global.debug` でゲート。RTT計測は文字列生成・Map操作も含めブロックごと無効化し、`pendingRequests` への記録も同条件にした（受信側だけ止めると記録が削除されず溜まり続けるため）。5MB上限で `server.prev.log` へ1世代退避する。
  → 親の終了検知を公式仕様どおり **WebSocket IPC の切断**に移行（Node組込の `WebSocket` を使うため依存追加なし）。接続確立前の close では終了しない（`open` を通った場合のみ終了する）ようガードし、stdin で踏んだ自死を再発させない。接続失敗時は3回再試行してから監視なしで継続する。
  → 終了理由を取りこぼさないよう `shutdownWithLog` を追加（非同期ストリームの書き込み完了を待って終了、300ms上限）。EPIPE 経路も同じ関数に集約し二重終了を防ぐ。
  **検証**: `server.log` が 74,190行/5.5MB（6時間）→ **7行/564バイト**、RTTトレース0件。`debug: true` ではトレースが復活することを確認（診断能力は維持）。ローテーションは上限を一時的に下げて発火を確認。Neutralino 強制終了でサーバーも自動終了しポート3000が解放され、**終了経路がログ上 IPC 切断であること**（EPIPE ではない）も確認済み。

以下は C-2 の書き換えに伴って同時に解消:

- [x] **C-9: LOD0 が全長を1本の LINE_STRIP で描画** → 可視範囲のみ描画。最大ズーム時 220,500 → 39,780 頂点
- [x] **C-10: インデックスバッファでVRAM 2倍** → 共有頂点IDバッファ + uniform でシェーダ内合成し、トラック毎のインデックスバッファを廃止
- [x] **C-11: devicePixelRatio 無視で HiDPI でボケる**（コメントは "avoid blurring" だが実態は逆）→ dpr 対応
- [x] **C-12: `window.resize` リスナーがインスタンス毎にリーク** → 共有側に1本化 + `ResizeObserver`
- [x] **C-13: `webglcontextlost` 未処理** → ハンドラ追加。復帰時は WaveSurfer のデコード済みデータからGPUバッファを再構築

---

## ⬜ 未着手

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

- [ ] **C-g: 残り時間表示が浮動小数点誤差で1秒短く出ることがある**（A-1 のテスト作成中に発見）
  マーカー範囲が 20%〜70% のようにきりの悪い値だと、`0.7 - 0.2` が `0.49999999999999994` になり、切り捨てのため **`-05:00` が `-04:59` と表示される**。
  「表示より長く残っていることはない」という方針では**安全側**に外れるため実害は小さく、現時点では現状の挙動をテストで固定してある（安全側であることは性質テストで担保済み）。
  **対応**: 直すなら丸め仕様の合意が先。厳密にするなら進行度ではなく秒数で引き算する必要がある。

- [ ] **C-f: `seekTo` の呼び出し頻度（要計測）**
  `animateCursor` が毎フレーム `t.ws.seekTo()` を呼ぶ = トラック数 × 60回/秒 で MediaElement の `currentTime` を設定している。実負荷は未計測。まず測ってから判断する。

---

## 参考

- 設計書: `260627-1548_ableton-two-stage-timeout-design.md`（2段階タイムアウトの正本）
- 監査時に確認した外部仕様: Neutralino 拡張は接続情報JSON（`nlPort` / `nlToken` / `nlConnectToken` / `nlExtensionId`）を **stdin 経由**で受け取る（コマンドライン引数ではない）
