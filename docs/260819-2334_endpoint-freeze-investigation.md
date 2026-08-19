# エンドポイント凍結バグ調査 (Seg. BPM 往復後に反映されない)

日付: 2026-08-19
状態: **解決済み** — `76a7900` で修正 (実測結果は「§4. Seg. BPM 操作の実測」参照)

## 症状

- クリップのエンドポイントを Live 上で動かしても viewWaves の波形表示 (右側グレーアウト) に反映されないことがある
- 再現手順: グローバルテンポ 120 の状態で、クリップの Seg. BPM を一度変更し、その後 120 に戻す → 以後エンドポイントが固まる

## 調査で確定した事実

### 1. 経路上に「キャッシュ凍結」は存在しない

- `server.js` は `playingSlots` にあるクリップの `start_marker` / `end_marker` / `warping` / `looping` / `loop_end` を **2秒ごとに再取得**し、応答のたびに dedup 無しで `clip_markers` を emit する ([server.js:563-570](packages/viewWaves/server.js#L563-L570), [server.js:972-993](packages/viewWaves/server.js#L972-L993))
- クライアントは `clip_markers` を受けるたび無条件に再計算・再描画する ([app.js:1132-1156](packages/viewWaves/public/app.js#L1132-L1156))。`updateOverlayUI` にも差分スキップは無い
- AbletonOSC の `_get_property` は素の `getattr` でキャッシュ無し (`handler.py:35-45`)

→ 表示が凍結するなら、**「AbletonOSC が返す値のうち、表示計算が採用している値」が変わっていない**ことになる。

### 2. 実効エンドの決定ロジックが min() になっている

[waveform-math.js:41-45](packages/viewWaves/public/waveform-math.js#L41-L45):

```js
// isLoopingのON/OFFに関わらず「より手前にあるマーカー」を常に実質的なエンドとする
const actualEnd = (markerData.loopEnd !== undefined && markerData.loopEnd < markerData.endMarker)
    ? markerData.loopEnd
    : markerData.endMarker;
```

commit `d5c7da3` (2026-06-23) で「非ループ時でもエンドポイントを動かすと loop_end が変化する」ことへの対応として導入された。

### 3. 稼働中の Live からの実測値 (2026-08-19、読み取り専用プローブ)

グローバルテンポ 120。非ループ・ワープ済みのオーディオクリップ:

| クリップ | end_marker | loop_end | length | 解釈 |
|---|---|---|---|---|
| T0_S0 The Hunter | 582.278 (小数=ファイル末尾) | **577** (整数=グリッドスナップ) | **577** | エンドポイントを操作済み |
| T0_S2 Change The World | 470.800 (小数=ファイル末尾) | **464** | **464** | 同上 |
| T0_S10 A Game Of Fairies | 472.108 | 472.108 | 472.108 | 未操作 (全部一致) |

ここから確定できること:

- 非ループクリップで **`length` は常に `loop_end` と一致** = Live の実効再生終端は `loop_end`
- エンドポイントのドラッグで動くのは **`loop_end`** 側。`end_marker` はファイル末尾の拍位置に置き去りになる (d5c7da3 の観察と整合)

### 4. Seg. BPM 操作の実測 (2026-08-19、T0_S10 A Game Of Fairies、非ループ・ワープ済み)

`monitor-endpoint.js` を回した状態で (1) エンドポイントをドラッグ (2) Seg. BPM 変更 (3) 元に戻す (4) 再度ドラッグ、を実施した変化ログ:

```
初期        end_marker=472.108  loop_end=472  length=472  (looping=false, warping=true, tempo=120)
(1) ドラッグ    loop_end 472→392→368、length 追従。end_marker は不動
(2) Seg.BPM変更 end_marker 472.108→236.054 (×0.5)、loop_end 368→184 (×0.5)、length 追従
(3) 元に戻す    end_marker 236.054→472.108 (完全復元)、loop_end 184→368 (完全復元)
(4) 再ドラッグ  loop_end 368→472、length 追従。end_marker は不動 (472.108 のまま)
```

確定した事実:

- **エンドポイントのドラッグで動くのは `loop_end` のみ。`end_marker` は一切動かない** (§3 の推定を直接確認)
- **`length` は全ステップで `loop_end` に追従** = Live の実効再生終端は常に `loop_end`
- Seg. BPM の変更は `end_marker` と `loop_end` を**同率スケール**し、戻すと**完全復元**する。今回の試行 (拍値が半減する方向への往復) ではクランプ残留・順序逆転は発生しなかった

一方、同日の全クリップ走査で **`end_marker < loop_end` の逆転状態が実在するクリップ**を確認:

| クリップ | end_marker | loop_end | length |
|---|---|---|---|
| T0_S16 M-2 We Will Rock You_編集済み | **64** | 106 | 106 |

このクリップは min() が 64 を返すため、実効エンド 106 に対し表示エンドが 64 で凍結する「発症中」の生きた証拠。逆転を作り込む具体的な操作列は今回の1往復では再現しなかったが、**逆転が実在する以上 min() は凍結を起こし、かつ実効終端が常に `loop_end` である以上 min() は不要** — 修正方向の確定には十分。

## 凍結メカニズム (確定)

通常は `end_marker`(ファイル末尾) ≥ `loop_end` なので min() は正しく `loop_end` を返す。

何らかの操作で **`end_marker` が `loop_end` より小さい状態**になると (T0_S16 で実在を確認):

1. min() は古い `end_marker` を採用し続ける
2. ユーザーがエンドポイントをドラッグしても、動くのは `loop_end` だけ (§4 で実測確認)
3. → 表示エンドは永遠に変わらない = 「固まる」

これは「たまに起きる」という症状とも整合する (end_marker < loop_end という順序逆転が起きた時だけ発症)。

逆転を作り込む操作列は未特定 (単純な Seg. BPM 1往復では両値が同率スケール・完全復元し、逆転しない — §4)。ただし修正は逆転の生成過程に依存しないため、特定は不要と判断。

## 修正方向 (確定後)

- `calculateMarkerPercentages` / `calculateAbsoluteProgress` の実効エンドを min() ではなく **`loopEnd !== undefined ? loopEnd : endMarker`** にする (looping ON/OFF どちらも Live の実効終端は loop_end であることが実測で裏付け済み)
- 既存テスト `test/waveform-math.test.js` の min() 前提ケースの更新が必要

## 副次的な発見 (今回の症状とは別)

- [server.js:559-561](packages/viewWaves/server.js#L559-L561): `/live/clip/get/length` は**キャッシュが undefined の時しか再取得されない**。Seg. BPM 変更で length は変わるため、サーバー側 `progress` 計算 ([server.js:773-787](packages/viewWaves/server.js#L773-L787)) が古い length を使い続ける。クライアントは自前計算 (`calculateAbsoluteProgress`) を使っているため実害は限定的だが、マーカー類と同様に2秒ポーリングへ含めるのが安全
- `totalBeats = durationSec * (songTempo / 60)` ([waveform-math.js:22](packages/viewWaves/public/waveform-math.js#L22), [48](packages/viewWaves/public/waveform-math.js#L48)) は **Seg. BPM = 曲テンポを前提**にした換算。Seg. BPM が曲テンポとずれている間は endPct・進行度の表示スケール自体がずれる (120 に戻せば解消するため、今回の凍結とは独立の制約)
