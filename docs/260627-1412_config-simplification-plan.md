# config.json 簡素化およびインライン集約 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `config.json` 内の設定重複を解消し、すべてのパッケージ固有設定を `packages` 配列内に集約し、保守性と新規パッケージ追加時の拡張性を向上させる。

**Architecture:** 
1. 共通ローダー `configLoader.js` に `getPackageConfig(config, pkgName)` ヘルパーを追加して後方互換性を担保しつつ設定を抽出できるようにする。
2. `config.json` のスキーマを更新し、下部の個別オブジェクトを廃止する。
3. `osc-router`、`viewWaves`、`DaihonTrigger`、`OscTester`、および `launcher-service` を修正し、新しい設定スキーマおよびヘルパーを利用するように変更する。

**Tech Stack:** Node.js, JavaScript, JSON, Neutralinojs

## Global Constraints
- `config.json` の `packages` 内では Webポートを `httpPort`、OSC受信ポートを `oscPort` に名前を統一する。
- 既存の動作を破壊しないよう、一時的に古い設定オブジェクトが残っていても動作する後方互換マッピングを `getPackageConfig` にて実装する。
- コミットは Git の Conventional Commits 形式に従い、かつ日本語で本文を記述する。

---

### Task 1: 共通ローダー `configLoader.js` の拡張と単体テスト

**Files:**
- Modify: `packages/shared-utils/configLoader.js`
- Create: `packages/shared-utils/testConfigLoader.js`

**Interfaces:**
- Consumes: None
- Produces: `getPackageConfig(config, pkgName)` (引数: configオブジェクト, パッケージ名文字列。戻り値: マージされた設定オブジェクト)

- [ ] **Step 1: テスト用スクリプトの作成**
  
  `packages/shared-utils/testConfigLoader.js` を作成し、`getPackageConfig` の挙動を検証するコードを記述します。
  
  ```javascript
  // packages/shared-utils/testConfigLoader.js
  const { getPackageConfig } = require('./configLoader');
  const assert = require('assert');
  
  const mockConfig = {
    packages: [
      { name: 'testApp', httpPort: 5000, oscPort: 6000 }
    ],
    testApp: {
      legacyParam: 'yes',
      httpPort: 4000 // 旧設定の値
    }
  };
  
  // テスト1: 新しいインライン設定が正しく取得できること、旧設定とマージされて新設定（packages内）が優先されること
  const result = getPackageConfig(mockConfig, 'testApp');
  try {
    assert.strictEqual(result.httpPort, 5000, 'packages内の設定が優先されるべきです');
    assert.strictEqual(result.oscPort, 6000, 'packages内の設定が取得できるべきです');
    assert.strictEqual(result.legacyParam, 'yes', '個別オブジェクトの設定もマージされるべきです');
    console.log('✓ Task 1 Tests Passed!');
  } catch (err) {
    console.error('✗ Task 1 Tests Failed:', err.message);
    process.exit(1);
  }
  ```

- [ ] **Step 2: スクリプトの実行（失敗することを確認）**
  
  Run: `node packages/shared-utils/testConfigLoader.js`
  Expected: FAIL (getPackageConfig is not a function)

- [ ] **Step 3: `configLoader.js` に `getPackageConfig` を実装**
  
  `packages/shared-utils/configLoader.js` を修正します。
  
  ```javascript
  // configLoader.js の末尾付近
  const getPackageConfig = (config, pkgName) => {
      if (!config) return {};
      const pkg = (config.packages || []).find(p => p.name === pkgName) || {};
      
      const legacyKey = Object.keys(config).find(
          key => key.toLowerCase() === pkgName.toLowerCase() && key !== 'packages' && key !== 'global'
      );
      const legacyConfig = legacyKey ? config[legacyKey] : {};
  
      return {
          ...legacyConfig,
          ...pkg
      };
  };
  
  module.exports = {
      loadConfig,
      getPackageConfig
  };
  ```

- [ ] **Step 4: テストの実行と検証**
  
  Run: `node packages/shared-utils/testConfigLoader.js`
  Expected: PASS (`✓ Task 1 Tests Passed!` が出力されること)

- [ ] **Step 5: コミット**
  
  ```bash
  git add packages/shared-utils/configLoader.js packages/shared-utils/testConfigLoader.js
  git commit -m "feat: configLoaderにパッケージ設定取得用のgetPackageConfigを追加"
  ```

---

### Task 2: `config.json` スキーマの簡素化

**Files:**
- Modify: `config.json`

**Interfaces:**
- Consumes: None
- Produces: 新しい `config.json` データ構造

- [ ] **Step 1: `config.json` の書き換え**
  
  `config.json` を編集し、不要になった下部の個別設定を削除し、`packages` のインライン要素に移植します。
  
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

- [ ] **Step 2: JSON構文の検証**
  
  Run: `node -e "require('./config.json')"`
  Expected: エラーなく終了すること

- [ ] **Step 3: コミット**
  
  ```bash
  git add config.json
  git commit -m "refactor: config.jsonの設定をpackages配列へインライン集約"
  ```

---

### Task 3: 各パッケージ（`viewWaves`、`DaihonTrigger`、`OscTester`）の修正

**Files:**
- Modify: `packages/viewWaves/server.js`
- Modify: `packages/DaihonTrigger/server.js`
- Modify: `packages/OscTester/server.js`

**Interfaces:**
- Consumes: `getPackageConfig(config, pkgName)`
- Produces: 新設定に準拠した各ポートでのWeb/OSCサーバーの起動

- [ ] **Step 1: `viewWaves/server.js` の修正**
  
  `packages/viewWaves/server.js` 内の設定読み込み処理を書き換えます。
  
  ```javascript
  // 変更前
  const { loadConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  
  const clientHost = config.global?.abletonHost ?? '127.0.0.1';
  const clientPort = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000);
  const serverPort = config.viewWaves?.oscPort ?? (process.env.OSC_PORT || 11002);
  // ...
  const WEB_PORT = config.viewWaves?.httpPort ?? (process.env.PORT || 3000);
  
  // 変更後
  const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  const pkgConfig = getPackageConfig(config, 'viewWaves');
  
  const clientHost = config.global?.abletonHost ?? '127.0.0.1';
  const clientPort = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000);
  const serverPort = pkgConfig.oscPort ?? (process.env.OSC_PORT || 11002);
  // ...
  const WEB_PORT = pkgConfig.httpPort ?? (process.env.PORT || 3000);
  ```

- [ ] **Step 2: `DaihonTrigger/server.js` の修正**
  
  `packages/DaihonTrigger/server.js` 内の設定読み込み処理を書き換えます。
  
  ```javascript
  // 変更前
  const { loadConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  
  const HTTP_PORT = config.daihonTrigger?.httpPort ?? (process.env.PORT || 3001); 
  const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
  const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
  const ABLETON_OSC_PORT = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000); 
  const OSC_CONCURRENCY_LIMIT = config.daihonTrigger?.oscConcurrencyLimit ?? (parseInt(process.env.OSC_CONCURRENCY_LIMIT, 10) || 20);
  const OSC_TIMEOUT = config.daihonTrigger?.oscTimeout ?? (parseInt(process.env.OSC_TIMEOUT, 10) || 1000);
  const NODE_OSC_PORT = config.daihonTrigger?.oscPort ?? (process.env.OSC_PORT || 11001);
  
  // 変更後
  const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  const pkgConfig = getPackageConfig(config, 'DaihonTrigger');
  
  const HTTP_PORT = pkgConfig.httpPort ?? (process.env.PORT || 3001); 
  const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
  const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
  const ABLETON_OSC_PORT = config.global?.abletonPort ?? (process.env.ABLETON_PORT || 11000); 
  const OSC_CONCURRENCY_LIMIT = pkgConfig.oscConcurrencyLimit ?? (parseInt(process.env.OSC_CONCURRENCY_LIMIT, 10) || 20);
  const OSC_TIMEOUT = pkgConfig.oscTimeout ?? (parseInt(process.env.OSC_TIMEOUT, 10) || 1000);
  const NODE_OSC_PORT = pkgConfig.oscPort ?? (process.env.OSC_PORT || 11003);
  ```

- [ ] **Step 3: `OscTester/server.js` の修正**
  
  `packages/OscTester/server.js` 内の設定読み込み処理を書き換えます。
  
  ```javascript
  // 変更前
  const { loadConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  
  const HTTP_PORT = config.oscTester?.httpPort ?? 3010;
  const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
  const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
  const ABLETON_OSC_PORT = config.global?.abletonPort ?? 11000;
  const NODE_OSC_PORT = config.oscTester?.oscPort ?? 11004;
  
  // 変更後
  const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const config = loadConfig(configPath);
  const pkgConfig = getPackageConfig(config, 'OscTester');
  
  const HTTP_PORT = pkgConfig.httpPort ?? 3010;
  const HTTP_HOST = config.global?.httpHost ?? '0.0.0.0';
  const ABLETON_OSC_HOST = config.global?.abletonHost ?? '127.0.0.1';
  const ABLETON_OSC_PORT = config.global?.abletonPort ?? 11000;
  const NODE_OSC_PORT = pkgConfig.oscPort ?? 11004;
  ```

- [ ] **Step 4: 各サーバーがスタンドアロンで起動できるかの簡易チェック**
  
  各ディレクトリで一時的に `node` スクリプトとして起動を試みます（Portが正しく読まれることの確認）。
  
  Run 1: `node packages/viewWaves/server.js` (すぐに Ctrl+C で終了)
  Expected: エラー（ポート競合など）を起こさず、正常にリスニングログ等が出力されること。
  
  Run 2: `node packages/DaihonTrigger/server.js` (すぐに Ctrl+C で終了)
  Expected: 同様に正常起動ログが出力されること。
  
  Run 3: `node packages/OscTester/server.js` (すぐに Ctrl+C で終了)
  Expected: 同様に正常起動ログが出力されること。

- [ ] **Step 5: コミット**
  
  ```bash
  git add packages/viewWaves/server.js packages/DaihonTrigger/server.js packages/OscTester/server.js
  git commit -m "feat: 各パッケージのサーバーでgetPackageConfigを用いた設定読み込みに対応"
  ```

---

### Task 4: `osc-router` の修正（転送先ポートの動的収集化）

**Files:**
- Modify: `packages/osc-router/index.js`

**Interfaces:**
- Consumes: `packages` 内の各要素の `oscPort`
- Produces: 自動検出されたポートへの OSC パケット複製転送

- [ ] **Step 1: `osc-router/index.js` の修正**
  
  固定のキーマッピングから、`packages` 配列を走査する動的収集ロジックへ変更します。
  
  ```javascript
  // 変更前
  const { loadConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const parsed = loadConfig(configPath);
  
  const targetPorts = [];
  if (parsed.viewWaves?.oscPort) targetPorts.push(Number(parsed.viewWaves.oscPort));
  if (parsed.daihonTrigger?.oscPort) targetPorts.push(Number(parsed.daihonTrigger.oscPort));
  if (parsed.oscTester?.oscPort) targetPorts.push(Number(parsed.oscTester.oscPort));
  
  config = {
    host: parsed.oscRouter?.host || DEFAULT_CONFIG.host,
    listenPort: parsed.oscRouter?.listenPort !== undefined ? Number(parsed.oscRouter.listenPort) : DEFAULT_CONFIG.listenPort,
    targetPorts: targetPorts.length > 0 ? targetPorts : DEFAULT_CONFIG.targetPorts
  };
  
  // 変更後
  const { loadConfig, getPackageConfig } = require('../shared-utils/configLoader');
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  const parsed = loadConfig(configPath);
  const routerConfig = getPackageConfig(parsed, 'osc-router');
  
  const targetPorts = [];
  if (parsed.packages && Array.isArray(parsed.packages)) {
    parsed.packages.forEach(pkg => {
      if (pkg.name !== 'osc-router' && pkg.oscPort) {
        targetPorts.push(Number(pkg.oscPort));
      }
    });
  }
  
  config = {
    host: routerConfig.host || DEFAULT_CONFIG.host,
    listenPort: routerConfig.listenPort !== undefined ? Number(routerConfig.listenPort) : DEFAULT_CONFIG.listenPort,
    targetPorts: targetPorts.length > 0 ? targetPorts : DEFAULT_CONFIG.targetPorts
  };
  ```

- [ ] **Step 2: `osc-router` の起動テスト**
  
  Run: `node packages/osc-router/index.js` (すぐに Ctrl+C)
  Expected: 起動メッセージに出力される転送先ポートとして `11002, 11003, 11004` が表示されること。
  
  出力例: `転送ポート: 11002, 11003, 11004 へ複製転送中`

- [ ] **Step 3: コミット**
  
  ```bash
  git add packages/osc-router/index.js
  git commit -m "feat: osc-routerにてpackages配列から転送先oscPortを動的収集するよう改善"
  ```

---

### Task 5: `launcher-service` の修正と全体の検証

**Files:**
- Modify: `packages/suite-launcher/extensions/launcher-service/index.js`

**Interfaces:**
- Consumes: `packages` 配列内パッケージの `httpPort` および `oscPort`
- Produces: `/status` API による正しいポート返却、および起動プロセスの環境変数適用

- [ ] **Step 1: `launcher-service/index.js` の修正**
  
  `packagesList` 生成、環境変数決定、ステータスポートの返却箇所を修正します。
  
  ```javascript
  // 変更前（39行目付近）
    packagesList = [
      { name: 'osc-router', dir: 'packages/osc-router', type: 'node', startCmd: 'index.js' },
      { name: 'viewWaves', dir: 'packages/viewWaves', type: 'neutralino' },
      { name: 'DaihonTrigger', dir: 'packages/DaihonTrigger', type: 'node', startCmd: 'server.js', port: appConfig.daihonTrigger?.httpPort || 3001 },
      { name: 'OscTester', dir: 'packages/OscTester', type: 'node', startCmd: 'server.js', port: appConfig.oscTester?.httpPort || 3010 }
    ];
  
  // 変更後
    packagesList = [
      { name: 'osc-router', dir: 'packages/osc-router', type: 'node', startCmd: 'index.js', listenPort: 11001 },
      { name: 'viewWaves', dir: 'packages/viewWaves', type: 'neutralino', httpPort: 3000, oscPort: 11002 },
      { name: 'DaihonTrigger', dir: 'packages/DaihonTrigger', type: 'node', startCmd: 'server.js', httpPort: 3001, oscPort: 11003 },
      { name: 'OscTester', dir: 'packages/OscTester', type: 'node', startCmd: 'server.js', httpPort: 3010, oscPort: 11004 }
    ];
  ```
  
  ```javascript
  // 変更前（98-117行目付近、spawn時の環境変数）
    let child;
    if (pkg.type === 'neutralino') {
      // ...
      child = spawn(binaryPath, ['--load-dir-res', '--path=.'], {
        cwd: pkgDir,
        env: { ...process.env, OSC_PORT: '11002', PORT: '3000' }
      });
    } else {
      const nodePath = process.execPath;
      const scriptPath = path.join(pkgDir, pkg.startCmd);
  
      const env = { ...process.env };
      if (pkgName === 'viewWaves') {
        env.OSC_PORT = '11002';
      } else if (pkgName === 'DaihonTrigger') {
        env.OSC_PORT = '11003';
      }
  
      child = spawn(nodePath, [scriptPath], {
        cwd: pkgDir,
        env: env
      });
    }
  
  // 変更後
    let child;
    const env = { ...process.env };
    if (pkg.oscPort) env.OSC_PORT = String(pkg.oscPort);
    if (pkg.httpPort) env.PORT = String(pkg.httpPort);
  
    if (pkg.type === 'neutralino') {
      // ... (プラットフォーム判定)
      child = spawn(binaryPath, ['--load-dir-res', '--path=.'], {
        cwd: pkgDir,
        env: env
      });
    } else {
      const nodePath = process.execPath;
      const scriptPath = path.join(pkgDir, pkg.startCmd);
  
      child = spawn(nodePath, [scriptPath], {
        cwd: pkgDir,
        env: env
      });
    }
  ```
  
  ```javascript
  // 変更前（202行目付近の /status レスポンス）
      packages: packagesList.map(pkg => ({
        name: pkg.name,
        port: pkg.port || null,
        status: runningProcesses[pkg.name]?.status || 'stopped',
        pid: runningProcesses[pkg.name]?.pid || null
      }))
  
  // 変更後
      packages: packagesList.map(pkg => ({
        name: pkg.name,
        port: pkg.httpPort || null,
        status: runningProcesses[pkg.name]?.status || 'stopped',
        pid: runningProcesses[pkg.name]?.pid || null
      }))
  ```

- [ ] **Step 2: `/status` レスポンスの検証**
  
  一時的に `launcher-service` を起動し、ステータスAPIのポート情報が正しく返ってくるか検証します。
  
  1. `node packages/suite-launcher/extensions/launcher-service/index.js` を実行 (バックグラウンドタスクまたは別端で実行)
  2. ブラウザまたは curl 等で `http://127.0.0.1:3020/status` にアクセス。
  3. `packages` 内の `viewWaves` の `port` が `3000`、`DaihonTrigger` が `3001`、`OscTester` が `3010` になっていることを確認する。
  4. 確認後、`launcher-service` を終了。

- [ ] **Step 3: ランチャー連携・統合動作テスト**
  
  ランチャーUIを使って全体の起動と連携を検証します。
  
  1. ランチャーを起動する (`npm run dev` 等)
  2. 画面上から `viewWaves` または `DaihonTrigger` を起動する。
  3. 自動的に `osc-router` が起動し、その後対象アプリが正常に起動し、WebUIにアクセスできることを確認する。
  4. Ableton Live からの波形データ、トリガーデータが正常に転送され通信が機能することを確認する。

- [ ] **Step 4: コミット**
  
  ```bash
  git add packages/suite-launcher/extensions/launcher-service/index.js
  git commit -m "feat: launcher-serviceにて各パッケージ定義から動的にポートや環境変数を解決するよう改善"
  ```
