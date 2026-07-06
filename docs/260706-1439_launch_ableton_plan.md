# Ableton Live 起動機能の実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ableton Live をランチャーアプリ（Neutralinojs）から直接起動できるようにする。

**Architecture:** 
1. `config.json` に Ableton Live の実行ファイルのパス（`abletonPath`）を追加できるようにします。
2. バックエンド拡張機能 `launcher-service` に `/launch-ableton` APIを追加し、設定されたパスの実行ファイルを `child_process.spawn` を使用して独立したプロセスで起動します。
3. フロントエンドのHTML, CSS, JSを変更し、「Ableton Liveを起動」ボタンを追加してAPIと連携させます。

**Tech Stack:** JavaScript (Node.js, Neutralinojs), HTML, CSS

## Global Constraints
* 日本語でのコミットメッセージ (`style: ランチャーのアプリアイコンを更新` など、Conventional Commits 形式) を使用する。
* 自動コミット・自動プッシュはユーザーの確認なしに行わない。

---

### Task 1: config.json の変更

**Files:**
* Modify: [config.json](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/config.json)

**Interfaces:**
* Produces: `appConfig.global.abletonPath` (string)

- [ ] **Step 1: config.json に abletonPath を追加**

`config.json` の `global` セクションに `abletonPath` を追加します。

```json
  "global": {
    "abletonHost": "127.0.0.1",
    "abletonPort": 11000,
    "httpHost": "0.0.0.0",
    "abletonPath": "C:\\ProgramData\\Ableton\\Live 12 Standard\\Program\\Ableton Live 12 Standard.exe",
    "debug": false
  },
```

- [ ] **Step 2: 変更の確認**

`config.json` を表示し、文法的に正しい JSON であることを確認します。

- [ ] **Step 3: コミット**

```bash
git add config.json
git commit -m "config: Ableton Live の起動パス設定を追加"
```

---

### Task 2: バックエンド (launcher-service) への API 実装

**Files:**
* Modify: [packages/suite-launcher/extensions/launcher-service/index.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/extensions/launcher-service/index.js)

**Interfaces:**
* Consumes: `appConfig.global.abletonPath`
* Produces: `POST /launch-ableton` (HTTP API, returns JSON `{ success: boolean, message?: string }`)

- [ ] **Step 1: `/launch-ableton` API の実装**

`launcher-service/index.js` の HTTP サーバーのリクエストハンドラ（`POST` の分岐内）に `/launch-ableton` を追加し、起動処理を実装します。また、`fs` と `child_process` を使用して、指定されたパスにファイルが存在するかを確認し、存在すれば `spawn` で起動します。
独立したプロセスとして起動するため、`detached: true, stdio: 'ignore'` オプションを指定し、起動後に `.unref()` を呼び出します。

`index.js` の `POST` 処理ブロック（`req.url === '/start'` などの付近）に以下を追加します：

```javascript
        if (req.url === '/launch-ableton') {
          const abletonPath = appConfig.global?.abletonPath;
          if (!abletonPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'config.json 内に abletonPath が設定されていません。' }));
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
            const child = spawn(abletonPath, [], {
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
        }
```

- [ ] **Step 2: 手動テストの実行**

APIサーバーが起動している状態で、PowerShell等から cURL で直接 API を叩き、Ableton Live が正常に起動することを確認します。

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3020/launch-ableton" -Method Post
```

期待されるレスポンス: `@{success=True}` (かつ Ableton Live 12 が起動する)

- [ ] **Step 3: コミット**

```bash
git add packages/suite-launcher/extensions/launcher-service/index.js
git commit -m "feat: Ableton Live を起動するAPIをバックエンドに追加"
```

---

### Task 3: フロントエンド UI & スタイルの変更

**Files:**
* Modify: [packages/suite-launcher/resources/index.html](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/index.html)
* Modify: [packages/suite-launcher/resources/css/main.css](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/css/main.css)

- [ ] **Step 1: index.html に起動ボタンを追加**

`index.html` の `header-actions` クラスの中に、`warning` スタイルを持つ「Ableton Liveを起動」ボタンを追加します。

```html
        <div class="header-actions">
            <button id="btn-ableton-start" class="btn warning">Ableton Liveを起動</button>
            <button id="btn-all-start" class="btn primary">すべて起動</button>
            <button id="btn-all-stop" class="btn danger">すべて停止</button>
        </div>
```

- [ ] **Step 2: main.css に警告（警告色・黄色）のボタンスタイルを追加**

`main.css` の `.btn.danger` 定義の直後付近に、`.btn.warning` 定義を追加します。テーマに合わせ、アプリアイコンで使用されている黄色（`#eab02d`）を使用します。

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

- [ ] **Step 3: コミット**

```bash
git add packages/suite-launcher/resources/index.html packages/suite-launcher/resources/css/main.css
git commit -m "style: フロントエンドに Ableton Live 起動ボタンと黄色スタイルを追加"
```

---

### Task 4: フロントエンドでの起動イベント連携

**Files:**
* Modify: [packages/suite-launcher/resources/js/main.js](file:///c:/Users/watat/Documents/MySoftwares/AbletonOSC_Suite/packages/suite-launcher/resources/js/main.js)

- [ ] **Step 1: main.js にボタンイベントを追加**

`main.js` の `window.addEventListener('load', ...)` 内で、`btn-ableton-start` ボタンのクリックイベントを追加し、`/launch-ableton` エンドポイントに POST リクエストを送信する処理を実装します。

```javascript
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
```

- [ ] **Step 2: コミット**

```bash
git add packages/suite-launcher/resources/js/main.js
git commit -m "feat: フロントエンドから Ableton Live 起動APIの呼び出し処理を追加"
```
