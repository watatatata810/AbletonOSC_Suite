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
  
