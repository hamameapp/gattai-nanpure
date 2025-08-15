export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---------- 0) クオータチェック ----------
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date().toISOString().slice(0,10);
  const key = `${day}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);

  // 広告表示の“目安”フラグ
  let hint = "0";
  let layout = null;
  let difficulty = "normal";
  try {
    const body = await request.json();
    hint = body?.adHint ? "1" : "0";
    layout = Array.isArray(body?.layout) ? body.layout : null;
    difficulty = body?.difficulty || "normal";
  } catch (_) { /* noop */ }

  const LIMIT = parseInt(hint === "1" ? (env.DAILY_LIMIT_WITH_AD || "100") : (env.DAILY_LIMIT || "20"), 10);
  if (used >= LIMIT) {
    return json({ ok:false, reason:"quota", limit: LIMIT }, 429);
  }

  // ---------- 1) 入力検証 ----------
  if (!layout || layout.length === 0) {
    return json({ ok:false, reason:"bad_request", message:"layout is required" }, 400);
  }
  if (layout.length > parseInt(env.MAX_BOARDS || "40", 10)) {
    return json({ ok:false, reason:"too_many_boards" }, 400);
  }

  // ---------- 2) タイムアウト管理 ----------
  const start = Date.now();
  const TIMEOUT = parseInt(env.GEN_TIMEOUT_MS || "3500", 10);
  const deadline = () => Date.now() - start > TIMEOUT;

  // ---------- 3) 合体生成（完成盤） ----------
  try {
    const solvedBoards = [];
    for (let i = 0; i < layout.length; i++) {
      if (deadline()) throw new Error("timeout");
      const fixed = computeOverlapFixed(layout[i], layout, solvedBoards);
      const solved = makeSolvedSudokuWithFixed(fixed, deadline);
      if (!solved) throw new Error("failed_generate");
      solvedBoards.push({ id: layout[i].id, x: layout[i].x, y: layout[i].y, grid: solved });
    }

    // ---------- 4) 問題化（各盤別にヒント削除） ----------
    const puzzles = [];
    for (let i = 0; i < layout.length; i++) {
      if (deadline()) throw new Error("timeout");
      const board = solvedBoards[i];
      const sharedCells = computeSharedCells(board, layout, solvedBoards);
      const puzzle = makePuzzleUnique(board.grid, sharedCells, difficulty, deadline);
      puzzles.push({ id: board.id, x: board.x, y: board.y, grid: puzzle });
    }

    // ---------- 5) 記録 ----------
    await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 30 });

    return json({ ok: true, puzzle: { boards: puzzles } }, 200);
  } catch (e) {
    if (e.message === "timeout") {
      return json({ ok:false, reason:"timeout" }, 504);
    }
    return json({ ok:false, reason:"error", message: e.message }, 500);
  }
};

// ---------- ユーティリティ ----------
function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// ========== 重なり検出 ==========
function computeOverlapFixed(target, layout, solvedBoards) {
  const fixed = [];
  const tX = target.x, tY = target.y;
  for (const prev of solvedBoards) {
    const pX = prev.x, pY = prev.y;
    const ox0 = Math.max(tX, pX), oy0 = Math.max(tY, pY);
    const ox1 = Math.min(tX + 9, pX + 9), oy1 = Math.min(tY + 9, pY + 9);
    if (ox1 <= ox0 || oy1 <= oy0) continue;
    for (let gy = oy0; gy < oy1; gy++) {
      for (let gx = ox0; gx < ox1; gx++) {
        const tr = gy - tY, tc = gx - tX;
        const pr = gy - pY, pc = gx - pX;
        const val = prev.grid[pr][pc];
        fixed.push({ r: tr, c: tc, val });
      }
    }
  }
  return fixed;
}

function computeSharedCells(board, layout, solvedBoards) {
  const set = new Set();
  for (const other of solvedBoards) {
    if (other.id === board.id) continue;
    const ox0 = Math.max(board.x, other.x);
    const oy0 = Math.max(board.y, other.y);
    const ox1 = Math.min(board.x + 9, other.x + 9);
    const oy1 = Math.min(board.y + 9, other.y + 9);
    if (ox1 <= ox0 || oy1 <= oy0) continue;
    for (let gy = oy0; gy < oy1; gy++) {
      for (let gx = ox0; gx < ox1; gx++) {
        const br = gy - board.y, bc = gx - board.x;
        set.add(`${br},${bc}`);
      }
    }
  }
  return set;
}

// ========== Sudoku 完成盤（固定値付き） ==========
function makeSolvedSudokuWithFixed(fixedCells, deadline) {
  const grid = Array.from({length:9}, () => Array(9).fill(0));
  for (const f of fixedCells) {
    if (!place(grid, f.r, f.c, f.val)) return null;
  }
  const cells = [];
  for (let r=0;r<9;r++) for(let c=0;c<9;c++) if (grid[r][c]===0) cells.push([r,c]);
  shuffle(cells);
  function dfs(idx) {
    if (deadline()) return false;
    if (idx === cells.length) return true;
    const [r,c] = cells[idx];
    const nums = [1,2,3,4,5,6,7,8,9]; shuffle(nums);
    for (const v of nums) {
      if (canPlace(grid, r, c, v)) {
        grid[r][c] = v;
        if (dfs(idx+1)) return true;
        grid[r][c] = 0;
      }
    }
    return false;
  }
  if (!dfs(0)) return null;
  return grid;
}

function canPlace(g, r, c, v){
  for (let i=0;i<9;i++){
    if (g[r][i]===v || g[i][c]===v) return false;
  }
  const br = Math.floor(r/3)*3, bc=Math.floor(c/3)*3;
  for (let i=0;i<3;i++) for (let j=0;j<3;j++){
    if (g[br+i][bc+j]===v) return false;
  }
  return true;
}
function place(g,r,c,v){ if (!canPlace(g,r,c,v)) return false; g[r][c]=v; return true; }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; }}

// ========== 問題化（唯一性チェック付き） ==========
function makePuzzleUnique(solved, sharedSet, difficulty, deadline) {
  const puzzle = solved.map(row => row.slice());
  const cells = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) {
    if (sharedSet.has(`${r},${c}`)) continue;
    cells.push([r,c]);
  }
  shuffle(cells);
  const limit = difficulty === "hard" ? 60 : difficulty === "easy" ? 40 : 50;
  let removed = 0;
  for (const [r,c] of cells) {
    if (deadline()) break;
    const backup = puzzle[r][c];
    puzzle[r][c] = 0;
    const count = countSolutions(puzzle, 2, deadline);
    if (count !== 1 || ++removed > limit) {
      puzzle[r][c] = backup;
      removed--;
    }
  }
  return puzzle;
}

function countSolutions(puz, maxCount, deadline) {
  const grid = puz.map(r => r.slice());
  const empties = [];
  for (let r=0;r<9;r++) for(let c=0;c<9;c++) if (grid[r][c]===0) empties.push([r,c]);
  function dfs(i){
    if (deadline()) return maxCount;
    if (i===empties.length) return 1;
    const [r,c] = empties[i];
    let cnt = 0;
    for (let v=1; v<=9; v++){
      if (canPlace(grid, r, c, v)) {
        grid[r][c] = v;
        cnt += dfs(i+1);
        if (cnt >= maxCount) { grid[r][c]=0; return cnt; }
        grid[r][c] = 0;
      }
    }
    return cnt;
  }
  return dfs(0);
}
