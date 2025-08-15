// functions/api/generate.js
// 合体ナンプレ：重なり（共有マス）を同じ数字に揃える生成器（prefill＋バックトラック）
const GRID = 9;
const CELL_PX = 30;           // ★フロント(script.js)の CELL と同じ値に！
const GEN_TIME_BUDGET_MS = 2500;
const PER_BOARD_TRIES = 40;

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});
const now = () => Date.now();

async function checkQuota(env, ip){
  if (!env.QUOTA) return true;
  const key = `quota:${new Date().toISOString().slice(0,10)}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0",10);
  const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || "20",10);
  if (used >= DAILY_LIMIT) return false;
  await env.QUOTA.put(key, String(used+1), { expirationTtl: 60*60*26 });
  return true;
}

const empty9 = () => Array.from({length:GRID}, () => Array(GRID).fill(0));
function isSafe(g,r,c,n){
  for(let i=0;i<GRID;i++) if(g[r][i]===n || g[i][c]===n) return false;
  const br=(r/3|0)*3, bc=(c/3|0)*3;
  for(let i=0;i<3;i++) for(let j=0;j<3;j++) if(g[br+i][bc+j]===n) return false;
  return true;
}
const randDigits = () => { const a=[1,2,3,4,5,6,7,8,9]; for(let i=a.length-1;i>0;i--){const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]];} return a; };

// prefill: Map<idx(0..80)->digit>
function makeSolvedWithPrefill(prefill, timeLimitAt){
  const g = empty9();
  for(const [idx,v] of prefill.entries()){
    const r=(idx/9|0), c=idx%9;
    if(v<1||v>9 || !isSafe(g,r,c,v)) return null;
    g[r][c]=v;
  }
  const order=[...Array(81).keys()];
  for(let i=order.length-1;i>0;i--){const j=(Math.random()*(i+1))|0; [order[i],order[j]]=[order[j],order[i]];}
  function dfs(pos=0){
    if(now()>timeLimitAt) return false;
    if(pos===81) return true;
    const idx=order[pos], r=(idx/9|0), c=idx%9;
    if(g[r][c]!==0) return dfs(pos+1);
    for(const n of randDigits()){
      if(isSafe(g,r,c,n)){ g[r][c]=n; if(dfs(pos+1)) return true; g[r][c]=0; }
    }
    return false;
  }
  return dfs(0) ? g : null;
}

function carve(grid, hintTarget=36){
  const g=grid.map(r=>r.slice());
  const cells=[...Array(81).keys()];
  for(let i=cells.length-1;i>0;i--){const j=(Math.random()*(i+1))|0; [cells[i],cells[j]]=[cells[j],cells[i]];}
  let toRemove=81-hintTarget;
  for(const idx of cells){
    if(toRemove<=0) break;
    const r=(idx/9|0), c=idx%9, or=8-r, oc=8-c;
    if(g[r][c]===0 && g[or][oc]===0) continue;
    g[r][c]=0; g[or][oc]=0;
    toRemove -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

function normalizeLayout(layout){
  return layout.map(o=>({ id:String(o.id), ox: Math.round((o.x||0)/CELL_PX), oy: Math.round((o.y||0)/CELL_PX) }));
}
function buildOverlaps(nlayout){
  const n=nlayout.length;
  const overlaps=Array.from({length:n},()=>[]);
  for(let i=0;i<n;i++){
    for(let j=i+1;j<n;j++){
      const A=nlayout[i], B=nlayout[j];
      const R0=Math.max(0, B.oy - A.oy), C0=Math.max(0, B.ox - A.ox);
      const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
      if(R0<=R1 && C0<=C1){
        const cells=[];
        for(let r=R0;r<=R1;r++) for(let c=C0;c<=C1;c++){
          const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
          cells.push({ r,c,r2,c2 });
        }
        overlaps[i].push({ j, cells });
        overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
      }
    }
  }
  return overlaps;
}
function orderBoards(overlaps){
  const n=overlaps.length, seen=Array(n).fill(false), order=[];
  for(let s=0;s<n;s++){
    if(seen[s]) continue;
    const q=[s]; seen[s]=true;
    while(q.length){
      const i=q.shift(); order.push(i);
      for(const e of overlaps[i]) if(!seen[e.j]){ seen[e.j]=true; q.push(e.j); }
    }
  }
  return order;
}
function makePrefillForBoard(i, solved, overlaps){
  const mp=new Map();
  for(const e of overlaps[i]){
    const sj=solved[e.j]; if(!sj) continue;
    for(const {r,c,r2,c2} of e.cells){
      const v=sj[r2][c2]; const idx=r*9+c;
      if(mp.has(idx) && mp.get(idx)!==v) return null;
      mp.set(idx, v);
    }
  }
  return mp;
}

export const onRequestPost = async ({ request, env }) => {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if(!(await checkQuota(env, ip))) return json({ ok:false, reason:"daily limit exceeded" }, 429);

  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  if(layout.length===0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const order    = orderBoards(overlaps);

  const tEnd = now() + Math.min(parseInt(env.GEN_TIMEOUT_MS||"3500",10), GEN_TIME_BUDGET_MS);
  const solved = new Array(nlayout.length);

  function solveAll(k=0){
    if(now()>tEnd) return false;
    if(k>=order.length) return true;
    const i = order[k];
    if(solved[i]) return solveAll(k+1);

    const pre = makePrefillForBoard(i, solved, overlaps);
    if(pre===null) return false;

    for(let tr=0; tr<PER_BOARD_TRIES && now()<=tEnd; tr++){
      const g = makeSolvedWithPrefill(pre, tEnd);
      if(!g) continue;
      solved[i]=g;
      if(solveAll(k+1)) return true;
      solved[i]=undefined;
    }
    return false;
  }

  if(!solveAll(0)) return json({ ok:false, reason:"generation failed (timeout or impossible overlap)" }, 500);

  const hintTarget = 36;
  const puzzles = solved.map(g => carve(g, hintTarget));

  // 共有マスの与え整合
  for(let i=0;i<nlayout.length;i++){
    for(const e of overlaps[i]){
      const j=e.j;
      for(const {r,c,r2,c2} of e.cells){
        const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
        if(a!==0 && b===0) puzzles[j][r2][c2]=a;
        else if(b!==0 && a===0) puzzles[i][r][c]=b;
      }
    }
  }

  const boards = nlayout.map((o,idx)=>({
    id: layout[idx].id, x: layout[idx].x||0, y: layout[idx].y||0, grid: puzzles[idx]
  }));
  return json({ ok:true, puzzle: { boards } });
};
