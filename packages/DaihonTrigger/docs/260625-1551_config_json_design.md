# config.json 設定一元管理 設計書

## 1. 理解の要約 (Understanding Summary)
* **目的**: プロジェクト全体の各種パラメータ（ポート、ホストIP、タイムアウトなど）を一括管理し、ユーザーがエディタから簡単に変更できるようにする。
* **解決策**: プロジェクトのルートフォルダに階層分けされた `config.json` を配置し、各パッケージの起動時に自動で読み込む仕組みを構築する。
* **決定優先順位**: **`config.json ＞ 環境変数 (process.env) ＞ ハードコードされたデフォルト値`** の順で適用する。
* **非目標（Non-goals）**: サーバー起動中の `config.json` の変更をリアルタイムで検知・反映する動的リロード機能は実装しない（起動時のみ読み込み）。

## 2. 前提条件 (Assumptions)
* **`config.json` の作成場所**:
  プロジェクトルート直下（`c:\Users\watat\Documents\MySoftwares\AbletonOSC_Suite\config.json`）
* **初期定義スキーマ**:
  ```json
  {
    "global": {
      "abletonHost": "127.0.0.1",
      "abletonPort": 11000
    },
    "viewWaves": {
      "httpPort": 3000,
      "oscPort": 11002
    },
    "daihonTrigger": {
      "httpPort": 3001,
      "oscPort": 11001,
      "oscConcurrencyLimit": 20,
      "oscTimeout": 1000
    }
  }
  ```

## 3. 決定ログ (Decision Log)
* **決定事項**: 階層型 JSON 設定ファイル `config.json` をルートに導入し、優先順位を `JSON ＞ 環境変数 ＞ デフォルト値` とする。
* **理由**: 一元管理の利便性を高めつつ、ユーザーが設定した値が環境変数などの既存動作に邪魔されずに確実に適用されるようにし、記述ミスに対しても安全にフォールバック（動作継続）させるため。

## 4. 詳細設計 (Detailed Design)

### 4.1. 共通ヘルパー関数の実装
各サーバープログラムの冒頭に、設定ファイルを安全に読み込む以下の関数を配置します。

```javascript
const loadConfig = () => {
    // packages/サブディレクトリから見て2階層上のルートフォルダにある config.json のパスを解決
    const configPath = path.join(__dirname, '..', '..', 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (err) {
            console.error(`\n[Config Error] config.json の解析に失敗しました。`);
            console.error(`記述に誤り（カンマや引用符の不足など）がないか確認してください。デフォルト値で起動します。\n`);
        }
    }
    return {};
};
const config = loadConfig();
```

### 4.2. 各サーバーでの優先適用記述

#### DaihonTrigger/server.js
```javascript
const HTTP_PORT = config.daihonTrigger?.httpPort ?? (process.env.PORT || 3001); 
const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
const ABLETON_OSC_PORT = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000); 
const NODE_OSC_PORT = config.daihonTrigger?.oscPort ?? (process.env.OSC_PORT || 11001);

const OSC_CONCURRENCY_LIMIT = config.daihonTrigger?.oscConcurrencyLimit ?? (parseInt(process.env.OSC_CONCURRENCY_LIMIT, 10) || 20);
const OSC_TIMEOUT = config.daihonTrigger?.oscTimeout ?? (parseInt(process.env.OSC_TIMEOUT, 10) || 1000);
```

#### viewWaves/server.js
```javascript
const clientHost = config.global?.abletonHost ?? '127.0.0.1';
const clientPort = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000);
const serverPort = config.viewWaves?.oscPort ?? (process.env.OSC_PORT || 11002);
const WEB_PORT = config.viewWaves?.httpPort ?? (process.env.PORT || 3000);
```

## 5. テストプラン (Verification Plan)
1. **正常起動テスト**: ルートフォルダに `config.json` を作成し、デフォルトのポート設定で起動を確認。
2. **優先設定テスト**: `config.json` のポートを `3005` などに変更して起動し、変更したポートでアクセスできることを確認。
3. **構文エラー耐性テスト**: `config.json` の構文（カンマなど）をあえて壊し、クラッシュせずデフォルト値で正常起動することを確認。
