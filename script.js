document.addEventListener('DOMContentLoaded', () => {
  // --- DOM要素の取得 ---
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const statusDiv = document.getElementById('status');
  const cancelGenerationButton = document.getElementById('cancelGenerationButton'); // 非表示のまま
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
  let isProblemGenerated = false;

  // =========================================================
  // サーバ生成呼び出し（/api/generate）＆描画反映
  // =========================================================
  async function generateFromServer(layout, adShown=false, difficulty="normal") {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout, adHint: adShown ? 1 : 0, difficulty })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      const reason = data?.reason || res.statusText || "unknown";
      throw new Error(`サーバ生成失敗: ${reason}`);
    }
    return data.puzzle.boards; // [{id,x,y,grid}]
  }

  function renderBoards(boards) {
    // いまの軽量APIは1盤だけ返す → 先頭のみ反映
    const b = boards[0];
    const sq = squares[0];
    if (!sq || !b) return;

    // 受け取った問題（0は空欄）
    sq.problemData = b.grid.map(row => row.slice());

    // 現状APIは解答を返さない → 解答は空で初期化
    sq.solutionData = createEmptyGrid();
    sq.userData = createEmptyGrid();
    sq.checkData = createEmptyGrid();

    isProblemGenerated = true;
    updateButtonStates();
    draw();
    statusDiv.textContent = "問題を作成しました！（サーバ生成・軽量版）";
  }

  // =========================================================
  // 初期化
  // =========================================================
  function initApp() {
    if (cancelGenerationButton) cancelGenerationButton.style.display = 'none'; // 使わない

    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', initCanvasSize);

    addSquareButton.addEventListener('click', addSquare);
    deleteButton.addEventListener('click', deleteSelectedSquare);
    generateProblemButton.addEventListener('click', handleGenerateProblem);
    editLayoutButton.addEventListener('click', () => {
      isProblemGenerated = false;
      resetAllGrids();
      selectSquare(null);
    });

    checkButton.addEventListener('click', handleCheck);
    solveButton.addEventListener('click', handleSolve);
    clearUserInputButton.addEventListener('click', handleClearUserInput);
    exportTextButton.addEventListener('click', handleExportText);

    if (closeModalButton) closeModalButton.onclick = () => (exportModal.style.display = 'none');
    window.onclick = (event) => { if (event.target == exportModal) exportModal.style.display = "none"; };
    copyCombinedButton.addEventListener('click', () => handleCopyToClipboard(copyCombinedButton, combinedTextOutput));
    saveCombinedButton.addEventListener('click', () => handleSaveToFile(combinedTextOutput.value, 'GattaiNanpure-Puzzle'));

    initCanvasSize();
    addSquare();
  }

  function initCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = window.innerHeight * 0.65 * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${window.innerHeight * 0.65}px`;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    draw();
  }

  // =========================================================
  // 描画
  // =========================================================
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
    for (let i = 0; i <= 9; i += 3) {
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
          ctx.fillStyle = (checkVal === -1) ? '#ef4444' : '#2563eb';
          ctx.fillText(userVal, cx, cy);
        }
      }
    }
  }

  // =========================================================
  // レイアウト/入力関連
  // =========================================================
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
    if (id === null) selectedCell = null;
    updateButtonStates();
    draw();
  }

  function updateButtonStates() {
    deleteButton.disabled = selectedSquareId === null || isProblemGenerated;
    addSquareButton.disabled = isProblemGenerated;
    generateProblemButton.disabled = squares.length === 0;
    editLayoutButton.style.display = isProblemGenerated ? 'inline-block' : 'none';

    // 解答がない（今のAPIはsolution未返却）ので解答系は無効
    const hasSolution = squares.some(s => s.solutionData.flat().some(cell => cell !== 0));
    checkButton.disabled = !hasSolution;
    solveButton.disabled = !hasSolution;
    clearUserInputButton.disabled = !hasSolution;
    exportTextButton.disabled = !hasSolution; // 解答付きで出したい想定
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

  function onPointerUp() {
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
    if (square && square.problemData[selectedCell.r][selectedCell.c] === 0) {
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

  // =========================================================
  // 生成・答え合わせ・解答表示・クリア
  // =========================================================
  async function handleGenerateProblem() {
    if (squares.length === 0) { alert("まず盤面を追加してください。"); return; }

    // 軽量APIは1盤のみ返す想定 → 1枚に絞る
    squares = squares.slice(0, 1);
    const sq = squares[0];
    sq.problemData = createEmptyGrid();
    sq.userData = createEmptyGrid();
    sq.solutionData = createEmptyGrid();
    sq.checkData = createEmptyGrid();
    isProblemGenerated = false;
    updateButtonStates();
    draw();

    generateProblemButton.disabled = true;
    statusDiv.textContent = "問題を生成しています...";
    try {
      const layout = [{ id: String(sq.id), x: 0, y: 0 }];
      const boards = await generateFromServer(layout, /*adShown=*/false, /*difficulty=*/"normal");
      renderBoards(boards);
    } catch (e) {
      console.error(e);
      statusDiv.textContent = e.message || "サーバ生成に失敗しました";
      alert(statusDiv.textContent);
    } finally {
      generateProblemButton.disabled = false;
    }
  }

  function handleCheck() {
    // いまは solutionData を持っていないので利用不可（将来用）
    if (checkButton.disabled) return;
    let allCorrect = true;
    squares.forEach(sq => {
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (sq.problemData[r][c] === 0 && sq.userData[r][c] !== 0) {
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
    if (solveButton.disabled) return;
    squares.forEach(sq => {
      sq.userData = JSON.parse(JSON.stringify(sq.solutionData));
      sq.checkData = createEmptyGrid();
    });
    draw();
    statusDiv.textContent = "解答を表示しました。";
  }

  function handleClearUserInput() {
    if (clearUserInputButton.disabled) return;
    squares.forEach(sq => {
      sq.userData = createEmptyGrid();
      sq.checkData = createEmptyGrid();
    });
    draw();
    statusDiv.textContent = "入力内容をクリアしました。";
  }

  // =========================================================
  // テキスト出力
  // =========================================================
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
    }).catch(() => {
      alert('クリップボードへのコピーに失敗しました。');
    });
  }

  // =========================================================
  // 起動
  // =========================================================
  initApp();
});
