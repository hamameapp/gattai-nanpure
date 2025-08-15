// script.js — フロント専用（Cloudflare Pages）
// 複数の 9x9 盤をキャンバス上に配置し、/api/generate に layout を投げて
// 合体ナンプレ（共有マス同値）を生成・表示する。
// 付加機能: 難易度選択, 共有マス矛盾チェック, ローカルオートセーブ。

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
    const difficultySel = document.getElementById('difficulty'); // ある場合のみ

    // ===== 定数 =====
    const GRID = 9;
    const CELL = 30;                 // ★サーバ側 CELL_PX と一致させる
    const BOARD_PIX = GRID * CELL;   // 270px
    const SNAP = CELL;               // 1マス単位でスナップ（合体判定のため厳密に）
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    // ===== 状態 =====
    /** @type {Array<{id:string,x:number,y:number,w:number,h:number,problemData:number[][],userData:number[][],checkData:number[][],solutionData:number[][]}>} */
    let squares = [];
    let isProblemGenerated = false;
    let editMode = true;                // true: レイアウト編集 / false: プレイ
    let activeSquareId = null;          // 選択中の盤ID
    let activeCell = null;              // {id,r,c} プレイ時の選択セル
    let drag = null;                    // {id, offsetX, offsetY}

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

    // ===== 描画 =====
    function draw() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 共有領域の薄ハイライト（編集時のみ視認性Up）
      if (editMode) drawOverlapHints();

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

    // 共有領域の薄ハイライト（編集時）
    function drawOverlapHints() {
      const overlaps = buildOverlapsClient(squares);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = '#00aa88';
      for (const { i, j, cells } of overlaps) {
        const A = squares[i];
        for (const { r, c } of cells) {
          const x = A.x + c * CELL;
          const y = A.y + r * CELL;
          ctx.fillRect(x, y, CELL, CELL);
        }
      }
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
    window.addEventListener('mouseup', () => { if (drag) saveState(); drag = null; });

    // ===== 入力（キーボード：プレイ） =====
    window.addEventListener('keydown', (e) => {
      if (editMode || !isProblemGenerated || !activeCell) return;
      const s = squares.find(x => String(x.id) === String(activeCell.id));
      if (!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return; // 与えマスは編集不可

      if (e.key >= '1' && e.key <= '9') {
        s.userData[activeCell.r][activeCell.c] = parseInt(e.key, 10);
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
        s.userData[activeCell.r][activeCell.c] = 0;
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
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
      // 4列レイアウトで自動配置
      const count = squares.length, col = count % 4, row = Math.floor(count / 4);
      const margin = 18;
      const nx = margin + col * (BOARD_PIX + margin);
      const ny = 40 + row * (BOARD_PIX + margin);
      const s = newSquare(snap(nx, SNAP), snap(ny, SNAP));
      squares.push(s);
      activeSquareId = s.id; isProblemGenerated = false;
      setStatus('盤を追加しました');
      updateButtonStates(); draw(); saveState();
    });

    deleteButton && deleteButton.addEventListener('click', () => {
      if (activeSquareId == null) return;
      squares = squares.filter(s => String(s.id) !== String(activeSquareId));
      activeSquareId = null; activeCell = null;
      isProblemGenerated = squares.length > 0 && isProblemGenerated;
      setStatus('選択中の盤を削除しました');
      updateButtonStates(); draw(); saveState();
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
      setStatus('入力をクリアしました'); draw(); saveState();
    });

    checkButton && checkButton.addEventListener('click', () => {
      if (!isProblemGenerated) return;
      for (const s of squares) runCheck(s); // 単盤の行/列/ブロック重複
      runOverlapCheck();                   // ★追加：合体ルール違反（共有マス不一致）
      setStatus('チェック完了：赤は矛盾（行/列/ブロック/共有マス）');
      draw();
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

    // ===== サーバ生成 =====
    async function handleGenerateProblem() {
      if (squares.length === 0) { alert('まず「盤面を追加」してください'); return; }
      // 初期化
      for (const sq of squares) {
        sq.problemData = createEmptyGrid();
        sq.userData = createEmptyGrid();
        sq.checkData = createEmptyGrid();
        sq.solutionData = createEmptyGrid();
      }
      isProblemGenerated = false; updateButtonStates(); draw();

      try {
        generateProblemButton.disabled = true;
        const diff = difficultySel ? String(difficultySel.value || 'normal') : 'normal';
        setStatus(`問題を生成しています...（難易度: ${diff}）`);
        const layout = squares.map(s => ({ id: String(s.id), x: Math.round(s.x), y: Math.round(s.y) }));
        const boards = await generateFromServer(layout, /*adShown=*/false, diff);
        renderBoards(boards);
        isProblemGenerated = true;
        setStatus(`問題を作成しました！（${boards.length}盤）`);
        saveState();
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
        // サーバ側で位置調整したい場合は：
        // sq.x = b.x; sq.y = b.y;
      }
      updateButtonStates(); draw();
    }

    function cloneGrid(g) { return g.map(r => r.slice()); }

    // ===== 単盤チェック（重複） =====
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

    // ===== 合体ルール違反チェック（共有マスの不一致） =====
    function buildOverlapsClient(sqs) {
      const norm = sqs.map(s => ({
        id: String(s.id),
        ox: Math.round(s.x / CELL),
        oy: Math.round(s.y / CELL),
      }));
      const n = norm.length;
      const overlaps = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const A = norm[i], B = norm[j];
        const R0 = Math.max(0, B.oy - A.oy);
        const C0 = Math.max(0, B.ox - A.ox);
        const R1 = Math.min(8, (B.oy + 8) - A.oy);
        const C1 = Math.min(8, (B.ox + 8) - A.ox);
        if (R0 <= R1 && C0 <= C1) {
          const cells = [];
          for (let r = R0; r <= R1; r++) for (let c = C0; c <= C1; c++) {
            const r2 = r + A.oy - B.oy, c2 = c + A.ox - B.ox;
            cells.push({ r, c, r2, c2, i, j });
          }
          overlaps.push({ i, j, cells });
        }
      }
      return overlaps;
    }

    function runOverlapCheck() {
      const overlaps = buildOverlapsClient(squares);
      const val = (sq, r, c) => (sq.userData[r][c] || sq.problemData[r][c] || 0);
      for (const { i, j, cells } of overlaps) {
        const A = squares[i], B = squares[j];
        for (const { r, c, r2, c2 } of cells) {
          const va = val(A, r, c), vb = val(B, r2, c2);
          if (va !== 0 && vb !== 0 && va !== vb) {
            A.checkData[r][c] = 1;
            B.checkData[r2][c2] = 1;
          }
        }
      }
    }

    // ===== オートセーブ/復元 =====
    function saveState() {
      try {
        const payload = {
          squares: squares.map(s => ({
            id: s.id, x: s.x, y: s.y,
            problemData: s.problemData, userData: s.userData
          })),
          isProblemGenerated,
          ts: Date.now()
        };
        localStorage.setItem('gattai_state_v1', JSON.stringify(payload));
      } catch { /* ignore */ }
    }
    function loadState() {
      try {
        const raw = localStorage.getItem('gattai_state_v1');
        if (!raw) return false;
        const obj = JSON.parse(raw);
        if (!obj || !Array.isArray(obj.squares)) return false;
        squares = obj.squares.map(o => ({
          id: o.id, x: o.x, y: o.y, w: BOARD_PIX, h: BOARD_PIX,
          problemData: o.problemData || createEmptyGrid(),
          userData: o.userData || createEmptyGrid(),
          checkData: createEmptyGrid(),
          solutionData: createEmptyGrid(),
        }));
        isProblemGenerated = !!obj.isProblemGenerated && squares.length > 0;
        return true;
      } catch { return false; }
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

    // ===== 初期化 =====
    resizeCanvasToDisplaySize();
    window.addEventListener('resize', () => { resizeCanvasToDisplaySize(); draw(); });
    if (!loadState()) {
      setStatus('レイアウト編集モード：盤を追加して配置してください');
    } else {
      setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトは復元されました');
    }
    updateButtonStates();
    draw();
  });
})();
