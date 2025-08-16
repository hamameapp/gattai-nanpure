// Cloudflare Pages Functions: /functions/api/generate.js
// 唯一解保証・共有整合・重い探索はリカバリして成功率を上げる

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

/* --------------------- Utils --------------------- */
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  function makeOrder(){ const band=shuffle([0,1,2]); const order=[]; for(const b of band){ const inner=shuffle([0,1,2]); for(const k of inner) order.push(b*3+k); } return order; }
  const rowOrder=makeOrder(), colOrder=makeOrder(), digitPerm=shuffle([1,2,3,4,5,6,7,8,9]);
  const base=(r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  function valueAt(R,C){ const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9]; return digitPerm[ base(r,c) ]; }
  return { valueAt };
}

function normalizeLayout(layout){
  return layout.map(o=>{
    const rawx=Number(o.x)||0, rawy=Number(o.y)||0;
    const ox=Math.round(rawx/CELL_PX);
    let oy=Math.round(rawy/CELL_PX); oy -= oy%3; // 箱整合
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

/* --------------------- ソルバ（0/1/2解, -1=締切超過） --------------------- */
function countSolutionsFast(grid, limit=2, nodeLimit=120000, deadlineMs=0){
  const ROW=new Uint16Array(9), COL=new Uint16Array(9), BOX=new Uint16Array(9);
  const ALL=0x3FE, bit=d=>1<<d, boxId=(r,c)=> (r/3|0)*3 + (c/3|0);

  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=grid[r][c]|0; if(!v) continue;
    const b=boxId(r,c), m=bit(v);
    if (ROW[r]&m || COL[c]&m || BOX[b]&m) return 0;
    ROW[r]|=m; COL[c]|=m; BOX[b]|=m;
  }

  const empty=[]; const filled=Array.from({length:9},()=>Array(9).fill(false));
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){ if(!grid[r][c]) empty.push([r,c]); else filled[r][c]=true; }

  const popcnt=(x)=>{ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz=(x)=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };
  const domainMask=(r,c)=> ALL ^ (ROW[r] | COL[c] | BOX[boxId(r,c)]);

  let nodes=0, sols=0;

  function pickCell(){
    let best=null, bestMask=0, bestCnt=10;
    for (let i=0;i<empty.length;i++){
      const [r,c]=empty[i]; if (filled[r][c]) continue;
      const mask=domainMask(r,c); const cnt=popcnt(mask);
      if (!cnt) return { r,c,mask:0,count:0 };
      if (cnt<bestCnt){ best={r,c}; bestMask=mask; bestCnt=cnt; if (cnt===1) break; }
    }
    if (!best) return null;
    return { r:best.r, c:best.c, mask:bestMask, count:bestCnt };
  }

  function dfs(){
    if (deadlineMs && Date.now()>deadlineMs) return -1;
    if (nodes++ > nodeLimit) return -1;

    // まだ空きがあるか
    let any=false; for (const [r,c] of empty){ if(!filled[r][c]){ any=true; break; } }
    if (!any){ sols++; return sols>=limit ? limit : sols; }

    const pick = pickCell();
    if (!pick) { sols++; return sols>=limit ? limit : sols; }
    if (pick.count===0) return sols;

    let mask=pick.mask; const r=pick.r, c=pick.c, b=boxId(r,c);
    while(mask){
      const d=ctz(mask); mask&=mask-1; const m=bit(d);
      if (ROW[r]&m || COL[c]&m || BOX[b]&m) continue;
      filled[r][c]=true; ROW[r]|=m; COL[c]|=m; BOX[b]|=m;
      const ret=dfs();
      ROW[r]&=~m; COL[c]&=~m; BOX[b]&=~m; filled[r][c]=false;
      if (ret===-1) return -1;
      if (sols>=limit) return limit;
    }
    return sols;
  }

  const res=dfs();
  return res===-1 ? -1 : Math.min(sols,limit);
}

/* --------------------- 与え矛盾チェック --------------------- */
function puzzleHasContradiction(p){
  for (let r=0;r<9;r++){ const seen=new Set(); for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);} }
  for (let c=0;c<9;c++){ const seen=new Set(); for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);} }
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    const seen=new Set(); for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){ const v=p[br+dr][bc+dc]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
  }
  return false;
}

/* --------------------- 削り（唯一解を守る／締切超過は無理せずスキップ） --------------------- */
function carveUniqueFromSolved(solved, targetHints, forbidMask, deadlineMs){
  const g=solved.map(r=>r.slice());

  // 共有マスは空欄固定
  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (forbidMask[r][c]) g[r][c]=0;
  }

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

  // 1) ペア削り
  for (const [r,c,or,oc] of pairs){
    if (deadlineMs && Date.now()>deadlineMs) break;
    if (hints<=targetHints) break;
    if ((!g[r][c] && !g[or][oc])) continue;
    if ((forbidMask?.[r]?.[c]) || (forbidMask?.[or]?.[oc])) continue;

    const keep1=g[r][c], keep2=g[or][oc];
    g[r][c]=0; g[or][oc]=0;

    const cnt=countSolutionsFast(g,2,120000,deadlineMs);
    if (cnt===1){
      hints -= (r===or && c===oc) ? 1 : 2;
    }else{
      // 重すぎ or 複数解 → 戻すだけで続行（全体は成功させる）
      g[r][c]=keep1; g[or][oc]=keep2;
    }
  }

  // 2) 単点微調整
  if (hints>targetHints){
    const singles=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c] && !(forbidMask?.[r]?.[c])) singles.push([r,c]);
    }
    shuffle(singles);
    for (const [r,c] of singles){
      if (deadlineMs && Date.now()>deadlineMs) break;
      if (hints<=targetHints) break;
      const keep=g[r][c]; g[r][c]=0;
      const cnt=countSolutionsFast(g,2,120000,deadlineMs);
      if (cnt===1) hints--; else g[r][c]=keep;
    }
  }

  return g; // 目標に届かなくても唯一解ならOK（呼び元で最終確認）
}

/* --------------------- メイン --------------------- */
export const onRequestPost = async ({ request, env }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty||'normal');
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true
  if (!layout.length) return json({ ok:false, reason:'layout required' }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);

  // 盤ごとの重なりセル数 → ヒント目標を自動調整
  const overlapCnt = nlayout.map(()=>0);
  for (let i=0;i<overlaps.length;i++) for (const e of overlaps[i]) overlapCnt[i]+=e.cells.length;

  const baseHint = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;
  const hintTarget = overlapCnt.map(cnt=>{
    const maxHints = 81 - (overlapEmpty ? cnt : 0);         // 共有マスは空欄にする場合は使えない
    const bump = Math.min(12, Math.floor(cnt * 0.5));       // 重なりが多いほど増量
    return Math.max(17, Math.min(maxHints, baseHint + bump));
  });

  // 全体締切（環境変数で上書き可）
  const HARD_MS = Math.max(2000, Number(env?.GEN_TIMEOUT_MS) || 8000);
  const deadline = Date.now() + HARD_MS;

  // forbid（共有マスを空欄にする）
  const forbids = Array.from({length:nlayout.length}, ()=> Array.from({length:9},()=>Array(9).fill(false)));
  if (overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        for (const {r,c} of e.cells){ forbids[i][r][c]=true; }
      }
    }
  }

  // 何度か試す（ただし締切厳守）
  const ATTEMPTS = 16;
  for (let attempt=0; attempt<ATTEMPTS; attempt++){
    if (Date.now()>deadline) break;

    const pattern = makeGlobalPattern();
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID},(_,r)=> Array.from({length:GRID},(_,c)=> pattern.valueAt(oy+r, ox+c)))
    );

    const puzzles=[];
    let failed=false;

    for (let i=0;i<nlayout.length;i++){
      const g = carveUniqueFromSolved(solved[i], hintTarget[i], forbids[i], deadline);
      if (puzzleHasContradiction(g)){ failed=true; break; }

      // 最終：唯一解か？
      const cnt = countSolutionsFast(g, 2, 120000, deadline);
      if (cnt !== 1){ failed=true; break; }

      puzzles.push(g);
      if (Date.now()>deadline){ failed=true; break; }
    }
    if (failed) continue;

    // overlapEmpty=false の場合だけ、与え同士の不一致を検査（今回は常に空欄なので実質スキップ）
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
        if (bad){ failed=true; break; }
      }
      if (failed) continue;
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
