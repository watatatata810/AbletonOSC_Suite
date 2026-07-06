# Ableton Live 起動機能の設計 (2026-07-06)

ランチャーアプリ（Neutralinojs）から、PCにインストールされている Ableton Live 自体を直接起動できるようにするための機能設計です。

## 変更の概要

1. **設定の外部化**: `config.json` 内で Ableton Live の実行パスをカスタマイズ可能にします。
2. **バックエンドでの起動処理**: `launcher-service` にAPIエンドポイント `/launch-ableton` を追加し、OSの独立したプロセスとして起動します。
3. **フロントエンドUI**: ランチャーのヘッダー右上「すべて起動」の左隣に「Ableton Liveを起動」ボタンを追加し、起動処理の成否をログコンソールに出力します。

---

## 変更対象ファイル

### 1. [config.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/config.json)
`global` に `abletonPath` キーを追加します。

* **追加内容**:
  ```json
  "abletonPath": "C:\\ProgramData\\Ableton\\Live 12 Standard\\Program\\Ableton Live 12 Standard.exe"
  ```

### 2. [packages/suite-launcher/extensions/launcher-service/index.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/extensions/launcher-service/index.js)
* HTTP サーバーに `POST /launch-ableton` を追加します。
* 処理ロジック:
  1. `appConfig.global.abletonPath` の値を取得。
  2. 値がある場合: パス上のファイル存在チェックを行い、存在するなら `child_process.spawn` を用いて起動。
     * ランチャーを終了しても Ableton Live が終了しないよう、`detached: true, stdio: 'ignore'` オプションを適用します。また、子プロセスの参照を保持せず `.unref()` します。
  3. 値がない場合: 主要なデフォルトパス（Live 12 Suite/Standard, Live 11 Suite/Standard など）の自動探索を試みます。
  4. ファイルが存在しない、または起動に失敗した場合は、適切なエラーメッセージと `success: false` を返します。

### 3. [packages/suite-launcher/resources/index.html](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/index.html)
「すべて起動」ボタンの左隣に、起動ボタンを追加します。

* **追加内容**:
  ```html
  <button id="btn-ableton-start" class="btn warning">Ableton Liveを起動</button>
  ```

### 4. [packages/suite-launcher/resources/css/main.css](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/css/main.css)
警告・テーマ色に合わせた黄色のボタンスタイルを追加します。

* **追加内容**:
  ```css
  .btn.warning {
      background-color: #eab02d;
      border-color: #eab02d;
      color: #000000;
  }
  .btn.warning:hover {
      background-color: #d19b22;
  }
  ```

### 5. [packages/suite-launcher/resources/js/main.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/js/main.js)
ボタンのクリックイベントを設定し、バックエンドのAPIを呼び出します。

* **実装内容**:
  * アプリロード時に `btn-ableton-start` のクリックイベントを購読。
  * `/launch-ableton` に POST リクエストを送信し、成否を `logToConsole` で出力します。

---

## 検証計画

### 手動検証
1. ランチャーを起動し、ヘッダーに黄色の「Ableton Liveを起動」ボタンが表示されることを確認。
2. ボタンをクリックし、Ableton Live 12 が正常にバックグラウンドまたはフォアグラウンドで起動することを確認。
3. 起動後, ランチャーを閉じて終了しても、起動した Ableton Live 12 が終了せずに独立して動作し続けることを確認。
4. `config.json` のパスを一時的に無効なものに変更し、ボタンをクリックした際に「実行ファイルが見つからない」旨のエラーログが出力されることを確認。
