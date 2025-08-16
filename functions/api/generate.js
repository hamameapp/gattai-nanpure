// Cloudflare Pages Functions: /functions/api/generate.js
// 唯一解保証版（共有マス=空欄可）。必要なら手掛かりを追加して唯一解に収束させる。

const GRID = 9;
const CELL_PX = 30;

// 難易度 → 目標ヒント数（多いほど易しい）。到達できない場合は唯一解優先で多めに残します。
const HINT_BY_DIFF = {
  easy: 40,
  normal: 34,
  hard: 30,
  expert: 26,
  extreme: 24,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/* ---------------- utils ---------------- */
const shuffle = (a) => { for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };

function makeGlobalPattern(){
  // 基本式：(r*3 + floor(r/3) + c) % 9 を、行/列/数字置換して完成盤を作る
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  const order3 = () => { const band=shuffle([0,1,2]); const out=[]; for(const b of band){ const inner=shuffle([0,1,2]); for(const k of inner) out.push(b*3+k); } return out; };
  const rowOrder = order3(), colOrder = order3(), digitPerm = shuffle([1,2,3,4,5,6,7,8,9]);
  return {
    valueAt(R,C){
      const r=rowOrder[((R%9)+9)%9];
      const c=colOrder[((C%9)+9)%9];
      return digitPerm[ base(r,c) ];
    }
  };
}

function normalizeLayout(layout){
  // y は 3 の倍数にスナップ（箱境界を揃える）
  return layout.map(o=>{
    const rawx = Number(o.x)||0, rawy = Number(o.y)||0;
    const ox = Math.round(rawx / CELL_PX);
    let oy = Math.round(rawy / CELL_PX); oy -= oy % 3;
    return { id:String(o.id), ox, oy, rawx, rawy };
  });
}

function buildOverlaps(nlayout){
  const n=nlayout.length;
  const overlaps = Array.from({length:n},()=>[]);
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
    const A=nlayout[i], B=nlayout[j];
    const R0=Math.max(0,B.oy-A.oy), C0=Math.max(0,B.ox-A.ox);
    const R1=Math.min(8,(B.oy+8)-A.oy), C1=Math.min(8,(B.ox+8)-A.ox);
    if (R0<=R1 && C0<=C1){
      const cells=[];
      for (let r=R0;r<=R1;r++) for (let c=C0;c<=C1;c++){
        const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
        cells.push({ r,c,r2,c2 });
      }
      overlaps[i].push({ j, cells });
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
    }
  }
  return overlaps;
}

/* ------------- solver (0/1/2 solutions) ------------- */
// ビット 1..9 を使用（ALL=0x3FE）
const ALL = 0x3FE;
function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }

function countSolutions(grid, limit=2){
  const rowMask = new Uint16Array(9);
  const colMask = new Uint16Array(9);
  const boxMask = new Uint16Array(9);

  // 初期与えセット（矛盾検出）
  for (let r=0;r<9;r++){
    for (let c=0;c<9;c++){
      const v = grid[r][c]|0; if (!v) continue;
      const bit = 1<<v, b=(r/3|0)*3+(c/3|0);
      if ((rowMask[r]&bit) || (colMask[c]&bit) || (boxMask[b]&bit)) return 0;
      rowMask[r]|=bit; colMask[c]|=bit; boxMask[b]|=bit;
    }
  }

  const cells=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) cells.push([r,c]);

  // MRV 順
  cells.sort((a,b)=>{
    const da = popcnt( ALL ^ (rowMask[a[0]]|colMask[a[1]]|boxMask[(a[0]/3|0)*3+(a[1]/3|0)]) );
    const db = popcnt( ALL ^ (rowMask[b[0]]|colMask[b[1]]|boxMask[(b[0]/3|0)*3+(b[1]/3|0)]) );
    return da-db;
  });

  let solutions=0;
  (function dfs(k){
    if (solutions>=limit) return;
    if (k===cells.length){ solutions++; return; }

    const [r,c]=cells[k], b=(r/3|0)*3+(c/3|0);
    let mask = ALL ^ (rowMask[r] | colMask[c] | boxMask[b]);
    if (!mask) return;

    while(mask && solutions<limit){
      const bit = mask & -mask; // 最下位1bit
      mask ^= bit;
      rowMask[r]|=bit; colMask[c]|=bit; boxMask[b]|=bit;
      dfs(k+1);
      rowMask[r]^=bit; colMask[c]^=bit; boxMask[b]^=bit;
    }
  })(0);

  return Math.min(solutions, limit);
}

/* ---------------- validators ---------------- */
function puzzleHasContradiction(p){
  // 行
  for (let r=0;r<9;r++){
    let seen=0;
    for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; }
  }
  // 列
  for (let c=0;c<9;c++){
    let seen=0;
    for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; }
  }
  // 箱
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    let seen=0;
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b;
    }
  }
  return false;
}

/* ------------- build puzzle with uniqueness ------------- */
// forbid: true のマスは必ず空欄にする。唯一解でなければ非forbidマスの手掛かりを「追加」していく。
function buildUniquePuzzle(solved, targetHints, forbidMask){
  const g = solved.map(r=>r.slice());

  // forbid を空欄に
  let hints=81;
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    if (forbidMask && forbidMask[r][c]){ if (g[r][c]) hints--; g[r][c]=0; }
  }
  if (puzzleHasContradiction(g)) return null;

  // まず唯一解になるまで「追加」する（点対称ペア優先）
  // 追加候補（非forbid かつ 現在0 のマス）
  function collectAddable(){
    const list=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c]===0 && !(forbidMask && forbidMask[r]?.[c])) list.push([r,c]);
    }
    // 影響が大きそうな順に一応シャッフル
    return shuffle(list);
  }

  let safety=0, addList=collectAddable();
  while (countSolutions(g,2)!==1){
    if (addList.length===0) { // 全部埋めれば必ず一意になるはず
      // 念のためブレークを防ぐ
      for (let r=0;r<9;r++) for (let c=0;c<9;c++){
        if (g[r][c]===0 && !(forbidMask && forbidMask[r]?.[c])){ g[r][c]=solved[r][c]; hints++; }
      }
      break;
    }
    // 点対称ペアを一緒に追加
    const [r,c] = addList.pop();
    const or=8-r, oc=8-c;
    if (g[r][c]===0){ g[r][c]=solved[r][c]; hints++; }
    if (g[or][oc]===0 && !(forbidMask && forbidMask[or]?.[oc])) { g[or][oc]=solved[or][oc]; hints++; }

    if (++safety>200) break; // 予防
  }

  // 唯一解になったら、目標に近づけるため「削る」（点対称で、唯一解が保てるときのみ）
  const target = Math.max(17, Math.min(81, targetHints));
  if (hints > target){
    const pairs=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      const or=8-r, oc=8-c;
      if (r>or || (r===or && c>oc)) continue;
      pairs.push([r,c,or,oc]);
    }
    shuffle(pairs);

    for (const [r,c,or,oc] of pairs){
      if (hints<=target) break;
      // forbid は消せない。今 0 でも消せない。
      const can1 = ! (forbidMask && forbidMask[r]?.[c]) && g[r][c]!==0;
      const can2 = ! (forbidMask && forbidMask[or]?.[oc]) && g[or][oc]!==0;
      if (!can1 && !can2) continue;

      const keep1=g[r][c], keep2=g[or][oc];
      if (can1) g[r][c]=0;
      if (can2) g[or][oc]=0;

      if (!puzzleHasContradiction(g) && countSolutions(g,2)===1){
        if (can1 && can2) hints -= (r===or && c===oc)?1:2;
        else if (can1 || can2) hints -= 1;
      }else{
        if (can1) g[r][c]=keep1;
        if (can2) g[or][oc]=keep2;
      }
    }
  }

  // 最終ガード
  if (puzzleHasContradiction(g)) return null;
  if (countSolutions(g,2)!==1) return null;

  return g;
}

/* ---------------- handler ---------------- */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true（共有マスは空欄）

  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // forbid（共有マスを空欄に固定）
  const forbids = Array.from({length:nlayout.length}, ()=> Array.from({length:9},()=>Array(9).fill(false)));
  if (overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        const j=e.j;
        for (const {r,c,r2,c2} of e.cells){
          forbids[i][r][c] = true;
          forbids[j][r2][c2] = true;
        }
      }
    }
  }

  // 1回で収束させる（再試行ループは基本不要）
  const pattern = makeGlobalPattern();
  const solved = nlayout.map(({ox,oy}) =>
    Array.from({length:GRID}, (_,r)=>
      Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
    )
  );

  const puzzles = new Array(nlayout.length);
  for (let i=0;i<nlayout.length;i++){
    const g = buildUniquePuzzle(solved[i], hintTarget, forbids[i]);
    if (!g) return json({ ok:false, reason:"failed to generate (resource-safe)" }, 500);
    puzzles[i] = g;
  }

  // 共有マス検証（overlapEmpty=false のときだけ、与え同士の不一致を弾く）
  if (!overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        const j=e.j;
        for (const {r,c,r2,c2} of e.cells){
          const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
          if (a!==0 && b!==0 && a!==b) return json({ ok:false, reason:"overlap conflict" }, 500);
        }
      }
    }
  }

  // 単盤最終チェック
  for (let i=0;i<puzzles.length;i++){
    if (puzzleHasContradiction(puzzles[i]) || countSolutions(puzzles[i],2)!==1){
      return json({ ok:false, reason:"verification failed" }, 500);
    }
  }

  const boards = nlayout.map((o, idx)=>({
    id: layout[idx].id,
    x: o.rawx, y: o.rawy,
    grid: puzzles[idx],
    solution: solved[idx],
  }));

  return json({ ok:true, puzzle:{ boards } });
};
