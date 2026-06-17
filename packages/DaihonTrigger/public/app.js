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
const MODES = { VIEW: 'view', SELECT: 'select', DRAW: 'draw', ERASER: 'eraser', TRIGGER: 'trigger' };
let currentMode = MODES.VIEW;
let pendingTriggerPos = null;
let pendingTriggerPage = null;

let cachedSessionData = null;
let isFetchingSessionData = false;
let isContinuousMode = false;
let nextContinuousSceneIndex = null;

// --- ドラッグ用ゴースト要素の準備 ---
const dragGhost = document.createElement('img');
dragGhost.style.position = 'fixed';
dragGhost.style.pointerEvents = 'none'; // マウスイベントを貫通させる
dragGhost.style.zIndex = '9999';
dragGhost.style.display = 'none';
dragGhost.style.opacity = '0.7'; // ちょっと半透明にする
document.body.appendChild(dragGhost);

let activeDragObject = null;
let activeDragStartCanvasNum = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

// --- コンテキストメニュー（コピー・ペースト） ---
let clipboardObject = null;
const contextMenu = document.getElementById('context-menu');
const btnCtxCopy = document.getElementById('btn-ctx-copy');
const btnCtxPaste = document.getElementById('btn-ctx-paste');
const btnCtxDelete = document.getElementById('btn-ctx-delete');

let contextTargetCanvasNum = null; // 現在メニューが表示されているキャンバスの番号
let contextMenuTimeout = null;
let pasteTouchStartCoords = null; // タップ判定用座標
let pasteTouchCanceled = false; // タップのキャンセルフラグ
let touchTargetObject = null; // タップした対象オブジェクト

const hideContextMenu = () => {
    contextMenu.classList.remove('visible');
    clearTimeout(contextMenuTimeout);
    contextMenuTimeout = setTimeout(() => {
        if (!contextMenu.classList.contains('visible')) {
            contextMenu.classList.add('hidden');
        }
    }, 200);
};

const showContextMenu = (x, y, showPasteOnly = false, canvasNum = null) => {
    if (showPasteOnly && !clipboardObject) return; // ペーストのみでクリップボード空なら出さない
    
    contextTargetCanvasNum = canvasNum;
    contextMenu.classList.remove('hidden');
    clearTimeout(contextMenuTimeout);
    
    requestAnimationFrame(() => {
        contextMenu.classList.add('visible');
    });
    
    // 表示内容の切り替え
    if (showPasteOnly) {
        btnCtxCopy.style.display = 'none';
        btnCtxDelete.style.display = 'none';
        btnCtxPaste.style.display = 'block';
    } else {
        btnCtxCopy.style.display = 'block';
        btnCtxDelete.style.display = 'block';
        btnCtxPaste.style.display = 'none';
    }
    
    // 位置計算
    const rect = contextMenu.getBoundingClientRect();
    // DOMに追加された直後はrectの幅が0の場合があるので、大体のサイズ(150px*40px)を仮定
    const w = rect.width || 150;
    const h = rect.height || 40;
    
    let left = x - w / 2;
    let top = y - h - 15;
    
    if (left < 10) left = 10;
    if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
    if (top < 10) top = y + 25;
    
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
};


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
        let displayName = `Scene ${nextContinuousSceneIndex + 1}`;
        if (cachedSessionData && cachedSessionData.scenes && cachedSessionData.scenes[nextContinuousSceneIndex]) {
            displayName = cachedSessionData.scenes[nextContinuousSceneIndex].name || displayName;
        }
        continuousNextText.textContent = `次の配置: ${displayName}`;
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
    select: document.getElementById('mode-select'),
    draw: document.getElementById('mode-draw'),
    eraser: document.getElementById('mode-eraser'),
    trigger: document.getElementById('mode-trigger')
};

const setMode = (mode) => {
    hideContextMenu(); // モードを切り替えたらコンテキストメニューを閉じる
    
    currentMode = mode;
    Object.values(modeBtns).forEach(btn => btn.classList.remove('active'));
    
    if (mode === MODES.VIEW) modeBtns.view.classList.add('active');
    else if (mode === MODES.SELECT) modeBtns.select.classList.add('active');
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
            obj.selectable = (mode === MODES.SELECT);
            obj.evented = true;
            
            // ペンで描いた線（isTriggerがないオブジェクト）の当たり判定を拡大
            if (!obj.isTrigger && obj.type === 'path') {
                obj.perPixelTargetFind = false;
                obj.padding = 10;
            }
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
        
        const renderCanvasEl = document.createElement('canvas');
        renderCanvasEl.className = 'pdf-render-canvas';
        renderCanvasEl.style.position = 'absolute';
        renderCanvasEl.style.top = '0';
        renderCanvasEl.style.left = '0';
        renderCanvasEl.style.zIndex = '1';
        
        const fabCanvasEl = document.createElement('canvas');
        fabCanvasEl.id = `fabric-canvas-${num}`;
        
        pageContainer.appendChild(renderCanvasEl);
        pageContainer.appendChild(fabCanvasEl);
        zoomWrapper.appendChild(pageContainer);

        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale });

        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;
        
        if (num === 1) {
            setMode(MODES.VIEW); // 初期モード適用
            // 最初のページの幅が確定した直後にスクロール位置をリセットする
            const scaledPdfWidth = viewport.width * currentZoom;
            const centerX = 250 + (scaledPdfWidth / 2);
            const centerY = 250;
            container.scrollLeft = Math.max(0, centerX - (window.innerWidth / 2));
            container.scrollTop = Math.max(0, centerY - 50);
        }
        
        // --- 高解像度Canvasレンダリング (SVGの代わり) ---
        // iOS等で複雑なPDFをSVG化すると処理落ちや描画失敗が起きるためCanvasを使用
        const dpr = window.devicePixelRatio || 1;
        renderCanvasEl.width = viewport.width * dpr;
        renderCanvasEl.height = viewport.height * dpr;
        renderCanvasEl.style.width = `${viewport.width}px`;
        renderCanvasEl.style.height = `${viewport.height}px`;

        const ctx = renderCanvasEl.getContext('2d');
        // 解像度に合わせてスケール調整
        ctx.scale(dpr, dpr);

        await page.render({
            canvasContext: ctx,
            viewport: viewport
        }).promise;

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
                // 既存のトリガーボタンも高画質化するためキャッシュを無効化
                fabCanvas.getObjects().forEach(obj => {
                    if (obj.isTrigger) {
                        obj.set('objectCaching', false);
                        if (obj.getObjects) {
                            obj.getObjects().forEach(child => child.set('objectCaching', false));
                        }
                    }
                });
                setMode(currentMode);
                fabCanvas.renderAll();
                fabCanvas.isRestoring = false;
            });
        }

        // イベント設定
        setupFabricEvents(fabCanvas, num);
    } // for loop end
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
    canvas.on('path:created', (e) => {
        if (currentMode === MODES.DRAW) {
            // ピンチ中、またはピンチ終了直後(500ms以内)のパスは、二本指パンの1本目が誤爆して描画されたものとして削除
            if (isPinching || (Date.now() - lastPinchTime < 500)) {
                canvas.remove(e.path);
                return;
            }
            e.path.perPixelTargetFind = false;
            e.path.padding = 10;
            e.path.selectable = (currentMode === MODES.SELECT);
            saveCurrentPage(pageNum);
        }
    });

    canvas.on('object:modified', () => {
        // 同じページ内での移動やリサイズが確定した場合のみ保存する（別ページ移動時はmouse:upで処理）
        if (!activeDragObject) {
            saveCurrentPage(pageNum);
        }
    });
    
    // ドラッグ移動中（ゴーストの追従）
    canvas.on('object:moving', (options) => {
        if (currentMode !== MODES.SELECT) return;
        
        hideContextMenu(); // ドラッグ開始・移動中はコンテキストメニューを非表示にする
        
        const obj = options.target;
        const e = options.e;
        let clientX = e.clientX;
        let clientY = e.clientY;
        
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }

        if (dragGhost.style.display === 'none') {
            activeDragObject = obj;
            activeDragStartCanvasNum = pageNum;
            
            // ゴーストに選択枠やパディングが写り込まないよう一時的にオフ
            const origHasControls = obj.hasControls;
            const origHasBorders = obj.hasBorders;
            const origPadding = obj.padding || 0;
            obj.set({ hasControls: false, hasBorders: false, padding: 0 });
            
            // ズームを加味して高画質に画像化
            const dataUrl = obj.toDataURL({ format: 'png', multiplier: currentZoom });
            dragGhost.src = dataUrl;
            dragGhost.style.display = 'block';
            
            // パディングなしの純粋なオブジェクト領域を取得
            const bound = obj.getBoundingRect();
            // ゴースト画像は画面のbody直下にあるため、CSSズームを掛けたサイズにする
            dragGhost.style.width = `${bound.width * currentZoom}px`;
            dragGhost.style.height = `${bound.height * currentZoom}px`;
            
            // 元の設定に戻す
            obj.set({ hasControls: origHasControls, hasBorders: origHasBorders, padding: origPadding });
            
            // マウスカーソルに対する正確なオフセット（キャンバスの絶対座標とズームを考慮）
            const canvasRect = canvas.lowerCanvasEl.getBoundingClientRect();
            // boundの座標はCanvas内部の論理値なので、画面上の位置にするにはズームを掛ける
            const absoluteObjLeft = canvasRect.left + (bound.left * currentZoom);
            const absoluteObjTop = canvasRect.top + (bound.top * currentZoom);
            
            dragOffsetX = clientX - absoluteObjLeft;
            dragOffsetY = clientY - absoluteObjTop;
            
            obj.set('opacity', 0.2); // 元のオブジェクトを半透明に
        }

        // ゴーストの位置を更新
        if (dragGhost.style.display === 'block') {
            dragGhost.style.left = `${clientX - dragOffsetX}px`;
            dragGhost.style.top = `${clientY - dragOffsetY}px`;
        }
    });

    // マウスアップ時のドロップ処理
    canvas.on('mouse:up', (options) => {
        if (activeDragObject && dragGhost.style.display === 'block') {
            const e = options.e;
            let clientX = e.clientX || 0;
            let clientY = e.clientY || 0;
            if (e.changedTouches && e.changedTouches.length > 0) {
                clientX = e.changedTouches[0].clientX;
                clientY = e.changedTouches[0].clientY;
            }
            
            dragGhost.style.display = 'none';
            activeDragObject.set('opacity', 1);
            
            // どのキャンバス(ページ)にドロップされたかを判定
            let targetPageNum = null;
            const containers = document.querySelectorAll('.page-container');
            containers.forEach((container, index) => {
                const rect = container.getBoundingClientRect();
                if (clientX >= rect.left && clientX <= rect.right &&
                    clientY >= rect.top && clientY <= rect.bottom) {
                    targetPageNum = index + 1; // 1始まり
                }
            });

            if (targetPageNum && targetPageNum !== pageNum) {
                const targetCanvas = fabricCanvases[targetPageNum];
                if (targetCanvas) {
                    const targetContainer = document.getElementById(`page-container-${targetPageNum}`);
                    const targetRect = targetContainer.getBoundingClientRect();
                    
                    const ghostLeft = parseFloat(dragGhost.style.left);
                    const ghostTop = parseFloat(dragGhost.style.top);
                    
                    // 新しいキャンバス内の論理座標（現在のズームを考慮）
                    const newLeft = (ghostLeft - targetRect.left) / currentZoom;
                    const newTop = (ghostTop - targetRect.top) / currentZoom;
                    
                    // プロパティを複製して別キャンバスに追加
                    activeDragObject.clone((clonedObj) => {
                        clonedObj.set({ left: newLeft, top: newTop });
                        targetCanvas.add(clonedObj);
                        targetCanvas.requestRenderAll();
                        canvas.remove(activeDragObject);
                        canvas.requestRenderAll();
                        
                        saveCurrentPage(pageNum);
                        saveCurrentPage(targetPageNum);
                        
                        activeDragObject = null;
                        activeDragStartCanvasNum = null;
                    }, ['isTrigger', 'trackNum', 'sceneNum', 'isSceneTrigger', 'id']);
                    return; // cloneは非同期なのでここで抜ける
                }
            } else {
                saveCurrentPage(pageNum);
            }
            
            activeDragObject = null;
            activeDragStartCanvasNum = null;
        }
    });
    
    const updateContextMenuPosition = () => {
        if (currentMode !== MODES.SELECT) return;
        const obj = canvas.getActiveObject();
        if (!obj) return;
        
        const canvasRect = canvas.lowerCanvasEl.getBoundingClientRect();
        const bound = obj.getBoundingRect();
        
        const x = canvasRect.left + (bound.left * currentZoom) + (bound.width * currentZoom / 2);
        const y = canvasRect.top + (bound.top * currentZoom);
        
        showContextMenu(x, y, false, pageNum);
    };

    canvas.on('selection:created', updateContextMenuPosition);
    canvas.on('selection:updated', updateContextMenuPosition);
    
    canvas.on('selection:cleared', () => {
        if (contextTargetCanvasNum === pageNum) hideContextMenu();
    });
    
    // 消しゴム等で消えた後に保存
    canvas.on('object:removed', () => {
        if (!canvas.isRestoring) saveCurrentPage(pageNum);
    });

    // マウスダウン・タッチイベント
    canvas.on('mouse:down', (options) => {
        const e = options.e;
        const isMultiTouch = e.touches && e.touches.length > 1;

        touchTargetObject = options.target;

        if (currentMode === MODES.SELECT && !options.target && !isPinching && !isMultiTouch) {
            // 他のキャンバスでメニューが出ていたら消す
            if (contextTargetCanvasNum && contextTargetCanvasNum !== pageNum) {
                hideContextMenu();
            }
            pasteTouchCanceled = false;
            let clientX = e.clientX || 0;
            let clientY = e.clientY || 0;
            if (e.touches && e.touches.length > 0) {
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            }
            pasteTouchStartCoords = { x: clientX, y: clientY };
        } else if (currentMode === MODES.VIEW || currentMode === MODES.TRIGGER) {
            pasteTouchCanceled = false;
            let clientX = e.clientX || 0;
            let clientY = e.clientY || 0;
            if (e.touches && e.touches.length > 0) {
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            }
            pasteTouchStartCoords = { x: clientX, y: clientY };
        }

        // アンドゥ用に状態保存 (トリガー配置・描画・消去の直前状態)
        if (currentMode === MODES.DRAW || currentMode === MODES.ERASER || currentMode === MODES.TRIGGER) {
            saveStateForUndo(pageNum);
        }

        if (currentMode === MODES.ERASER) {
            isErasing = true;
            if (options.target) canvas.remove(options.target);
        }
    });

    canvas.on('mouse:move', (options) => {
        if (pasteTouchStartCoords) {
            const e = options.e;
            let currentX = e.clientX || 0;
            let currentY = e.clientY || 0;
            if (e.touches && e.touches.length > 0) {
                currentX = e.touches[0].clientX;
                currentY = e.touches[0].clientY;
            }
            const dx = currentX - pasteTouchStartCoords.x;
            const dy = currentY - pasteTouchStartCoords.y;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
                pasteTouchCanceled = true;
            }
        }
        
        if (currentMode === MODES.ERASER && isErasing) {
            // 対象を検索して消す (ポインター下のオブジェクト)
            const pointer = canvas.getPointer(options.e);
            const targets = canvas.getObjects().filter(obj => obj.containsPoint(pointer));
            targets.forEach(obj => canvas.remove(obj));
        }
    });

    canvas.on('mouse:up', (options) => {
        // ペーストメニュー表示のタップ完了判定
        if (currentMode === MODES.SELECT && pasteTouchStartCoords && !pasteTouchCanceled && !isPinching) {
            // options.target が無く、かつ動いていない場合のみ表示
            if (!touchTargetObject) {
                if (contextMenu.classList.contains('visible')) {
                    hideContextMenu();
                } else {
                    showContextMenu(pasteTouchStartCoords.x, pasteTouchStartCoords.y, true, pageNum);
                }
            }
        }
        
        // トリガー発火のタップ完了判定
        if (currentMode === MODES.VIEW && touchTargetObject && touchTargetObject.isTrigger && !pasteTouchCanceled && !isPinching) {
            if (touchTargetObject.isSceneTrigger) {
                const s = touchTargetObject.sceneNum;
                console.log(`OSC Fire Scene: Scene ${s}`);
                socket.emit('fire_scene', { scene: s });
            } else {
                const t = touchTargetObject.trackNum;
                const s = touchTargetObject.sceneNum;
                console.log(`OSC Fire: Track ${t}, Scene ${s}`);
                socket.emit('fire_clip', { track: t, scene: s });
            }
            
            touchTargetObject.set('opacity', 0.5);
            canvas.renderAll();
            const targetRef = touchTargetObject;
            setTimeout(() => {
                if (targetRef) targetRef.set('opacity', 1);
                canvas.renderAll();
            }, 200);
        }

        // トリガー配置モーダルのタップ完了判定
        if (currentMode === MODES.TRIGGER && !touchTargetObject && pasteTouchStartCoords && !pasteTouchCanceled && !isPinching) {
            pendingTriggerPos = canvas.getPointer(options.e);
            pendingTriggerPage = pageNum;
            
            if (isContinuousMode && nextContinuousSceneIndex !== null) {
                placeTrigger(null, nextContinuousSceneIndex, null, true);
            } else {
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
            }
        }

        pasteTouchStartCoords = null;
        pasteTouchCanceled = false;
        touchTargetObject = null;

        isErasing = false;
    });
};

let isPinching = false;
let isPanning = false;
let initialDistance = 0;
let initialZoom = 1.0;
let lastCenter = { x: 0, y: 0 };
let lastPinchTime = 0;

// 慣性スクロール（モメンタム）用
let velocityX = 0;
let velocityY = 0;
let lastTouchTime = 0;
let momentumId = null;

// ズーム更新の最適化（ガクツキ防止）
let isZoomTicking = false;

const applyZoomTransform = () => {
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
        pasteTouchCanceled = true; // 2本目の指が触れたらペーストをキャンセル
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
                
                // 描画途中のトップコンテキストのインクを強制クリアして操作中のチラつきを防ぐ
                if (c.contextTop) {
                    c.clearContext(c.contextTop);
                }
            }
        });
    } else if (e.touches.length === 1 && (currentMode === MODES.VIEW || currentMode === MODES.SELECT || currentMode === MODES.TRIGGER)) {
        // 1本指パンの準備 (SELECT/TRIGGERモードではtouchmove時にオブジェクトを触っていないか確認してパン開始)
        isPanning = (currentMode === MODES.VIEW); // VIEWモードは無条件でパン開始
        container._potentialPan = true;
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
            
            // スケールの基準点（transform-origin）は #zoom-wrapper の左上
            // レイアウト変更や画面幅に依存しないよう、実際のDOM位置から取得する
            const originX = zoomWrapper.offsetLeft || 250;
            const originY = zoomWrapper.offsetTop || 250;
            
            const distX = absoluteX - originX;
            const distY = absoluteY - originY;
            
            const newDistX = distX * (clampedZoom / oldZoom);
            const newDistY = distY * (clampedZoom / oldZoom);
            
            container.scrollLeft = (originX + newDistX) - relX;
            container.scrollTop = (originY + newDistY) - relY;
            
            // 状態（変数）は即座に同期更新し、次回のtouchmoveで計算が狂うのを防ぐ
            currentZoom = clampedZoom;
            
            // ズーム描画の間引き（GPU負荷軽減）
            if (!isZoomTicking) {
                requestAnimationFrame(() => {
                    applyZoomTransform();
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
    } else if (e.touches.length === 1) {
        if (container._potentialPan && !touchTargetObject) {
            // オブジェクトを触っていなければパンに昇格
            isPanning = true;
            container._potentialPan = false;
        }

        if (isPanning) {
            // 1本指でのパンスクロール
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
    }
}, { passive: false });

container.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        if (isPinching) {
            isPinching = false;
            lastPinchTime = Date.now();
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
            
            const originX = zoomWrapper.offsetLeft || 250;
            const originY = zoomWrapper.offsetTop || 250;
            
            const distX = absoluteX - originX;
            const distY = absoluteY - originY;
            
            const newDistX = distX * (clampedZoom / oldZoom);
            const newDistY = distY * (clampedZoom / oldZoom);
            
            container.scrollLeft = (originX + newDistX) - relX;
            container.scrollTop = (originY + newDistY) - relY;
            
            // 状態（変数）は即座に同期更新する
            currentZoom = clampedZoom;
            
            if (!isZoomTicking) {
                requestAnimationFrame(() => {
                    applyZoomTransform();
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
    
    // 高画質化のため、2倍のサイズで作成して0.5倍にスケールダウンする
    const rect = new fabric.Rect({
        width: 280, height: 100, fill: isScene ? '#007aff' : '#ff2d55', rx: 20, ry: 20,
        originX: 'center', originY: 'center',
        shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 10, offsetX: 4, offsetY: 4 }),
        objectCaching: false // キャッシュを使わず常にネイティブ解像度で描画
    });
    
    const text = new fabric.Text(labelText, {
        fontSize: 48, fill: '#ffffff', fontWeight: 'bold', // 余白を減らすため文字をさらに大きく
        fontFamily: '"Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
        originX: 'center', originY: 'center', textAlign: 'center',
        objectCaching: false
    });
    
    const group = new fabric.Group([rect, text], {
        left: pendingTriggerPos.x, top: pendingTriggerPos.y,
        originX: 'center', originY: 'center',
        scaleX: 0.5, scaleY: 0.5,
        hasControls: true, hasBorders: true,
        objectCaching: false,
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
    // 初回ロード時にAbletonのセッションデータをバックグラウンドで取得開始（高速化）
    if (!isFetchingSessionData && !cachedSessionData) {
        isFetchingSessionData = true;
        socket.emit('get_session_data');
    }

    currentPdfName = data.activePdfName || 'sample.pdf';
    pagesData = data.pagesData || {};
    
    const pdfUrl = `/assets/${encodeURIComponent(currentPdfName)}?t=` + Date.now(); // キャッシュ回避
    
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
        
        btnUpload.textContent = '読込中...';
        btnUpload.disabled = true;

        try {
            // iOS Safari等のクラウドファイルピッカーのバグ対策：
            // 実データのダウンロード完了を待つため、一度ArrayBufferとして全て読み込んでからBlobに再構築する
            const arrayBuffer = await file.arrayBuffer();
            const safeBlob = new Blob([arrayBuffer], { type: file.type || 'application/pdf' });
            
            const formData = new FormData();
            // multerでの文字化けを完全に防ぐため、ファイル名をURLエンコードして送信する
            formData.append('pdf', safeBlob, encodeURIComponent(file.name));
            
            btnUpload.textContent = 'アップロード中...';

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
            const pdfUrl = `/assets/${encodeURIComponent(currentPdfName)}?t=${Date.now()}`;
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
            
            // 3. 合成したPDFを保存
            const pdfBytes = await pdfDocLib.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const defaultFilename = `Exported_${currentPdfName}`;
            
            if (window.showSaveFilePicker) {
                // File System Access API (Chrome/Edge等) を使用して保存先を選択させる
                const handle = await window.showSaveFilePicker({
                    suggestedName: defaultFilename,
                    types: [{
                        description: 'PDF File',
                        accept: { 'application/pdf': ['.pdf'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } else {
                // 非対応ブラウザのフォールバック（従来通りダウンロード）
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = defaultFilename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
            
        } catch (err) {
            if (err.name === 'AbortError') {
                // ユーザーが保存ダイアログでキャンセルした場合は無視
                console.log('PDF export was canceled by the user.');
            } else {
                console.error('PDF Export Error:', err);
                alert('PDFの書き出し中にエラーが発生しました。コンソールをご確認ください。');
            }
        } finally {
            btnExport.textContent = '⬇️ PDF書き出し';
            btnExport.disabled = false;
        }
    });
}

// --- コンテキストメニューのボタンイベント ---
btnCtxCopy.addEventListener('click', () => {
    if (!contextTargetCanvasNum) return;
    const canvas = fabricCanvases[contextTargetCanvasNum];
    if (!canvas) return;
    const activeObj = canvas.getActiveObject();
    if (!activeObj) return;
    
    // オブジェクトのクローンを非同期で作成してクリップボードに保存
    activeObj.clone((cloned) => {
        clipboardObject = cloned;
        hideContextMenu();
        canvas.discardActiveObject();
        canvas.requestRenderAll();
    }, ['isTrigger', 'trackNum', 'sceneNum', 'isSceneTrigger', 'id']);
});

btnCtxDelete.addEventListener('click', () => {
    if (!contextTargetCanvasNum) return;
    const canvas = fabricCanvases[contextTargetCanvasNum];
    if (!canvas) return;
    const activeObj = canvas.getActiveObject();
    if (!activeObj) return;
    
    saveStateForUndo(contextTargetCanvasNum);
    canvas.remove(activeObj);
    canvas.discardActiveObject();
    hideContextMenu();
});

btnCtxPaste.addEventListener('click', () => {
    if (!clipboardObject || !contextTargetCanvasNum) return;
    const canvas = fabricCanvases[contextTargetCanvasNum];
    if (!canvas) return;
    
    saveStateForUndo(contextTargetCanvasNum);
    
    // もう一度クローンしてキャンバスに追加（同じものを何度もペーストできるようにするため）
    clipboardObject.clone((cloned) => {
        // メニューの「ペースト」ボタンを出した位置付近にペーストする
        const rect = canvas.lowerCanvasEl.getBoundingClientRect();
        // メニューのDOM要素の画面内座標
        const menuRect = contextMenu.getBoundingClientRect();
        // 中心より少し下くらい
        const px = menuRect.left + menuRect.width / 2;
        const py = menuRect.top + 30;
        
        // 画面座標をキャンバス内の論理座標に変換
        const logicalLeft = (px - rect.left) / currentZoom;
        const logicalTop = (py - rect.top) / currentZoom;
        
        cloned.set({
            left: logicalLeft,
            top: logicalTop,
            evented: true
        });

        canvas.add(cloned);
        canvas.setActiveObject(cloned);
        canvas.requestRenderAll();
        hideContextMenu();
        saveCurrentPage(contextTargetCanvasNum);
    }, ['isTrigger', 'trackNum', 'sceneNum', 'isSceneTrigger', 'id']);
});
