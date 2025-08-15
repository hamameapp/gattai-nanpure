// functions/api/generate.js
const GRID = 9;
const CELL_PX = 30;
const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 30 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeGlobalPattern(){
  function makeOrder(){
    const bandOrder = shuffle([0,1,2]); const order=[];
    for (const b of bandOrder){ const inner=shuffle([0,1,2]); for (const k of inner) order.push(b*3+k); }
    return order;
  }
  const rowOrder=makeOrder(), colOrder=makeOrder(), digitPerm=shuffle([1,2,3,4,5,6,7,8,9]);
  const base=(r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  function valueAt(R,C){
    const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
}

function carveBoard(solved, hintTarget){
  const g = solved.map(r=>r.slice());
  const cells=[...Array(81).keys()]; shuffle(cells);
  let toRemove=Math.max(0, 81-hintTarget);
  for(const idx of cells){
    if(toRemove<=0) break;
    const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
    if(g[r][c]===0 && g[or][oc]===0) continue;
    g[r][c]=0; g[or][oc]=0;
    toRemove -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

function normalizeLayout(layout){
  return layout.map(o=>{
    const ox = Math.round((Number(o.x)||0)/CELL_PX);
    let   oy = Math.round((Number(o.y)||0)/CELL_PX);
    // ★重要：3の倍数に正規化（箱の崩れ防止）
    oy -= oy % 3;
    return {
      id:String(o.id),
      ox, oy,
      rawx: Number(o.x)||0,
      rawy: Number(o.y)||0
    };
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

function clampPuzzleToSolution(puzzle, solution){
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const v=puzzle[r][c]|0; if(v!==0) puzzle[r][c]=solution[r][c];
  }
}

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

function puzzleHasContradiction(p){
  // row
  for (let r=0;r<9;r++){
    const seen=new Set();
    for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
  }
  // col
  for (let c=0;c<9;c++){
    const seen=new Set();
    for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
  }
  // box
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    const seen=new Set();
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);
    }
  }
  return false;
}

export const onRequestPost = async ({ request }) => {
  let body = {}; try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  for (let attempt=0; attempt<20; attempt++){
    const pattern = makeGlobalPattern();
    // ★重要：R=oy+r, C=ox+c（oy は 3の倍数なので箱が壊れない）
    const solved = nlayout.map(({ ox, oy }) =>
      Array.from({ length: GRID }, (_, r) =>
        Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
      )
    );
    let puzzles = solved.map(g => carveBoard(g, hintTarget));
    const overlaps = buildOverlaps(nlayout);

    // 与えの整合
    unifyGivenCells(puzzles, overlaps);
    enforceOverlapBySolution(puzzles, solved, overlaps);
    for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);

    // バリデーション（行/列/箱/共有マス）
    let bad = false;
    for (const p of puzzles) if (puzzleHasContradiction(p)) { bad = true; break; }
    if (!bad){
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ bad = true; break; }
          }
          if (bad) break;
        }
        if (bad) break;
      }
    }
    if (!bad){
      const boards = nlayout.map((o, idx) => ({
        id: layout[idx].id, x: o.rawx, y: o.rawy,
        grid: puzzles[idx], solution: solved[idx]
      }));
      return json({ ok:true, puzzle:{ boards } });
    }
  }
  return json({ ok:false, reason:"generator failed to produce a valid puzzle" }, 500);
};
