/* global io */
const socket = io();

let state = null; // サーバーの publicState
let status = null; // 監視の結果
let lastTcAt = 0;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) node.append(c);
    return node;
};

/** サーバーへ操作を送り、結果を待つ */
const call = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

const showError = (res) => {
    if (res && !res.ok) alert((res.problems || ['失敗しました']).join('\n'));
    return res && res.ok;
};

/** "1:23" "1:23.5" "83" "83.5" → 秒。読めなければ null */
const parseTime = (text) => {
    const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
    if (!m) return null;
    const min = m[1] ? Number(m[1]) : 0;
    const sec = Number(m[2]);
    if (m[1] && sec >= 60) return null;
    return min * 60 + sec;
};

const sceneLabel = (scene) => {
    const name = state && state.sceneNames[scene];
    return `${scene + 1}${name ? ` ${name}` : ''}`;
};

// ---- 描画 ----

const renderMode = () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
};

const fillSelect = (select, options, value) => {
    select.replaceChildren(...options.map(([v, label]) => el('option', { value: String(v), textContent: label })));
    if (value !== undefined && value !== null) select.value = String(value);
};

const trackOptions = () => (state.trackNames || []).filter(Boolean).map((n) => [n, n]);

const renderShowSelect = () => {
    const names = Object.keys(state.data.shows);
    fillSelect($('show-select'), names.length ? names.map((n) => [n, n]) : [['', '(ショーがありません)']], state.data.active);
};

const renderSettings = () => {
    const show = state.show;
    const disabled = !show;
    document.querySelectorAll('#show-settings input, #show-settings select, #show-settings button, #add-cue, #auto-assign, #add-scene')
        .forEach((n) => { n.disabled = disabled; });
    if (!show) return;
    fillSelect($('set-rate'), state.rates.map((r) => [r, r === '29.97DF' ? '29.97 ドロップフレーム' : r]), show.rate);
    $('set-tempo').value = show.tempo;
    $('set-level').value = show.levelDb;
    const tracks = trackOptions();
    fillSelect($('set-ltc-track'), [['', '(選んでください)'], ...tracks], show.ltcTrack);
    fillSelect($('set-bgm-track'), [['', '(選んでください)'], ...tracks], show.bgmTrack);
    $('set-output-dir').value = show.outputDir || '';
};

const fileCell = (cue) => {
    if (!cue.file) return el('span', { className: 'file-none', textContent: '未作成' });
    const name = cue.file.split(/[\\/]/).pop();
    if (cue.fileCheck && cue.fileCheck.ok) {
        return el('span', { className: 'file-ok', textContent: `検査済み ${name}`, title: cue.file });
    }
    const problems = cue.fileCheck ? cue.fileCheck.problems.join(' / ') : '未検査';
    return el('span', { className: 'file-ng', textContent: `問題あり: ${problems}`, title: cue.file });
};

const renderCues = () => {
    const tbody = $('cue-table').querySelector('tbody');
    const show = state.show;
    if (!show) {
        tbody.replaceChildren();
        return;
    }
    tbody.replaceChildren(...show.cues.map((cue) => {
        const tcInput = el('input', { className: 'tc', value: cue.startTC });
        tcInput.addEventListener('change', async () => {
            if (!showError(await call('upsert_cue', { cue: { scene: cue.scene, startTC: tcInput.value } }))) tcInput.value = cue.startTC;
        });
        const bgmSelect = el('select');
        fillSelect(bgmSelect, [['', `(ショーの既定: ${show.bgmTrack || '未設定'})`], ...trackOptions()], cue.bgmTrack || '');
        bgmSelect.addEventListener('change', async () => {
            showError(await call('upsert_cue', { cue: { scene: cue.scene, bgmTrack: bgmSelect.value } }));
        });
        const make = el('button', { textContent: cue.file ? '作り直す' : 'LTC ファイルを作る' });
        make.addEventListener('click', async () => {
            make.disabled = true;
            make.textContent = '作成中…';
            const res = await call('create_file', { scene: cue.scene });
            showError(res);
            make.disabled = false;
        });
        const remove = el('button', { textContent: '削除' });
        remove.addEventListener('click', async () => {
            if (confirm(`シーン ${sceneLabel(cue.scene)} を台帳から外しますか？`)) showError(await call('remove_cue', { scene: cue.scene }));
        });
        return el('tr', {}, [
            el('td', { textContent: sceneLabel(cue.scene) }),
            el('td', {}, [bgmSelect]),
            el('td', {}, [tcInput]),
            el('td', {}, [fileCell(cue)]),
            el('td', {}, [make, ' ', remove])
        ]);
    }));
};

const renderSceneSelects = () => {
    const scenes = (state.sceneNames || []).map((_, i) => [i, sceneLabel(i)]);
    const registered = state.show ? state.show.cues.map((c) => [c.scene, sceneLabel(c.scene)]) : [];
    const keep = $('seek-scene').value;
    fillSelect($('seek-scene'), registered.length ? registered : scenes, keep || undefined);
    const used = new Set(state.show ? state.show.cues.map((c) => c.scene) : []);
    fillSelect($('add-scene'), scenes.filter(([i]) => !used.has(i)));
};

const renderState = () => {
    renderMode();
    renderShowSelect();
    renderSettings();
    renderCues();
    renderSceneSelects();
};

const renderStatus = () => {
    const issues = [...(status ? status.issues : [])];
    if (state && state.patchMissing.length && !issues.some((i) => i.code === 'PATCH_MISSING')) {
        issues.unshift({ level: 'error', code: 'PATCH_MISSING', message: `AbletonOSC の改造がありません (${state.patchMissing.join(', ')})` });
    }
    $('issues').replaceChildren(...issues.map((i) => el('div', { className: `issue ${i.level}`, textContent: i.message })));
    const hasError = issues.some((i) => i.level === 'error');
    const hasWarn = issues.some((i) => i.level === 'warn');
    document.body.className = !status ? 'status-waiting'
        : hasError ? 'status-error' : hasWarn ? 'status-warn' : 'status-ok';

    const conn = $('connection');
    conn.textContent = !status ? '接続待ち' : status.connected ? `Live 接続中 (テンポ ${status.tempo})` : 'Live から返信がありません';
    conn.className = !status ? '' : status.connected ? 'ok' : 'ng';

    const a = status && status.active;
    $('now-scene').textContent = a
        ? `シーン ${a.scene + 1} ${a.sceneName}  (開始 ${a.startTC})`
        : '鳴っている台帳のシーンはありません';
    if (!a) $('tc-display').textContent = '--:--:--:--';
};

// 時刻の通知が 0.5 秒来なければ灰色にする (止まった・通知が途切れた)
setInterval(() => {
    $('tc-display').classList.toggle('stale', Date.now() - lastTcAt > 500);
}, 200);

// ---- サーバーからの通知 ----

socket.on('state', (s) => {
    state = s;
    renderState();
    renderStatus();
});
socket.on('status', (s) => {
    status = s;
    renderStatus();
});
socket.on('tc', (d) => {
    lastTcAt = Date.now();
    $('tc-display').textContent = d.text;
});
socket.on('disconnect', () => {
    status = null;
    document.body.className = 'status-error';
    $('connection').textContent = 'LtcSender のサーバーと切断されました';
    $('connection').className = 'ng';
});

// ---- 操作 ----

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', async () => {
    showError(await call('set_mode', { mode: b.dataset.mode }));
}));

$('show-select').addEventListener('change', async (e) => {
    showError(await call('select_show', { name: e.target.value }));
});

$('new-show').addEventListener('click', async () => {
    const name = prompt('ショー名');
    if (name) showError(await call('create_show', { name }));
});

$('save-settings').addEventListener('click', async () => {
    const res = await call('update_show', {
        settings: {
            rate: $('set-rate').value,
            tempo: Number($('set-tempo').value),
            levelDb: Number($('set-level').value),
            ltcTrack: $('set-ltc-track').value,
            bgmTrack: $('set-bgm-track').value,
            outputDir: $('set-output-dir').value.trim()
        }
    });
    showError(res);
});

$('add-cue').addEventListener('click', async () => {
    const scene = Number($('add-scene').value);
    if (Number.isNaN(scene)) return;
    const startTC = state.show.rate === '29.97DF' ? '01:00:00;00' : '01:00:00:00';
    showError(await call('upsert_cue', { cue: { scene, sceneName: state.sceneNames[scene] || '', startTC } }));
});

$('auto-assign').addEventListener('click', async () => {
    if (!confirm('台帳のシーン順に、開始時刻を 01:00:00 から 1 時間ずつ振り直します。作成済みの LTC ファイルは作り直しが必要になります。')) return;
    const res = await call('auto_assign', { firstHour: 1 });
    if (showError(res) && res.warnings && res.warnings.length) alert(res.warnings.join('\n'));
});

/** 本番モードでは確認してから送る */
const confirmIfShow = (message) => state.mode !== 'show' || confirm(`【本番モード】${message}`);

const showResult = (res) => {
    const box = $('seek-result');
    if (res.ok) {
        box.className = 'ok';
        const skipped = res.skipped && res.skipped.length
            ? `。鳴り終わっているため外したトラック: ${res.skipped.map((t) => `${t + 1} ${state.trackNames[t] || ''}`).join(', ')}`
            : '';
        box.textContent = `揃って移動しました (クリップ ${res.positions.length} 本、ずれ ${(res.spread ?? 0).toFixed(4)} 拍)${skipped}`;
    } else {
        box.className = 'ng';
        box.textContent = `実行できませんでした: ${(res.problems || []).join(' / ')}`;
    }
};

$('seek-start').addEventListener('click', async () => {
    const scene = Number($('seek-scene').value);
    const seconds = parseTime($('seek-time').value);
    if (seconds === null) return alert('時刻は 1:23 や 83.5 の形で入れてください');
    if (!confirmIfShow(`シーン ${sceneLabel(scene)} を ${$('seek-time').value} から再生します`)) return;
    showResult(await call('start_from', { scene, seconds, confirmed: true }));
});

$('jump-to').addEventListener('click', async () => {
    const seconds = parseTime($('seek-time').value);
    if (seconds === null) return alert('時刻は 1:23 や 83.5 の形で入れてください');
    if (!confirmIfShow(`再生中のシーンを ${$('seek-time').value} へ飛ばします`)) return;
    showResult(await call('jump', { seconds, confirmed: true }));
});

document.querySelectorAll('.jump-btn').forEach((b) => b.addEventListener('click', async () => {
    const delta = Number(b.dataset.delta);
    if (!confirmIfShow(`再生中のシーンを ${delta > 0 ? '+' : ''}${delta} 秒動かします`)) return;
    showResult(await call('jump', { deltaSeconds: delta, confirmed: true }));
}));
