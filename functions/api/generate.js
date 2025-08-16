// Cloudflare Pages Functions: /functions/api/generate.js
// ☆ 置き換え可：唯一解保証＋共有整合＋難易度（ヒント数）＋リソース配慮

const GRID = 9;
const CELL_PX = 30;

// 難易度 → 残すヒント数（多いほど易しい）
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

/* ----------------- utils ----------------- */
const shuffle = (a) => { for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };

function makeGlobalPattern(){
  // 標準のベース式を行/列/数字置換で
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  const order3 = () => { const band = shuffle([0,1,2]); const out=[]; for(const b of band){ const inner=shuffle([0,1,2]); for(const k of inner) out.push(b*3+k); } return out; };
  const rowOrder = order3(), colOrder = order3(), digitPerm = shuffle([1,2,3,4,5,6,7,8,9]);
  return {
    valueAt(R,C){
      const r = rowOrder[((R%9)+9)%9];
      const c = colOrder[((C%9)+9)%9];
      return digitPerm[ base(r,c) ];
    }
  };
}

function normalizeLayout(layout){
  // y は 3 の倍数にスナップ（箱整合）
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

/* --------- solver (0/1/2 solutions) --------- */
// 9ビットのマスク（bit1..bit9使用）
const ALL = 0x3FE; // 1<<1 .. 1<<9 の和

function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
function ctz(x){ return Math.clz32(x & -x) ^ 31; } // 最下位1bitのindex

function countSolutions(grid, limit=2){
  // 行/列/箱の使用ビット
  const rowMask = new Uint16Array(9);
  const colMask = new Uint16Array(9);
  const boxMask = new Uint16Array(9);

  // 初期セット＆矛盾検出
  for (let r=0;r<9;r++){
    for (let c=0;c<9;c++){
      const v = grid[r][c]|0; if (!v) continue;
      const bit = 1<<v, b = (r/3|0)*3 + (c/3|0);
      if ((rowMask[r]&bit) || (colMask[c]&bit) || (boxMask[b]&bit)) return 0;
      rowMask[r]|=bit; colMask[c]|=bit; boxMask[b]|=bit;
    }
  }

  const cells=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) cells.push([r,c]);

  // MRV 事前並べ
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
    let mask = ALL ^ (rowMask[r] | colMask[c] | boxMask[b]); // 候補
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

/* -------------- puzzle helpers -------------- */
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

function carveUniqueFromSolved(solved, targetHints, forbidMask){
  // forbid を 0 にしてから、点対称に削る→単点調整。各手順ごとに「矛盾なし＆唯一解=1」を必ず確認。
  const g = solved.map(r=>r.slice());

  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (forbidMask[r][c]) g[r][c]=0;
  }

  const target = Math.max(17, Math.min(81, targetHints));
  let hints = 0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) hints++;

  // ペア一覧（点対称）
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);

  const canErase = (r,c)=> g[r][c] && !(forbidMask && forbidMask[r]?.[c]);

  // ペア削り
  for (const [r,c,or,oc] of pairs){
    if (hints<=target) break;
    if (!canErase(r,c) && !canErase(or,oc)) continue;

    const a=g[r][c], b=g[or][oc];
    g[r][c]=0; g[or][oc]=0;

    // 途中で矛盾しないか＆唯一解か
    if (!puzzleHasContradiction(g) && countSolutions(g,2)===1){
      hints -= (r===or && c===oc) ? 1 : 2;
    }else{
      g[r][c]=a; g[or][oc]=b;
    }
  }

  // 単点で微調整
  if (hints>target){
    const cells=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (canErase(r,c)) cells.push([r,c]);
    shuffle(cells);
    for (const [r,c] of cells){
      if (hints<=target) break;
      const keep=g[r][c]; g[r][c]=0;
      if (!puzzleHasContradiction(g) && countSolutions(g,2)===1) hints--; else g[r][c]=keep;
    }
  }

  // 最終ガード
  if (puzzleHasContradiction(g) || countSolutions(g,2)!==1) return null;
  return g;
}

/* ----------------- handler ----------------- */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true（共有マスは必ず空欄）

  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // forbid（共有マスを空欄にする）
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

  // 複数回トライ（リソース配慮）
  const MAX_TRY = 22;
  for (let attempt=0; attempt<MAX_TRY; attempt++){
    const pattern = makeGlobalPattern();

    // 1) 完成盤（重なりは自動で一致：同一パターンを座標で参照）
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

    // 2) 盤ごとに「唯一解に削る」
    const puzzles = new Array(nlayout.length);
    let ok = true;
    for (let i=0;i<nlayout.length;i++){
      const g = carveUniqueFromSolved(solved[i], hintTarget, forbids[i]);
      if (!g){ ok=false; break; }
      puzzles[i] = g;
    }
    if (!ok) continue;

    // 3) 共有マス検証（overlapEmpty=false の場合のみ与え一致を要求）
    if (!overlapEmpty){
      for (let i=0;i<overlaps.length && ok;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ ok=false; break; }
          }
          if (!ok) break;
        }
      }
      if (!ok) continue;
    }

    // 4) 最終安全チェック（全盤 与え矛盾なし＆唯一解=1）
    for (let i=0;i<puzzles.length && ok;i++){
      if (puzzleHasContradiction(puzzles[i]) || countSolutions(puzzles[i],2)!==1){ ok=false; }
    }
    if (!ok) continue;

    // 5) 返却
    const boards = nlayout.map((o, idx)=>({
      id: layout[idx].id,
      x: o.rawx, y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx],
    }));
    return json({ ok:true, puzzle:{ boards } });
  }

  // 収まらなければ 500（フロントはメッセージをそのまま表示）
  return json({ ok:false, reason:"failed to generate (resource-safe)" }, 500);
};
