// Cloudflare Pages Functions: /functions/api/generate.js
// 唯一解保証・重なり整合・重い探索を時間/ノードで安全に打ち切り

const GRID = 9;
const CELL_PX = 30;

// 難易度→残すヒント数（多いほど易しい）
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

/* --------------------- ユーティリティ --------------------- */
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  // 既知の完成盤テンプレを行/列/数字置換で生成
  function makeOrder(){
    const band = shuffle([0,1,2]);
    const order=[];
    for (const b of band){
      const inner = shuffle([0,1,2]);
      for (const k of inner) order.push(b*3+k);
    }
    return order;
  }
  const rowOrder = makeOrder();
  const colOrder = makeOrder();
  const digitPerm = shuffle([1,2,3,4,5,6,7,8,9]);
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  function valueAt(R,C){
    const r = rowOrder[((R%9)+9)%9];
    const c = colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
}

function normalizeLayout(layout){
  return layout.map(o=>{
    const rawx = Number(o.x)||0, rawy = Number(o.y)||0;
    const ox = Math.round(rawx / CELL_PX);
    let oy = Math.round(rawy / CELL_PX);
    oy -= oy % 3; // 箱境界を揃える
    return { id:String(o.id), ox, oy, rawx, rawy };
  });
}

function buildOverlaps(nlayout){
  const n=nlayout.length, overlaps=Array.from({length:n},()=>[]);
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
    const A=nlayout[i], B=nlayout[j];
    const R0=Math.max(0, B.oy-A.oy), C0=Math.max(0, B.ox-A.ox);
    const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
    if (R0<=R1 && C0<=C1){
      const cells=[];
      for (let r=R0;r<=R1;r++) for (let c=C0;c<=C1;c++){
        const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
        cells.push({ r,c,r2,c2 });
      }
      overlaps[i].push({ j, cells });
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2,c:c2,r2:r,c2:c })) });
    }
  }
  return overlaps;
}

/* --------------------- 高速ソルバ（0/1/2解、-1=タイムアウト） --------------------- */
function countSolutionsFast(grid, limit=2, nodeLimit=80000, deadlineMs=0){
  const ROW = new Uint16Array(9); // bit1..9
  const COL = new Uint16Array(9);
  const BOX = new Uint16Array(9);
  const ALL = 0x3FE; // 1..9
  const bit = d => 1<<d;
  const boxId = (r,c)=> (r/3|0)*3 + (c/3|0);

  // 初期与えをセット（矛盾あれば 0）
  for (let r=0;r<9;r++){
    for (let c=0;c<9;c++){
      const v = grid[r][c]|0;
      if (!v) continue;
      const b = boxId(r,c), m = bit(v);
      if (ROW[r]&m || COL[c]&m || BOX[b]&m) return 0;
      ROW[r]|=m; COL[c]|=m; BOX[b]|=m;
    }
  }

  // 空セル一覧
  const empty = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) empty.push([r,c]);
  const filled = Array.from({length:9},()=>Array(9).fill(false));
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) filled[r][c] = !!grid[r][c];

  const popcnt = (x)=>{ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz = (x)=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };
  const domainMask = (r,c)=> ALL ^ (ROW[r] | COL[c] | BOX[boxId(r,c)]);

  let nodes=0, sols=0;

  function pickCell(){
    // MRV：未確定セルの中で候補数が最小のもの
    let best=null, bestMask=0, bestCount=10;
    for (let i=0;i<empty.length;i++){
      const [r,c]=empty[i];
      if (filled[r][c]) continue;
      const mask = domainMask(r,c);
      if (!mask) return { r, c, mask:0, count:0 };
      const cnt = popcnt(mask);
      if (cnt < bestCount){ best={r,c}; bestMask=mask; bestCount=cnt; if (cnt===1) break; }
    }
    if (!best) return null; // すべて埋まった（この pickCell は呼ばれないはず）
    return { r:best.r, c:best.c, mask:bestMask, count:bestCount };
  }

  function dfs(){
    if (deadlineMs && Date.now() > deadlineMs) return -1;      // 時間打ち切り
    if (nodes++ > nodeLimit) return -1;                         // ノード打ち切り

    // 未確定セルを選ぶ
    let totalLeft = 0;
    for (let i=0;i<empty.length;i++){ const [r,c]=empty[i]; if (!filled[r][c]) { totalLeft++; break; } }
    if (totalLeft===0){ sols++; return sols>=limit ? limit : sols; }

    const pick = pickCell();
    if (!pick) { sols++; return sols>=limit ? limit : sols; }
    if (pick.count===0) return sols; // 行き止まり

    let mask = pick.mask;
    const r = pick.r, c = pick.c, b = boxId(r,c);

    while(mask){
      const d = ctz(mask); mask &= mask-1;
      const m = bit(d);
      if (ROW[r]&m || COL[c]&m || BOX[b]&m) continue;

      // 置く
      filled[r][c] = true;
      ROW[r]|=m; COL[c]|=m; BOX[b]|=m;

      const ret = dfs();
      // 戻す
      ROW[r]&=~m; COL[c]&=~m; BOX[b]&=~m;
      filled[r][c] = false;

      if (ret === -1) return -1;
      if (sols >= limit) return limit;
    }
    return sols;
  }

  const res = dfs();
  if (res === -1) return -1;
  return Math.min(sols, limit);
}

/* --------------------- 削り（唯一解を守る） --------------------- */
function carveUniqueFromSolved(solved, targetHints, forbidMask, timeBudgetMs){
  const g = solved.map(r=>r.slice());
  // forbid（共有マス）は必ず空に
  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (forbidMask[r][c]) g[r][c]=0;
  }
  const start = Date.now();
  const deadline = timeBudgetMs ? start + timeBudgetMs : 0;

  const ALL_POS = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) ALL_POS.push([r,c]);
  // 点対称ペア
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);

  // 現在ヒント数
  let hints=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) hints++;

  // まずペア削りで一気に近づける
  for (const [r,c,or,oc] of pairs){
    if (hints <= targetHints) break;
    if ((!g[r][c] && !g[or][oc])) continue;
    if ((forbidMask?.[r]?.[c]) || (forbidMask?.[or]?.[oc])) continue;

    const keep1=g[r][c], keep2=g[or][oc];
    g[r][c]=0; g[or][oc]=0;

    const cnt = countSolutionsFast(g, 2, 60000, deadline);
    if (cnt === 1){
      hints -= (r===or && c===oc) ? 1 : 2;
    }else{
      g[r][c]=keep1; g[or][oc]=keep2;
      if (cnt === -1) return null; // 時間超
    }
  }

  // 単点微調整
  if (hints > targetHints){
    const singles = [];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c] && !(forbidMask?.[r]?.[c])) singles.push([r,c]);
    }
    shuffle(singles);
    for (const [r,c] of singles){
      if (hints <= targetHints) break;
      const k=g[r][c]; g[r][c]=0;
      const cnt = countSolutionsFast(g, 2, 60000, deadline);
      if (cnt === 1) hints--;
      else { g[r][c]=k; if (cnt === -1) return null; }
    }
  }

  return g;
}

/* --------------------- 与え矛盾チェック --------------------- */
function puzzleHasContradiction(p){
  // 行
  for (let r=0;r<9;r++){
    const seen=new Set();
    for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
  }
  // 列
  for (let c=0;c<9;c++){
    const seen=new Set();
    for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
  }
  // 箱
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    const seen=new Set();
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);
    }
  }
  return false;
}

/* --------------------- メイン --------------------- */
export const onRequestPost = async ({ request, env }) => {
  let body={}; try{ body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true
  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);

  // 盤ごとの重なりセル数を数え、ヒント目標を調整
  const overlapCountPerBoard = nlayout.map(()=>0);
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      for (const {r,c} of e.cells){ // i側カウント
        overlapCountPerBoard[i]++;
      }
    }
  }
  const baseHint = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;
  const hintTargetPerBoard = overlapCountPerBoard.map(cnt=>{
    // 共有マスは必ず空欄 → 最大ヒント数は (81 - cnt)
    const maxHints = 81 - cnt;
    // 重なりが多いほどヒントを増やして唯一解を安定化（係数は控えめ）
    const bump = Math.min(8, Math.floor(cnt * 0.4));
    const target = Math.min(maxHints, Math.max(baseHint + bump, baseHint));
    return Math.max(17, target);
  });

  // 全体時間（デフォルト 3500ms、 wrangler.toml の [vars] GEN_TIMEOUT_MS で上書き可）
  const hardMs = Math.max(1000, Number(env?.GEN_TIMEOUT_MS)||3500);
  const deadline = Date.now() + hardMs;

  const ATTEMPTS = 24;
  for (let attempt=0; attempt<ATTEMPTS; attempt++){
    if (Date.now() > deadline) break;

    const pattern = makeGlobalPattern();
    // 完成盤（重なり一致）
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

    // forbid（共有マスは空欄）
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

    // 各盤：唯一解になるまで削る（時間を小分けに使う）
    const perBoardBudget = Math.max(80, Math.floor((deadline - Date.now())/Math.max(1,nlayout.length)));
    const puzzles = [];
    let gaveUp = false;

    for (let i=0;i<nlayout.length;i++){
      const g = carveUniqueFromSolved(solved[i], hintTargetPerBoard[i], forbids[i], perBoardBudget);
      if (!g){ gaveUp=true; break; }
      // 与え矛盾の即時チェック
      if (puzzleHasContradiction(g)){ gaveUp=true; break; }
      // 唯一解最終確認（安全）
      const cnt = countSolutionsFast(g, 2, 80000, deadline);
      if (cnt !== 1){ gaveUp=true; break; }
      puzzles.push(g);
      if (Date.now() > deadline){ gaveUp=true; break; }
    }
    if (gaveUp) continue;

    // 共有マス整合（overlapEmpty の時は与え同士は存在しないため省略可）
    if (!overlapEmpty){
      let bad=false;
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ bad=true; break; }
          }
          if (bad) break;
        }
        if (bad) { gaveUp=true; break; }
      }
      if (gaveUp) continue;
    }

    const boards = nlayout.map((o, idx)=>({
      id: layout[idx].id,
      x: o.rawx, y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx],
    }));
    return json({ ok:true, puzzle:{ boards } });
  }

  return json({ ok:false, reason:"failed to generate (resource-safe)" }, 500);
};
