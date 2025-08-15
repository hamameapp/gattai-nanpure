document.addEventListener('DOMContentLoaded', () => {
    // --- DOM要素の取得 ---
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const statusDiv = document.getElementById('status');
    const cancelGenerationButton = document.getElementById('cancelGenerationButton');
    const addSquareButton = document.getElementById('addSquareButton');
    const deleteButton = document.getElementById('deleteButton');
    const generateProblemButton = document.getElementById('generateProblemButton');
    const editLayoutButton = document.getElementById('editLayoutButton');
    const checkButton = document.getElementById('checkButton');
    const solveButton = document.getElementById('solveButton');
    const clearUserInputButton = document.getElementById('clearUserInputButton');
    const exportTextButton = document.getElementById('exportTextButton');
    const exportModal = document.getElementById('exportModal');
    const closeModalButton = document.getElementById('closeModalButton');
    const combinedTextOutput = document.getElementById('combinedTextOutput');
    const copyCombinedButton = document.getElementById('copyCombinedButton');
    const saveCombinedButton = document.getElementById('saveCombinedButton');

    // --- 定数とグローバル変数 ---
    const CELL_SIZE = 30;
    const SQUARE_SIZE = CELL_SIZE * 9;
    const BLOCK_SNAP = CELL_SIZE * 3;

    let squares = [];
    let nextId = 1;
    let selectedSquareId = null;
    let selectedCell = null;
    let scale = 1.0;
    let viewOffsetX = 0;
    let viewOffsetY = 0;
    let isPanning = false;
    let lastPanPos = { x: 0, y: 0 };
    let isDragging = false;
    let dragOffsetX, dragOffsetY;
    let generationWorker = null;
    let isProblemGenerated = false;

    function getWorker() {
        if (generationWorker) generationWorker.terminate();
        const workerCode = `
            let isCancelled = false;
            let wasm_instance;
            let baseURL = '';

            async function initWasm(init_data) {
                if (wasm_instance) return true;
                try {
                    const wasmURL = \`\${baseURL}/solver.wasm\`;
                    const response = await fetch(wasmURL);
                    if (!response.ok) throw new Error(\`Failed to fetch wasm: \${response.statusText}\`);
                    const bytes = await response.arrayBuffer();
                    const { instance } = await WebAssembly.instantiate(bytes, {});
                    wasm_instance = instance;

                    const units_flat_ptr = wasm_instance.exports.malloc(init_data.units_flat.length * 4);
                    const unit_offsets_ptr = wasm_instance.exports.malloc(init_data.unit_offsets.length * 4);
                    const cell_to_units_flat_ptr = wasm_instance.exports.malloc(init_data.cell_to_units_flat.length * 4);
                    const cell_to_units_offsets_ptr = wasm_instance.exports.malloc(init_data.cell_to_units_offsets.length * 4);

                    new Int32Array(wasm_instance.exports.memory.buffer, units_flat_ptr, init_data.units_flat.length).set(init_data.units_flat);
                    new Int32Array(wasm_instance.exports.memory.buffer, unit_offsets_ptr, init_data.unit_offsets.length).set(init_data.unit_offsets);
                    new Int32Array(wasm_instance.exports.memory.buffer, cell_to_units_flat_ptr, init_data.cell_to_units_flat.length).set(init_data.cell_to_units_flat);
                    new Int32Array(wasm_instance.exports.memory.buffer, cell_to_units_offsets_ptr, init_data.cell_to_units_offsets.length).set(init_data.cell_to_units_offsets);

                    wasm_instance.exports.init_solver_data(
                        init_data.num_units, units_flat_ptr, unit_offsets_ptr,
                        init_data.num_cells, cell_to_units_flat_ptr, cell_to_units_offsets_ptr
                    );

                    wasm_instance.exports.free(units_flat_ptr);
                    wasm_instance.exports.free(unit_offsets_ptr);
                    wasm_instance.exports.free(cell_to_units_flat_ptr);
                    wasm_instance.exports.free(cell_to_units_offsets_ptr);
                    
                    return true;
                } catch (e) {
                    console.error("Wasm initialization failed:", e);
                    self.postMessage({ type: 'error', message: '高速ソルバー(solver.wasm)の読み込みまたは初期化に失敗しました。同じフォルダにファイルがあるか確認してください。' });
                    return false;
                }
            }

            function countSolutionsWasm(board) {
                if (!wasm_instance) return -1;
                const board_ptr = wasm_instance.exports.malloc(board.length * 4);
                new Int32Array(wasm_instance.exports.memory.buffer, board_ptr, board.length).set(board.map(c => c.value));
                const count = wasm_instance.exports.count_solutions(board_ptr, board.length);
                wasm_instance.exports.free(board_ptr);
                return count;
            }

            function shuffle(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }
            function cloneBoard(board) { return board.map(cell => ({ ...cell })); }
            
            async function nonBlockingLoop(items, processItem, progressCallback) {
                for (let i = 0; i < items.length; i++) {
                    processItem(items[i]);
                    if (isCancelled) return false;
                    if (i % 20 === 0) { // 20アイテムごとに進捗更新＆一時停止
                        progressCallback(i + 1, items.length);
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
                return true;
            }
            
            self.onmessage = async (e) => {
                const { command, baseURL: newBaseURL, squaresData } = e.data;
                if (command === 'cancel') { isCancelled = true; return; }
                if (newBaseURL) { baseURL = newBaseURL; }
                isCancelled = false;

                const CELL_SIZE = ${CELL_SIZE};
                let baseCells = [];
                const cellMap = new Map();
                for (const square of squaresData) { for (let r = 0; r < 9; r++) { for (let c = 0; c < 9; c++) { const key = \`\${square.x + c * CELL_SIZE},\${square.y + r * CELL_SIZE}\`; if (!cellMap.has(key)) { const cellInfo = { id: baseCells.length, value: 0, boards: [], constraints: new Set() }; baseCells.push(cellInfo); cellMap.set(key, cellInfo); } cellMap.get(key).boards.push({ sId: square.id, r, c }); } } }
                
                const constraintUnits = [];
                for (const square of squaresData) { for (let i = 0; i < 9; i++) { const rU = new Set(), cU = new Set(); for (let j = 0; j < 9; j++) { rU.add(cellMap.get(\`\${square.x + j * CELL_SIZE},\${square.y + i * CELL_SIZE}\`).id); cU.add(cellMap.get(\`\${square.x + i * CELL_SIZE},\${square.y + j * CELL_SIZE}\`).id); } constraintUnits.push(Array.from(rU)); constraintUnits.push(Array.from(cU)); } for (let br = 0; br < 3; br++) { for (let bc = 0; bc < 3; bc++) { const bU = new Set(); for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) { bU.add(cellMap.get(\`\${square.x + (bc*3+c)*CELL_SIZE},\${square.y + (br*3+r)*CELL_SIZE}\`).id); } } constraintUnits.push(Array.from(bU)); } } }
                
                baseCells.forEach(cell => { for(let i=0; i<constraintUnits.length; i++) { if (new Set(constraintUnits[i]).has(cell.id)) { cell.constraints.add(i); } } });
                
                const wasmReady = await initWasm({
                    num_units: constraintUnits.length,
                    units_flat: constraintUnits.flat(),
                    unit_offsets: constraintUnits.reduce((acc, u) => { acc.push(acc[acc.length - 1] + u.length); return acc; }, [0]),
                    num_cells: baseCells.length,
                    cell_to_units_flat: baseCells.flatMap(c => Array.from(c.constraints)),
                    cell_to_units_offsets: baseCells.reduce((acc, c) => { acc.push(acc[acc.length - 1] + c.constraints.size); return acc; }, [0])
                });

                if (!wasmReady) return;

                function generateSingleSolution(board) { const cS = board.find(c=>c.value===0); if(!cS)return true; const n = shuffle([1,2,3,4,5,6,7,8,9]); for(const num of n){ let ok=true; for(const ci of cS.constraints){ for(const pi of constraintUnits[ci]){ if(board[pi].value===num){ok=false;break;}}if(!ok)break;} if(ok){cS.value=num;if(generateSingleSolution(board))return true;cS.value=0;}} return false;}

                let success = false;
                const maxAttempts = 10;
                let finalProblem, finalSolution;
                const generationTimeout = 60000;
                const startTime = Date.now();
                
                // ★★★ 難易度調整: 各3x3グリッドに残すヒントの最小数 (推奨: 1～2) ★★★
                const MIN_HINTS_PER_SUBGRID = 5; 

                for (let attempt = 0; attempt < maxAttempts && !isCancelled; attempt++) {
                    if (Date.now() - startTime > generationTimeout) {
                        self.postMessage({ type: 'error', message: 'タイムアウトしました。盤面を単純にするか、再試行してください。' });
                        return;
                    }
                    self.postMessage({ type: 'status', message: \`解答を探索中... (試行 \${attempt + 1}/\${maxAttempts})\` });
                    
                    let solutionCells = cloneBoard(baseCells);
                    if (!generateSingleSolution(solutionCells)) { continue; }

                    let problemCells = cloneBoard(solutionCells);
                    
                    // 重なっているセルは先にすべて穴にする
                    for (const cell of problemCells) { if (cell.boards.length > 1) { cell.value = 0; } }

                    const nonOverlappingIndices = shuffle(problemCells.map((c, i) => c.boards.length === 1 ? i : -1).filter(i => i !== -1));
                    
                    const hintCountsPerSubgrid = {};
                    squaresData.forEach(sq => {
                        hintCountsPerSubgrid[sq.id] = Array(9).fill(0);
                    });
                    problemCells.forEach(cell => {
                        if (cell.value !== 0 && cell.boards.length === 1) {
                            const boardInfo = cell.boards[0];
                            const subgridIndex = Math.floor(boardInfo.r / 3) * 3 + Math.floor(boardInfo.c / 3);
                            hintCountsPerSubgrid[boardInfo.sId][subgridIndex]++;
                        }
                    });

                    const loopSuccess = await nonBlockingLoop(
                        nonOverlappingIndices,
                        (cellIndex) => {
                            const cell = problemCells[cellIndex];
                            const boardInfo = cell.boards[0];
                            const sId = boardInfo.sId;
                            const subgridIndex = Math.floor(boardInfo.r / 3) * 3 + Math.floor(boardInfo.c / 3);

                            if (hintCountsPerSubgrid[sId][subgridIndex] > MIN_HINTS_PER_SUBGRID) {
                                const originalValue = cell.value;
                                cell.value = 0;
                                
                                if (countSolutionsWasm(problemCells) !== 1) {
                                    cell.value = originalValue;
                                } else {
                                    hintCountsPerSubgrid[sId][subgridIndex]--;
                                }
                            }
                        },
                        (current, total) => {
                            self.postMessage({ type: 'status', message: \`問題を生成中... (\${Math.round((current/total)*100)}%)\` });
                        }
                    );

                    if (!loopSuccess || isCancelled) break;

                    if (countSolutionsWasm(problemCells) === 1) {
                        finalProblem = problemCells;
                        finalSolution = solutionCells;
                        success = true;
                        break;
                    }
                }

                if (isCancelled) { self.postMessage({ type: 'cancelled' }); return; }

                if (success) {
                    const problemBoards = {}; const solutionBoards = {};
                    squaresData.forEach(s => { problemBoards[s.id] = Array(9).fill(0).map(() => Array(9).fill(0)); solutionBoards[s.id] = Array(9).fill(0).map(() => Array(9).fill(0)); });
                    for (const cell of finalProblem) { for (const boardInfo of cell.boards) { problemBoards[boardInfo.sId][boardInfo.r][boardInfo.c] = cell.value; } }
                    for (const cell of finalSolution) { for (const boardInfo of cell.boards) { solutionBoards[boardInfo.sId][boardInfo.r][boardInfo.c] = cell.value; } }
                    self.postMessage({ type: 'result', problemBoards, solutionBoards });
                } else {
                    if(!isCancelled) self.postMessage({ type: 'error', message: '条件を満たす問題の作成に失敗しました。盤面の配置を変えて再試行してください。' });
                }
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }

    function initApp() {
        canvas.addEventListener('mousedown', onPointerDown);
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', initCanvasSize);
        addSquareButton.addEventListener('click', addSquare);
        deleteButton.addEventListener('click', deleteSelectedSquare);
        generateProblemButton.addEventListener('click', handleGenerateProblem);
        editLayoutButton.addEventListener('click', () => { isProblemGenerated = false; resetAllGrids(); selectSquare(null); });
        cancelGenerationButton.addEventListener('click', () => { if (generationWorker) { generationWorker.postMessage({ command: 'cancel' }); statusDiv.textContent = 'キャンセルしています...'; cancelGenerationButton.disabled = true; } });
        checkButton.addEventListener('click', handleCheck);
        solveButton.addEventListener('click', handleSolve);
        clearUserInputButton.addEventListener('click', handleClearUserInput);
        exportTextButton.addEventListener('click', handleExportText);
        closeModalButton.onclick = () => exportModal.style.display = 'none';
        window.onclick = (event) => { if (event.target == exportModal) { exportModal.style.display = "none"; } };
        copyCombinedButton.addEventListener('click', () => handleCopyToClipboard(copyCombinedButton, combinedTextOutput));
        saveCombinedButton.addEventListener('click', () => handleSaveToFile(combinedTextOutput.value, 'GattaiNanpure-Puzzle'));
        initCanvasSize();
        addSquare();
    };

    function initCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = window.innerHeight * 0.65 * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${window.innerHeight * 0.65}px`;
        ctx.scale(dpr, dpr);
        draw();
    }

    function draw() {
        if(!ctx) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        ctx.save();
        ctx.translate(viewOffsetX, viewOffsetY);
        ctx.scale(scale, scale);
        squares.forEach(square => {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(square.x, square.y, SQUARE_SIZE, SQUARE_SIZE);
            drawGridLines(square.x, square.y);
            drawNumbers(square);
        });
        if (selectedSquareId !== null) {
            const square = squares.find(s => s.id === selectedSquareId);
            if (square) {
                ctx.strokeStyle = '#4f46e5';
                ctx.lineWidth = 4 / scale;
                ctx.strokeRect(square.x - 2/scale, square.y - 2/scale, SQUARE_SIZE + 4/scale, SQUARE_SIZE + 4/scale);
            }
        }
        if (selectedCell) {
            const square = squares.find(s => s.id === selectedCell.squareId);
            if(square && square.problemData[selectedCell.r][selectedCell.c] === 0) {
                ctx.fillStyle = 'rgba(165, 180, 252, 0.3)';
                ctx.fillRect(square.x + selectedCell.c * CELL_SIZE, square.y + selectedCell.r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
        }
        ctx.restore();
    }

    function drawGridLines(offsetX, offsetY) {
        ctx.lineWidth = 1 / scale;
        ctx.strokeStyle = '#cbd5e1';
        for (let i = 0; i <= 9; i++) {
            ctx.beginPath();
            ctx.moveTo(offsetX + i * CELL_SIZE, offsetY);
            ctx.lineTo(offsetX + i * CELL_SIZE, offsetY + SQUARE_SIZE);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY + i * CELL_SIZE);
            ctx.lineTo(offsetX + SQUARE_SIZE, offsetY + i * CELL_SIZE);
            ctx.stroke();
        }
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = '#475569';
        for (let i = 0; i <= 9; i+=3) {
            ctx.beginPath();
            ctx.moveTo(offsetX + i * CELL_SIZE, offsetY);
            ctx.lineTo(offsetX + i * CELL_SIZE, offsetY + SQUARE_SIZE);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY + i * CELL_SIZE);
            ctx.lineTo(offsetX + SQUARE_SIZE, offsetY + i * CELL_SIZE);
            ctx.stroke();
        }
    }

    function drawNumbers(square) {
        const fontSize = CELL_SIZE * 0.6;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const cx = square.x + c * CELL_SIZE + CELL_SIZE / 2;
                const cy = square.y + r * CELL_SIZE + CELL_SIZE / 2;
                const problemVal = square.problemData[r][c];
                const userVal = square.userData[r][c];
                const checkVal = square.checkData[r][c];
                if (problemVal !== 0) {
                    ctx.fillStyle = '#111827';
                    ctx.font = `bold ${fontSize}px Arial`;
                    ctx.fillText(problemVal, cx, cy);
                } else if (userVal !== 0) {
                    ctx.font = `${fontSize}px Arial`;
                    if (checkVal === -1) { ctx.fillStyle = '#ef4444'; } 
                    else { ctx.fillStyle = '#2563eb'; }
                    ctx.fillText(userVal, cx, cy);
                }
            }
        }
    }

    function createEmptyGrid() { return Array(9).fill(0).map(() => Array(9).fill(0)); }

    function addSquare() {
        const rect = canvas.getBoundingClientRect();
        const centerX = (rect.width / 2 - viewOffsetX) / scale;
        const centerY = (rect.height / 2 - viewOffsetY) / scale;
        const newSquare = {
            id: nextId++,
            x: Math.round((centerX - SQUARE_SIZE / 2) / BLOCK_SNAP) * BLOCK_SNAP,
            y: Math.round((centerY - SQUARE_SIZE / 2) / BLOCK_SNAP) * BLOCK_SNAP,
            problemData: createEmptyGrid(),
            userData: createEmptyGrid(),
            solutionData: createEmptyGrid(),
            checkData: createEmptyGrid()
        };
        squares.push(newSquare);
        selectSquare(newSquare.id);
        draw();
    }

    function deleteSelectedSquare() {
        if (selectedSquareId !== null) {
            squares = squares.filter(s => s.id !== selectedSquareId);
            selectSquare(null);
            draw();
        }
    }

    function selectSquare(id) {
        selectedSquareId = id;
        if (id === null) {
            selectedCell = null;
        }
        updateButtonStates();
        draw();
    }

    function updateButtonStates() {
        deleteButton.disabled = selectedSquareId === null || isProblemGenerated;
        addSquareButton.disabled = isProblemGenerated;
        generateProblemButton.disabled = squares.length === 0;
        editLayoutButton.style.display = isProblemGenerated ? 'inline-block' : 'none';
        
        const hasSolution = squares.some(s => s.solutionData.flat().some(cell => cell !== 0));
        checkButton.disabled = !hasSolution;
        solveButton.disabled = !hasSolution;
        clearUserInputButton.disabled = !hasSolution;
        exportTextButton.disabled = !hasSolution;
    }

    function getPointerPos(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? e.touches?.[0]?.clientX;
        const clientY = e.clientY ?? e.touches?.[0]?.clientY;
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function onPointerDown(e) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const worldPos = { x: (pos.x - viewOffsetX) / scale, y: (pos.y - viewOffsetY) / scale };
        
        let clickedSquareIndex = -1;
        for (let i = squares.length - 1; i >= 0; i--) {
            const s = squares[i];
            if (worldPos.x >= s.x && worldPos.x <= s.x + SQUARE_SIZE &&
                worldPos.y >= s.y && worldPos.y <= s.y + SQUARE_SIZE) {
                clickedSquareIndex = i;
                break;
            }
        }

        if (isProblemGenerated) {
            if (clickedSquareIndex !== -1) {
                const square = squares[clickedSquareIndex];
                const r = Math.floor((worldPos.y - square.y) / CELL_SIZE);
                const c = Math.floor((worldPos.x - square.x) / CELL_SIZE);
                selectedCell = { squareId: square.id, r, c };
                selectSquare(square.id);
            } else {
                selectSquare(null);
            }
        } else {
            if (clickedSquareIndex !== -1) {
                isDragging = true;
                const square = squares[clickedSquareIndex];
                selectSquare(square.id);
                if (clickedSquareIndex < squares.length - 1) {
                    squares.push(squares.splice(clickedSquareIndex, 1)[0]);
                    selectedSquareId = square.id;
                }
                dragOffsetX = worldPos.x - square.x;
                dragOffsetY = worldPos.y - square.y;
            } else {
                isPanning = true;
                selectSquare(null);
                lastPanPos = { x: pos.x, y: pos.y };
                canvas.style.cursor = 'grabbing';
            }
        }

        window.addEventListener('mousemove', onPointerMove, { passive: false });
        window.addEventListener('mouseup', onPointerUp);
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        draw();
    }
    
    function onPointerMove(e) {
        const pos = getPointerPos(e);
        if (isDragging && selectedSquareId !== null) {
            e.preventDefault();
            const worldPos = { x: (pos.x - viewOffsetX) / scale, y: (pos.y - viewOffsetY) / scale };
            const selected = squares.find(s => s.id === selectedSquareId);
            if (selected) {
                selected.x = worldPos.x - dragOffsetX;
                selected.y = worldPos.y - dragOffsetY;
                draw();
            }
        } else if (isPanning) {
            e.preventDefault();
            viewOffsetX += pos.x - lastPanPos.x;
            viewOffsetY += pos.y - lastPanPos.y;
            lastPanPos = pos;
            draw();
        }
    }

    function onPointerUp(e) {
        if (isDragging && selectedSquareId !== null) {
            const selected = squares.find(s => s.id === selectedSquareId);
            if (selected) {
                selected.x = Math.round(selected.x / BLOCK_SNAP) * BLOCK_SNAP;
                selected.y = Math.round(selected.y / BLOCK_SNAP) * BLOCK_SNAP;
                draw();
            }
        }
        isDragging = false;
        isPanning = false;
        canvas.style.cursor = 'grab';
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
        window.removeEventListener('touchmove', onPointerMove);
        window.removeEventListener('touchend', onPointerUp);
    }
    
    function onWheel(e) {
        e.preventDefault();
        const zoomIntensity = 0.1;
        const scroll = e.deltaY < 0 ? (1 + zoomIntensity) : (1 - zoomIntensity);
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - viewOffsetX) / scale;
        const worldY = (mouseY - viewOffsetY) / scale;
        const newScale = Math.max(0.1, Math.min(5, scale * scroll));
        viewOffsetX = mouseX - worldX * newScale;
        viewOffsetY = mouseY - worldY * newScale;
        scale = newScale;
        draw();
    }

    function onKeyDown(e) {
        if (!selectedCell) return;
        const num = parseInt(e.key);
        const square = squares.find(s => s.id === selectedCell.squareId);
        if(square && square.problemData[selectedCell.r][selectedCell.c] === 0) {
            if (num >= 1 && num <= 9) {
                square.userData[selectedCell.r][selectedCell.c] = num;
                square.checkData[selectedCell.r][selectedCell.c] = 0;
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
                square.userData[selectedCell.r][selectedCell.c] = 0;
                square.checkData[selectedCell.r][selectedCell.c] = 0;
            }
            draw();
        }
    }

    function resetAllGrids() {
        squares.forEach(sq => {
            sq.problemData = createEmptyGrid();
            sq.userData = createEmptyGrid();
            sq.solutionData = createEmptyGrid();
            sq.checkData = createEmptyGrid();
        });
        isProblemGenerated = false;
        updateButtonStates();
        draw();
    }

    function handleGenerateProblem() {
        if (squares.length === 0) { alert("まず盤面を追加してください。"); return; }
        resetAllGrids();
        isProblemGenerated = false; // 生成開始時にリセット
        generateProblemButton.disabled = true;
        statusDiv.textContent = "問題を生成しています...";
        cancelGenerationButton.style.display = 'block';
        cancelGenerationButton.disabled = false;
        
        generationWorker = getWorker();
        const baseURL = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
        generationWorker.postMessage({ command: 'start', baseURL: baseURL, squaresData: squares.map(({id, x, y})=>({id, x, y})) });

        generationWorker.onmessage = function(e) {
            const { type, message, problemBoards, solutionBoards } = e.data;
            const isFinalState = ['result', 'error', 'cancelled'].includes(type);

            if (isFinalState) {
                generateProblemButton.disabled = false;
                cancelGenerationButton.style.display = 'none';
            }

            switch (type) {
                case 'status':
                    statusDiv.textContent = message;
                    break;
                case 'result':
                    isProblemGenerated = true;
                    squares.forEach(sq => {
                        if (problemBoards[sq.id]) {
                            sq.problemData = problemBoards[sq.id];
                            sq.solutionData = solutionBoards[sq.id];
                        }
                    });
                    statusDiv.textContent = "一意解を持つ問題が作成されました！";
                    updateButtonStates();
                    draw();
                    break;
                case 'error':
                    alert(message);
                    statusDiv.textContent = "エラーが発生しました。";
                    break;
                case 'cancelled':
                    statusDiv.textContent = '生成がキャンセルされました。';
                    break;
            }
        };
    }

    function handleCheck() {
        let allCorrect = true;
        squares.forEach(sq => {
            for (let r = 0; r < 9; r++) {
                for (let c = 0; c < 9; c++) {
                    if(sq.problemData[r][c] === 0 && sq.userData[r][c] !== 0) {
                        if (sq.userData[r][c] === sq.solutionData[r][c]) {
                            sq.checkData[r][c] = 1;
                        } else {
                            sq.checkData[r][c] = -1;
                            allCorrect = false;
                        }
                    }
                }
            }
        });
        draw();
        statusDiv.textContent = allCorrect ? "素晴らしい！すべて正解です！" : "間違いがあります。";
    }

    function handleSolve() {
        squares.forEach(sq => {
            sq.userData = JSON.parse(JSON.stringify(sq.solutionData));
            sq.checkData = createEmptyGrid();
        });
        draw();
        statusDiv.textContent = "解答を表示しました。";
    }

    function handleClearUserInput() {
        squares.forEach(sq => {
            sq.userData = createEmptyGrid();
            sq.checkData = createEmptyGrid();
        });
        draw();
        statusDiv.textContent = "入力内容をクリアしました。";
    }

    function handleExportText() {
        if (squares.length === 0) {
            combinedTextOutput.value = "";
            exportModal.style.display = 'flex';
            return;
        }

        const gridUnit = CELL_SIZE;
        let minX_world = Infinity, minY_world = Infinity;
        squares.forEach(s => { minX_world = Math.min(minX_world, s.x); minY_world = Math.min(minY_world, s.y); });
        
        let max_x_idx = 0, max_y_idx = 0;
        squares.forEach(s => {
            const startX = Math.round((s.x - minX_world) / gridUnit);
            const startY = Math.round((s.y - minY_world) / gridUnit);
            max_x_idx = Math.max(max_x_idx, startX + 8);
            max_y_idx = Math.max(max_y_idx, startY + 8);
        });

        const gridWidth = max_x_idx + 1;
        const gridHeight = max_y_idx + 1;

        if (gridWidth <= 0 || gridHeight <= 0 || !isFinite(gridWidth) || !isFinite(gridHeight)) {
            combinedTextOutput.value = "エラー: 盤面のサイズを計算できませんでした。";
            exportModal.style.display = 'flex';
            return;
        }

        const problemGrid = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(' '));
        const solutionGrid = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(' '));

        squares.forEach(s => {
            const startX = Math.round((s.x - minX_world) / gridUnit);
            const startY = Math.round((s.y - minY_world) / gridUnit);
            for (let r = 0; r < 9; r++) {
                for (let c = 0; c < 9; c++) {
                    const yIndex = startY + r;
                    const xIndex = startX + c;
                    if (yIndex < gridHeight && xIndex < gridWidth) {
                        if (s.problemData[r][c] !== 0) {
                            problemGrid[yIndex][xIndex] = String(s.problemData[r][c]);
                        } else if (problemGrid[yIndex][xIndex] === ' ') {
                             problemGrid[yIndex][xIndex] = '.';
                        }
                        if (s.solutionData[r][c] !== 0) {
                           solutionGrid[yIndex][xIndex] = String(s.solutionData[r][c]);
                        }
                    }
                }
            }
        });

        const problemString = problemGrid.map(row => row.join('')).join('\n');
        const solutionString = solutionGrid.map(row => row.join('')).join('\n');
        
        combinedTextOutput.value = `【問題】\n${problemString}\n\n【解答】\n${solutionString}`;
        exportModal.style.display = 'flex';
    }

    function getTimestamp() {
        const now = new Date();
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    }

    function handleSaveToFile(content, filePrefix) {
        const filename = `${filePrefix}-${getTimestamp()}.txt`;
        const blob = new Blob([content.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function handleCopyToClipboard(button, textarea) {
        navigator.clipboard.writeText(textarea.value).then(() => {
            const originalText = button.textContent;
            button.textContent = 'コピー！';
            button.disabled = true;
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);
        }).catch(err => {
            alert('クリップボードへのコピーに失敗しました。');
        });
    }

    initApp();
});
