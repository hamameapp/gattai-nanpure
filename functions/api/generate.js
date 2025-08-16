// /functions/api/generate.js  — 合体全体で唯一解保証・共有マスは空欄のまま
const GRID = 9;
const CELL_PX = 30;

const HINT_BY_DIFF = { easy: 40, normal: 34, hard: 30, expert: 26, extreme: 24 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/* ---------- utils ---------- */
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const ALL = 0x3FE; // bits 1..9
function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }

function makeGlobalPattern(){
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  const order3 = () => { const band=shuffle([0,1,2]); const out=[]; for(const b of band){ const inner=shuffle([0,1,2]); for(const k of inner) out.push(b*3+k);} return out; };
  const rowOrder=order3(), colOrder=order3(), digitPerm=shuffle([1,2,3,4,5,6,7,8,9]);
  return { valueAt(R,C){ const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9]; return digitPerm[ base(r,c) ]; } };
}

function normalizeLayout(layout){
  return layout.map(o=>{
    const rawx=Number(o.x)||0, rawy=Number(o.y)||0;
    const ox=Math.round(rawx/CELL_PX);
    let oy=Math.round(rawy/CELL_PX); oy -= oy%3; // 箱境界合わせ
    return { id:String(o.id), ox, oy, rawx, rawy };
  });
}

function buildOverlaps(nlayout){
  const n=nlayout.length, overlaps=Array.from({length:n},()=>[]);
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

function puzzleHasContradiction(p){
  // 行
  for (let r=0;r<9;r++){ let seen=0; for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; } }
  // 列
  for (let c=0;c<9;c++){ let seen=0; for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; } }
  // 箱
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    let seen=0;
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b;
    }
  }
  return false;
}

/* ---------- 単盤：ターゲットへ「削る」（唯一性は問わない） ---------- */
function carveTowardTargetFromSolved(solved, targetHints, forbidMask){
  const g = solved.map(r=>r.slice());
  // forbid は必ず空欄に
  let hints = 81;
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    if (forbidMask && forbidMask[r][c]){ if (g[r][c]) hints--; g[r][c]=0; }
  }
  const target = clamp(targetHints, 17, 81);
  if (hints<=target) return g;

  // 点対称ペアで削る（forbidは触らない）
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c; if (r>or || (r===or && c>oc)) continue;
    const can1 = !(forbidMask && forbidMask[r]?.[c]);
    const can2 = !(forbidMask && forbidMask[or]?.[oc]);
    if (can1 || can2) pairs.push([r,c,or,oc,can1,can2]);
  }
  shuffle(pairs);

  for (const [r,c,or,oc,can1,can2] of pairs){
    if (hints<=target) break;
    let drop=0;
    if (can1 && g[r][c]!==0){ g[r][c]=0; drop++; }
    if (can2 && g[or][oc]!==0){ g[or][oc]=0; drop+= (or===r && oc===c)?0:1; }
    hints -= drop;
  }
  return g;
}

/* ---------- 合体CSP：0/1/2解カウント（共有セルを同一変数化） ---------- */
function countSolutionsCombined(puzzles, overlaps, limit=2){
  const B = puzzles.length;
  const idOf = (b,r,c)=> b*81 + r*9 + c;
  const N = B*81;
  const parent = new Int32Array(N); for (let i=0;i<N;i++) parent[i]=i;
  const find = x => { while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const unite = (a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

  // unify overlaps
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      for (const {r,c,r2,c2} of e.cells){
        unite(idOf(i,r,c), idOf(e.j,r2,c2));
      }
    }
  }
  // 変数クラス構築
  const classes = new Map();
  for (let b=0;b<B;b++) for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const root = find(idOf(b,r,c));
    const arr = classes.get(root) || [];
    arr.push({b,r,c});
    classes.set(root, arr);
  }
  const vars = Array.from(classes.values());

  // 盤ごとの使用マスク
  const ROW = Array.from({length:B}, ()=> new Uint16Array(9));
  const COL = Array.from({length:B}, ()=> new Uint16Array(9));
  const BOX = Array.from({length:B}, ()=> new Uint16Array(9));

  // 与えを固定
  const fixed = new Map(); // varIndex -> value
  let vi=0;
  for (const v of vars){
    let forced=0;
    for (const {b,r,c} of v){
      const val = puzzles[b][r][c]|0;
      if (val){
        if (forced===0) forced=val; else if (forced!==val) return 0; // 同一変数に矛盾与え
      }
    }
    if (forced){
      fixed.set(vi, forced);
      for (const {b,r,c} of v){
        const bi=(r/3|0)*3+(c/3|0), bit=1<<forced;
        if (ROW[b][r]&bit || COL[b][c]&bit || BOX[b][bi]&bit) return 0; // 同盤内衝突
        ROW[b][r]|=bit; COL[b][c]|=bit; BOX[b][bi]|=bit;
      }
    }
    vi++;
  }

  // 未固定の探索順（MRV）
  const order=[]; for (let i=0;i<vars.length;i++) if (!fixed.has(i)) order.push(i);
  function domainMaskForVar(i){
    const v=vars[i];
    let mask = ALL;
    for (const {b,r,c} of v){
      const bi=(r/3|0)*3+(c/3|0);
      mask &= (ALL ^ (ROW[b][r] | COL[b][c] | BOX[b][bi]));
      if (!mask) break;
    }
    return mask;
  }
  order.sort((a,b)=> popcnt(domainMaskForVar(a)) - popcnt(domainMaskForVar(b)));

  let solutions=0, nodes=0; const LIMIT=150000; // リソース制限
  (function dfs(k){
    if (solutions>=limit || nodes++>LIMIT) return;
    if (k===order.length){ solutions++; return; }
    const i=order[k];
    let mask = domainMaskForVar(i); if (!mask) return;

    while(mask && solutions<limit){
      const bit = mask & -mask; mask ^= bit;
      // 置いてみる
      const touched=[];
      for (const {b,r,c} of vars[i]){
        const bi=(r/3|0)*3+(c/3|0);
        if (ROW[b][r]&bit || COL[b][c]&bit || BOX[b][bi]&bit){ // 置けない
          for (const t of touched){ ROW[t.b][t.r]^=bit; COL[t.b][t.c]^=bit; BOX[t.b][t.bi]^=bit; }
          touched.length=0; // 破棄
          mask &= mask; // 続行
          // 早期break
          while(false){} // no-op
          continue;
        }
        ROW[b][r]|=bit; COL[b][c]|=bit; BOX[b][bi]|=bit;
        touched.push({b,r,c,bi});
      }
      if (touched.length){
        dfs(k+1);
        for (const t of touched){ ROW[t.b][t.r]^=bit; COL[t.b][t.c]^=bit; BOX[t.b][t.bi]^=bit; }
      }
      if (solutions>=limit) return;
    }
  })(0);

  return Math.min(solutions, limit);
}

/* ---------- handler ---------- */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout)?body.layout:[];
  const difficulty = String(body.difficulty||"normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true

  if (!layout.length) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const target = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // forbid（共有マスは空欄固定）
  const forbids = Array.from({length:nlayout.length}, ()=> Array.from({length:9},()=>Array(9).fill(false)));
  if (overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        for (const {r,c,r2,c2} of e.cells){
          forbids[i][r][c]=true; forbids[e.j][r2][c2]=true;
        }
      }
    }
  }

  // 完成盤
  const pat = makeGlobalPattern();
  const solved = nlayout.map(({ox,oy}) =>
    Array.from({length:GRID},(_,r)=> Array.from({length:GRID},(_,c)=> pat.valueAt(oy+r, ox+c)))
  );

  // まず非共有だけ削って「下地」を作る（高速・単盤の唯一性は見ない）
  let puzzles = solved.map((sol,idx)=> carveTowardTargetFromSolved(sol, target, forbids[idx]));

  // 共有矛盾はなし（全て空欄）だが、行列箱の与え矛盾だけ確認
  for (const p of puzzles){ if (puzzleHasContradiction(p)) return json({ ok:false, reason:"contradiction" }, 500); }

  // --- 合体全体の唯一性へ収束（複数解なら非共有マスに手掛かりを追加） ---
  let addBudget = 180; // 合計追加試行の上限（大きくすると遅く/500の原因）
  let solCount = countSolutionsCombined(puzzles, overlaps, 2);
  if (solCount === 0) return json({ ok:false, reason:"no solution" }, 500);

  // 候補（非共有かつ現状0）を集める
  function collectAddables(){
    const list=[];
    for (let b=0;b<puzzles.length;b++){
      for (let r=0;r<9;r++) for (let c=0;c<9;c++){
        if (puzzles[b][r][c]===0 && !(forbids[b]&&forbids[b][r]?.[c])) list.push({b,r,c});
      }
    }
    return list;
  }

  while (solCount !== 1 && addBudget-- > 0){
    const cands = collectAddables();
    if (!cands.length) break;
    // ランダムよりは「対称ペア＋分散」優先
    shuffle(cands);
    const pick = cands[0];
    const {b,r,c} = pick; const or=8-r, oc=8-c;

    // 追加（点対称ペアも可能なら一緒に）
    puzzles[b][r][c] = solved[b][r][c];
    if (!(forbids[b]&&forbids[b][or]?.[oc]) && puzzles[b][or][oc]===0){
      puzzles[b][or][oc] = solved[b][or][oc];
    }

    solCount = countSolutionsCombined(puzzles, overlaps, 2);
    // 追加しても2解以上のままのことが多いので、そのまま続ける（戻さない）
  }

  // ここで 1 解でなければ、これ以上は重いので安全に中断
  if (solCount !== 1){
    return json({ ok:false, reason:"failed to generate (resource-safe)" }, 500);
  }

  // 余力があれば、再び少しだけ削って目標に近づける（常に唯一性維持）
  let pruneBudget = 60;
  const pairs=[];
  for (let b=0;b<puzzles.length;b++){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      const or=8-r, oc=8-c;
      if (r>or || (r===or && c>oc)) continue;
      const forbid = forbids[b];
      const can1 = !(forbid&&forbid[r]?.[c]) && puzzles[b][r][c]!==0;
      const can2 = !(forbid&&forbid[or]?.[oc]) && puzzles[b][or][oc]!==0;
      if (can1 || can2) pairs.push({b,r,c,or,oc,can1,can2});
    }
  }
  shuffle(pairs);

  for (const p of pairs){
    if (pruneBudget--<=0) break;
    const {b,r,c,or,oc,can1,can2} = p;
    const k1=puzzles[b][r][c], k2=puzzles[b][or][oc];
    if (!can1 && !can2) continue;
    if (can1) puzzles[b][r][c]=0;
    if (can2) puzzles[b][or][oc]=0;
    if (puzzleHasContradiction(puzzles[b]) || countSolutionsCombined(puzzles, overlaps, 2)!==1){
      // 戻す
      if (can1) puzzles[b][r][c]=k1;
      if (can2) puzzles[b][or][oc]=k2;
    }
  }

  // 最終検証（安全）
  if (countSolutionsCombined(puzzles, overlaps, 2)!==1){
    return json({ ok:false, reason:"verification failed" }, 500);
  }

  const boards = nlayout.map((o, idx)=>({
    id: layout[idx].id,
    x: o.rawx, y: o.rawy,
    grid: puzzles[idx],
    solution: solved[idx],
  }));
  return json({ ok:true, puzzle:{ boards } });
};
