# C面追加と選択シーンのプリロード（PRE LOAD）設計書

本ドキュメントは、Ableton Live で選択中のシーンのクリップ波形を事前に読み込む「C面」の実装と、それに伴う「PRE LOAD」機能の設計についてまとめたものです。

---

## 1. 目的と概要
現在、`viewWaves` は再生中のクリップ（A面 or B面）と、次に再生される予定のクリップ（`NEXT READY`）の2つのレイヤーを保持するダブルバッファリング構成となっています。
これに「C面」を第3のレイヤーとして追加し、Ableton Live 上で選択されている（ハイライトされている）シーンのクリップを自動で事前ロード（プリロード）します。
選択変更後 300ms の間、さらなる変更がなかった場合（デバウンス処理）にロードを開始し、ロードが完了したら `NEXT READY` バッジの右側に青色の `PRE LOAD` バッジを表示します。これにより、再生中のシーン以外の選択中シーンが発火された際も、ロード遅延なしに瞬時に波形を描画可能にします。

---

## 2. サーバー側（server.js）の設計

### 2.1. OSC イベントの監視と取得
* 起動時およびブラウザ接続時に、AbletonOSC に対して選択シーンの監視と初期値取得を要求します。
  ```javascript
  oscClient.send('/live/view/start_listen/selected_scene');
  oscClient.send('/live/view/get/selected_scene');
  ```
* メッセージ受信ハンドラ (`oscServer.on('message', ...)`) にて、`/live/view/get/selected_scene` および `/live/view/selected_scene` を処理します。

### 2.2. デバウンス処理 (Debounce)
* 選択シーン of インデックスが変更された場合、300ms のタイマーを起動します。
* 300ms の間に新たな選択変更イベントを受信した場合は、タイマーをクリアして再設定します。
* 300ms 経過後、全トラックに対して該当シーンのクリップパスを問い合わせます（キャッシュがある場合はそれを即座に利用します）。

### 2.3. クライアントへのイベント通知
* 選択シーンが変更された瞬間: `selected_scene_changed` を送信し、クライアント側のバッジを一旦非表示にします。
* 300ms 経過し、各トラックの選択シーンに対応するクリップファイルパスが取得できた（またはキャッシュに存在した）場合: `clip_selected_preload` を送信します。
* クリップがオーディオを持たない場合: `clip_selected_preload_empty` を送信します。

---

## 3. クライアント側（app.js & webgl-waveform.js）の設計

### 3.1. WebGL レイヤー（webgl-waveform.js）のC面対応
* レイヤー管理オブジェクト（`lods`, `lengths`, `sampleRates`）に `C` を追加します。
* `clear()` および `setActiveLayer()` を拡張し、レイヤー `C` のバッファ確保とクリアをサポートします。

### 3.2. 3面バッファリングと動的役割アサイン（app.js）
* `getOrCreateTrackUI` にて `wsLayerC`（DOM）と `wsC`（WaveSurfer インスタンス）を生成します。
* 各レイヤーのステートオブジェクトに `slotIndex`（読み込み中または読み込み済みのスロット）を保持させます。
  ```javascript
  layers: {
      A: { ws: wsA, el: wsLayerA, url: null, slotIndex: -1, isReady: false },
      B: { ws: wsB, el: wsLayerB, url: null, slotIndex: -1, isReady: false },
      C: { ws: wsC, el: wsLayerC, url: null, slotIndex: -1, isReady: false }
  }
  ```
* 各イベント受信時の動作:
  * **`clip_playing` (再生開始)**: 再生対象の URL が A, B, C のいずれかのレイヤーにロード完了（またはロード中）であれば、そのレイヤーをアクティブレイヤー（`activeLayerKey`）にスワップします。見つからない場合は現在のアクティブレイヤーで新規ロードします。
  * **`clip_preload` (NEXT READY)**: 非アクティブな2つのレイヤーのうち、空いているレイヤー（または `PRE LOAD` で使われていないレイヤー）にロードします。
  * **`clip_selected_preload` (PRE LOAD)**: 非アクティブな2つのレイヤーのうち、空いているレイヤー（または `NEXT READY` で使われていないレイヤー）にロードします。

---

## 4. 安全設計 (競合・レースコンディション対策)

### 4.1. ロード中に選択が再度変更された場合
* ロード先のレイヤー（例: C面）が同一の場合、新たに `load(newUrl)` を走らせることで WaveSurfer 内部で古い非同期処理が自動でアボート（キャンセル）されます。
* ロード先のレイヤーが別になった場合でも、古いレイヤーの `slotIndex` が上書きまたはクリアされているため、後から古いロードの `ready` が発火しても、現在のターゲットと不一致であるためUI更新処理は無視されます。

### 4.2. ロード中にそのクリップが再生開始された場合
* `clip_playing` が届いた時点で、たとえ `isReady` が `false`（ロード中）であってもその面へのスワップを許容します。
* ロード完了時の `ready` ハンドラで、現在の `activeLayerKey` が自身であれば、通常通り WebGL へのデータ転送と描画が行われます。
* ロード中の面がアクティブレイヤーになったため、以降 of プリロード選定候補から自動的に除外され、上書きから保護されます。

---

## 5. UI とバッジ表示

### 5.1. CSS 定義 (style.css)
* 青色のバッジ `.pre-load-badge` を定義します。
  ```css
  .pre-load-badge {
      font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 12px;
      font-weight: bold;
      color: #2196F3; /* Blue */
      background-color: rgba(33, 150, 243, 0.15);
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid rgba(33, 150, 243, 0.3);
      opacity: 0;
      transform: translateY(10px) scale(0.9);
      transition: opacity 0.5s ease, transform 0.5s ease;
      pointer-events: none;
  }
  .pre-load-badge.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
      transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }
  .badges-wrapper {
      display: flex;
      gap: 8px;
      align-items: center;
  }
  ```

### 5.2. DOM 構造の変更
* `footer-row` にバッジを並べるための `.badges-wrapper` を追加し、その中に `next-ready-badge` と `pre-load-badge` を配置します。
* `footer-row` 内に、A, B, C 各面のロード・再生状態を表す3つのバッジ要素を追加します。
* `ready` 受信時に、非アクティブなレイヤーの中で `slotIndex` が選択中シーンと一致し、且つロード完了していれば `pre-load-badge`（必要に応じて処理）または3面バッファ自体のREADY状態を表現します。

---

## 6. 3面ステータスバッジ (layer-badge)

### 6.1. CSS 定義
```css
.layer-badge {
    font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 11px;
    font-weight: bold;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.4);
    background-color: rgba(255, 255, 255, 0.03);
    transition: all 0.3s ease;
}

.layer-badge.status-empty {
    border-style: dashed;
    color: rgba(255, 255, 255, 0.2);
}

.layer-badge.status-loading {
    color: #2196F3;
    background-color: rgba(33, 150, 243, 0.08);
    border-color: rgba(33, 150, 243, 0.3);
}

.layer-badge.status-ready {
    color: #4CAF50;
    background-color: rgba(76, 175, 80, 0.08);
    border-color: rgba(76, 175, 80, 0.3);
}

.layer-badge.active {
    color: #121212;
    background-color: var(--accent-color); /* オレンジ #ff9800 */
    border-color: var(--accent-color);
    box-shadow: 0 0 8px rgba(255, 152, 0, 0.4);
}

.badge-spinner {
    display: inline-block;
    animation: badge-spin 1.5s linear infinite;
}

@keyframes badge-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(-360deg); }
}
```

### 6.2. バッジの状態表現
* **アクティブ面** (現在再生中): `▶ A : Scene 1` (バッジをオレンジ強調)
* **READY面** (ロード完了してスタンバイ): `A : Scene 1` (バッジを緑枠線表示)
* **LOADING面** (ロード中): `A : Scene 1 ↺` (スピンする回転矢印、青枠線表示)
* **EMPTY面** (空状態): `A : ---` (グレー破線表示)

### 6.3. 表示更新ロジック (app.js)
* `updateLayerBadgesUI(trackId)` に表示制御を一本化します。
* 以下のタイミングで各面の表示状態を自動的に再描画します。
  * `wsA` / `wsB` / `wsC` の `ready` 時
  * 各種ソケットイベント（`clip_playing`, `clip_preload`, `clip_selected_preload`, `clip_selected_preload_empty`, `clip_stopped`）の受信時

