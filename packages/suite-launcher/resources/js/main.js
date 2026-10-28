const API_BASE = 'http://127.0.0.1:3020';
const EXTENSION_ID = 'js.neutralino.launcherservice';
let isConsoleOpen = false;
// このウィンドウの launcher-service の状態 (拡張機能から 'launcher:state' で届く)
let serviceState = null;
// /status に答えた launcher-service の PID (古い版は返さないので null)
let statusServicePid = null;

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

        statusServicePid = data.service ? data.service.pid : null;
        renderServiceWarning();
        document.getElementById('local-ip').textContent = `ホストIP: ${data.localIp}`;
        renderApps(data.packages, data.localIp);
    } catch (e) {
        logToConsole('拡張機能（APIサーバー）との接続に失敗しました。');
    }
}

// 前回のランチャーの launcher-service が残っている時の警告
// (画面は、ポート 3020 に残っている古い処理と話してしまい、古い config.json の一覧が出る)
function renderServiceWarning() {
    const box = document.getElementById('service-warning');
    const text = document.getElementById('service-warning-text');
    const button = document.getElementById('btn-replace-stale');
    if (!serviceState) {
        box.hidden = true;
        return;
    }
    const s = serviceState;
    let message = '';
    if (s.mode === 'conflict') {
        const running = s.running && s.running.length ? s.running.join(', ') : 'なし';
        message = s.isLauncherService
            ? `前回のランチャーの処理 (PID ${s.pid}) が残っています。下の一覧はその古い処理のもので、config.json の変更が反映されていません。古い処理の下で動いているパッケージ: ${running}`
            : `ポート 3020 を別のプログラム (PID ${s.pid}) が使っているため、ランチャーの処理を起動できません。`;
    } else if (s.mode === 'replacing') {
        message = '古い処理を止めて、入れ替えています…';
    } else if (s.mode === 'ok' && statusServicePid !== null && statusServicePid !== s.pid) {
        message = `このウィンドウとは別のランチャーの処理 (PID ${statusServicePid}) が答えています。`;
    }
    if (s.error) message = s.error;
    box.hidden = message === '';
    text.textContent = message;
    button.hidden = !(s.mode === 'conflict' && s.isLauncherService);
}

async function replaceStaleService() {
    const s = serviceState;
    const running = s.running && s.running.length ? s.running.join(', ') : 'なし';
    const ok = confirm(`古いランチャーの処理 (PID ${s.pid}) と、その下で動いているパッケージ (${running}) を止めて、新しい処理に入れ替えます。\n\n本番中は止めないでください。続けますか？`);
    if (!ok) return;
    logToConsole(`古い処理 (PID ${s.pid}) を止めて入れ替えます...`);
    try {
        await Neutralino.extensions.dispatch(EXTENSION_ID, 'launcher:replaceStale');
    } catch (err) {
        logToConsole(`入れ替えの依頼に失敗: ${err.message || err.code}`);
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
async function showQrCode(e) {
    const ip = e.target.getAttribute('data-ip');
    const port = e.target.getAttribute('data-port');
    const name = e.target.getAttribute('data-name');
    const url = `http://${ip}:${port}`;

    document.getElementById('qr-url-text').textContent = `${name}: ${url}`;
    const container = document.getElementById('qr-code-img-container');
    container.innerHTML = '生成中...';
    document.getElementById('qr-modal').style.display = 'flex';

    try {
        const res = await fetch(`${API_BASE}/qrcode?url=${encodeURIComponent(url)}`);
        const result = await res.json();
        if (result.success) {
            container.innerHTML = `<img src="${result.qr}" width="200" height="200" alt="QR Code">`;
        } else {
            container.innerHTML = 'QRコードの生成に失敗しました。';
        }
    } catch (err) {
        container.innerHTML = '通信エラーが発生しました。';
        logToConsole(`QRコード生成エラー: ${err.message}`);
    }
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
          Neutralino.events.on('launcher:state', (e) => {
              const prev = serviceState ? serviceState.mode : null;
              serviceState = e.detail;
              if (serviceState.mode === 'conflict' && prev !== 'conflict') {
                  logToConsole(`前回のランチャーの処理 (PID ${serviceState.pid}) が残っています。`);
              }
              if (serviceState.mode === 'ok' && prev && prev !== 'ok') {
                  logToConsole('ランチャーの処理を入れ替えました。');
              }
              renderServiceWarning();
              fetchStatus();
          });
          // 拡張機能につながったら今の状態を送ってもらう (先に届いた知らせを取りこぼさないため)
          Neutralino.extensions.dispatch(EXTENSION_ID, 'launcher:hello')
              .catch(err => logToConsole(`ランチャーの処理と接続できません: ${err.message || err.code}`));
      }
      document.getElementById('btn-replace-stale').addEventListener('click', replaceStaleService);

      // イベント設定
      document.getElementById('btn-all-start').addEventListener('click', () => handleAll('start'));
      document.getElementById('btn-all-stop').addEventListener('click', () => handleAll('stop'));

      // Ableton Live 起動イベント
      document.getElementById('btn-ableton-start').addEventListener('click', async () => {
          logToConsole('Ableton Live を起動しています...');
          try {
              const res = await fetch(`${API_BASE}/launch-ableton`, {
                  method: 'POST'
              });
              const result = await res.json();
              if (result.success) {
                  logToConsole('Ableton Live の起動要求に成功しました。');
              } else {
                  logToConsole(`Ableton Live の起動に失敗: ${result.message}`);
              }
          } catch (err) {
              logToConsole(`通信エラー: ${err.message}`);
          }
      });

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
  
