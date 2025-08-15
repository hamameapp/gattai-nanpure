// functions/api/generate.js — デバッグ版（例外の詳細を返す）
export const onRequestPost = async (context) => {
  const { request, env } = context;
  const debug = { step: "start" };
  try {
    // ---- 入力 ----
    let bodyText = await request.text();
    debug.step = "parse_json";
    const body = JSON.parse(bodyText || "{}");
    const layout = Array.isArray(body.layout) ? body.layout : null;
    const adHint = !!body.adHint;
    const difficulty = body.difficulty || "normal";

    if (!layout || layout.length === 0) {
      return j({ ok:false, reason:"bad_request", message:"layout is required", debug }, 400);
    }

    // ---- KV ----
    debug.step = "kv_binding";
    const kv = env.QUOTA ?? env.MY_KV;
    if (!kv) throw new Error("KV binding (QUOTA or MY_KV) not found");

    // ---- クオータ ----
    debug.step = "quota_read";
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const day = new Date().toISOString().slice(0,10);
    const qKey = `${day}:${ip}`;
    const used = parseInt((await kv.get(qKey)) || "0", 10);
    const limit = parseInt(adHint ? (env.DAILY_LIMIT_WITH_AD || "100") : (env.DAILY_LIMIT || "20"), 10);
    if (Number.isNaN(limit)) throw new Error("ENV DAILY_LIMIT* is NaN");
    if (used >= limit) return j({ ok:false, reason:"quota", limit, debug });

    // ---- タイムアウト ----
    debug.step = "timeout_init";
    const start = Date.now();
    const TIMEOUT = parseInt(env.GEN_TIMEOUT_MS || "3500", 10);
    const deadline = () => Date.now() - start > TIMEOUT;

    // ---- 生成（完成盤→問題化）----
    debug.step = "generate_solved";
    const solvedBoards = [];
    for (let i = 0; i < layout.length; i++) {
      if (deadline()) throw new Error("timeout");
      const fixed = computeOverlapFixed(layout[i], layout, solvedBoards);
      const solved = makeSolvedSudokuWithFixed(fixed, deadline);
      if (!solved) throw new Error("failed_generate");
      solvedBoards.push({ id: layout[i].id, x: layout[i].x, y: layout[i].y, grid: solved });
    }

    debug.step = "make_puzzle";
    const puzzles = [];
    for (const b of solvedBoards) {
      if (deadline()) throw new Error("timeout");
      const shared = computeSharedCells(b, solvedBoards);
      const puzzle = makePuzzleUnique(b.grid, shared, difficulty, deadline);
      puzzles.push({ id: b.id, x: b.x, y: b.y, grid: puzzle });
    }

    // ---- クオータ更新 ----
    debug.step = "quota_write";
    await kv.put(qKey, String(used + 1), { expirationTtl: 60 * 60 * 30 });

    debug.step = "done";
    return j({ ok:true, puzzle:{ boards: puzzles }, debug });
  } catch (e) {
    console.error("GEN ERROR:", e && e.stack ? e.stack : e);
    return j({ ok:false, reason:"exception", message: String(e && e.message || e), stack: String(e && e.stack || ""), debug }, 500);
  }
};

function j(data, status=200){
  return new Response(JSON.stringify(data), { status, headers:{ "content-type":"application/json" }});
}

// ---- 重なり検出（既確定盤の値を固定に）----
function computeOverlapFixed(target, layout, solvedBoards){
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

function computeSharedCells(board, solvedBoards){
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

// ---- 完成盤生成（固定値付きバックトラック）----
function makeSolvedSudokuWithFixed(fixedCells, deadline){
  const g = Array.from({length:9}, () => Array(9).fill(0));
  for (const f of fixedCells) if (!place(g, f.r, f.c, f.val)) return null;

  const cells = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]===0) cells.push([r,c]);
  shuffle(cells);

  function dfs(i){
    if (deadline()) return false;
    if (i===cells.length) return true;
    const [r,c]=cells[i];
    const nums=[1,2,3,4,5,6,7,8,9]; shuffle(nums);
    for (const v of nums){
      if (canPlace(g,r,c,v)){
        g[r][c]=v;
        if (dfs(i+1)) return true;
        g[r][c]=0;
      }
    }
    return false;
  }
  return dfs(0) ? g : null;
}
function canPlace(g,r,c,v){
  for (let i=0;i<9;i++) if (g[r][i]===v || g[i][c]===v) return false;
  const br=Math.floor(r/3)*3, bc=Math.floor(c/3)*3;
  for (let i=0;i<3;i++) for (let j=0;j<3;j++) if (g[br+i][bc+j]===v) return false;
  return true;
}
function place(g,r,c,v){ if (!canPlace(g,r,c,v)) return false; g[r][c]=v; return true; }
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } }

// ---- 問題化（唯一性チェック）----
function makePuzzleUnique(solved, sharedSet, difficulty, deadline){
  const puz = solved.map(r => r.slice());
  const cells = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    if (sharedSet.has(`${r},${c}`)) continue;
    cells.push([r,c]);
  }
  shuffle(cells);
  const limit = difficulty==="hard"?60: difficulty==="easy"?40:50;
  let removed = 0;

  for (const [r,c] of cells){
    if (deadline()) break;
    const bak = puz[r][c];
    puz[r][c] = 0;
    const cnt = countSolutions(puz, 2, deadline);
    if (cnt !== 1 || ++removed > limit){
      puz[r][c] = bak;
      removed--;
    }
  }
  return puz;
}
function countSolutions(puz, maxCount, deadline){
  const g = puz.map(r => r.slice());
  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]===0) empties.push([r,c]);
  function dfs(i){
    if (deadline()) return maxCount;
    if (i===empties.length) return 1;
    const [r,c]=empties[i];
    let cnt=0;
    for (let v=1; v<=9; v++){
      if (canPlace(g,r,c,v)){
        g[r][c]=v;
        cnt+=dfs(i+1);
        if (cnt>=maxCount){ g[r][c]=0; return cnt; }
        g[r][c]=0;
      }
    }
    return cnt;
  }
  return dfs(0);
}
