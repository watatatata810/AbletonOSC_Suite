# config.json の設定簡素化およびインライン集約設計仕様書

## 1. 目的と概要
`config.json` において、`packages` 配列内の定義と、ファイル下部のパッケージ個別オブジェクト（`viewWaves`、`daihonTrigger`、`oscTester`）の間で、ポート番号などの設定情報が重複して定義されています。
本設計では、これらの固有設定を `packages` 配列内の各要素に直接定義する「インライン集約方式」に統一し、設定の重複管理を解消するとともに、新規パッケージ追加時の拡張性を向上させます。

---

## 2. 設計方針

### 2.1 設定ファイル (`config.json`) の新スキーマ
下部の個別オブジェクトを廃止し、`packages` の各要素の直下にポート（`httpPort`、`oscPort`）や個別パラメータ（`oscConcurrencyLimit`等）を定義します。

```json
{
  "global": {
    "abletonHost": "127.0.0.1",
    "abletonPort": 11000,
    "httpHost": "0.0.0.0",
    "debug": false
  },
  "packages": [
    {
      "name": "osc-router",
      "dir": "packages/osc-router",
      "type": "node",
      "startCmd": "index.js",
      "host": "127.0.0.1",
      "listenPort": 11001
    },
    {
      "name": "viewWaves",
      "dir": "packages/viewWaves",
      "type": "neutralino",
      "httpPort": 3000,
      "oscPort": 11002,
      "pollInterval": 500,
      "dependencies": ["osc-router"]
    },
    {
      "name": "DaihonTrigger",
      "dir": "packages/DaihonTrigger",
      "type": "node",
      "startCmd": "server.js",
      "httpPort": 3001,
      "oscPort": 11003,
      "oscConcurrencyLimit": 50,
      "oscTimeout": 1000,
      "dependencies": ["osc-router"]
    },
    {
      "name": "OscTester",
      "dir": "packages/OscTester",
      "type": "node",
      "startCmd": "server.js",
      "httpPort": 3010,
      "oscPort": 11004,
      "dependencies": ["osc-router"]
    }
  ]
}
```

### 2.2 共通設定ローダーの拡張 (`shared-utils/configLoader.js`)
各パッケージが自身のインライン設定を容易に、かつ後方互換性を保ちながら取得できるよう、`getPackageConfig` ヘルパーを公開します。
ファイル下部に旧形式の個別オブジェクトが存在する場合でも、それを自動でマージして取得します。

### 2.3 各パッケージの対応
- **`osc-router`**: 転送先ポートの動的収集化。`packages` 配列を走査し、`oscPort` が定義されているすべてのパッケージを転送対象とします。
- **`viewWaves`、`DaihonTrigger`、`OscTester`**: `getPackageConfig` 経由でポートおよび個別パラメータを読み込むよう修正します。
- **`launcher-service`**: プロセス起動時の環境変数 `PORT` や `OSC_PORT` を、該当パッケージオブジェクト内の `httpPort` / `oscPort` から動的に設定します。また、`/status` API で返却する各パッケージのポート値を `pkg.port` から `pkg.httpPort` に更新します。

---

## 3. 影響範囲と変更対象ファイル

1. **[config.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/config.json)**:
   - スキーマの更新（個別オブジェクトの廃止、パッケージ内パラメータの追加）
2. **[packages/shared-utils/configLoader.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/shared-utils/configLoader.js)**:
   - `getPackageConfig` 関数の追加およびエクスポート
3. **[packages/osc-router/index.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/osc-router/index.js)**:
   - 設定取得方式の変更
   - `targetPorts` の動的収集ループ実装
4. **[packages/viewWaves/server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/viewWaves/server.js)**:
   - `getPackageConfig` を用いた設定取得への変更
5. **[packages/DaihonTrigger/server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/DaihonTrigger/server.js)**:
   - `getPackageConfig` を用いた設定取得への変更
6. **[packages/OscTester/server.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/OscTester/server.js)**:
   - `getPackageConfig` を用いた設定取得への変更
7. **[packages/suite-launcher/extensions/launcher-service/index.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/extensions/launcher-service/index.js)**:
   - `pkg.port` から `pkg.httpPort` への変更
   - 起動時の環境変数 `OSC_PORT`、`PORT` の動的決定ロジック導入

---

## 4. 検証計画

### 4.1 ユニットテスト/動作確認
1. **設定ローダーの互換性テスト**: 新旧両方の形式、または新形式のみで設定が正しく取得できることを検証する。
2. **パッケージの起動テスト**: ランチャーから各パッケージ（`viewWaves`、`DaihonTrigger`、`OscTester`）を起動し、正しい `httpPort` でサーバーが起動すること、また `osc-router` が自動的に連動起動することを確認する。
3. **通信テスト**:
   - `osc-router` が `packages` 配列から動的に `oscPort`（11002、11003、11004）を収集し、Ableton Live からの OSC メッセージを複製して正しく各アプリへ転送できていることを確認する。
   - `viewWaves` 画面にて波形が問題なく表示されること。
   - `DaihonTrigger` および `OscTester` が正常にAbletonと通信できること。
