// app.js

const socket = io();

let pdfDoc = null;
let pagesData = {};
let fabricCanvases = {}; // pageNum(1-indexed) -> fabric.Canvas
let currentPdfName = 'sample.pdf'; // サーバーから受け取るアクティブなPDF名
const scale = 1.5;

// DOM
const zoomWrapper = document.getElementById('zoom-wrapper');
const pageCountSpan = document.getElementById('page-count');
const zoomLevelSpan = document.getElementById('zoom-level');
const currentPageInput = document.getElementById('current-page-input');
const container = document.getElementById('canvas-container');

// サイドバーDOM
const sidebar = document.getElementById('sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnCloseSidebar = document.getElementById('btn-close-sidebar');
const thumbnailContainer = document.getElementById('thumbnail-container');

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
    
    const newDataStr = JSON.stringify(canvas.toJSON(['isTrigger', 'trackNum', 'sceneNum', 'isSceneTrigger']));
    
    // ズーム操作等の誤タッチで同一状態が連続してスタックに積まれるのを防ぐ
    if (undoStack.length > 0) {
        const lastState = undoStack[undoStack.length - 1];
        if (lastState.pageNum === pageNum && lastState.data === newDataStr) {
            return;
        }
    }
    
    undoStack.push({
        pageNum: pageNum,
        data: newDataStr
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

let cachedSessionData = null;
let isFetchingSessionData = false;
let isContinuousMode = false;
let nextContinuousSceneIndex = null;

const triggerSettingsPanel = document.getElementById('trigger-settings');
const continuousModeCheckbox = document.getElementById('continuous-trigger-mode');
const continuousStatusContainer = document.getElementById('continuous-status-container');
const continuousNextText = document.getElementById('continuous-next-text');
const btnResetContinuous = document.getElementById('btn-reset-continuous');
const modalWarning = document.getElementById('modal-warning');
const btnUpdateSession = document.getElementById('btn-update-session');

if (continuousModeCheckbox) {
    continuousModeCheckbox.addEventListener('change', (e) => {
        isContinuousMode = e.target.checked;
        if (isContinuousMode) {
            continuousStatusContainer.style.display = 'flex';
            updateContinuousStatusUI();
        } else {
            continuousStatusContainer.style.display = 'none';
            nextContinuousSceneIndex = null;
        }
    });
}
if (btnResetContinuous) {
    btnResetContinuous.addEventListener('click', () => {
        nextContinuousSceneIndex = null;
        updateContinuousStatusUI();
    });
}
const updateContinuousStatusUI = () => {
    if (nextContinuousSceneIndex === null) {
        continuousNextText.textContent = '次の配置: 未定（配置したい場所をクリック）';
    } else {
        continuousNextText.textContent = `次の配置: Scene ${nextContinuousSceneIndex + 1}`;
    }
};

// ペン設定
let currentPenColor = 'rgba(255, 0, 0, 0.7)'; // 初期値: 赤
let currentPenWidth = 3;

const penSettingsPanel = document.getElementById('pen-settings');
const colorBtns = document.querySelectorAll('.color-btn');
const penWidthInput = document.getElementById('pen-width-input');
const penWidthBtns = document.querySelectorAll('.pen-width-btn');

// ペン設定を全キャンバスに反映する関数
const updatePenSettings = () => {
    Object.values(fabricCanvases).forEach(canvas => {
        if (canvas.freeDrawingBrush) {
            canvas.freeDrawingBrush.color = currentPenColor;
            canvas.freeDrawingBrush.width = currentPenWidth;
        }
    });
};

// 色選択イベント
colorBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        colorBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        currentPenColor = btn.dataset.color;
        updatePenSettings();
    });
});

// 太さ直接入力イベント
penWidthInput.addEventListener('change', (e) => {
    let w = parseFloat(e.target.value);
    if (isNaN(w) || w < 0.5) w = 0.5;
    if (w > 50) w = 50;
    e.target.value = w;
    currentPenWidth = w;
    updatePenSettings();
});

// 太さショートカットイベント
penWidthBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        const w = parseFloat(btn.dataset.width);
        penWidthInput.value = w;
        currentPenWidth = w;
        updatePenSettings();
    });
});

// 初期状態の設定
document.querySelector('.color-btn[data-color="rgba(255,0,0,0.7)"]').classList.add('selected');


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

    // 設定パネルの表示切替
    if (mode === MODES.DRAW) {
        penSettingsPanel.classList.remove('pen-settings-hidden');
        if(triggerSettingsPanel) triggerSettingsPanel.classList.add('pen-settings-hidden');
    } else if (mode === MODES.ERASER) {
    } else if (mode === MODES.TRIGGER) {
        penSettingsPanel.classList.add('pen-settings-hidden');
        if(triggerSettingsPanel) triggerSettingsPanel.classList.remove('pen-settings-hidden');
        if (!isFetchingSessionData) {
            isFetchingSessionData = true;
            socket.emit('get_session_data');
        }
    } else {
        penSettingsPanel.classList.add('pen-settings-hidden');
        if(triggerSettingsPanel) triggerSettingsPanel.classList.add('pen-settings-hidden');
    }

    // 全キャンバスの設定を更新
    Object.values(fabricCanvases).forEach(canvas => {
        canvas.isDrawingMode = (mode === MODES.DRAW);
        if (mode === MODES.DRAW) {
            canvas.freeDrawingBrush.color = currentPenColor;
            canvas.freeDrawingBrush.width = currentPenWidth;
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
    const fabricData = canvas.toJSON(['isTrigger', 'trackNum', 'sceneNum', 'isSceneTrigger']);
    pagesData[pageNum] = fabricData;
    socket.emit('save_data', { pdfName: currentPdfName, pageNum: pageNum, fabricData: fabricData });
};

// --- PDF連続描画とキャンバス初期化 ---
const renderAllPages = async () => {
    pageCountSpan.textContent = pdfDoc.numPages;
    currentPageInput.max = pdfDoc.numPages;
    zoomWrapper.innerHTML = ''; // クリア
    thumbnailContainer.innerHTML = ''; // サムネイルクリア

    for (let num = 1; num <= pdfDoc.numPages; num++) {
        // コンテナ作成
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page-container';
        pageContainer.id = `page-container-${num}`;
        pageContainer.style.position = 'relative'; // 追加: SVGとFabricを重ねるため
        
        const svgContainerEl = document.createElement('div');
        svgContainerEl.className = 'pdf-svg-container';
        svgContainerEl.style.position = 'absolute';
        svgContainerEl.style.top = '0';
        svgContainerEl.style.left = '0';
        svgContainerEl.style.zIndex = '1';
        
        const fabCanvasEl = document.createElement('canvas');
        fabCanvasEl.id = `fabric-canvas-${num}`;
        // Fabric.jsのコンテナが自動生成されるが、その親であるpageContainerのpositionを基準にする
        
        pageContainer.appendChild(svgContainerEl);
        pageContainer.appendChild(fabCanvasEl);
        zoomWrapper.appendChild(pageContainer);

        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale });

        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;
        
        svgContainerEl.style.width = `${viewport.width}px`;
        svgContainerEl.style.height = `${viewport.height}px`;

        // --- SVGレンダリング ---
        // Canvasの代わりに完全なベクターデータ(SVG)としてPDFを描画する
        const operatorList = await page.getOperatorList();
        const svgGfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
        const svgElement = await svgGfx.getSVG(operatorList, viewport);
        
        svgContainerEl.appendChild(svgElement);

        // --- サムネイル生成 ---
        const thumbWrapper = document.createElement('div');
        thumbWrapper.className = 'thumbnail-wrapper';
        thumbWrapper.onclick = () => jumpToPage(num);
        
        const thumbCanvas = document.createElement('canvas');
        const thumbViewport = page.getViewport({ scale: 0.2 }); // 縮小版
        thumbCanvas.width = thumbViewport.width;
        thumbCanvas.height = thumbViewport.height;
        const thumbCtx = thumbCanvas.getContext('2d');
        await page.render({ canvasContext: thumbCtx, viewport: thumbViewport }).promise;
        
        const thumbLabel = document.createElement('div');
        thumbLabel.className = 'thumbnail-page-num';
        thumbLabel.textContent = `Page ${num}`;
        
        thumbWrapper.appendChild(thumbCanvas);
        thumbWrapper.appendChild(thumbLabel);
        thumbnailContainer.appendChild(thumbWrapper);

        // --- Fabric初期化 ---
        // ※以前ボタン高画質化のために devicePixelRatio = 3 としていたが、
        // これによりペンツールの描画負荷が跳ね上がり（面積9倍の計算）、遅延の原因となっていたため元に戻す。
        const fabCanvas = new fabric.Canvas(`fabric-canvas-${num}`, {
            selection: false,
            width: viewport.width,
            height: viewport.height
        });
        
        // ブラシ初期設定
        fabCanvas.freeDrawingBrush.color = currentPenColor;
        fabCanvas.freeDrawingBrush.width = currentPenWidth;

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

// --- ナビゲーション機能 ---
const jumpToPage = (pageNum) => {
    const pageEl = document.getElementById(`page-container-${pageNum}`);
    if (!pageEl) return;
    
    // スケールを考慮した要素の中心座標を計算
    const rect = pageEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    
    // 現在のスクロール位置 + 要素の相対位置
    const targetTop = (pageEl.offsetTop * currentZoom) + 250 - 50; // 250はzoom-wrapperのオフセット、50は余白
    
    container.scrollTo({
        top: targetTop,
        behavior: 'smooth'
    });
    
    currentPageInput.value = pageNum;
    if (!sidebar.classList.contains('sidebar-hidden')) {
        sidebar.classList.add('sidebar-hidden');
    }
};

btnToggleSidebar.addEventListener('click', () => {
    sidebar.classList.toggle('sidebar-hidden');
});

btnCloseSidebar.addEventListener('click', () => {
    sidebar.classList.add('sidebar-hidden');
});

currentPageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        let val = parseInt(currentPageInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (pdfDoc && val > pdfDoc.numPages) val = pdfDoc.numPages;
        currentPageInput.value = val;
        jumpToPage(val);
    }
});

// スクロール時の現在ページ追従
let scrollTimeout = null;
container.addEventListener('scroll', () => {
    if (!pdfDoc) return;
    if (scrollTimeout) clearTimeout(scrollTimeout);
    
    scrollTimeout = setTimeout(() => {
        let minDiff = Infinity;
        let closestPage = 1;
        const containerCenterY = container.scrollTop + container.clientHeight / 2;
        
        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const pageEl = document.getElementById(`page-container-${i}`);
            if (pageEl) {
                const pageCenterY = (pageEl.offsetTop * currentZoom) + 250 + ((pageEl.clientHeight * currentZoom) / 2);
                const diff = Math.abs(containerCenterY - pageCenterY);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestPage = i;
                }
            }
        }
        currentPageInput.value = closestPage;
    }, 100);
});

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
            pendingTriggerPos = canvas.getPointer(options.e);
            pendingTriggerPage = pageNum;
            
            if (isContinuousMode && nextContinuousSceneIndex !== null) {
                placeTrigger(null, nextContinuousSceneIndex, null, true);
                nextContinuousSceneIndex++;
                updateContinuousStatusUI();
                return;
            }

            const triggerModal = document.getElementById('trigger-modal');
            const modalLoading = document.getElementById('modal-loading');
            const gridContainer = document.getElementById('modal-grid-container');
            
            triggerModal.classList.remove('hidden');
            
            if (cachedSessionData) {
                modalLoading.style.display = 'none';
                gridContainer.classList.remove('hidden');
                renderSessionGrid(cachedSessionData);
            } else {
                modalLoading.style.display = 'block';
                gridContainer.classList.add('hidden');
                if (!isFetchingSessionData) {
                    isFetchingSessionData = true;
                    socket.emit('get_session_data');
                }
            }
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

// ズーム更新の最適化（ガクツキ防止）
let isZoomTicking = false;

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



container.addEventListener('touchstart', (e) => {
    // 慣性スクロール中なら停止
    if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
    }

    if (e.touches.length >= 2) {
        isPinching = true;
        isPanning = false;
        zoomWrapper.classList.add('fast-zoom'); // ズーム中はGPUキャッシュを使用して軽くする
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
            
            // ズーム描画の間引き（GPU負荷軽減）
            if (!isZoomTicking) {
                requestAnimationFrame(() => {
                    updateZoom(clampedZoom);
                    isZoomTicking = false;
                });
                isZoomTicking = true;
            }
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
        if (isPinching) {
            isPinching = false;
            zoomWrapper.classList.remove('fast-zoom'); // ズーム終了時に高画質ベクターの再計算を許可
        }
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

let wheelZoomTimeout = null;

// PC用 ホイールズーム
container.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomWrapper.classList.add('fast-zoom'); // ズーム開始
        
        clearTimeout(wheelZoomTimeout);
        wheelZoomTimeout = setTimeout(() => {
            zoomWrapper.classList.remove('fast-zoom'); // ズーム完了後に高画質化
        }, 150);
        
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
            
            if (!isZoomTicking) {
                requestAnimationFrame(() => {
                    updateZoom(clampedZoom);
                    isZoomTicking = false;
                });
                isZoomTicking = true;
            }
        }
    }
}, { passive: false });


// --- セッションデータ・モーダル関連 ---
const renderSessionGrid = (data) => {
    const thead = document.getElementById('session-grid-head');
    const tbody = document.getElementById('session-grid-body');
    thead.innerHTML = ''; tbody.innerHTML = '';
    
    const trHead = document.createElement('tr');
    data.tracks.forEach(t => {
        const th = document.createElement('th');
        th.textContent = t.name;
        trHead.appendChild(th);
    });
    
    const thScenes = document.createElement('th');
    thScenes.textContent = 'Scenes';
    trHead.appendChild(thScenes);
    thead.appendChild(trHead);
    
    data.scenes.forEach(s => {
        const tr = document.createElement('tr');
        data.tracks.forEach(t => {
            const td = document.createElement('td');
            const clipName = data.clips[t.index][s.index];
            td.textContent = clipName ? clipName : '';
            td.className = clipName ? 'clip-cell' : 'clip-cell empty-clip';
            td.onclick = () => {
                const warn = document.getElementById('modal-warning');
                if (warn && !warn.classList.contains('hidden')) return;
                placeTrigger(t.index, s.index, s.name);
            };
            tr.appendChild(td);
        });

        const tdScene = document.createElement('td');
        tdScene.textContent = s.name;
        tdScene.style.cursor = 'pointer';
        tdScene.className = 'scene-cell';
        tdScene.onclick = () => {
            const warn = document.getElementById('modal-warning');
            if (warn && !warn.classList.contains('hidden')) return;
            placeTrigger(null, s.index, s.name, true);
        };
        tr.appendChild(tdScene);
        tbody.appendChild(tr);
    });
};

socket.on('session_data_result', (data) => {
    isFetchingSessionData = false;
    const modalLoading = document.getElementById('modal-loading');
    const triggerModal = document.getElementById('trigger-modal');
    
    if (data.error) {
        alert("セッションデータの取得に失敗しました。Ableton Liveとosc-routerが起動しているか確認してください。");
        if(modalLoading) modalLoading.style.display = 'none';
        if(triggerModal) triggerModal.classList.add('hidden');
        return;
    }
    
    const isModalOpen = triggerModal && !triggerModal.classList.contains('hidden');
    const modalWarning = document.getElementById('modal-warning');
    
    if (cachedSessionData) {
        const isChanged = (cachedSessionData.numScenes !== data.numScenes || cachedSessionData.numTracks !== data.numTracks);
        if (isChanged && isModalOpen) {
            if(modalWarning) modalWarning.classList.remove('hidden');
            cachedSessionData.pendingUpdate = data;
            return;
        }
    }
    
    cachedSessionData = data;
    
    if (isModalOpen && (!modalWarning || modalWarning.classList.contains('hidden'))) {
        if(modalLoading) modalLoading.style.display = 'none';
        document.getElementById('modal-grid-container').classList.remove('hidden');
        renderSessionGrid(cachedSessionData);
    }
});

const btnUpdateSessionLocal = document.getElementById('btn-update-session');
if (btnUpdateSessionLocal) {
    btnUpdateSessionLocal.addEventListener('click', () => {
        if (cachedSessionData && cachedSessionData.pendingUpdate) {
            cachedSessionData = cachedSessionData.pendingUpdate;
        }
        document.getElementById('modal-warning').classList.add('hidden');
        document.getElementById('modal-loading').style.display = 'none';
        document.getElementById('modal-grid-container').classList.remove('hidden');
        renderSessionGrid(cachedSessionData);
    });
}

document.getElementById('modal-refresh').addEventListener('click', () => {
    document.getElementById('modal-grid-container').classList.add('hidden');
    document.getElementById('modal-loading').style.display = 'block';
    const warn = document.getElementById('modal-warning');
    if(warn) warn.classList.add('hidden');
    isFetchingSessionData = true;
    socket.emit('get_session_data');
});

document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('trigger-modal').classList.add('hidden');
});

const placeTrigger = (trackIndex, sceneIndex, labelText, isScene = false) => {
    if (!pendingTriggerPos || pendingTriggerPage === null) return;
    
    if (!labelText && cachedSessionData && cachedSessionData.scenes[sceneIndex]) {
        labelText = cachedSessionData.scenes[sceneIndex].name;
    }

    if (isContinuousMode && isScene) {
        nextContinuousSceneIndex = sceneIndex + 1;
        updateContinuousStatusUI();
    }

    const canvas = fabricCanvases[pendingTriggerPage];
    
    const rect = new fabric.Rect({
        width: 140, height: 50, fill: isScene ? '#007aff' : '#ff2d55', rx: 10, ry: 10,
        originX: 'center', originY: 'center',
        shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 5, offsetX: 2, offsetY: 2 })
    });
    
    const text = new fabric.Text(labelText, {
        fontSize: 16, fill: '#ffffff', fontWeight: 'bold',
        fontFamily: '"Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
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
    
    document.getElementById('trigger-modal').classList.add('hidden');
    // 配置後もトリガーモードを維持するため、閲覧モードへの自動遷移を削除
    // setMode(MODES.VIEW);
};

// --- 初期化フロー ---

socket.emit('load_all_data');
socket.on('all_data_loaded', (data) => {
    currentPdfName = data.activePdfName || 'sample.pdf';
    pagesData = data.pagesData || {};
    
    const pdfUrl = `/assets/${currentPdfName}?t=` + Date.now(); // キャッシュ回避
    
    pdfjsLib.getDocument(pdfUrl).promise.then((pdfDoc_) => {
        pdfDoc = pdfDoc_;
        renderAllPages();
    }).catch(err => {
        console.error('PDF Load Error:', err);
        zoomWrapper.innerHTML = `
            <div style="color:white; padding: 50px; text-align: center; margin-top: 1000px; transform: scale(3);">
                <h2>PDFがまだアップロードされていません</h2>
                <p>右上の「📄 PDF変更」ボタンから台本PDFをアップロードしてください。</p>
            </div>
        `;
    });
});

// --- PDFアップロード機能 ---
const btnUpload = document.getElementById('btn-upload-pdf');
const inputUpload = document.getElementById('pdf-upload-input');

if (btnUpload && inputUpload) {
    btnUpload.addEventListener('click', () => {
        inputUpload.click();
    });

    inputUpload.addEventListener('change', async (e) => {
        if (!e.target.files || e.target.files.length === 0) return;
        
        const file = e.target.files[0];
        const formData = new FormData();
        formData.append('pdf', file);
        
        btnUpload.textContent = 'アップロード中...';
        btnUpload.disabled = true;

        try {
            const res = await fetch('/upload-pdf', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!data.success) {
                alert('アップロードに失敗しました: ' + data.error);
                btnUpload.textContent = '📄 PDF変更';
                btnUpload.disabled = false;
            }
            // 成功時は socket.on('pdf_updated') によって全クライアントが一斉に自動リロードされる
        } catch (err) {
            console.error('Upload error:', err);
            alert('アップロード中にエラーが発生しました');
            btnUpload.textContent = '📄 PDF変更';
            btnUpload.disabled = false;
        } finally {
            inputUpload.value = ''; // 連続アップロード可能にするためリセット
        }
    });
}

// 他の端末（または自身）でPDFがアップロード・更新された場合、自動で画面をリロードする
socket.on('pdf_updated', () => {
    window.location.reload();
});

// --- PDF書き出し機能 ---
const btnExport = document.getElementById('btn-export-pdf');
if (btnExport) {
    btnExport.addEventListener('click', async () => {
        if (!pdfDoc || !currentPdfName) {
            alert('PDFが読み込まれていません');
            return;
        }
        
        btnExport.textContent = '書き出し中...';
        btnExport.disabled = true;
        
        try {
            // 1. 元のPDFをダウンロードして pdf-lib でロード
            const pdfUrl = `/assets/${currentPdfName}?t=${Date.now()}`;
            const existingPdfBytes = await fetch(pdfUrl).then(res => res.arrayBuffer());
            
            const { PDFDocument } = PDFLib;
            const pdfDocLib = await PDFDocument.load(existingPdfBytes);
            const pages = pdfDocLib.getPages();
            
            // 2. 各ページのFabric上のオブジェクト（手書き・ボタン）を透過PNGとして埋め込む
            for (let num = 1; num <= pages.length; num++) {
                const page = pages[num - 1];
                const pageHeight = page.getHeight();
                const canvas = fabricCanvases[num];
                if (!canvas) continue;
                
                const objects = canvas.getObjects();
                for (const obj of objects) {
                    // Fabricの描画スケール（1.5）を元のPDFサイズに戻す係数
                    const pdfScale = 1 / scale; 
                    
                    // オブジェクト単体を高画質の背景透過PNGとして書き出し
                    const dataUrl = obj.toDataURL({ format: 'png', multiplier: 3 });
                    const imgBytes = await fetch(dataUrl).then(res => res.arrayBuffer());
                    const img = await pdfDocLib.embedPng(imgBytes);
                    
                    const w = obj.getScaledWidth() * pdfScale;
                    const h = obj.getScaledHeight() * pdfScale;
                    
                    let cx = obj.left * pdfScale;
                    let cy = obj.top * pdfScale;
                    
                    // originが 'left' / 'top' の場合、中心座標に補正する（手書きパス等）
                    if (obj.originX === 'left') cx += (w / 2);
                    if (obj.originY === 'top') cy += (h / 2);
                    
                    // PDFは左下が原点 (0,0) なのでY座標を反転。drawImageの起点は左下
                    const pdfX = cx - (w / 2);
                    const pdfY = pageHeight - cy - (h / 2);
                    
                    page.drawImage(img, { 
                        x: pdfX, 
                        y: pdfY, 
                        width: w, 
                        height: h 
                    });
                }
            }
            
            // 3. 合成したPDFをブラウザでダウンロード
            const pdfBytes = await pdfDocLib.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `Exported_${currentPdfName}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
        } catch (err) {
            console.error('PDF Export Error:', err);
            alert('PDFの書き出し中にエラーが発生しました。コンソールをご確認ください。');
        } finally {
            btnExport.textContent = '⬇️ PDF書き出し';
            btnExport.disabled = false;
        }
    });
}
