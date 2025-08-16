// functions/api/generate.js
// 目的：
//  - 難易度でヒント数の差が明確に出る
//  - 盤と盤の重なりセルにはヒントを置かない（常に空欄）
//  - 各盤のヒント数をバランス良く（全盤で同数）
//  - ヒント配置は点対称（180°回転対称）で美しく
//  - Sudoku の成立条件は常に担保（行/列/ブロック、重なり一致）
//
// フロントの difficulty は: easy / normal / hard / expert / extreme を想定

const GRID = 9;
const CELL_PX = 30;

// 難易度別：ヒント数（１盤の「重なり以外のセル」に残す個数）
const HINTS = {
  easy: 46,
  normal: 40,
  hard: 34,
  expert: 30,
  extreme: 26,
};

// 難易度別：最低分布（行/列/箱）に残すヒントの下限（重なり以外）
// 配置のバランスが良くなり、見た目の差も出やすい
const MIN_PER = {
  easy:   { row: 4, col: 4, box: 4 },
  normal: { row: 3, col: 3, box: 3 },
  hard:   { row: 2, col: 2, box: 2 },
  expert: { row: 1, col: 1, box: 1 },
  extreme:{ row: 0, col: 0, box: 0 },
};

// ポリシー
const NO_HINTS_ON_OVERLAP = true;   // 重なりセルは常に空欄
const MAX_ATTEMPTS = 30;            // 全体生成の最大リトライ

// ---- ユーティリティ ----
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

// 盤全体を一括で組み立てるソリューションパターン（同一パターンの平行移動/置換）
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

function normalizeLayout(layout){
  return layout.map(o=>({
    id:String(o.id),
    ox: Math.round((Number(o.x)||0)/CELL_PX),
    oy: Math.round((Number(o.y)||0)/CELL_PX),
    rawx: Number(o.x)||0,
    rawy: Number(o.y)||0
  }));
}

// どの盤がどこで重なるか（座標は各盤の0..8）
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
      // 逆方向（j側）も作る
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2,c:c2,r2:r,c2:c })) });
    }
  }
  return overlaps;
}

// 各盤ごとの「重なりセル」マスクを作る（true=重なり）
function buildForbidMasks(nlayout){
  const masks = Array.from({length:nlayout.length}, ()=> Array.from({length:GRID}, ()=> Array(GRID).fill(false)));
  const ov = buildOverlaps(nlayout);
  for (let i=0;i<ov.length;i++){
    for (const e of ov[i]){
      for (const {r,c} of e.cells){
        masks[i][r][c] = true;
      }
    }
  }
  return { masks, overlaps: ov };
}

function puzzleHasContradiction(p){
  // 与え同士がぶつかっていないか（0は無視）
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

// forbidMask（true=重なりセル）は常に 0 にする
// targetKeep は「重なり以外で残すヒント個数」
function carveSymmetricWithForbid(solved, targetKeep, forbidMask, minRow, minCol, minBox){
  // 1) 対称ペアを列挙（重なりセルは候補から除外）
  const visited = Array.from({length:GRID}, ()=>Array(GRID).fill(false));
  const pairs = []; // { a:{r,c}, b:{r,c} } または center:{r,c}
  let centerAllowed = false;

  const center = { r:4, c:4 };
  if (!forbidMask[4][4]) centerAllowed = true;

  for (let r=0;r<GRID;r++){
    for (let c=0;c<GRID;c++){
      if (visited[r][c]) continue;
      if (forbidMask[r][c]) { visited[r][c]=true; continue; }
      const r2=8-r, c2=8-c;
      if (r===r2 && c===c2){
        // 中心
        if (centerAllowed){
          pairs.push({ center: { r, c } });
        }
        visited[r][c]=true;
      }else{
        if (forbidMask[r2][c2]){ // 相方が禁止なら、このセルも実質使えない
          visited[r][c]=true; visited[r2][c2]=true;
          continue;
        }
        pairs.push({ a:{r,c}, b:{r:r2, c:c2} });
        visited[r][c]=true; visited[r2][c2]=true;
      }
    }
  }

  // 2) 取りうる最大ヒント数（重なり以外）
  let maxKeep = 0;
  for (const p of pairs){
    if (p.center) maxKeep += 1; else maxKeep += 2;
  }
  const wantKeep = clamp(targetKeep, 0, maxKeep);

  // 3) Greedy にペアを選んで「分布の下限」を満たしながら wantKeep に近づける
  const rowCnt = new Uint16Array(9); // 現在残す予定の数
  const colCnt = new Uint16Array(9);
  const boxCnt = new Uint16Array(9);
  const kept = new Set(); // index of pairs kept
  const idxs = pairs.map((_,i)=>i);

  function boxIndex(r,c){ return Math.floor(r/3)*3 + Math.floor(c/3); }

  function addPair(i){
    const p = pairs[i];
    if (p.center){
      const {r,c} = p.center;
      rowCnt[r]++; colCnt[c]++; boxCnt[boxIndex(r,c)]++;
    }else{
      const a=p.a, b=p.b;
      rowCnt[a.r]++; colCnt[a.c]++; boxCnt[boxIndex(a.r,a.c)]++;
      rowCnt[b.r]++; colCnt[b.c]++; boxCnt[boxIndex(b.r,b.c)]++;
    }
    kept.add(i);
  }
  function removePair(i){
    if (!kept.has(i)) return;
    const p = pairs[i];
    if (p.center){
      const {r,c} = p.center;
      rowCnt[r]--; colCnt[c]--; boxCnt[boxIndex(r,c)]--;
    }else{
      const a=p.a, b=p.b;
      rowCnt[a.r]--; colCnt[a.c]--; boxCnt[boxIndex(a.r,a.c)]--;
      rowCnt[b.r]--; colCnt[b.c]--; boxCnt[boxIndex(b.r,b.c)]--;
    }
    kept.delete(i);
  }

  // スコア：不足分（row/col/box）をどれだけ改善するか
  function scorePair(i){
    const p=pairs[i];
    let s=0;
    if (p.center){
      const {r,c}=p.center, b=boxIndex(r,c);
      if (rowCnt[r] < minRow) s++;
      if (colCnt[c] < minCol) s++;
      if (boxCnt[b] < minBox) s++;
    }else{
      const a=p.a, b=p.b;
      const biA=boxIndex(a.r,a.c), biB=boxIndex(b.r,b.c);
      if (rowCnt[a.r]<minRow) s++;
      if (colCnt[a.c]<minCol) s++;
      if (boxCnt[biA]<minBox) s++;
      if (rowCnt[b.r]<minRow) s++;
      if (colCnt[b.c]<minCol) s++;
      if (boxCnt[biB]<minBox) s++;
    }
    // 少しランダム性（並び替えの安定化防止）
    return s*100 + Math.random();
  }

  // 3-1) まず不足を埋める方向でペアを追加
  shuffle(idxs);
  while (kept.size < wantKeep){
    // ソートは重いので、上位候補だけ見る
    const remain = idxs.filter(i=>!kept.has(i));
    if (remain.length===0) break;
    remain.sort((i,j)=>scorePair(j)-scorePair(i));
    const pick = remain[0];
    addPair(pick);
  }

  // 3-2) 下限を満たしているか確認。満たしていなければ、残りの中から補強追加（上限はmaxKeepなので超える可能性あり）
  function hasDeficit(){
    for (let r=0;r<9;r++) if (rowCnt[r] < minRow) return true;
    for (let c=0;c<9;c++) if (colCnt[c] < minCol) return true;
    for (let b=0;b<9;b++) if (boxCnt[b] < minBox) return true;
    return false;
  }
  let safety = 0;
  while (hasDeficit() && safety++ < 200){
    const remain = idxs.filter(i=>!kept.has(i));
    if (remain.length===0) break;
    remain.sort((i,j)=>scorePair(j)-scorePair(i));
    addPair(remain[0]);
  }

  // 3-3) 行き過ぎて wantKeep より多くなったら、なるべく影響の小さいペアから削る
  function negativeScore(i){
    // これを外したときの「下限割れリスク」が小さいほど良い
    const p=pairs[i];
    let risk=0;
    if (p.center){
      const {r,c}=p.center, b=boxIndex(r,c);
      if (rowCnt[r] <= minRow) risk+=3;
      if (colCnt[c] <= minCol) risk+=3;
      if (boxCnt[b] <= minBox) risk+=3;
    }else{
      const a=p.a, b=p.b;
      const biA=boxIndex(a.r,a.c), biB=boxIndex(b.r,b.c);
      if (rowCnt[a.r] <= minRow) risk+=1;
      if (colCnt[a.c] <= minCol) risk+=1;
      if (boxCnt[biA] <= minBox) risk+=1;
      if (rowCnt[b.r] <= minRow) risk+=1;
      if (colCnt[b.c] <= minCol) risk+=1;
      if (boxCnt[biB] <= minBox) risk+=1;
    }
    return risk*100 - Math.random();
  }

  while (kept.size > wantKeep){
    const ks = Array.from(kept);
    ks.sort((i,j)=>negativeScore(i)-negativeScore(j));
    removePair(ks[0]);
  }

  // 4) グリッドを作る（重なりは常に0）
  const g = solved.map(r=>r.slice());
  // いったん全部0（重なり含めて）
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) g[r][c]=0;
  for (const i of kept){
    const p=pairs[i];
    if (p.center){
      const {r,c}=p.center; g[r][c] = solved[r][c];
    }else{
      const {a,b}=p; g[a.r][a.c] = solved[a.r][a.c]; g[b.r][b.c] = solved[b.r][b.c];
    }
  }
  // forbid（重なり）は保証として0のまま
  return g;
}

// 重なりセルは常に 0 にそろえる（NO_HINTS_ON_OVERLAP 前提）
function unifyOverlapZeros(puzzles, overlaps){
  if (!NO_HINTS_ON_OVERLAP) return;
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        puzzles[i][r][c] = 0;
        puzzles[j][r2][c2] = 0;
      }
    }
  }
}

// 与えが解答とズレないよう最終クランプ（保険）
function clampPuzzleToSolution(puzzle, solution){
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const v=puzzle[r][c]|0; if(v!==0) puzzle[r][c]=solution[r][c];
  }
}

// 検証：各盤が矛盾なし／重なりは一致（ここでは重なりは両方0）
function validateAll(puzzles, solved, overlaps){
  // 盤内の与え矛盾
  for (const p of puzzles) if (puzzleHasContradiction(p)) return false;
  // 重なり一致
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
        if (a!==b) return false; // いずれも0のはず
      }
    }
  }
  // 与え != 解答の齟齬（与え>0 は解答と同値）
  for (let k=0;k<puzzles.length;k++){
    const p=puzzles[k], s=solved[k];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (p[r][c]!==0 && p[r][c]!==s[r][c]) return false;
    }
  }
  return true;
}

// ---- ハンドラ ----
export const onRequestPost = async ({ request }) => {
  let body = {}; try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const hintBase = HINTS[difficulty] ?? HINTS.normal;
  const minReq  = MIN_PER[difficulty] ?? MIN_PER.normal;

  const nlayout = normalizeLayout(layout);

  for (let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
    // 1) 解答（全盤一括パターン）
    const pattern = makeGlobalPattern();
    const solved = nlayout.map(({ ox, oy }) =>
      Array.from({ length: GRID }, (_, r) =>
        Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
      )
    );

    // 2) 重なり情報と forbid（重なり）マスク
    const { masks: forbidMasks, overlaps } = buildForbidMasks(nlayout);

    // 3) 各盤で「重なり以外のセル数」を見て、全盤共通の targetKeep を決める（バランス重視）
    const allowedCounts = forbidMasks.map(mask=>{
      let cnt=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!mask[r][c]) cnt++;
      return cnt;
    });
    const maxTargetPerBoard = Math.min(...allowedCounts);           // 全盤で実現可能な上限
    const targetKeep = clamp(hintBase, 0, maxTargetPerBoard);       // 全盤同数にする

    // 4) 点対称＆分布下限を満たしつつ、重なりにはヒントを置かないように削る
    let puzzles = solved.map((grid, i) =>
      carveSymmetricWithForbid(grid, targetKeep, forbidMasks[i], minReq.row, minReq.col, minReq.box)
    );

    // 5) 重なりは強制0（安全のためもう一度）
    unifyOverlapZeros(puzzles, overlaps);

    // 6) 与え＝解答の整合性を最終保証
    for (let i=0;i<puzzles.length;i++){
      clampPuzzleToSolution(puzzles[i], solved[i]);
    }

    // 7) 検証：矛盾や不一致があればやり直し
    if (!validateAll(puzzles, solved, overlaps)) continue;

    // 8) 完成
    const boards = nlayout.map((o, idx) => ({
      id: layout[idx].id, x: o.rawx, y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx],
    }));
    return json({ ok:true, puzzle:{ boards } });
  }

  return json({ ok:false, reason:"generator failed to produce a valid puzzle" }, 500);
};
