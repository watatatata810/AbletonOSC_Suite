# LTC 送出ツール (LtcSender) 第 1 段階 実装計画書

> 設計: [261028-2253_ltc-sender-design.md](261028-2253_ltc-sender-design.md)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live のクリップで鳴らす LTC 音声ファイルを、作成・検査・監視し、シーンを途中から揃えて再生できる独立パッケージ `packages/LtcSender` を作る。

**Architecture:**
1. Node (Express + Socket.IO + node-osc) のサーバーが AbletonOSC (11000) に問い合わせ、osc-router 経由 (11005) で返信を受ける
2. 時刻計算・LTC 符号化/解読・検査ロジックは**純粋関数のモジュール**に分け、`node --test` で試験する
3. ブラウザの操作画面 (3002) に、今の LTC 時刻・監視の警告・台帳・途中再生の操作を出す

**Tech Stack:** Node.js (v24, fnm)、Express 5、Socket.IO 4、node-osc 11、Vanilla JS、`node:test`

## Global Constraints

- **Live のプロジェクトを書き換えない**: 送る命令は `scrub` / `stop_scrub` / `move_playing_pos` / `fire` / `stop` / `get` / `start_listen` だけ。`set` 系 (Start・ミュート・音量など) と `stop_listen` は送らない (`stop_listen` は viewWaves のリスナーまで止めるため)
- 複数クリップへの scrub・move_playing_pos は、必ず **1 つの OSC バンドル**で送る。scrub は同じバンドルに stop_scrub を入れる
- 秒 ⇔ 拍の換算は、Live から読んだテンポを使う (決め打ちしない)
- トラックは**名前**で台帳に持ち、操作の直前に番号へ解決する
- コメント・UI 文言は日本語。既存パッケージ (DaihonTrigger / viewWaves) の書き方に合わせる

---

### Task 1: パッケージの土台と起動設定

**Files:**
- Create: `packages/LtcSender/package.json` (`"test": "node --test \"test/**/*.test.js\""`, 依存は express / socket.io / node-osc)
- Create: `packages/LtcSender/server.js` (起動・設定読み込み・静的配信だけ)
- Create: `packages/LtcSender/public/index.html`, `app.js`, `style.css` (空の画面)
- Modify: `config.json` (`{ "name": "LtcSender", "dir": "packages/LtcSender", "type": "node", "startCmd": "server.js", "httpPort": 3002, "oscPort": 11005, "dependencies": ["osc-router"] }` を追加)
- Modify: `package.json` (ルート。`start:LtcSender` を追加)

- [ ] `shared-utils/configLoader` で設定を読み、`httpPort` / `oscPort` を使う
- [ ] osc-router が `oscPort` を持つ全パッケージへ複製転送することを確かめる (osc-router の `targetPorts` は config から自動で作られる)
- [ ] 確認: suite-launcher から起動し、`http://localhost:3002` が開く

### Task 2: タイムコードの計算 (`lib/timecode.js`)

**Interfaces:**
- `parseTC("01:07:13:02") -> {h,m,s,f}`、`formatTC({h,m,s,f}, dropFrame) -> "01:07:13;02"` 等
- `tcToFrames(tc, rate)` / `framesToTC(n, rate)` — `rate` は `{ fps: 30, drop: true }` (29.97DF) / 30 / 25 / 24
- `secondsToFrames(sec, rate)` — 29.97 系は `sec * 30000 / 1001`
- `fileTimeToTC(sec, startTC, rate)` — LTC ファイルの先頭からの秒 → 出ている時刻

- [ ] 試験: DF の分境界 (00:00:59;29 → 00:01:00;02)、10 分ごとの例外、24 時間の折り返し
- [ ] 試験: 実測値と一致すること — ファイル 480 秒 (開始 01:00:00;00、29.97DF) が `01:08:00;01` の途中 (1.6 フレーム目)、433 秒が `01:07:13` 台

### Task 3: LTC の符号化と解読 (`lib/ltc-encoder.js`, `lib/ltc-decoder.js`, `lib/wav.js`)

- [ ] **実装前に** SMPTE ST 12-1 (LTC) の一次資料で、ビット割り当て・同期語・極性補正ビット・ユーザービット・立ち上がり時間・推奨レベルを確かめ、このファイル冒頭のコメントに出典付きで書く (`standards-driven-design` スキル)
- [ ] `encodeLTC({ startTC, rate, seconds, sampleRate: 48000, levelDb })` → Float32Array。バイフェーズ符号、80 ビット/フレーム
- [ ] `wav.js`: 24bit PCM モノラルの書き出しと、16/24/32bit/float の読み込み (RIFF を直接読む)
- [ ] `ltc-decoder.js`: 今日の Python 版 (`ltc_decode.py`) を移植。遷移間隔を「長い = 0 / 短い 2 つ = 1」に分類し、同期語で切り出す
- [ ] 試験: 符号化 → 解読の往復で、開始時刻・フレーム数・連続性が一致 (29.97DF / 30 / 25、分境界をまたぐ長さ)
- [ ] 試験: 今日録音した実ファイル (`rec.wav` / `rec2.wav` を `test/fixtures/` に縮めて置く) を解読し、既知の結果 (`01:08:00:02` から始まる等) と一致

### Task 4: AbletonOSC との通信 (`lib/live.js`)

**Interfaces:**
- `query(address, ...args, { timeout, match })` — DaihonTrigger の `queryOsc` と同じく、返信のアドレスと先頭の引数で対応づける
- `sendBundle(messages)` — node-osc の Bundle で送る
- `resolveTrack(name) -> index`、`getSceneClips(sceneIndex) -> [{ track, name, hasClip }]`
- `getClipState(track, clip) -> { isPlaying, isTriggered, position, warping, warpMode, length, filePath, ... }`

- [ ] 返信は osc-router から 11005 で受ける。ブール値 (`T` / `F`) の型タグも読めることを確かめる
- [ ] 確認: Live 起動中に、シーン 13 のクリップ一覧と状態が取れる

### Task 5: AbletonOSC の改造の管理 (`abletonosc-patch/`)

**Files:**
- Create: `packages/LtcSender/abletonosc-patch/apply.js` — `Documents\Ableton\User Library\Remote Scripts\AbletonOSC\abletonosc\clip.py` の `methods` に `"move_playing_pos"`, `"scrub"`, `"stop_scrub"` を足す。冪等 (すでにあれば何もしない)。改行コード (CRLF/LF) を保つ。書き換え前に `clip.py.bak-<日時>` を作る
- Create: `packages/LtcSender/lib/patch-check.js` — 同じファイルを読み、3 つがあるかを返す
- Create: `packages/LtcSender/README.md` — 導入手順と「AbletonOSC を更新したら apply.js を再実行」の注意

- [ ] 試験: 上流版の `clip.py` (fixture) に当てると 3 行増える。2 回当てても変わらない。CRLF のファイルでも CRLF のまま
- [ ] サーバー起動時に `patch-check` を実行し、足りなければ画面に赤で出す

### Task 6: 台帳 (`lib/cues.js`)

- [ ] `project_data.json` にプロジェクトごとの台帳を保存 (シーン番号・BGM トラック名・LTC トラック名・開始時刻・ファイルのパス・作成時の検査結果)。フレームレートとテンポはショー単位
- [ ] 「M1 = 01:00:00:00、M2 = 02:00:00:00 …」の自動入力
- [ ] 試験: 保存 → 読み込みの往復、自動入力が 24 時を超えたら警告

### Task 7: LTC ファイルの作成

- [ ] BGM クリップの `file_path` と `sample_length` から曲の長さを求める (サンプルレートはファイルのヘッダーから読む)。Live が開いているファイルを読めるかは〈未確認〉なので、読めない場合は `end_marker` の拍 × 60 ÷ テンポで代用する
- [ ] 長さ + 余白 10 秒で LTC を作り、台帳で決めた出力フォルダに書く。書いた直後に Task 3 の解読で読み戻し、開始時刻・フレームレート・連続性を検査してから「作成済み」にする
- [ ] 画面: 作成ボタン、作成結果、「Live の LTC トラックのこのシーンにドラッグして、Warp オン・Re-Pitch・BPM をテンポと同じに」の案内

### Task 8: 監視 (`lib/checks.js` + サーバーの監視ループ)

**Interfaces:**
- `evaluate(snapshot, cue, settings) -> [{ level: 'error'|'warn', code, message }]` (純粋関数)

| code | 条件 |
|---|---|
| `LTC_NOT_PLAYING` | BGM が鳴っているのに LTC が `is_playing=True` でない |
| `LTC_OUT_OF_SYNC` | BGM と LTC の位置の差 > 0.002 拍 |
| `LTC_WARP` | LTC が Warp オフ、または Re-Pitch 以外 |
| `LTC_RATIO` | LTC クリップの長さ (拍) と ファイル長 × テンポ ÷ 60 の差が 0.5% を超える |
| `LTC_TRACK` | LTC トラックがミュート、または出力が Master |
| `SET_TEMPO` / `SET_QUANT` | テンポが台帳と違う / グローバルクオンタイズが None でない |
| `PATCH_MISSING` | AbletonOSC の改造が無い |

- [ ] 試験: 各 code が正しい条件でだけ出る
- [ ] 監視ループ: 再生中のシーンの BGM・LTC の `playing_position` は `start_listen` で受け (stop_listen は送らない)、その他は 1 秒ごとに `get`
- [ ] 確認: Live で LTC トラックをミュートすると 1 秒以内に画面が赤くなる

### Task 9: 途中から再生・飛ばす (`lib/seek.js`)

**Interfaces:**
- `startFrom(sceneIndex, seconds)` — シーン内のクリップがある全トラックへ `scrub(拍)` + `stop_scrub()` を 1 バンドル。前提: 全クリップ Warp オン
- `jumpTo(seconds)` / `jumpBy(seconds)` — 再生中の全クリップへ `move_playing_pos(差の拍)` を 1 バンドル。前提: 全クリップ `is_playing=True`
- どちらも 0.5 秒後に全クリップの位置を読み直し `{ ok, positions, spread }` を返す

- [ ] 試験 (送る内容の組み立て部分を純粋関数にして): 拍の計算、バンドルの中身、前提を満たさない時に送らないこと
- [ ] 本番モードでは確認ダイアログを 1 回挟む。リハモードは確認なし

### Task 10: 操作画面

- [ ] 上部: 本番/リハの切り替え (大きく色分け)、今の LTC 時刻 (大きく)、Live との接続状態
- [ ] 警告の帯: Task 8 の error は画面全体を赤枠、warn は黄色
- [ ] 台帳の表: シーン・曲名・開始時刻・LTC ファイルの状態・作成ボタン
- [ ] 途中再生: シーン選択 + `分:秒` 入力 + 「ここから再生」、再生中の「±10 秒」

### Task 11: 実機での受け入れ確認

- [ ] シーン 13 を 8:00 から再生 → LTC を録音して解読し、最初のフレームが目的の時刻で、`01:00` 台が出ないこと
- [ ] 再生中に -10 秒 / +20 秒 → 解読で正しく切り替わること
- [ ] LTC トラックのミュート、Warp を Beats に変える、テンポを変える → それぞれ警告が出ること
- [ ] AbletonOSC の `clip.py` を上流版に戻す → 起動時に `PATCH_MISSING` が出ること。apply.js で戻ること
- [ ] 結果を画面のスクリーンショットと解読結果付きで報告する

## 実装前に確かめること (設計書 7 章)

- 照明卓・映像サーバーで、Re-Pitch の LTC と、飛ばした瞬間の壊れたフレーム 1 つの扱い
- 出力レベル (今の録音でピーク -26 dBFS) を受け側が読めるか
