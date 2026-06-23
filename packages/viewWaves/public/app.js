const socket = io();
// Text status was removed, we use body class instead
const waveformsContainer = document.getElementById('waveforms-container');

// ラグ補正（レイテンシ先読み）の設定値
let latencyOffsetMs = 0;
const latencySlider = document.getElementById('latency-slider');
const latencyValue = document.getElementById('latency-value');

function updateEmptyState() {
    const emptyMsg = document.getElementById('empty-state-message');
    if (!emptyMsg) return;
    
    const hasVisibleTrack = document.querySelector('.track-box.visible');
    if (hasVisibleTrack) {
        emptyMsg.classList.add('hidden');
    } else {
        emptyMsg.classList.remove('hidden');
    }
}

if (latencySlider && latencyValue) {
    latencySlider.addEventListener('input', (e) => {
        latencyOffsetMs = parseInt(e.target.value, 10);
        latencyValue.textContent = latencyOffsetMs;
    });
}

const syncButton = document.getElementById('sync-button');
if (syncButton) {
    syncButton.addEventListener('click', () => {
        // ボタンの視覚的フィードバック
        const originalText = syncButton.textContent;
        syncButton.textContent = '⏳ 同期中...';
        syncButton.style.opacity = '0.7';
        syncButton.style.pointerEvents = 'none';
        
        setTimeout(() => {
            syncButton.textContent = originalText;
            syncButton.style.opacity = '1';
            syncButton.style.pointerEvents = 'auto';
        }, 1000);

        Object.values(tracks).forEach(t => {
            t.boxEl.classList.remove('visible');
            t.currentSceneIndex = -1;
            t.infoEl.textContent = '同期中...';
        });
        socket.emit('force_sync');
    });
}

// Track state
// key: trackId, value: { ws, containerEl }
const tracks = {};

let isSongPlaying = false;

// ==========================================
// 純粋関数群 (Pure Functions)
// ==========================================

/**
 * 進行度（0.0〜1.0）を計算する
 * @param {number} position 現在の拍数 (beats)
 * @param {Object} markerData マーカー情報
 * @param {number} durationSec 音声ファイルの実時間 (seconds)
 * @returns {number} 波形全体に対する絶対的なパーセンテージ
 */
function calculateAbsoluteProgress(position, markerData, durationSec) {
    if (position === undefined || !markerData || durationSec <= 0) return 0;
    
    if (markerData.isWarped) {
        const totalBeats = durationSec * (markerData.tempo / 60);
        return totalBeats > 0 ? position / totalBeats : 0;
    } else {
        return position / durationSec;
    }
}

/**
 * マーカーの表示用パーセンテージを計算する
 * @param {Object} markerData マーカー情報
 * @param {number} durationSec 音声ファイルの実時間 (seconds)
 * @returns {{startPct: number, endPct: number}}
 */
function calculateMarkerPercentages(markerData, durationSec) {
    if (!markerData || durationSec <= 0) return { startPct: 0, endPct: 1 };

    let startPct = 0;
    let endPct = 1;

    // AbletonOSCの仕様対応：非ループ時でもエンドポイントを動かすとloop_endが変化するため、
    // isLoopingのON/OFFに関わらず「より手前にあるマーカー」を常に実質的なエンドとする
    const actualEnd = (markerData.loopEnd !== undefined && markerData.loopEnd < markerData.endMarker)
        ? markerData.loopEnd
        : markerData.endMarker;

    if (markerData.isWarped) {
        const totalBeats = durationSec * (markerData.tempo / 60);
        if (totalBeats > 0) {
            startPct = Math.max(0, markerData.startMarker / totalBeats);
            endPct = Math.min(1, actualEnd / totalBeats);
        }
    } else {
        startPct = Math.max(0, markerData.startMarker / durationSec);
        endPct = Math.min(1, actualEnd / durationSec);
    }

    // 異常値の場合は補正
    if (startPct >= 1) startPct = 0;
    if (endPct <= startPct) endPct = 1;

    return { startPct, endPct };
}

/**
 * タイマー表示用の文字列を生成する
 * @param {number} extrapolatedProgress 現在の進行割合 (0.0〜1.0)
 * @param {number} durationMs 音声ファイルの実時間 (ms)
 * @returns {string} フォーマットされた時間文字列
 */
function calculateTimeDisplay(extrapolatedProgress, durationMs) {
    if (durationMs <= 0) return "00:00 / -00:00";

    const elapsedSec = (extrapolatedProgress * durationMs) / 1000;
    const remainingSec = ((1 - extrapolatedProgress) * durationMs) / 1000;

    const elMin = Math.floor(elapsedSec / 60);
    const elSec = Math.floor(elapsedSec % 60);
    const elStr = `${elMin.toString().padStart(2, '0')}:${elSec.toString().padStart(2, '0')}`;

    const remTotalSec = Math.ceil(remainingSec);
    const remMin = Math.floor(remTotalSec / 60);
    const remSec = remTotalSec % 60;
    const remStr = `-${remMin.toString().padStart(2, '0')}:${remSec.toString().padStart(2, '0')}`;

    return `${elStr} / ${remStr}`;
}

// ==========================================
// UI更新関数群 (UI Update Functions)
// ==========================================

function updateOverlayUI(trackId, startPct, endPct) {
    const overlayLeft = document.getElementById(`overlay-left-${trackId}`);
    const overlayRight = document.getElementById(`overlay-right-${trackId}`);
    if (overlayLeft && overlayRight) {
        overlayLeft.style.width = `${startPct * 100}%`;
        overlayRight.style.width = `${(1 - endPct) * 100}%`;
    }
}

function updateTimerUI(trackId, timeText) {
    const t = tracks[trackId];
    if (t && t.timeEl && t.timeEl.textContent !== timeText) {
        t.timeEl.textContent = timeText;
    }
}

function updatePlayheadUI(trackId, progress) {
    const t = tracks[trackId];
    if (!t) return;

    // WaveSurferの内部カーソルを更新
    if (t.ws) {
        t.ws.seekTo(progress);
    }
}
socket.on('connect', () => {
    document.body.className = 'status-waiting';
});

socket.on('disconnect', () => {
    document.body.className = 'status-disconnected';
});

function getOrCreateTrackUI(trackId) {
    if (tracks[trackId]) return tracks[trackId];

    const box = document.createElement('div');
    box.className = 'track-box';
    
    const header = document.createElement('div');
    header.className = 'track-header';
    
    const title = document.createElement('div');
    title.className = 'track-title';
    // Live uses 0-based index, so Track 0 is Track 1
    title.textContent = `Track ${trackId + 1}`;
    
    const info = document.createElement('div');
    info.className = 'track-info';
    info.id = `info-${trackId}`;
    info.textContent = '準備中...';
    
    header.appendChild(title);
    header.appendChild(info);
    
    const waveContainer = document.createElement('div');
    waveContainer.className = 'waveform';
    waveContainer.id = `waveform-${trackId}`;
    
    // オーバーレイを追加
    const overlayLeft = document.createElement('div');
    overlayLeft.className = 'overlay-left';
    overlayLeft.id = `overlay-left-${trackId}`;
    
    const overlayRight = document.createElement('div');
    overlayRight.className = 'overlay-right';
    overlayRight.id = `overlay-right-${trackId}`;
    
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'time-display';
    timeDisplay.id = `time-${trackId}`;
    timeDisplay.textContent = '00:00 / -00:00';
    
    waveContainer.appendChild(overlayLeft);
    waveContainer.appendChild(overlayRight);
    
    box.appendChild(header);
    box.appendChild(waveContainer);
    box.appendChild(timeDisplay);
    
    waveformsContainer.appendChild(box);

    const ws = WaveSurfer.create({
        container: `#waveform-${trackId}`,
        waveColor: '#ff9800',
        progressColor: '#e68900',
        cursorColor: '#fff',
        barWidth: 2,
        barRadius: 2,
        cursorWidth: 1,
        height: 128,
        barGap: 1,
        interact: false // Prevent user clicking to seek
    });

    tracks[trackId] = {
        ws: ws,
        infoEl: info,
        titleEl: title,
        boxEl: box,
        timeEl: timeDisplay,
        currentSceneIndex: -1,
        fileName: null,
        sceneName: null,
        trackName: `Track ${trackId + 1}`,
        lastProgress: 0,
        currentProgress: 0,
        velocity: 0,
        firstPositionTime: undefined,
        currentOffsetProgress: undefined,
        justLooped: false,
        animationFrameId: null,
        startPct: 0,
        endPct: 1,
        markerData: null
    };

    ws.on('ready', () => {
        updateTrackMarkers(tracks[trackId]);
    });

    return tracks[trackId];
}

function updateTrackTitle(trackId) {
    const t = tracks[trackId];
    if (!t) return;
    
    // 「トラック名」 - 「シーン名」「『ファイル名』」 の形式で表示
    let text = t.trackName;
    
    if (t.sceneName || t.fileName) {
        text += ' - ';
        if (t.sceneName) text += t.sceneName;
        if (t.fileName) text += `『${t.fileName}』`;
    }
    
    t.titleEl.textContent = text;
}

socket.on('clip_playing', (data) => {
    const { trackId, slotIndex, filePath } = data;
    const t = getOrCreateTrackUI(trackId);
    
    // 違うクリップ（または同じトラックの別シーン）が再生された場合、完全にリセットする
    if (t.currentSceneIndex !== slotIndex) {
        t.firstPositionTime = undefined;
        t.baseProgress = 0;
        t.currentOffsetProgress = undefined;
        t.lastProgress = 0;
        t.currentProgress = undefined;
        t.justLooped = false;
        t.loadedUrl = null;
    }
    
    t.infoEl.textContent = `Scene ${slotIndex + 1} 再生中`;
    t.currentSceneIndex = slotIndex;
    
    // ファイルパスからファイル名を抽出 (Windowsの\とMacの/両対応)
    t.fileName = filePath.split(/[\\/]/).pop();
    t.sceneName = null; // シーン名を受信するまでリセット
    updateTrackTitle(trackId);
    
    // 一番上に移動し、アニメーションクラスを追加
    waveformsContainer.prepend(t.boxEl);
    
    // アニメーションを確実に発火させるため、少しだけ遅延させる
    setTimeout(() => {
        t.boxEl.classList.add('visible');
        updateEmptyState();
    }, 10);
    
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    
    if (t.loadedUrl === url) {
        // すでにロード中、またはロード済みの場合は重複実行を防ぐ
        return;
    }
    t.loadedUrl = url;
    
    console.log(`Loading audio for Track ${trackId + 1}: ${url}`);
    t.ws.load(url).catch(err => {
        // シーンを高速で切り替えた際、前の読み込みがキャンセルされて出るエラー（AbortError）は正常な動作のため無視する
        if (err.name !== 'AbortError') {
            console.error('WaveSurfer load error:', err);
        }
    });
});

socket.on('clip_stopped', (data) => {
    const { trackId } = data;
    if (tracks[trackId]) {
        const t = tracks[trackId];
        t.infoEl.textContent = '停止中';
        t.currentSceneIndex = -1;
        t.fileName = null;
        t.sceneName = null;
        t.loadedUrl = null;
        updateTrackTitle(trackId);
        t.ws.empty();
        
        // アニメーションを停止し、変数をリセット
        cancelAnimationFrame(t.animationFrameId);
        t.animationFrameId = null;
        t.velocity = 0;
        t.lastPositionTime = 0;
        t.firstPositionTime = undefined;
        t.currentOffsetProgress = undefined;
        
        // 瞬時に非表示にする（アニメーションなし）
        t.boxEl.classList.remove('visible');
        updateEmptyState();
    }
});

socket.on('song_stopped', () => {
    isSongPlaying = false;
    Object.values(tracks).forEach(t => {
        // 全トラックの波形を非表示にする
        t.boxEl.classList.remove('visible');
        
        // アニメーションを停止
        cancelAnimationFrame(t.animationFrameId);
        t.animationFrameId = null;
        t.firstPositionTime = undefined; // 次回再開時に基準時間をリセットさせる
        
        if (t.currentSceneIndex >= 0) {
            t.infoEl.textContent = '一時停止中';
        }
    });
    updateEmptyState();
});

socket.on('song_playing', () => {
    isSongPlaying = true;
    Object.values(tracks).forEach(t => {
        if (t.currentSceneIndex >= 0) {
            // 再生中のクリップがあるトラックのみ再表示
            t.boxEl.classList.add('visible');
            t.infoEl.textContent = `Scene ${t.currentSceneIndex + 1} 再生中`;
            // 再生再開・再トリガー時にAbletonの実際の位置から同期し直すためリセット
            // 次の clip_position イベントで firstPositionTime と baseProgress が正しく設定される
            t.firstPositionTime = undefined;
            t.currentProgress = undefined;
        }
    });
    updateEmptyState();
});

socket.on('clip_position', (data) => {
    let { trackId, slotIndex, progress, position } = data;
    const t = tracks[trackId];
    if (t) {
        // サーバーから送られた生のpositionを使って、マーカー表示時と完全に同じ分母でprogressを再計算する
        // （純粋関数に委譲してロジックを分離）
        if (t.ws && t.ws.getDuration() > 0) {
            progress = calculateAbsoluteProgress(position, t.markerData, t.ws.getDuration());
        }

        // サーバーが古いバージョン（slotIndex未定義）の場合はスキップしない
        if (slotIndex !== undefined && t.currentSceneIndex !== slotIndex) {
            // console.log(`[IGNORE] 遅延パケット無視: Track ${trackId + 1}, 現在のScene ${t.currentSceneIndex + 1} !== パケットのScene ${slotIndex + 1}`);
            return;
        }
        
        if (!isSongPlaying) return; // 一時停止中は何もしない
        
        const now = performance.now();
        
        // 初回、大きな前方ジャンプ（シーク等）、または「過去への巻き戻り（ループや再トリガー）」を確実に検出
        // ※以前は5%以上のジャンプのみを検出していたため、曲の序盤（数秒以内）で再トリガーした際に巻き戻りを検知できず波形が戻らないバグが発生していました
        if (t.firstPositionTime === undefined || (progress - (t.lastProgress || 0)) > 0.05 || progress < (t.lastProgress || 0) - 0.001) {
            t.firstPositionTime = now;
            t.baseProgress = progress; // シーク時の基準位置
            t.justLooped = true;
            t.currentOffsetProgress = undefined; // オフセット履歴もリセット
            t.currentProgress = undefined;       // 後退防止ガードもリセット（同シーン再トリガー対応）
        }
        
        // Abletonからの進行度は基準として保持（ローカルアニメーションの絶対的な速度計算には使わない）
        t.lastProgress = progress;
        t.lastPositionTime = now;
        
        // ローカル補間アニメーションが回っていなければ開始
        if (!t.animationFrameId) {
            t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
        }
    }
});

function animateCursor(trackId) {
    const t = tracks[trackId];
    if (!t || t.currentSceneIndex === -1) {
        if (t) t.animationFrameId = null;
        return; // 停止状態ならアニメーション終了
    }
    
    const now = performance.now();
    const durationMs = t.ws && t.ws.getDuration() ? t.ws.getDuration() * 1000 : 0;
    
    if (durationMs === 0 || t.firstPositionTime === undefined) {
        // 波形がまだロードされていない、または初回パケット未受信の場合は待機
        t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
        return;
    }
    
    // プレイヘッドは波形全体の幅（0〜1）に対する絶対的な割合として描画されるため、
    // velocity（1ミリ秒あたりの進行度）は常に「1 / 波形全体の実時間」とする必要があります。
    // （※スタートポイントをずらした際にプレイヘッドが加速してしまうバグを修正）
    t.velocity = 1 / Math.max(durationMs, 1);
    
    // ラグ補正（先読み）による目標オフセット値
    const targetOffsetProgress = t.velocity * latencyOffsetMs;
    
    // オフセット値の急変によるワープを防ぐため、滑らかに追従させる
    if (t.currentOffsetProgress === undefined) {
        t.currentOffsetProgress = targetOffsetProgress;
    } else {
        // 60fps環境で約0.1秒かけて滑らかに変化させる
        t.currentOffsetProgress = t.currentOffsetProgress * 0.85 + targetOffsetProgress * 0.15;
    }
    
    // 「再生開始位置」＋「実時間経過による物理的な進行」＋「滑らかなラグ補正オフセット」
    // Abletonからの狂ったprogressを使わず、自分自身のストップウォッチで完璧に進行させます
    const elapsedMs = now - t.firstPositionTime;
    let extrapolatedProgress = t.baseProgress + (t.velocity * elapsedMs) + t.currentOffsetProgress;
    extrapolatedProgress = Math.min(Math.max(extrapolatedProgress, 0), 1);
    
    // カーソルの「後ろへのワープ」を物理的に防止する最終保護処理
    if (t.currentProgress !== undefined) {
        if (t.justLooped) {
            t.justLooped = false; // ループ直後の1回だけワープ（巻き戻り）を許可
        } else if (extrapolatedProgress < t.currentProgress) {
            extrapolatedProgress = t.currentProgress; // それ以外は絶対に戻さない
        }
    }
    t.currentProgress = extrapolatedProgress;
    
    // 時間表示の更新
    const timeText = calculateTimeDisplay(extrapolatedProgress, durationMs);
    updateTimerUI(trackId, timeText);
    
    // WaveSurferのカーソルを進める
    updatePlayheadUI(trackId, extrapolatedProgress);
    
    // 次のフレームも実行
    t.animationFrameId = requestAnimationFrame(() => animateCursor(trackId));
}

socket.on('scene_name', (data) => {
    const { sceneIndex, name } = data;
    Object.keys(tracks).forEach(trackId => {
        const t = tracks[trackId];
        if (t.currentSceneIndex === sceneIndex) {
            t.sceneName = name;
            updateTrackTitle(parseInt(trackId));
        }
    });
});

socket.on('track_name', (data) => {
    const { trackId, name } = data;
    const t = getOrCreateTrackUI(trackId);
    t.trackName = name;
    updateTrackTitle(trackId);
});

// 次のシーンの音声ファイルを裏でダウンロード（キャッシュ）しておく処理
socket.on('clip_preload', (data) => {
    const { trackId, filePath } = data;
    const url = `/audio?path=${encodeURIComponent(filePath)}`;
    console.log(`[Preload] Downloading audio in background for Track ${trackId + 1}: ${url}`);
    
    // fetchを使ってブラウザにキャッシュさせる（描画はしない）
    fetch(url).catch(e => console.error('Preload fetch failed:', e));
});

// マーカー情報を受信したときの処理
socket.on('clip_markers', (data) => {
    const trackId = data.trackId;
    const t = tracks[trackId];
    if (t && t.currentSceneIndex === data.slotIndex) {
        t.markerData = data;
        updateTrackMarkers(t);
    }
});

function updateTrackMarkers(t) {
    if (!t.markerData || !t.ws || t.ws.getDuration() === 0) return;
    
    const durationSec = t.ws.getDuration();
    
    // 純粋関数を使ってパーセンテージを計算
    const { startPct, endPct } = calculateMarkerPercentages(t.markerData, durationSec);
    
    // 状態を保持
    t.startPct = startPct;
    t.endPct = endPct;
    
    // UIを更新
    const trackId = Object.keys(tracks).find(key => tracks[key] === t);
    updateOverlayUI(trackId, startPct, endPct);
}

// ==========================================
// デジタル時計の更新処理
// ==========================================
const clockEl = document.getElementById('digital-clock');
const clockToggle = document.getElementById('clock-toggle');

if (clockToggle && clockEl) {
    clockToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            clockEl.classList.remove('hidden');
        } else {
            clockEl.classList.add('hidden');
        }
    });
}

function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const timeString = `${h}:${m}:${s}`;
    
    // パフォーマンスのため、時刻文字列が変化したときだけDOMを更新する
    if (clockEl.textContent !== timeString) {
        clockEl.textContent = timeString;
    }
}

// 200ms間隔で時刻をチェックして毎秒正確に更新する
setInterval(updateClock, 200);
updateClock(); // 初回実行
