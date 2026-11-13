const http = require('http');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const kill = require('tree-kill');
const QRCode = require('qrcode');
const fs = require('fs');
const { neutralinoBinaryName } = require('../../../shared-utils/neutralinoBinary');

const PORT = 3020;
const IS_WINDOWS = process.platform === 'win32';
const logFilePath = path.join(__dirname, 'extension.log');

function logToFile(msg) {
  try {
    const time = new Date().toISOString();
    fs.appendFileSync(logFilePath, `[${time}] ${msg}\n`);
  } catch (e) {
    // ログ書き込み失敗時は無視
  }
}
const runningProcesses = {}; // { packageName: { process, pid, status, intentional } }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 予期しない終了に対する自動再起動 ---
// osc-router のようなバックグラウンドプロセスが落ちると、転送経路が黙って消えて
// 全アプリが「波形が出ない」状態のまま復旧しないため、node 型に限って再起動する。
// （neutralino 型はウィンドウを閉じる＝ユーザーの終了意思なので対象外）
// クラッシュループを避けるため、60秒未満で死んだ場合のみ試行回数を数え、上限で打ち切る。
const RESTART_MAX_ATTEMPTS = 5;
const RESTART_DELAY_MS = 1000;
const RESTART_STABLE_MS = 60 * 1000; // これ以上生きていたら試行回数をリセット
const restartCounts = {}; // { packageName: count }
let shuttingDown = false;

// config.json の読み込み
const configPath = path.join(__dirname, '..', '..', '..', '..', 'config.json');
let appConfig = {};
try {
  appConfig = require(configPath);
} catch (e) {
  logToFile('Failed to load config.json: ' + e.message);
}

// config.json からパッケージ定義をロード
let packagesList = appConfig.packages || [];
if (packagesList.length === 0) {
  // 互換性フォールバック用の定義
  packagesList = [
    { name: 'osc-router', dir: 'packages/osc-router', type: 'node', startCmd: 'index.js', listenPort: 11001 },
    { name: 'viewWaves', dir: 'packages/viewWaves', type: 'neutralino', httpPort: 3000, oscPort: 11002 },
    { name: 'DaihonTrigger', dir: 'packages/DaihonTrigger', type: 'node', startCmd: 'server.js', httpPort: 3001, oscPort: 11003 },
    { name: 'OscTester', dir: 'packages/OscTester', type: 'node', startCmd: 'server.js', httpPort: 3010, oscPort: 11004 }
  ];
}

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
async function startPackage(pkgName) {
  if (runningProcesses[pkgName] && runningProcesses[pkgName].status === 'running') {
    return { success: false, message: 'Already running' };
  }

  const pkg = packagesList.find(p => p.name === pkgName);
  if (!pkg) return { success: false, message: 'Package not found' };

  // 依存パッケージのチェックと自動起動
  if (pkg.dependencies && pkg.dependencies.length > 0) {
    for (const depName of pkg.dependencies) {
      const depProc = runningProcesses[depName];
      if (!depProc || depProc.status !== 'running') {
        logToFile(`[${pkgName}] Found dependency [${depName}] is not running. Starting [${depName}] first.`);
        const depResult = await startPackage(depName);
        if (!depResult.success) {
          logToFile(`[${pkgName}] Failed to start dependency [${depName}]: ${depResult.message}`);
          return { success: false, message: `Failed to start dependency [${depName}]: ${depResult.message}` };
        }
        logToFile(`[${pkgName}] Waiting 500ms for [${depName}] to initialize...`);
        await sleep(500);
      }
    }
  }

  const workspaceRoot = path.join(__dirname, '..', '..', '..', '..');
  const pkgDir = path.join(workspaceRoot, pkg.dir);

  let child;
  const env = { ...process.env };
  if (pkg.oscPort) env.OSC_PORT = String(pkg.oscPort);
  if (pkg.httpPort) env.PORT = String(pkg.httpPort);

  if (pkg.type === 'neutralino') {
    const binaryPath = path.join(pkgDir, 'bin', neutralinoBinaryName());
    // 診断ログ収集および環境変数の明示的伝達のため、標準入出力をパイプし、環境変数を引き渡す
    child = spawn(binaryPath, ['--load-dir-res', '--path=.'], {
      cwd: pkgDir,
      env: env
    });
  } else {
    const nodePath = process.execPath; // 現在実行中の node バイナリのパス
    const scriptPath = path.join(pkgDir, pkg.startCmd);

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
    child.stdout.on('data', (data) => logToFile(`[${pkgName}] ${data.toString().trim()}`));
  }
  if (child.stderr) {
    child.stderr.on('data', (data) => logToFile(`[${pkgName}] ERR: ${data.toString().trim()}`));
  }

  const startedAt = Date.now();
  child.on('close', (code) => {
    const wasIntentional = runningProcesses[pkgName]?.intentional === true;
    logToFile(`[${pkgName}] stopped with code ${code}`);
    runningProcesses[pkgName] = { status: 'stopped' };

    // 予期しない終了なら自動再起動する（stop API 経由・ランチャー終了時は再起動しない）
    if (wasIntentional || shuttingDown || pkg.type !== 'node') return;

    if (Date.now() - startedAt >= RESTART_STABLE_MS) {
      restartCounts[pkgName] = 0; // 十分生きていたので試行回数をリセット
    }
    const attempts = restartCounts[pkgName] || 0;
    if (attempts >= RESTART_MAX_ATTEMPTS) {
      logToFile(`[${pkgName}] Auto-restart limit (${RESTART_MAX_ATTEMPTS}) reached. Giving up.`);
      return;
    }
    restartCounts[pkgName] = attempts + 1;
    logToFile(`[${pkgName}] Unexpected exit. Auto-restarting in ${RESTART_DELAY_MS}ms (attempt ${attempts + 1}/${RESTART_MAX_ATTEMPTS})`);
    setTimeout(() => {
      if (shuttingDown) return;
      startPackage(pkgName).then(result => {
        if (!result.success) logToFile(`[${pkgName}] Auto-restart failed: ${result.message}`);
      }).catch(e => logToFile(`[${pkgName}] Auto-restart error: ${e.message}`));
    }, RESTART_DELAY_MS);
  });

  child.on('error', (err) => {
    logToFile(`[${pkgName}] error: ` + err.message);
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

  // 意図的な停止であることを close ハンドラに伝える（自動再起動の対象外にする）
  procInfo.intentional = true;

  return new Promise((resolve) => {
    kill(procInfo.pid, 'SIGKILL', (err) => {
      if (err) {
        logToFile(`Failed to kill process tree for ${pkgName}: ` + err.message);
        procInfo.intentional = false; // 停止に失敗したのでフラグを戻す
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

  if (req.method === 'GET' && req.url.startsWith('/qrcode')) {
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = urlParams.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400);
      res.end('Missing url parameter');
      return;
    }
    try {
      const qrDataUrl = await QRCode.toDataURL(targetUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, qr: qrDataUrl }));
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    const statusData = {
      // 画面が、自分のウィンドウの launcher-service と話しているかを確かめるため
      service: { pid: process.pid },
      localIp: getLocalIP(),
      packages: packagesList.map(pkg => ({
        name: pkg.name,
        port: pkg.httpPort || null,
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
        const data = body ? JSON.parse(body) : {};
        if (req.url === '/start') {
          const result = await startPackage(data.package);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (req.url === '/stop') {
          const result = await stopPackage(data.package);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (req.url === '/launch-ableton') {
          // Mac では abletonPathMac (Ableton Live の .app) を使う。Windows と同じ config.json を共有するため分けている
          const pathKey = process.platform === 'darwin' ? 'abletonPathMac' : 'abletonPath';
          const abletonPath = appConfig.global?.[pathKey];
          if (!abletonPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: `config.json 内に ${pathKey} が設定されていません。` }));
            return;
          }

          if (!fs.existsSync(abletonPath)) {
            logToFile(`Ableton Live not found at: ${abletonPath}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: `指定されたパスに Ableton Live が見つかりません: ${abletonPath}` }));
            return;
          }

          logToFile(`Launching Ableton Live from: ${abletonPath}`);
          try {
            // Mac の .app はフォルダなので直接は実行できない。open -a で開く
            const [command, args] = process.platform === 'darwin'
              ? ['open', ['-a', abletonPath]]
              : [abletonPath, []];
            const child = spawn(command, args, {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            logToFile(`Failed to launch Ableton Live: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: `起動エラー: ${err.message}` }));
          }
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

// --- ポート 3020 の取り合い ---
// 前回のランチャーの launcher-service が残っていると、ポート 3020 を使えない。
// 黙って落ちると、画面は残っている古いサービス (古い config.json の内容) につながってしまうため、
// 古いサービスの PID と、その下で動いているパッケージを調べて画面に知らせる。
// 入れ替えは、画面で確認して「止めて入れ替える」を押した時だけ行う (本番中に勝手に止めないため)。
let serviceState = { mode: 'starting' }; // starting | ok | conflict | replacing

const execText = (command) => new Promise((resolve) => {
  exec(command, { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout));
});

/** ポートで待ち受けているプロセスの PID (Windows は netstat、Mac / Linux は lsof を読む)。見つからなければ null */
async function findListeningPid(port) {
  if (!IS_WINDOWS) {
    const out = await execText(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
    const n = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  const out = await execText('netstat -ano -p tcp');
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && cols[3] === 'LISTENING') return Number(cols[4]);
  }
  return null;
}

async function getCommandLine(pid) {
  const out = IS_WINDOWS
    ? await execText(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`)
    : await execText(`ps -o command= -p ${pid}`);
  return out.trim();
}

/** 残っている古いサービスの /status (動いているパッケージを知るため) */
function fetchOldStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/status', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function detectConflict() {
  const pid = await findListeningPid(PORT);
  const commandLine = pid ? await getCommandLine(pid) : '';
  const old = await fetchOldStatus();
  const running = old ? old.packages.filter(p => p.status === 'running').map(p => p.name) : [];
  serviceState = {
    mode: 'conflict',
    pid,
    commandLine,
    isLauncherService: commandLine.includes('launcher-service'),
    running
  };
  logToFile(`[Launcher Extension] Port ${PORT} is in use by PID ${pid} (${commandLine}). Running under it: ${running.join(', ') || 'none'}`);
  broadcastState();
}

// 待ち受けに失敗して listen() をやり直しても、成功時の処理が重ならないよう 1 回だけ登録する
server.on('listening', () => {
  serviceState = { mode: 'ok', pid: process.pid };
  logToFile(`[Launcher Extension] HTTP API Server running on port ${PORT}`);
  broadcastState();
});

function listen() {
  server.listen(PORT);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    detectConflict().catch(e => logToFile('[Launcher Extension] Failed to inspect port conflict: ' + e.message));
    return;
  }
  logToFile('[Launcher Extension] HTTP server error: ' + err.message);
});

/** 画面で確認された時だけ呼ぶ。古いサービスをパッケージごと止めて、ポート 3020 を引き継ぐ */
async function replaceStaleService() {
  if (serviceState.mode !== 'conflict') return;
  const { pid, isLauncherService } = serviceState;
  if (!pid || !isLauncherService) {
    // launcher-service 以外のプロセスがポートを使っている時は止めない
    logToFile(`[Launcher Extension] Refusing to stop PID ${pid}: not a launcher-service process`);
    broadcastState({ error: `ポート ${PORT} を使っているのはランチャーの処理ではないため、止めませんでした (PID ${pid})` });
    return;
  }
  serviceState = { ...serviceState, mode: 'replacing' };
  broadcastState();
  logToFile(`[Launcher Extension] Stopping stale launcher-service (PID ${pid}) and its packages...`);
  await new Promise((resolve) => kill(pid, 'SIGKILL', (err) => {
    if (err) logToFile(`Failed to kill stale launcher-service: ${err.message}`);
    resolve();
  }));
  await sleep(500);
  listen();
}

// --- Neutralino との接続と、終了の検知 ---
// Neutralino は終了する時に拡張機能を止めない (https://neutralino.js.org/docs/how-to/extensions-overview/)。
// 公式の方法は「WebSocket の接続が切れたら終了する」だが、Windows では Neutralino が終了しても
// 接続が切れない (Neutralino のソケットのハンドルが、起動された cmd.exe / node に引き継がれていて
// ソケットが閉じない。2026-10-28 実測: Neutralino 終了後も接続が Established のまま残った)。
// そのため、Neutralino のプロセスが生きているかを定期的に確かめ、終了していたら止まる。
// WebSocket が切れた時の終了も念のため残す。
// 接続情報は起動時に標準入力へ JSON で渡される。
const PARENT_CHECK_MS = 2000;

async function getParentPid(pid) {
  const out = IS_WINDOWS
    ? await execText(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`)
    : await execText(`ps -o ppid= -p ${pid}`);
  const n = Number(out.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** 自分を起動した Neutralino (node ← cmd.exe /c ← neutralino) が終了したら止まる */
async function watchNeutralinoProcess() {
  // Windows では cmd.exe /c を間に挟んで起動される。
  // Mac / Linux は直接の親かシェルを挟んだ先かを確かめていないため、祖先を 3 代までたどって探す
  let neutralinoPid = null;
  let name = '';
  if (IS_WINDOWS) {
    neutralinoPid = await getParentPid(process.ppid);
    name = neutralinoPid ? await getCommandLine(neutralinoPid) : '';
  } else {
    let pid = process.ppid;
    for (let i = 0; i < 3 && pid && pid > 1; i++) {
      const cmd = await getCommandLine(pid);
      if (cmd.includes('neutralino')) {
        neutralinoPid = pid;
        name = cmd;
        break;
      }
      pid = await getParentPid(pid);
    }
  }
  if (!neutralinoPid) {
    logToFile('[Launcher Extension] Could not find the Neutralino process. The service will not stop when the window closes.');
    return;
  }
  if (!name.includes('neutralino')) {
    logToFile(`[Launcher Extension] Parent PID ${neutralinoPid} is not Neutralino (${name}). Not watching it.`);
    return;
  }
  logToFile(`[Launcher Extension] Watching Neutralino (PID ${neutralinoPid})`);
  setInterval(() => {
    if (!isAlive(neutralinoPid)) shutdown(`Neutralino (PID ${neutralinoPid}) exited`);
  }, PARENT_CHECK_MS);
}
let nlSocket = null;
let nlAuth = null;

function sendToNeutralino(method, data) {
  if (!nlSocket || nlSocket.readyState !== 1 || !nlAuth) return;
  nlSocket.send(JSON.stringify({ id: crypto.randomUUID(), method, accessToken: nlAuth.nlToken, data }));
}

/** 画面 (main.js) へ今の状態を知らせる */
function broadcastState(extra = {}) {
  sendToNeutralino('app.broadcast', { event: 'launcher:state', data: { ...serviceState, ...extra } });
}

function connectNeutralino(auth) {
  nlAuth = auth;
  const url = `ws://localhost:${auth.nlPort}?extensionId=${auth.nlExtensionId}&connectToken=${auth.nlConnectToken}`;
  if (typeof WebSocket === 'undefined') {
    logToFile(`[Launcher Extension] WebSocket is not available in Node ${process.version}. The service cannot detect the window closing.`);
    return;
  }
  nlSocket = new WebSocket(url);
  nlSocket.addEventListener('open', () => {
    logToFile('[Launcher Extension] Connected to Neutralino');
    broadcastState();
  });
  nlSocket.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.event === 'launcher:hello') broadcastState();
    else if (msg.event === 'launcher:replaceStale') {
      replaceStaleService().catch(err => logToFile('[Launcher Extension] Replace failed: ' + err.message));
    }
  });
  nlSocket.addEventListener('close', () => shutdown('Neutralino connection closed'));
  nlSocket.addEventListener('error', () => logToFile('[Launcher Extension] Neutralino connection error'));
}

function readNeutralinoAuth() {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf('\n');
    const text = nl >= 0 ? buf.slice(0, nl) : buf;
    try {
      const auth = JSON.parse(text);
      process.stdin.off('data', onData);
      connectNeutralino(auth);
    } catch (e) {
      // JSON が分割して届いた場合は続きを待つ
    }
  };
  process.stdin.on('data', onData);
}

// Poka-Yoke: 終了時に、起動したパッケージを止め終えてから終了する
let shutdownStarted = false;
async function shutdown(reason) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true; // 終了処理中の close イベントで自動再起動しないようにする
  logToFile(`[Launcher Extension] Shutting down (${reason}). Cleaning up child processes...`);
  const kills = Object.keys(runningProcesses)
    .filter(key => runningProcesses[key]?.status === 'running')
    .map(key => new Promise((resolve) => {
      logToFile(`Killing ${key} (PID: ${runningProcesses[key].pid})`);
      kill(runningProcesses[key].pid, 'SIGKILL', (err) => {
        if (err) logToFile(`Error killing ${key}: ` + err.message);
        resolve();
      });
    }));
  // 止まらないプロセスがあっても、3 秒で見切って終了する
  await Promise.race([Promise.all(kills), sleep(3000)]);
  process.exit(0);
}

// 終了シグナルの検知
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

readNeutralinoAuth();
watchNeutralinoProcess().catch(e => logToFile('[Launcher Extension] Failed to watch Neutralino: ' + e.message));
listen();
