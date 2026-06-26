# AbletonOSC Suite Launcher 実装計画書

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AbletonOSC Suite の各パッケージを一元的に起動・停止・監視できる、モダンでソリッドなデザインの Neutralinojs デスクトップランチャーを構築する。

**Architecture:** ランチャーは Neutralinojs ウィンドウアプリとして起動し、バックグラウンドの Node.js 拡張機能（Extension）が HTTP API サーバー（ポート `3020`）を立ち上げます。フロントエンドUIは Fetch API を用いて拡張機能と通信し、OS判定に基づいた他パッケージプロセスの起動・停止・状態取得およびローカルIPのQRコード生成を行います。ランチャー終了時には、起動した全子プロセスを自動的にクリーンアップ（Poka-Yoke）します。

**Tech Stack:** Neutralinojs, Node.js, Express (or native `http` module), `qrcode` (フロントエンド表示用), Vanilla CSS/HTML/JS (No Glassmorphism).

## Global Constraints
* 既存の他パッケージ（`osc-router`, `viewWaves`, `DaihonTrigger` 等）のコードは一切変更しない。
* 自動での git commit / push は絶対に行わず、手順内の git commit コマンドは手動実行用とする。
* デザインにはガラスモーフィズムを採用せず、ソリッドなダークモードで構成する。
* OS（Windows, macOS, Linux）に応じてコマンドやバイナリのパスを動的に切り替える。

---

### Task 1: ランチャーのパッケージ初期化と Neutralinojs 設定の配置

**Files:**
* Create: `packages/suite-launcher/package.json`
* Create: `packages/suite-launcher/neutralino.config.json`
* Create: `packages/suite-launcher/run.js`

**Interfaces:**
* Consumes: なし
* Produces: Neutralinojs ランチャーの基本骨格

- [ ] **Step 1: packages/suite-launcher ディレクトリの作成と package.json の新規作成**
  
  以下の内容で [package.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/package.json) を作成する。
  ```json
  {
    "name": "suite-launcher",
    "version": "1.0.0",
    "private": true,
    "main": "run.js",
    "scripts": {
      "start": "node run.js"
    }
  }
  ```

- [ ] **Step 2: Neutralinojs 設定ファイル neutralino.config.json の作成**

  拡張機能 `js.neutralino.launcherservice`（Node.js）を定義した [neutralino.config.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/neutralino.config.json) を作成する。
  ```json
  {
    "$schema": "https://raw.githubusercontent.com/neutralinojs/neutralinojs/main/schemas/neutralino.config.schema.json",
    "applicationId": "jp.watatatata810.abletonosc-launcher",
    "version": "1.0.0",
    "singleInstance": true,
    "defaultMode": "window",
    "port": 0,
    "documentRoot": "/resources/",
    "url": "/index.html",
    "enableServer": true,
    "enableNativeAPI": true,
    "enableExtensions": true,
    "tokenSecurity": "one-time",
    "logging": {
      "enabled": true,
      "writeToLogFile": true
    },
    "nativeAllowList": [
      "app.*",
      "os.*"
    ],
    "extensions": [
      {
        "id": "js.neutralino.launcherservice",
        "command": "node extensions/launcher-service/index.js"
      }
    ],
    "modes": {
      "window": {
        "title": "AbletonOSC Suite Launcher",
        "width": 900,
        "height": 600,
        "minWidth": 600,
        "minHeight": 400,
        "center": true,
        "alwaysOnTop": false,
        "icon": "/resources/favicon.ico",
        "enableInspector": true,
        "exitProcessOnClose": true
      }
    },
    "cli": {
      "binaryName": "neutralino",
      "resourcesPath": "/resources/",
      "extensionsPath": "/extensions/",
      "clientLibrary": "/resources/js/neutralino.js",
      "binaryVersion": "6.8.0",
      "clientVersion": "6.8.0"
    }
  }
  ```

- [ ] **Step 3: 起動スクリプト run.js の作成**

  OSを判定して正しいバイナリを呼び出す [run.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/run.js) を作成する。
  ```javascript
  const { exec } = require('child_process');
  const path = require('path');

  let binary = '';
  if (process.platform === 'win32') {
    binary = 'neutralino-win_x64.exe';
  } else if (process.platform === 'darwin') {
    binary = 'neutralino-mac_x64';
  } else {
    binary = 'neutralino-linux_x64';
  }

  const binaryPath = path.join(__dirname, 'bin', binary);
  const cmd = `"${binaryPath}" --load-dir-res --path=.`;

  console.log(`[Launcher] Starting Neutralinojs binary: ${binaryPath}`);
  exec(cmd, (err) => {
    if (err) {
      console.error('Failed to start Neutralinojs:', err);
      process.exit(1);
    }
  });
  ```

- [ ] **Step 4: バイナリと resources フォルダの初期コピー**

  `viewWaves` から共通のバイナリと resources フォルダをコピーする。
  ```powershell
  # packages/suite-launcher ディレクトリを作成
  mkdir packages/suite-launcher
  # bin フォルダのコピー
  Copy-Item -Recurve packages/viewWaves/bin packages/suite-launcher/bin
  # resources フォルダのコピー
  Copy-Item -Recurve packages/viewWaves/resources packages/suite-launcher/resources
  ```
  ※ コピー完了後、[resources/index.html](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/index.html) の中身は後ほど上書きします。

- [ ] **Step 5: ルート package.json への起動スクリプト追加**

  ルートの [package.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/package.json) の `"scripts"` に以下を追加する。
  ```json
  "start:launcher": "npm run start --workspace=suite-launcher"
  ```

- [ ] **Step 6: コミット（※ユーザー承認後に実行）**
  ```bash
  git add packages/suite-launcher package.json
  git commit -m "feat: suite-launcher パッケージ構造と設定の作成"
  ```

---

### Task 2: バックグラウンド Node.js 拡張 (launcher-service) の実装

**Files:**
* Create: `packages/suite-launcher/extensions/launcher-service/package.json`
* Create: `packages/suite-launcher/extensions/launcher-service/index.js`

**Interfaces:**
* Consumes: なし（独立したHTTP APIサーバー）
* Produces: ポート `3020` で稼働する HTTP API (GET `/status`, POST `/start`, POST `/stop`)

- [ ] **Step 1: launcher-service の package.json 作成**

  依存関係（`tree-kill` など）を定義した [package.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/extensions/launcher-service/package.json) を作成する。
  ```json
  {
    "name": "launcher-service",
    "version": "1.0.0",
    "main": "index.js",
    "dependencies": {
      "tree-kill": "^1.2.2"
    }
  }
  ```

- [ ] **Step 2: launcher-service の依存関係インストール**

  ```powershell
  cd packages/suite-launcher/extensions/launcher-service
  npm install
  cd ../../../..
  ```

- [ ] **Step 3: バックグラウンド処理 index.js の作成**

  OS判定、ローカルIP取得、プロセス監視、キル（Poka-Yoke）および HTTP API サーバーを実装した [index.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/extensions/launcher-service/index.js) を作成する。
  ```javascript
  const http = require('http');
  const { spawn } = require('child_process');
  const path = require('path');
  const os = require('os');
  const kill = require('tree-kill');

  const PORT = 3020;
  const runningProcesses = {}; // { packageName: { process, pid, status } }

  // config.json の読み込み
  const configPath = path.join(__dirname, '..', '..', '..', '..', 'config.json');
  let appConfig = {};
  try {
    appConfig = require(configPath);
  } catch (e) {
    console.error('Failed to load config.json', e);
  }

  // 管理対象パッケージ定義
  const packagesList = [
    { name: 'osc-router', dir: 'packages/osc-router', type: 'node', startCmd: 'index.js' },
    { name: 'viewWaves', dir: 'packages/viewWaves', type: 'neutralino' },
    { name: 'DaihonTrigger', dir: 'packages/DaihonTrigger', type: 'node', startCmd: 'server.js', port: appConfig.daihonTrigger?.httpPort || 3001 },
    { name: 'OscTester', dir: 'packages/OscTester', type: 'node', startCmd: 'server.js', port: appConfig.oscTester?.httpPort || 3010 }
  ];

  // ローカルIPの取得
  function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  // プロセスの起動
  function startPackage(pkgName) {
    if (runningProcesses[pkgName] && runningProcesses[pkgName].status === 'running') {
      return { success: false, message: 'Already running' };
    }

    const pkg = packagesList.find(p => p.name === pkgName);
    if (!pkg) return { success: false, message: 'Package not found' };

    const workspaceRoot = path.join(__dirname, '..', '..', '..', '..');
    const pkgDir = path.join(workspaceRoot, pkg.dir);

    let child;
    if (pkg.type === 'neutralino') {
      let binary = '';
      if (process.platform === 'win32') {
        binary = 'neutralino-win_x64.exe';
      } else if (process.platform === 'darwin') {
        binary = 'neutralino-mac_x64';
      } else {
        binary = 'neutralino-linux_x64';
      }
      const binaryPath = path.join(pkgDir, 'bin', binary);
      child = spawn(binaryPath, ['--load-dir-res', '--path=.'], {
        cwd: pkgDir,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } else {
      const isWin = process.platform === 'win32';
      const nodePath = process.execPath; // 現在実行中の node バイナリのパス
      const scriptPath = path.join(pkgDir, pkg.startCmd);

      // 環境変数を引き継ぐ
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

    runningProcesses[pkgName] = {
      process: child,
      pid: child.pid,
      status: 'running'
    };

    // ログおよび終了監視
    if (child.stdout) {
      child.stdout.on('data', (data) => console.log(`[${pkgName}] ${data.toString().trim()}`));
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => console.error(`[${pkgName}] ERR: ${data.toString().trim()}`));
    }

    child.on('close', (code) => {
      console.log(`[${pkgName}] stopped with code ${code}`);
      runningProcesses[pkgName] = { status: 'stopped' };
    });

    child.on('error', (err) => {
      console.error(`[${pkgName}] error:`, err);
      runningProcesses[pkgName] = { status: 'error', error: err.message };
    });

    return { success: true, pid: child.pid };
  }

  // プロセスの停止
  function stopPackage(pkgName) {
    const procInfo = runningProcesses[pkgName];
    if (!procInfo || procInfo.status !== 'running') {
      return { success: false, message: 'Not running' };
    }

    return new Promise((resolve) => {
      kill(procInfo.pid, 'SIGKILL', (err) => {
        if (err) {
          console.error(`Failed to kill process tree for ${pkgName}:`, err);
          resolve({ success: false, message: err.message });
        } else {
          runningProcesses[pkgName] = { status: 'stopped' };
          resolve({ success: true });
        }
      });
    });
  }

  // HTTP API サーバー作成
  const server = http.createServer(async (req, res) => {
    // CORS ヘッダー追加
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const statusData = {
        localIp: getLocalIP(),
        packages: packagesList.map(pkg => ({
          name: pkg.name,
          port: pkg.port || null,
          status: runningProcesses[pkg.name]?.status || 'stopped',
          pid: runningProcesses[pkg.name]?.pid || null
        }))
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusData));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (req.url === '/start') {
            const result = startPackage(data.package);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (req.url === '/stop') {
            const result = await stopPackage(data.package);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    console.log(`[Launcher Extension] HTTP API Server running on port ${PORT}`);
  });

  // Poka-Yoke: プロセス親終了時のクリーンアップ
  function cleanup() {
    console.log('[Launcher Extension] Cleaning up child processes...');
    const keys = Object.keys(runningProcesses);
    for (const key of keys) {
      if (runningProcesses[key]?.status === 'running') {
        console.log(`Killing ${key} (PID: ${runningProcesses[key].pid})`);
        try {
          kill(runningProcesses[key].pid, 'SIGKILL');
        } catch (e) {
          console.error(`Error killing ${key}:`, e);
        }
      }
    }
    process.exit(0);
  }

  // 終了シグナルの検知
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('exit', cleanup);
  ```

- [ ] **Step 4: コミット（※ユーザー承認後に実行）**
  ```bash
  git add packages/suite-launcher/extensions/launcher-service
  git commit -m "feat: バックグラウンドプロセス管理HTTPサーバー (launcher-service) の実装"
  ```

---

### Task 3: フロントエンド UI (HTML/CSS/JS) の実装

**Files:**
* Modify: `packages/suite-launcher/resources/index.html`
* Create: `packages/suite-launcher/resources/css/main.css`
* Create: `packages/suite-launcher/resources/js/main.js`

**Interfaces:**
* Consumes: HTTP API (ポート `3020`)
* Produces: フラットなダークモードUIおよびQRコード表示機能

- [ ] **Step 1: resources/index.html の上書き作成**

  以下の内容で [index.html](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/index.html) を上書きする。
  ```html
  <!DOCTYPE html>
  <html lang="ja">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AbletonOSC Suite Launcher</title>
      <link rel="stylesheet" href="css/main.css">
  </head>
  <body>
      <header>
          <h1>AbletonOSC Suite Launcher</h1>
          <div class="header-info">
              <span id="local-ip">検出中...</span>
          </div>
          <div class="header-actions">
              <button id="btn-all-start" class="btn primary">すべて起動</button>
              <button id="btn-all-stop" class="btn danger">すべて停止</button>
          </div>
      </header>

      <main>
          <div id="apps-grid" class="grid">
              <!-- 動的生成されるアプリカード -->
          </div>
      </main>

      <!-- QRコードポップアップモーダル -->
      <div id="qr-modal" class="modal">
          <div class="modal-content">
              <span class="close-modal">&times;</span>
              <h2>iPad等での接続用 QRコード</h2>
              <p id="qr-url-text"></p>
              <div id="qr-code-img-container"></div>
          </div>
      </div>

      <!-- ログコンソール -->
      <footer>
          <div class="console-header" id="console-toggle">
              <span>コンソールログ</span>
              <span class="toggle-icon">▲</span>
          </div>
          <div class="console-body" id="console-logs"></div>
      </footer>

      <script src="js/neutralino.js"></script>
      <!-- QRコード生成ライブラリ (CDN/ローカルに代替可能、今回は安全なローカル生成APIまたはCDNを使用) -->
      <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
      <script src="js/main.js"></script>
  </body>
  </html>
  ```

- [ ] **Step 2: CSS (css/main.css) の新規作成**

  ガラスモーフィズムを排除し、境界線を強調したソリッドなダークモードスタイルを [main.css](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/css/main.css) として作成する。
  ```css
  :root {
      --bg-color: #121212;
      --card-bg: #1e1e1e;
      --border-color: #333333;
      --text-color: #e0e0e0;
      --text-dim: #888888;
      --primary-color: #007acc;
      --primary-hover: #005999;
      --success-color: #4caf50;
      --danger-color: #f44336;
      --danger-hover: #d32f2f;
  }

  body {
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
  }

  header {
      background-color: var(--card-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 15px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
  }

  header h1 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 600;
  }

  .header-info {
      font-size: 0.9rem;
      color: var(--text-dim);
  }

  .header-actions {
      display: flex;
      gap: 10px;
  }

  .btn {
      padding: 8px 16px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
      font-weight: 550;
      background-color: #2a2a2a;
      color: var(--text-color);
      transition: background-color 0.2s;
  }

  .btn:hover {
      background-color: #383838;
  }

  .btn.primary {
      background-color: var(--primary-color);
      border-color: var(--primary-color);
  }

  .btn.primary:hover {
      background-color: var(--primary-hover);
  }

  .btn.danger {
      background-color: var(--danger-color);
      border-color: var(--danger-color);
  }

  .btn.danger:hover {
      background-color: var(--danger-hover);
  }

  main {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
  }

  .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
  }

  .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 180px;
  }

  .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
  }

  .card h3 {
      margin: 0;
      font-size: 1.2rem;
  }

  .status-badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: bold;
      background-color: #333333;
  }

  .status-badge.running {
      background-color: var(--success-color);
      color: #000;
  }

  .status-badge.stopped {
      background-color: #555555;
      color: var(--text-color);
  }

  .status-badge.error {
      background-color: var(--danger-color);
      color: #fff;
  }

  .card-body {
      margin: 15px 0;
      font-size: 0.85rem;
      color: var(--text-dim);
  }

  .card-actions {
      display: flex;
      gap: 8px;
  }

  /* Modal Styles */
  .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.8);
      justify-content: center;
      align-items: center;
  }

  .modal-content {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      padding: 25px;
      border-radius: 8px;
      text-align: center;
      max-width: 400px;
      width: 80%;
  }

  .close-modal {
      float: right;
      font-size: 28px;
      cursor: pointer;
      color: var(--text-dim);
  }

  .close-modal:hover {
      color: var(--text-color);
  }

  #qr-code-img-container {
      margin-top: 15px;
      background: white;
      padding: 10px;
      display: inline-block;
  }

  /* Console Styles */
  footer {
      background-color: #1a1a1a;
      border-top: 1px solid var(--border-color);
  }

  .console-header {
      padding: 8px 20px;
      background-color: #252526;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      color: var(--text-dim);
  }

  .console-body {
      height: 120px;
      overflow-y: auto;
      padding: 10px 20px;
      font-family: monospace;
      font-size: 0.8rem;
      background-color: #1e1e1e;
      color: #d4d4d4;
      display: none;
  }

  .console-body.open {
      display: block;
  }
  ```

- [ ] **Step 3: resources/js/main.js の作成**

  フロントエンドのポーリング状態監視、起動停止リクエスト、およびQRコードモーダル表示ロジックを含む [main.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/js/main.js) を作成する。
  ```javascript
  const API_BASE = 'http://localhost:3020';
  let isConsoleOpen = false;

  // ログ出力関数
  function logToConsole(message) {
      const logsDiv = document.getElementById('console-logs');
      const time = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.textContent = `[${time}] ${message}`;
      logsDiv.appendChild(line);
      logsDiv.scrollTop = logsDiv.scrollHeight;
  }

  // ステータス取得とUI更新
  async function fetchStatus() {
      try {
          const res = await fetch(`${API_BASE}/status`);
          const data = await res.json();
          
          document.getElementById('local-ip').textContent = `ホストIP: ${data.localIp}`;
          renderApps(data.packages, data.localIp);
      } catch (e) {
          logToConsole('拡張機能（APIサーバー）との接続に失敗しました。');
      }
  }

  // アプリケーションカードのレンダリング
  function renderApps(apps, localIp) {
      const grid = document.getElementById('apps-grid');
      grid.innerHTML = '';

      apps.forEach(app => {
          const card = document.createElement('div');
          card.className = 'card';

          const isRunning = app.status === 'running';

          let infoHtml = `ステータス: ${app.status.toUpperCase()}`;
          if (app.port) {
              infoHtml += `<br>ポート: ${app.port}`;
          }

          card.innerHTML = `
              <div class="card-header">
                  <h3>${app.name}</h3>
                  <span class="status-badge ${app.status}">${app.status}</span>
              </div>
              <div class="card-body">
                  ${infoHtml}
              </div>
              <div class="card-actions">
                  <button class="btn btn-toggle" data-name="${app.name}" data-action="${isRunning ? 'stop' : 'start'}">
                      ${isRunning ? '停止' : '起動'}
                  </button>
                  ${app.port && app.name !== 'viewWaves' ? `
                      <button class="btn primary btn-open" data-port="${app.port}">ブラウザ</button>
                      <button class="btn btn-qr" data-ip="${localIp}" data-port="${app.port}" data-name="${app.name}">QRコード</button>
                  ` : ''}
              </div>
          `;

          grid.appendChild(card);
      });

      // イベントリスナーの再紐付け
      document.querySelectorAll('.btn-toggle').forEach(btn => {
          btn.addEventListener('click', handleToggle);
      });
      document.querySelectorAll('.btn-open').forEach(btn => {
          btn.addEventListener('click', (e) => {
              const port = e.target.getAttribute('data-port');
              Neutralino.os.open(`http://localhost:${port}`);
          });
      });
      document.querySelectorAll('.btn-qr').forEach(btn => {
          btn.addEventListener('click', showQrCode);
      });
  }

  // 起動・停止の切り替え処理
  async function handleToggle(e) {
      const name = e.target.getAttribute('data-name');
      const action = e.target.getAttribute('data-action');

      logToConsole(`${name} を ${action === 'start' ? '起動' : '停止'} しています...`);

      try {
          const res = await fetch(`${API_BASE}/${action}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ package: name })
          });
          const result = await res.json();
          if (result.success) {
              logToConsole(`${name} の ${action === 'start' ? '起動' : '停止'} に成功しました。`);
          } else {
              logToConsole(`${name} の操作に失敗: ${result.message}`);
          }
          fetchStatus();
      } catch (err) {
          logToConsole(`通信エラー: ${err.message}`);
      }
  }

  // QRコードの表示
  function showQrCode(e) {
      const ip = e.target.getAttribute('data-ip');
      const port = e.target.getAttribute('data-port');
      const name = e.target.getAttribute('data-name');
      const url = `http://${ip}:${port}`;

      document.getElementById('qr-url-text').textContent = `${name}: ${url}`;
      const container = document.getElementById('qr-code-img-container');
      container.innerHTML = '';

      QRCode.toCanvas(url, { width: 200 }, function (error, canvas) {
          if (error) {
              logToConsole(`QRコード生成エラー: ${error}`);
              return;
          }
          container.appendChild(canvas);
          document.getElementById('qr-modal').style.display = 'flex';
      });
  }

  // 全起動・全停止処理
  async function handleAll(action) {
      logToConsole(`すべてのパッケージを一括 ${action === 'start' ? '起動' : '停止'} します...`);
      try {
          const res = await fetch(`${API_BASE}/status`);
          const data = await res.json();
          for (const app of data.packages) {
              const isRunning = app.status === 'running';
              if (action === 'start' && !isRunning) {
                  await fetch(`${API_BASE}/start`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ package: app.name })
                  });
              } else if (action === 'stop' && isRunning) {
                  await fetch(`${API_BASE}/stop`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ package: app.name })
                  });
              }
          }
          fetchStatus();
      } catch (e) {
          logToConsole(`一括処理エラー: ${e.message}`);
      }
  }

  // 初期化イベント
  window.addEventListener('load', () => {
      // Neutralino 初期化
      if (typeof Neutralino !== 'undefined') {
          Neutralino.init();
      }

      // イベント設定
      document.getElementById('btn-all-start').addEventListener('click', () => handleAll('start'));
      document.getElementById('btn-all-stop').addEventListener('click', () => handleAll('stop'));

      document.getElementById('console-toggle').addEventListener('click', () => {
          isConsoleOpen = !isConsoleOpen;
          document.getElementById('console-logs').classList.toggle('open', isConsoleOpen);
          document.querySelector('.toggle-icon').textContent = isConsoleOpen ? '▼' : '▲';
      });

      document.querySelector('.close-modal').addEventListener('click', () => {
          document.getElementById('qr-modal').style.display = 'none';
      });

      window.onclick = function(event) {
          const modal = document.getElementById('qr-modal');
          if (event.target === modal) {
              modal.style.display = 'none';
          }
      }

      // ステータスポーリングの開始
      fetchStatus();
      setInterval(fetchStatus, 2000);
      logToConsole('ランチャーUIがロードされました。');
  });
  ```

- [ ] **Step 4: コミット（※ユーザー承認後に実行）**
  ```bash
  git add packages/suite-launcher/resources/index.html packages/suite-launcher/resources/css/main.css packages/suite-launcher/resources/js/main.js
  git commit -m "feat: ランチャーUIのクリーンなダークモード実装とAPI連携"
  ```

---

### Task 4: 動作検証とポカヨケテスト

**Files:**
* None

**Interfaces:**
* Consumes: アプリ全体
* Produces: 動作確認済みのランチャー

- [ ] **Step 1: ランチャーの起動テスト**

  ルートディレクトリから以下を実行し、ランチャーウィンドウが開くことを確認する。
  ```powershell
  npm run start:launcher
  ```

- [ ] **Step 2: ローカルIPアドレスおよびQRコード表示確認**
  * ホストIPが `127.0.0.1` 以外の実IP（`192.168.X.X` など）で表示されていることを確認。
  * `DaihonTrigger` カードの「QRコード」ボタンをクリックし、拡大キャンバスが正しくポップアップすることを確認。

- [ ] **Step 3: 各パッケージの起動・終了テスト**
  * `osc-router` の起動を押して、緑色の `running` になることを確認。
  * `viewWaves` を起動して、現状と同じ専用の Neutralino ウィンドウが起動することを確認。
  * ブラウザで `DaihonTrigger` 等を開き、正常動作することを確認。その後、停止ボタンで終了することを確認。

- [ ] **Step 4: ゾンビプロセス防止（ポカヨケ）の確認**
  * ランチャーのメインウィンドウを閉じる。
  * タスクマネージャー（または `ps` コマンド）を開き、`node` や `neutralino` のプロセスがすべて終了し、残存していないことを確認する。
