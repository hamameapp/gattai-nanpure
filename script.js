// script.js — フロント専用（ブラウザで実行）。export, import は使わない！
// 複数9x9盤をキャンバス上で配置し、/api/generate に layout を投げて合体ナンプレを生成する。

(() => {
  document.addEventListener('DOMContentLoaded', () => {
    // ===== DOM =====
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const statusDiv = document.getElementById('status');

    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const generateProblemButton = byId('generateProblemButton');
    const editLayoutButton = byId('editLayoutButton');
    const checkButton = byId('checkButton');
    const solveButton = byId('solveButton');
    const clearUserInputButton = byId('clearUserInputButton');
    const exportTextButton = byId('exportTextButton');

    // ===== 定数（フロントの1マス=30px。サーバ側 CELL_PX と一致させる） =====
    const GRID = 9;
    const CELL = 30;            // ★サーバの CELL_PX と同じ値に！
    const BOARD_PIX = GRID * CELL; // 270px
    const SNAP = CELL;             // 盤ドラッグは「1マス単位」でスナップ
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    // ===== 状態 =====
    let squares = []; // { id, x, y, w, h, problemData, userData, checkData, solutionData }
    let isProblemGenerated = false;
    let editMode = true;
    let activeSquareId = null;
    let activeCell = null; // {id,r,c}
    let drag = null;       // {id, offsetX, offsetY}

    // ===== ユーティリティ =====
    function byId(id) { return document.getElementById(id) || null; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function snap(v, unit) { return Math.round(v / unit) * unit; }
    function createEmptyGrid() {
      return Array.from({ length: GRID }, () => Array(GRID).fill(0));
    }
    function nextId() {
      let m = 0; for (const s of squares) m = Math.max(m, Number(s.id) || 0);
      return String(m + 1);
    }
    function newSquare(x, y) {
      const id = nextId();
      return {
        id, x, y,
        w: BOARD_PIX, h: BOARD_PIX,
        problemData: createEmptyGrid(),
        userData: createEmptyGrid(),
        checkData: createEmptyGrid(),
        solutionData: createEmptyGrid(),
      };
    }
    function setStatus(msg) { if (statusDiv) statusDiv.textContent = msg; }
    function updateButtonStates() {
      if (generateProblemButton) generateProblemButton.disabled = squares.length === 0;
      if (deleteButton) deleteButton.disabled = activeSquareId == null;
      if (editLayoutButton) editLayoutButton.textContent = editMode ? 'レイアウト固定' : 'レイアウト編集';
      if (checkButton) checkButton.disabled = !isProblemGenerated;
      if (clearUserInputButton) clearUserInputButton.disabled = !isProblemGenerated;
      if (solveButton) { solveButton.disabled = true; solveButton.title = '解答返却未実装'; }
      if (exportTextButton) exportTextButton.disabled = squares.length === 0;
    }

    // ===== キャンバス描画 =====
    function draw() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const s of squares) drawBoard(s);
      if (activeCell && !editMode) {
        const s = squares.find(x => String(x.id) === String(activeCell.id));
        if (s) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = '#66aaff';
          const x = s.x + activeCell.c * CELL;
          const y = s.y + activeCell.r * CELL;
          ctx.fillRect(x, y, CELL, CELL);
          ctx.restore();
        }
      }
    }

    function drawBoard(s) {
      ctx.save();
      const isActive = String(s.id) === String(activeSquareId);
      // 外枠
      ctx.strokeStyle = isActive ? '#2b90ff' : '#222';
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.strokeRect(s.x - 0.5, s.y - 0.5, s.w + 1, s.h + 1);
      // 格子
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#aaa';
      for (let i = 1; i < GRID; i++) {
        const gx = s.x + i * CELL, gy = s.y + i * CELL;
        ctx.beginPath(); ctx.moveTo(gx + 0.5, s.y); ctx.lineTo(gx + 0.5, s.y + s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy + 0.5); ctx.lineTo(s.x + s.w, gy + 0.5); ctx.stroke();
      }
      // 太線（3x3）
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#333';
      for (let i = 0; i <= GRID; i += 3) {
        const gx = s.x + i * CELL + 0.5, gy = s.y + i * CELL + 0.5;
        ctx.beginPath(); ctx.moveTo(gx, s.y); ctx.lineTo(gx, s.y + s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy); ctx.lineTo(s.x + s.w, gy); ctx.stroke();
      }
      // 数字
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const px = s.x + c * CELL + CELL / 2;
          const py = s.y + r * CELL + CELL / 2;
          const giv = s.problemData[r][c] | 0;
          const usr = s.userData[r][c] | 0;
          if (giv > 0) {
            ctx.fillStyle = '#000';
            ctx.fillText(String(giv), px, py);
          } else if (usr > 0) {
            const bad = (s.checkData[r][c] | 0) === 1;
            ctx.fillStyle = bad ? '#d11' : '#2b90ff';
            ctx.fillText(String(usr), px, py);
          }
        }
      }
      // IDラベル
      ctx.fillStyle = isActive ? '#2b90ff' : '#666';
      ctx.fillRect(s.x, s.y - 18, 26, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.id, s.x + 13, s.y - 9);

      ctx.restore();
    }

    // ===== ヒット判定 =====
    function boardAt(x, y) {
      for (let i = squares.length - 1; i >= 0; i--) {
        const s = squares[i];
        if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return s;
      }
      return null;
    }
    function cellAt(s, x, y) {
      if (!s) return null;
      const cx = Math.floor((x - s.x) / CELL);
      const cy = Math.floor((y - s.y) / CELL);
      if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return null;
      return { id: s.id, r: cy, c: cx };
    }

    // ===== 入力（マウス） =====
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const s = boardAt(mx, my);
      if (editMode) {
        if (!s) { activeSquareId = null; activeCell = null; draw(); updateButtonStates(); return; }
        activeSquareId = s.id; activeCell = null;
        drag = { id: s.id, offsetX: mx - s.x, offsetY: my - s.y };
      } else {
        if (!s) { activeSquareId = null; activeCell = null; draw(); updateButtonStates(); return; }
        activeSquareId = s.id; activeCell = cellAt(s, mx, my); draw();
      }
      updateButtonStates();
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!drag || !editMode) return;
      const s = squares.find(x => String(x.id) === String(drag.id));
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let nx = mx - drag.offsetX, ny = my - drag.offsetY;
      nx = snap(nx, SNAP); ny = snap(ny, SNAP);
      nx = clamp(nx, 0, canvas.width - s.w);
      ny = clamp(ny, 0, canvas.height - s.h);
      s.x = nx; s.y = ny; draw();
    });
    window.addEventListener('mouseup', () => { drag = null; });

    // ===== 入力（キーボード：プレイ） =====
    window.addEventListener('keydown', (e) => {
      if (editMode || !isProblemGenerated || !activeCell) return;
      const s = squares.find(x => String(x.id) === String(activeCell.id));
      if (!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return; // 与えマスは編集不可

      if (e.key >= '1' && e.key <= '9') {
        s.userData[activeCell.r][activeCell.c] = parseInt(e.key, 10);
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
        s.userData[activeCell.r][activeCell.c] = 0;
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); return;
      }
      const mv = { ArrowUp: [-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1] }[e.key];
      if (mv) {
        const nr = clamp(activeCell.r + mv[0], 0, GRID-1);
        const nc = clamp(activeCell.c + mv[1], 0, GRID-1);
        activeCell = { id: activeCell.id, r: nr, c: nc }; draw(); e.preventDefault();
      }
    });

    // ===== ボタン =====
    addSquareButton && addSquareButton.addEventListener('click', () => {
      const count = squares.length, col = count % 4, row = Math.floor(count / 4);
      const margin = 18;
      const nx = margin + col * (BOARD_PIX + margin);
      const ny = 40 + row * (BOARD_PIX + margin);
      const s = newSquare(snap(nx, SNAP), snap(ny, SNAP));
      squares.push(s);
      activeSquareId = s.id; isProblemGenerated = false;
      setStatus('盤を追加しました'); updateButtonStates(); draw();
    });
    deleteButton && deleteButton.addEventListener('click', () => {
      if (activeSquareId == null) return;
      squares = squares.filter(s => String(s.id) !== String(activeSquareId));
      activeSquareId = null; activeCell = null;
      isProblemGenerated = squares.length > 0 && isProblemGenerated;
      setStatus('選択中の盤を削除しました'); updateButtonStates(); draw();
    });
    editLayoutButton && editLayoutButton.addEventListener('click', () => {
      editMode = !editMode; activeCell = null;
      setStatus(editMode ? 'レイアウト編集モード' : 'プレイモード');
      updateButtonStates(); draw();
    });
    generateProblemButton && generateProblemButton.addEventListener('click', handleGenerateProblem);
    clearUserInputButton && clearUserInputButton.addEventListener('click', () => {
      if (!isProblemGenerated) return;
      for (const s of squares) { s.userData = createEmptyGrid(); s.checkData = createEmptyGrid(); }
      setStatus('入力をクリアしました'); draw();
    });
    checkButton && checkButton.addEventListener('click', () => {
      if (!isProblemGenerated) return;
      for (const s of squares) runCheck(s);
      setStatus('重複チェックを実行しました（赤＝矛盾）'); draw();
    });
    solveButton && solveButton.addEventListener('click', () => {
      alert('解答表示は未実装です（サーバが solution を返したら有効化）。');
    });
    exportTextButton && exportTextButton.addEventListener('click', () => {
      const data = {
        layout: squares.map(s => ({ id: s.id, x: s.x, y: s.y })),
        boards: squares.map(s => ({ id: s.id, problem: s.problemData, user: s.userData }))
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'gattai_export.json'; a.click();
      URL.revokeObjectURL(url);
    });

    // ===== 生成処理 =====
    async function handleGenerateProblem() {
      if (squares.length === 0) { alert('まず「盤面を追加」してください'); return; }
      for (const sq of squares) {
        sq.problemData = createEmptyGrid(); sq.userData = createEmptyGrid();
        sq.checkData = createEmptyGrid(); sq.solutionData = createEmptyGrid();
      }
      isProblemGenerated = false; updateButtonStates(); draw();

      try {
        generateProblemButton.disabled = true;
        setStatus('問題を生成しています...');
        const layout = squares.map(s => ({ id: String(s.id), x: Math.round(s.x), y: Math.round(s.y) }));
        const boards = await generateFromServer(layout, false, 'normal');
        renderBoards(boards);
        isProblemGenerated = true;
        setStatus(`問題を作成しました！（${boards.length}盤）`);
      } catch (err) {
        console.error(err);
        alert(err?.message || 'サーバ生成に失敗しました');
        setStatus('サーバ生成に失敗しました');
      } finally {
        generateProblemButton.disabled = false; updateButtonStates(); draw();
      }
    }

    async function generateFromServer(layout, adShown=false, difficulty='normal') {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout, adShown, difficulty })
      });
      if (!res.ok) {
        const t = await safeText(res);
        throw new Error(`APIエラー: ${res.status} ${t}`);
      }
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.reason || 'ok=false');
      return data.puzzle?.boards || [];
    }
    async function safeText(res) { try { return await res.text(); } catch { return ''; } }

    function renderBoards(boards) {
      const map = new Map(boards.map(b => [String(b.id), b]));
      for (const sq of squares) {
        const b = map.get(String(sq.id));
        if (!b) continue;
        sq.problemData = cloneGrid(b.grid);
        sq.userData = createEmptyGrid();
        sq.checkData = createEmptyGrid();
        // 必要ならサーバ値で位置を調整
        // sq.x = b.x; sq.y = b.y;
      }
      updateButtonStates(); draw();
    }
    function cloneGrid(g) { return g.map(r => r.slice()); }

    // ===== 重複チェック =====
    function runCheck(sq) {
      sq.checkData = createEmptyGrid();
      const val = (r, c) => (sq.userData[r][c] || sq.problemData[r][c] || 0);
      // 行
      for (let r = 0; r < GRID; r++) {
        const seen = new Map();
        for (let c = 0; c < GRID; c++) {
          const v = val(r, c); if (v === 0) continue;
          if (seen.has(v)) { sq.checkData[r][c] = 1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
          else seen.set(v, [r, c]);
        }
      }
      // 列
      for (let c = 0; c < GRID; c++) {
        const seen = new Map();
        for (let r = 0; r < GRID; r++) {
          const v = val(r, c); if (v === 0) continue;
          if (seen.has(v)) { sq.checkData[r][c] = 1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
          else seen.set(v, [r, c]);
        }
      }
      // ブロック
      for (let br = 0; br < GRID; br += 3) {
        for (let bc = 0; bc < GRID; bc += 3) {
          const seen = new Map();
          for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) {
            const r = br + dr, c = bc + dc;
            const v = val(r, c); if (v === 0) continue;
            if (seen.has(v)) { sq.checkData[r][c] = 1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
            else seen.set(v, [r, c]);
          }
        }
      }
    }

    // ===== キャンバス実サイズをCSSに同期 =====
    function resizeCanvasToDisplaySize() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(600, Math.floor(rect.width));
      const h = Math.max(450, Math.floor(rect.height)); // 4:3
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const displayWidth = Math.floor(w * dpr);
      const displayHeight = Math.floor(h * dpr);
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
      }
    }
    resizeCanvasToDisplaySize();
    window.addEventListener('resize', () => {
      resizeCanvasToDisplaySize(); draw();
    });

    // ===== 初期表示 =====
    setStatus('レイアウト編集モード：盤を追加して配置してください');
    updateButtonStates();
    draw();
  });
})();
