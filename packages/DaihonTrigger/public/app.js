// app.js

const socket = io();

let pdfDoc = null;
let pagesData = {};
let fabricCanvases = {}; // pageNum(1-indexed) -> fabric.Canvas
const scale = 1.5;

// DOM
const zoomWrapper = document.getElementById('zoom-wrapper');
const pageCountSpan = document.getElementById('page-count');
const zoomLevelSpan = document.getElementById('zoom-level');

// ズーム状態
let currentZoom = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;

// 履歴管理 (アンドゥ)
const undoStack = []; // 要素: { pageNum, data: JSON string }
const MAX_UNDO = 20;

const saveStateForUndo = (pageNum) => {
    const canvas = fabricCanvases[pageNum];
    if (!canvas) return;
    undoStack.push({
        pageNum: pageNum,
        data: JSON.stringify(canvas.toJSON(['isTrigger', 'trackNum', 'sceneNum']))
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
};

const undo = () => {
    if (undoStack.length === 0) return;
    const lastState = undoStack.pop();
    const canvas = fabricCanvases[lastState.pageNum];
    if (canvas) {
        // isRestoringフラグを立てて、読み込み時の追加イベントで履歴が汚れないようにする
        canvas.isRestoring = true;
        canvas.loadFromJSON(lastState.data, () => {
            canvas.renderAll();
            saveCurrentPage(lastState.pageNum); // サーバーへも保存
            canvas.isRestoring = false;
        });
    }
};
document.getElementById('btn-undo').addEventListener('click', undo);

// モード管理
const MODES = { VIEW: 'view', DRAW: 'draw', ERASER: 'eraser', TRIGGER: 'trigger' };
let currentMode = MODES.VIEW;
let pendingTriggerPos = null;
let pendingTriggerPage = null;

const modeBtns = {
    view: document.getElementById('mode-view'),
    draw: document.getElementById('mode-draw'),
    eraser: document.getElementById('mode-eraser'),
    trigger: document.getElementById('mode-trigger')
};

const setMode = (mode) => {
    currentMode = mode;
    Object.values(modeBtns).forEach(btn => btn.classList.remove('active'));
    
    if (mode === MODES.VIEW) modeBtns.view.classList.add('active');
    else if (mode === MODES.DRAW) modeBtns.draw.classList.add('active');
    else if (mode === MODES.ERASER) modeBtns.eraser.classList.add('active');
    else if (mode === MODES.TRIGGER) modeBtns.trigger.classList.add('active');

    // 全キャンバスの設定を更新
    Object.values(fabricCanvases).forEach(canvas => {
        canvas.isDrawingMode = (mode === MODES.DRAW);
        if (mode === MODES.DRAW) {
            canvas.freeDrawingBrush.color = 'rgba(255, 0, 0, 0.7)';
            canvas.freeDrawingBrush.width = 3;
        }

        canvas.forEachObject(obj => {
            obj.selectable = (mode === MODES.TRIGGER);
            obj.evented = true;
        });
        canvas.requestRenderAll();
    });
};

Object.keys(modeBtns).forEach(key => {
    modeBtns[key].addEventListener('click', () => setMode(MODES[key.toUpperCase()]));
});

// サーバー保存
const saveCurrentPage = (pageNum) => {
    const canvas = fabricCanvases[pageNum];
    if (!canvas || canvas.isRestoring) return;
    const fabricData = canvas.toJSON(['isTrigger', 'trackNum', 'sceneNum']);
    pagesData[pageNum] = fabricData;
    socket.emit('save_data', { pageNum: pageNum, fabricData: fabricData });
};

// --- PDF連続描画とキャンバス初期化 ---
const renderAllPages = async () => {
    pageCountSpan.textContent = pdfDoc.numPages;
    zoomWrapper.innerHTML = ''; // クリア

    for (let num = 1; num <= pdfDoc.numPages; num++) {
        // コンテナ作成
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page-container';
        pageContainer.id = `page-container-${num}`;
        
        const pdfCanvasEl = document.createElement('canvas');
        pdfCanvasEl.className = 'pdf-canvas';
        
        const fabCanvasEl = document.createElement('canvas');
        fabCanvasEl.id = `fabric-canvas-${num}`;
        
        pageContainer.appendChild(pdfCanvasEl);
        pageContainer.appendChild(fabCanvasEl);
        zoomWrapper.appendChild(pageContainer);

        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale });

        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;
        pdfCanvasEl.width = viewport.width;
        pdfCanvasEl.height = viewport.height;

        // PDF描画
        const ctx = pdfCanvasEl.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        // Fabric初期化
        const fabCanvas = new fabric.Canvas(`fabric-canvas-${num}`, {
            selection: false,
            width: viewport.width,
            height: viewport.height
        });
        fabricCanvases[num] = fabCanvas;

        // 保存データがあれば復元
        if (pagesData[num]) {
            fabCanvas.isRestoring = true;
            fabCanvas.loadFromJSON(pagesData[num], () => {
                setMode(currentMode);
                fabCanvas.renderAll();
                fabCanvas.isRestoring = false;
            });
        }

        // イベント設定
        setupFabricEvents(fabCanvas, num);
    }
    setMode(MODES.VIEW); // 初期モード適用
    
    // PDF外側もパンできるように設けた巨大なパディング（3000px）を考慮して初期スクロールする
    setTimeout(() => {
        const firstPage = document.querySelector('.page-container');
        const pdfWidth = firstPage ? firstPage.clientWidth : 800;
        
        const scaledPdfWidth = pdfWidth * currentZoom;
        
        // #zoom-wrapper は left: 250px, top: 250px に絶対配置されているため、
        // どんなズーム倍率でもPDFの原点（左上角）は必ず (250, 250) となる。
        const centerX = 250 + (scaledPdfWidth / 2);
        const centerY = 250;
        
        container.scrollLeft = centerX - (window.innerWidth / 2);
        container.scrollTop = centerY - 50; // 上部に少し余裕を持たせる
    }, 100);
};

// --- Fabric.js イベント ---
let isErasing = false;
const setupFabricEvents = (canvas, pageNum) => {
    
    // パス描画完了時に保存
    canvas.on('path:created', () => {
        if (currentMode === MODES.DRAW) {
            saveCurrentPage(pageNum);
        }
    });

    canvas.on('object:modified', () => saveCurrentPage(pageNum));
    
    // 消しゴム等で消えた後に保存
    canvas.on('object:removed', () => {
        if (!canvas.isRestoring) saveCurrentPage(pageNum);
    });

    // マウスダウン・タッチイベント
    canvas.on('mouse:down', (options) => {
        // アンドゥ用に状態保存 (トリガー配置・描画・消去の直前状態)
        if (currentMode === MODES.DRAW || currentMode === MODES.ERASER || currentMode === MODES.TRIGGER) {
            saveStateForUndo(pageNum);
        }

        if (currentMode === MODES.TRIGGER && !options.target) {
            // 新規トリガー配置
            pendingTriggerPos = canvas.getPointer(options.e);
            pendingTriggerPage = pageNum;
            document.getElementById('trigger-modal').classList.remove('hidden');
            document.getElementById('modal-loading').classList.remove('hidden');
            document.getElementById('modal-grid-container').classList.add('hidden');
            socket.emit('get_session_data');
        } else if (currentMode === MODES.VIEW && options.target && options.target.isTrigger) {
            // トリガー発火
            if (options.target.isSceneTrigger) {
                const s = options.target.sceneNum;
                console.log(`OSC Fire Scene: Scene ${s}`);
                socket.emit('fire_scene', { scene: s });
            } else {
                const t = options.target.trackNum;
                const s = options.target.sceneNum;
                console.log(`OSC Fire: Track ${t}, Scene ${s}`);
                socket.emit('fire_clip', { track: t, scene: s });
            }
            
            options.target.set('opacity', 0.5);
            canvas.renderAll();
            setTimeout(() => {
                options.target.set('opacity', 1);
                canvas.renderAll();
            }, 200);
        } else if (currentMode === MODES.ERASER) {
            isErasing = true;
            if (options.target) canvas.remove(options.target);
        }
    });

    canvas.on('mouse:move', (options) => {
        if (currentMode === MODES.ERASER && isErasing) {
            // 対象を検索して消す (ポインター下のオブジェクト)
            const pointer = canvas.getPointer(options.e);
            const targets = canvas.getObjects().filter(obj => obj.containsPoint(pointer));
            targets.forEach(obj => canvas.remove(obj));
        }
    });

    canvas.on('mouse:up', () => {
        isErasing = false;
    });
};

let isPinching = false;
let isPanning = false;
let initialDistance = 0;
let initialZoom = 1.0;
let lastCenter = { x: 0, y: 0 };

// 慣性スクロール（モメンタム）用
let velocityX = 0;
let velocityY = 0;
let lastTouchTime = 0;
let momentumId = null;

const updateZoom = (newZoom) => {
    currentZoom = Math.max(MIN_ZOOM, Math.min(newZoom, MAX_ZOOM));
    zoomWrapper.style.transform = `scale(${currentZoom})`;
    zoomLevelSpan.textContent = `${Math.round(currentZoom * 100)}%`;
};

const getDistance = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
};

const getCenter = (touches) => {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
    };
};

const container = document.getElementById('canvas-container');

container.addEventListener('touchstart', (e) => {
    // 慣性スクロール中なら停止
    if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
    }

    if (e.touches.length >= 2) {
        isPinching = true;
        isPanning = false;
        initialDistance = getDistance(e.touches);
        initialZoom = currentZoom;
        lastCenter = getCenter(e.touches);
        
        // 2本指以上なら手書きモードを一時解除し、スクロール等を許可
        Object.values(fabricCanvases).forEach(c => {
            if (c.isDrawingMode) {
                c.isDrawingMode = false;
                c.__wasDrawingMode = true;
            }
        });
    } else if (e.touches.length === 1 && currentMode === MODES.VIEW) {
        // 閲覧モード時の1本指パン
        isPanning = true;
        lastCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        lastTouchTime = Date.now();
        velocityX = 0;
        velocityY = 0;
    }
}, { passive: false });

container.addEventListener('touchmove', (e) => {
    if (e.touches.length >= 2 && isPinching) {
        e.preventDefault(); // ブラウザ標準のピンチズームを防ぐ
        
        const currentCenter = getCenter(e.touches);
        const dist = getDistance(e.touches);
        
        const oldZoom = currentZoom;
        const newZoom = initialZoom * (dist / initialDistance);
        const clampedZoom = Math.max(MIN_ZOOM, Math.min(newZoom, MAX_ZOOM));
        
        // スケールが変わった場合、ズームの中心点（指の真ん中）がズレないようにスクロール位置を補正
        if (oldZoom !== clampedZoom) {
            const rect = container.getBoundingClientRect();
            const relX = currentCenter.x - rect.left;
            const relY = currentCenter.y - rect.top;
            
            // 現在のタッチ中心のコンテナ内絶対座標
            const absoluteX = container.scrollLeft + relX;
            const absoluteY = container.scrollTop + relY;
            
            // スケールの基準点（transform-origin）は #zoom-wrapper の左上、つまり絶対座標 (250, 250)
            const originX = 250;
            const originY = 250;
            
            const distX = absoluteX - originX;
            const distY = absoluteY - originY;
            
            const newDistX = distX * (clampedZoom / oldZoom);
            const newDistY = distY * (clampedZoom / oldZoom);
            
            container.scrollLeft = (originX + newDistX) - relX;
            container.scrollTop = (originY + newDistY) - relY;
            
            updateZoom(clampedZoom);
        }
        
        // パン（平行移動）処理
        const dx = currentCenter.x - lastCenter.x;
        const dy = currentCenter.y - lastCenter.y;
        
        container.scrollLeft -= dx;
        container.scrollTop -= dy;
        
        lastCenter = currentCenter;
    } else if (e.touches.length === 1 && isPanning) {
        // 1本指でのパンスクロール（閲覧モードのみ）
        e.preventDefault();
        const currentCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const dx = currentCenter.x - lastCenter.x;
        const dy = currentCenter.y - lastCenter.y;
        
        // 慣性スクロールのための速度計算
        const now = Date.now();
        const dt = now - lastTouchTime;
        if (dt > 0) {
            // スワイプ速度を直近の移動量から算出（指を離す直前の速度を重視する）
            velocityX = (dx / dt) * 0.8 + velocityX * 0.2;
            velocityY = (dy / dt) * 0.8 + velocityY * 0.2;
        }
        lastTouchTime = now;
        
        container.scrollLeft -= dx;
        container.scrollTop -= dy;
        
        lastCenter = currentCenter;
    }
}, { passive: false });

container.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        isPinching = false;
        // モード復帰
        Object.values(fabricCanvases).forEach(c => {
            if (c.__wasDrawingMode) {
                c.isDrawingMode = true;
                c.__wasDrawingMode = false;
            }
        });
    }
    if (e.touches.length === 0) {
        if (isPanning) {
            // 指を離した瞬間に慣性スクロール（物理演算）を開始
            const applyMomentum = () => {
                // 十分に速度が落ちたら停止
                if (Math.abs(velocityX) > 0.05 || Math.abs(velocityY) > 0.05) {
                    container.scrollLeft -= velocityX * 16; // 1フレーム(約16ms)分の移動
                    container.scrollTop -= velocityY * 16;
                    
                    // 摩擦で速度を減衰させる（1に近いほどよく滑る）
                    velocityX *= 0.96; // 0.92 から 0.96 に変更し、より滑るように
                    velocityY *= 0.96;
                    
                    momentumId = requestAnimationFrame(applyMomentum);
                }
            };
            momentumId = requestAnimationFrame(applyMomentum);
        }
        isPanning = false;
    }
});

// PC用 ホイールズーム
container.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const oldZoom = currentZoom;
        const newZoom = currentZoom + delta;
        const clampedZoom = Math.max(MIN_ZOOM, Math.min(newZoom, MAX_ZOOM));
        
        if (oldZoom !== clampedZoom) {
            const rect = container.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            const relY = e.clientY - rect.top;
            
            const absoluteX = container.scrollLeft + relX;
            const absoluteY = container.scrollTop + relY;
            
            const originX = 250;
            const originY = 250;
            
            const distX = absoluteX - originX;
            const distY = absoluteY - originY;
            
            const newDistX = distX * (clampedZoom / oldZoom);
            const newDistY = distY * (clampedZoom / oldZoom);
            
            container.scrollLeft = (originX + newDistX) - relX;
            container.scrollTop = (originY + newDistY) - relY;
            
            updateZoom(clampedZoom);
        }
    }
}, { passive: false });


// --- セッションデータ・モーダル関連 ---
socket.on('session_data_result', (data) => {
    document.getElementById('modal-loading').classList.add('hidden');
    
    if (data.error) {
        alert("セッションデータの取得に失敗しました。Ableton Liveとosc-routerが起動しているか確認してください。");
        document.getElementById('trigger-modal').classList.add('hidden');
        return;
    }
    
    document.getElementById('modal-grid-container').classList.remove('hidden');
    
    const thead = document.getElementById('session-grid-head');
    const tbody = document.getElementById('session-grid-body');
    thead.innerHTML = ''; tbody.innerHTML = '';
    
    const trHead = document.createElement('tr');
    
    // トラック見出しを先に並べる
    data.tracks.forEach(t => {
        const th = document.createElement('th');
        th.textContent = t.name;
        trHead.appendChild(th);
    });
    
    // 右端にシーン用見出しを追加
    const thScenes = document.createElement('th');
    thScenes.textContent = 'Scenes';
    trHead.appendChild(thScenes);
    
    thead.appendChild(trHead);
    
    data.scenes.forEach(s => {
        const tr = document.createElement('tr');
        
        // クリップセルを先に並べる
        data.tracks.forEach(t => {
            const td = document.createElement('td');
            const clipName = data.clips[t.index][s.index];
            td.textContent = clipName ? clipName : '';
            td.className = clipName ? 'clip-cell' : 'clip-cell empty-clip';
            
            // ボタン（トリガー）のラベルは常にシーン名を使用する
            td.onclick = () => placeTrigger(t.index, s.index, s.name);
            tr.appendChild(td);
        });

        // 右端にシーン名を追加
        const tdScene = document.createElement('td');
        tdScene.textContent = s.name;
        tdScene.style.cursor = 'pointer';
        tdScene.className = 'scene-cell';
        tdScene.onclick = () => placeTrigger(null, s.index, s.name, true);
        tr.appendChild(tdScene);

        tbody.appendChild(tr);
    });
});

document.getElementById('modal-refresh').addEventListener('click', () => {
    document.getElementById('modal-loading').classList.remove('hidden');
    document.getElementById('modal-grid-container').classList.add('hidden');
    socket.emit('get_session_data');
});

document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('trigger-modal').classList.add('hidden');
});

const placeTrigger = (trackIndex, sceneIndex, labelText, isScene = false) => {
    if (pendingTriggerPos && pendingTriggerPage) {
        const canvas = fabricCanvases[pendingTriggerPage];
        
        const rect = new fabric.Rect({
            width: 140, height: 50, fill: isScene ? '#007aff' : '#ff2d55', rx: 10, ry: 10,
            originX: 'center', originY: 'center',
            shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 5, offsetX: 2, offsetY: 2 })
        });
        
        const text = new fabric.Text(labelText, {
            fontSize: 16, fill: '#ffffff', fontWeight: 'bold',
            originX: 'center', originY: 'center', textAlign: 'center'
        });
        
        const group = new fabric.Group([rect, text], {
            left: pendingTriggerPos.x, top: pendingTriggerPos.y,
            originX: 'center', originY: 'center',
            hasControls: true, hasBorders: true,
            isTrigger: true,
            isSceneTrigger: isScene,
            trackNum: isScene ? null : trackIndex + 1,
            sceneNum: sceneIndex + 1
        });
        
        canvas.add(group);
        saveCurrentPage(pendingTriggerPage);
    }
    
    document.getElementById('trigger-modal').classList.add('hidden');
    setMode(MODES.VIEW);
};

// --- 初期化フロー ---
const pdfUrl = 'pdfs/test.pdf';

socket.emit('load_all_data');
socket.on('all_data_loaded', (data) => {
    pagesData = data || {};
    
    pdfjsLib.getDocument(pdfUrl).promise.then((pdfDoc_) => {
        pdfDoc = pdfDoc_;
        renderAllPages();
    }).catch(err => {
        console.error('PDF Load Error:', err);
        zoomWrapper.innerHTML = `<h2 style="color:red">PDFの読み込みに失敗しました (${pdfUrl})</h2>`;
    });
});
