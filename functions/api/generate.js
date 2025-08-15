// functions/api/generate.js — 完成盤のみ + クオータ
export const onRequestPost = async (context) => {
  const { request, env } = context;

  // 入力
  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : null; // [{id,x,y}]
  const adHint = !!body.adHint;

  if (!layout || layout.length === 0) {
    return j({ ok:false, reason:"bad_request", message:"layout is required" }, 400);
  }

  // KV & クオータ
  const kv = env.QUOTA ?? env.MY_KV;
  if (!kv) return j({ ok:false, reason:"no_kv_binding" }, 500);

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date().toISOString().slice(0,10);
  const qKey = `${day}:${ip}`;
  const used = parseInt((await kv.get(qKey)) || "0", 10);
  const limit = parseInt(adHint ? (env.DAILY_LIMIT_WITH_AD || "100") : (env.DAILY_LIMIT || "20"), 10);
  if (used >= limit) return j({ ok:false, reason:"quota", limit }, 429);

  // タイムアウト
  const start = Date.now();
  const TIMEOUT = parseInt(env.GEN_TIMEOUT_MS || "3500", 10);
  const deadline = () => Date.now() - start > TIMEOUT;

  // 完成盤を“合体制約”を考慮して順次生成
  try {
    const solvedBoards = [];
    for (let i = 0; i < layout.length; i++) {
      if (deadline()) throw new Error("timeout");
      const fixed = computeOverlapFixed(layout[i], layout, solvedBoards);
      const solved = makeSolvedSudokuWithFixed(fixed, deadline);
      if (!solved) throw new Error("failed_generate");
      solvedBoards.push({ id: layout[i].id, x: layout[i].x, y: layout[i].y, grid: solved });
    }

    await kv.put(qKey, String(used + 1), { expirationTtl: 60 * 60 * 30 });

    // ひとまず“完成盤”を返す（後で問題化を足す）
    return j({ ok:true, puzzle: { boards: solvedBoards, kind: "solved-only" } });
  } catch (e) {
    if (e.message === "timeout") return j({ ok:false, reason:"timeout" }, 504);
    return j({ ok:false, reason:"error", message: e.message }, 500);
  }
};

function j(data, status=200){
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type":"application/json", "cache-control":"no-store" }
  });
}

// ---- 重なり検出（既確定盤の値を固定として新盤へ）----
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
        fixed.push({ r: tr, c: tc, val: prev.grid[pr][pc] });
      }
    }
  }
  return fixed;
}

// ---- 完成盤生成（固定値付きバックトラック）----
function makeSolvedSudokuWithFixed(fixedCells, deadline) {
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
