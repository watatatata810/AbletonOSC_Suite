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
