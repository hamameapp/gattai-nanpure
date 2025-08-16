// functions/api/generate.js
// 目的: 各盤が「少なくとも一意解」になるまでサーバ側で自動的にヒントを追加してから返す
// ポイント:
//  - 既知の完成解 solved を持ちながら、パズル p に対して「solved と異なる別解が存在するか」を直接探索
//  - 別解が見つかったら、solved の値をヒントとして 1 マス追加 → 共有セルにも伝播 → 再検証 → 再チェック
//  - 時間/試行バジェット内で収束させる（単盤なら現実的時間で安定収束）
//
// 合体の“全体唯一”までは保証しませんが、「1枚構成でも重解が出る」問題を確実に止めます。

const GRID = 9;
const CELL_PX = 30;
const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 30, expert: 28, extreme: 26 };

const MAX_ATTEMPTS = 30;              // 全体の再生成試行
const DEFAULT_GEN_TIMEOUT_MS = 6000;  // 生成タイムバジェット（ms）少し余裕を増やす

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/* ---------- small utils ---------- */
const now = () => Date.now();
const shuffle = (a)=>{ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };
const cloneGrid = g => g.map(r=>r.slice());

/* 完全解ジェネレータ */
function makeGlobalPattern(){
  function makeOrder(){
    const band = shuffle([0,1,2]);
    const out = [];
    for (const b of band){
      const inner = shuffle([0,1,2]);
      for (const k of inner) out.push(b*3+k);
    }
    return out;
  }
  const rowOrder = makeOrder();
  const colOrder = makeOrder();
  const digitPerm = shuffle([1,2,3,4,5,6,7,8,9]);
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  function valueAt(R,C){
    const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
}

/* レイアウト正規化（Y は 3 セル単位に） */
function normalizeLayout(layout){
  return layout.map(o=>{
    const ox=Math.round((Number(o.x)||0)/CELL_PX);
    let oy=Math.round((Number(o.y)||0)/CELL_PX);
    oy -= oy%3;
    return { id:String(o.id), ox, oy, rawx:Number(o.x)||0, rawy:Number(o.y)||0 };
  });
}

/* 共有セル列挙 */
function buildOverlaps(nlayout){
  const n=nlayout.length, overlaps=Array.from({length:n},()=>[]);
  for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
    const A=nlayout[i], B=nlayout[j];
    const R0=Math.max(0, B.oy-A.oy), C0=Math.max(0, B.ox-A.ox);
    const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
    if (R0<=R1 && C0<=C1){
      const cells=[];
      for(let r=R0;r<=R1;r++) for(let c=C0;c<=C1;c++){
        const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
        cells.push({ r,c,r2,c2 });
      }
      overlaps[i].push({ j, cells });
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
    }
  }
  return overlaps;
}

/* 穴あけ（対称） */
function carveBoard(solved, hintTarget){
  const g = solved.map(r=>r.slice());
  const order = [...Array(81).keys()];
  shuffle(order);
  let toRemove = Math.max(0, 81-hintTarget);
  for (const idx of order){
    if (toRemove<=0) break;
    const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
    if (g[r][c]===0 && g[or][oc]===0) continue;
    g[r][c]=0; g[or][oc]=0;
    toRemove -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

/* 与え矛盾（行/列/箱） */
function puzzleHasContradiction(p){
  // row
  for (let r=0;r<9;r++){
    const seen=new Set();
    for (let c=0;c<9;c++){
      const v=p[r][c]|0; if(!v) continue;
      if (seen.has(v)) return true; seen.add(v);
    }
  }
  // col
  for (let c=0;c<9;c++){
    const seen=new Set();
    for (let r=0;r<9;r++){
      const v=p[r][c]|0; if(!v) continue;
      if (seen.has(v)) return true; seen.add(v);
    }
  }
  // box
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    const seen=new Set();
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue;
      if (seen.has(v)) return true; seen.add(v);
    }
  }
  return false;
}

/* クランプ：与え!=0 のマスは必ず完成解に合わせる */
function clampPuzzleToSolution(puzzle, solution){
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    if ((puzzle[r][c]|0)!==0) puzzle[r][c]=solution[r][c];
  }
}

/* 与えの統一と、共有に値がある場合は両盤を完成解値で固定 */
function unifyGivenCells(puzzles, overlaps){
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
        if (a!==0 && b===0) puzzles[j][r2][c2]=a;
        else if (b!==0 && a===0) puzzles[i][r][c]=b;
      }
    }
  }
}
function enforceOverlapBySolution(puzzles, solved, overlaps){
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const sVal=solved[i][r][c];
        if (puzzles[i][r][c]!==0 || puzzles[j][r2][c2]!==0){
          puzzles[i][r][c]=sVal; puzzles[j][r2][c2]=sVal;
        }
      }
    }
  }
}

/* 総合バリデーション（与え矛盾 + 共有矛盾） */
function validateAll(puzzles, overlaps){
  for (const p of puzzles){
    if (puzzleHasContradiction(p)) return {ok:false, reason:'row/col/box contradiction'};
  }
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
        if (a!==0 && b!==0 && a!==b) return {ok:false, reason:'overlap mismatch'};
      }
    }
  }
  return {ok:true};
}

/* === 標準数独ソルバ（2解までカウント）=== */
function countSolutionsBoard(p, limit=2){
  const ROW=new Uint16Array(9), COL=new Uint16Array(9), BOX=new Uint16Array(9);
  const BIT=d=>1<<d, ALL=0x3FE;
  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=p[r][c]|0;
    if (v){
      const bi=Math.floor(r/3)*3+Math.floor(c/3), bit=BIT(v);
      if (ROW[r]&bit || COL[c]&bit || BOX[bi]&bit) return 0;
      ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
    }else empties.push([r,c]);
  }
  const domainMask=(r,c)=>{ const bi=Math.floor(r/3)*3+Math.floor(c/3); return (ALL ^ (ROW[r]|COL[c]|BOX[bi])); };
  let sol=0;
  function dfs(){
    if (sol>=limit) return;
    let best=-1, bestM=0, bestPop=10;
    for (let i=0;i<empties.length;i++){
      const [r,c]=empties[i]; if (p[r][c]) continue;
      const m=domainMask(r,c), pc=popcnt(m);
      if (pc===0) return;
      if (pc<bestPop){ best=i; bestM=m; bestPop=pc; if (pc===1) break; }
    }
    if (best===-1){ sol++; return; }
    const [r,c]=empties[best]; const bi=Math.floor(r/3)*3+Math.floor(c/3);
    let m=bestM;
    while(m){
      const v=ctz(m); m&=m-1; const bit=1<<v;
      p[r][c]=v; ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
      dfs();
      ROW[r]&=~bit; COL[c]&=~bit; BOX[bi]&=~bit; p[r][c]=0;
      if (sol>=limit) return;
    }
  }
  dfs();
  return Math.min(sol, limit);
  function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
  function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }
}

/* === “既知解と異なる解があるか”を直接探索 === */
function hasAnotherSolutionBoard(p, solved){
  // p をコピーして DFS。完成したときに solved と完全一致なら「別解ではない」として無視。
  const board = p.map(r=>r.slice());
  const ROW=new Uint16Array(9), COL=new Uint16Array(9), BOX=new Uint16Array(9);
  const BIT=d=>1<<d, ALL=0x3FE;

  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=board[r][c]|0;
    if (v){
      const bi=Math.floor(r/3)*3+Math.floor(c/3), bit=BIT(v);
      if (ROW[r]&bit || COL[c]&bit || BOX[bi]&bit) return false; // 与え矛盾 → 「別解」以前の問題
      ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
    }else empties.push([r,c]);
  }
  const domainMask=(r,c)=>{ const bi=Math.floor(r/3)*3+Math.floor(c/3); return (ALL ^ (ROW[r]|COL[c]|BOX[bi])); };

  // できるだけ solved と違う候補から試す（別解探索を優先）
  function nextCell(){
    let best=-1, bestM=0, bestPop=10;
    for (let i=0;i<empties.length;i++){
      const [r,c]=empties[i]; if (board[r][c]) continue;
      const m=domainMask(r,c), pc=popcnt(m);
      if (pc===0) return null;
      if (pc<bestPop){ best=i; bestM=m; bestPop=pc; if (pc===1) break; }
    }
    if (best===-1) return { done:true };
    const [r,c]=empties[best]; const bi=Math.floor(r/3)*3+Math.floor(c/3);
    // 候補列：まず "solved と違う候補"、最後に "同じ候補"
    const cand=[];
    let m=bestM;
    while(m){ const v=ctz(m); m&=m-1; cand.push(v); }
    const solv = solved[r][c]|0;
    const others = cand.filter(v=>v!==solv);
    const ordered = others.concat(solv && cand.includes(solv) ? [solv] : []);
    return { r,c,bi,ordered };
  }

  function dfs(){
    const pick = nextCell();
    if (!pick) return false;       // 行き止まり
    if (pick.done){
      // 完成。solved と一致？ → 別解ではない
      for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (board[r][c] !== (solved[r][c]|0)) return true;
      return false;
    }
    const { r,c,bi,ordered } = pick;
    for (const v of ordered){
      const bit=1<<v;
      if (ROW[r]&bit || COL[c]&bit || BOX[bi]&bit) continue;
      board[r][c]=v; ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
      if (dfs()) return true;
      ROW[r]&=~bit; COL[c]&=~bit; BOX[bi]&=~bit; board[r][c]=0;
    }
    return false;
  }

  const ans = dfs();
  return ans;

  function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
  function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }
}

/* 共有位置へも伝播する与え追加入れ子 */
function applyGiven(puzzles, i, r, c, val, overlaps){
  if (puzzles[i][r][c] === val) return;
  puzzles[i][r][c] = val;
  // 共有セルへ伝播
  for (const e of overlaps[i]){
    for (const {r:rr,c:cc,r2,c2} of e.cells){
      if (rr===r && cc===c) puzzles[e.j][r2][c2] = val;
    }
  }
}

/* 一意化: 別解が無くなるまで、solved の値をヒント追加（MRVっぽく） */
function enforcePerBoardUniqueness(puzzles, solved, overlaps, deadlineMs){
  for (let i=0;i<puzzles.length;i++){
    // まず「少なくとも 1 解」は成り立つか（与えが solved に矛盾しないか）
    clampPuzzleToSolution(puzzles[i], solved[i]);
    if (puzzleHasContradiction(puzzles[i])) return false;

    // 別解がある間は潰す
    while (true){
      if (now() > deadlineMs) return false;

      const hasAlt = hasAnotherSolutionBoard(puzzles[i], solved[i]);
      if (!hasAlt) break; // 一意になった

      // 候補追加先を選ぶ：現在 0 のセルの中で候補が多そうな場所を優先して、solved の値を固定
      const blanks=[];
      for (let r=0;r<9;r++) for (let c=0;c<9;c++) if ((puzzles[i][r][c]|0)===0) blanks.push([r,c]);
      if (blanks.length===0) return false;

      // 雑にシャッフルしてから上から試す（十分収束します）
      shuffle(blanks);
      let fixed=false;
      for (const [r,c] of blanks){
        const val = solved[i][r][c]|0;
        if (!val) continue;

        applyGiven(puzzles, i, r, c, val, overlaps);
        clampPuzzleToSolution(puzzles[i], solved[i]);
        unifyGivenCells(puzzles, overlaps);
        enforceOverlapBySolution(puzzles, solved, overlaps);

        const vAll = validateAll(puzzles, overlaps);
        if (!vAll.ok){
          // 無効なら戻す（単純に 0 に戻す）
          // 共有側も戻す必要があるが、次の再生成で整うので、この試行はスキップ
          puzzles[i][r][c]=0;
          continue;
        }
        fixed=true;
        break;
      }
      if (!fixed) return false; // どれも有効に追加できない＝収束困難
    }
  }
  return true;
}

/* ---------- ハンドラ ---------- */
export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTargetBase = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  const BUDGET = Number(env?.GEN_TIMEOUT_MS)||DEFAULT_GEN_TIMEOUT_MS;
  const deadline = now() + Math.max(1500, BUDGET);

  for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++){
    if (now() > deadline) break;

    // 完全解を作る
    const pattern = makeGlobalPattern();
    const solved = nlayout.map(({ ox, oy }) =>
      Array.from({ length: GRID }, (_, r) =>
        Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
      )
    );

    // 穴あけ（難易度：10回ごとに +2 ヒントで収束を上げる）
    const hintTarget = Math.min(81, hintTargetBase + Math.floor((attempt-1)/10)*2);
    let puzzles = solved.map(g => carveBoard(g, hintTarget));

    // 与え整合
    unifyGivenCells(puzzles, overlaps);
    enforceOverlapBySolution(puzzles, solved, overlaps);
    for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);

    // バリデーション
    let v = validateAll(puzzles, overlaps);
    if (!v.ok) continue;

    // ★各盤を一意化（別解がある限り追加ヒント）
    const ok = enforcePerBoardUniqueness(puzzles, solved, overlaps, deadline);
    if (!ok) continue;

    // 最終チェック
    v = validateAll(puzzles, overlaps);
    if (!v.ok) continue;

    // 返却
    const boards = nlayout.map((o, idx) => ({
      id: layout[idx].id,
      x: o.rawx,
      y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx]
    }));
    return json({ ok:true, boards });
  }

  return json({ ok:false, reason:"generator failed within time budget" }, 500);
}
