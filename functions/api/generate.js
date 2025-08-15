// functions/api/generate.js
// 目的: 生成される各盤面が「少なくとも一意解」になるようにする
// 方針:
// 1) グローバル周期パターンから完全解(solved)を作成
// 2) 手がかり数（難易度）に合わせて穴あけ
// 3) 盤の重なり(共有マス)に対して与えを統一/整合
// 4) ★各盤に対して「解が1つになるまで」最小限の与えを追加（solutionの該当値を戻す）
//    - 追加する際は共有マスにも同じ値を伝播
// 5) 検証（行/列/箱矛盾と共有矛盾）に通ったら返す
//
// 備考:
// - レイアウト全体(合体全体)の“グローバル唯一性”までは保証しません（要件は「1つの盤面でも重解が出ない」）。
//   必要なら Combined 一意性チェッカーも追加可能です（重くなるため省略）。
// - 大規模盤数(例: 40)では計算時間制限のため、唯一性強制は最大 MAX_UNI_BOARDS 枚まで（下記定数）。

const GRID = 9;
const CELL_PX = 30;
const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 30, expert: 28, extreme: 26 };

// 唯一性強制の対象とする最大枚数（多すぎると時間超過の恐れ）
const MAX_UNI_BOARDS = 4;

// 生成試行回数
const MAX_ATTEMPTS = 30;

// 生成処理の全体タイムバジェット（ms）
const DEFAULT_GEN_TIMEOUT_MS = 3500;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/* ---------- ユーティリティ ---------- */
function now() { return Date.now(); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
function cloneGrid(g){ return g.map(r=>r.slice()); }

/* 周期ベース完全解ジェネレータ（高速・一様ランダムで十分） */
function makeGlobalPattern(){
  function makeOrder(){
    const bandOrder = shuffle([0,1,2]);
    const order = [];
    for (const b of bandOrder){
      const inner = shuffle([0,1,2]);
      for (const k of inner) order.push(b*3 + k);
    }
    return order;
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

/* 対称穴あけ（目標ヒント数まで） */
function carveBoard(solved, hintTarget){
  const g = solved.map(r=>r.slice());
  const cells = [...Array(81).keys()];
  shuffle(cells);
  let toRemove = Math.max(0, 81 - hintTarget);
  for (const idx of cells){
    if (toRemove <= 0) break;
    const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
    if (g[r][c]===0 && g[or][oc]===0) continue;
    g[r][c]=0; g[or][oc]=0;
    toRemove -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

/* レイアウト正規化（Yは3セル単位） */
function normalizeLayout(layout){
  return layout.map(o=>{
    const ox = Math.round((Number(o.x)||0)/CELL_PX);
    let oy  = Math.round((Number(o.y)||0)/CELL_PX);
    oy -= oy % 3;
    return {
      id: String(o.id),
      ox, oy,
      rawx: Number(o.x)||0,
      rawy: Number(o.y)||0
    };
  });
}

/* 重なり構築：i<->j で共有セルのペア一覧を持つ */
function buildOverlaps(nlayout){
  const n=nlayout.length;
  const overlaps = Array.from({length:n},()=>[]);
  for (let i=0;i<n;i++){
    for (let j=i+1;j<n;j++){
      const A=nlayout[i], B=nlayout[j];
      const R0=Math.max(0, B.oy-A.oy), C0=Math.max(0, B.ox-A.ox);
      const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
      if (R0<=R1 && C0<=C1){
        const cells=[];
        for (let r=R0;r<=R1;r++){
          for (let c=C0;c<=C1;c++){
            const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
            cells.push({ r,c,r2,c2 });
          }
        }
        overlaps[i].push({ j, cells });
        // 逆方向（インデックス差し替え）
        overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
      }
    }
  }
  return overlaps;
}

/* 与え矛盾（行/列/箱）チェック */
function puzzleHasContradiction(p){
  // 行
  for (let r=0;r<9;r++){
    const seen=new Set();
    for (let c=0;c<9;c++){
      const v=p[r][c]|0; if (!v) continue;
      if (seen.has(v)) return true;
      seen.add(v);
    }
  }
  // 列
  for (let c=0;c<9;c++){
    const seen=new Set();
    for (let r=0;r<9;r++){
      const v=p[r][c]|0; if (!v) continue;
      if (seen.has(v)) return true;
      seen.add(v);
    }
  }
  // 箱
  for (let br=0;br<9;br+=3){
    for (let bc=0;bc<9;bc+=3){
      const seen=new Set();
      for (let dr=0;dr<3;dr++){
        for (let dc=0;dc<3;dc++){
          const v=p[br+dr][bc+dc]|0; if (!v) continue;
          if (seen.has(v)) return true;
          seen.add(v);
        }
      }
    }
  }
  return false;
}

/* 与えのクランプ：与え!=0のマスは必ず solution の値に合わせる */
function clampPuzzleToSolution(puzzle, solution){
  for (let r=0;r<9;r++){
    for (let c=0;c<9;c++){
      const v=puzzle[r][c]|0;
      if (v!==0) puzzle[r][c] = solution[r][c];
    }
  }
}

/* 与えの統一（共有マスで片方だけ与えがある場合、もう片方にコピー） */
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

/* 与えがどちらかにあるなら両方を「解の値」で固定（与えの整合を強化） */
function enforceOverlapBySolution(puzzles, solved, overlaps){
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const sVal = solved[i][r][c];
        if (puzzles[i][r][c]!==0 || puzzles[j][r2][c2]!==0){
          puzzles[i][r][c]=sVal; puzzles[j][r2][c2]=sVal;
        }
      }
    }
  }
}

/* パズル群の総合バリデーション（与え矛盾＋共有矛盾） */
function validateAll(puzzles, overlaps){
  for (const p of puzzles){
    if (puzzleHasContradiction(p)) return { ok:false, reason:'row/col/box contradiction' };
  }
  // 共有矛盾
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
        if (a!==0 && b!==0 && a!==b) return { ok:false, reason:'overlap mismatch' };
      }
    }
  }
  return { ok:true };
}

/* ---------- 標準数独: 高速ソルバ（解数カウント） ---------- */
/** 盤 p(9x9, 0=空) の解の個数を limit を上限に数える（limit超えたら limit を返す） */
function countSolutionsBoard(p, limit=2){
  // マスク初期化
  const ROW = new Uint16Array(9);
  const COL = new Uint16Array(9);
  const BOX = new Uint16Array(9);
  const BIT = d => 1<<d;  // 1..9 -> 2..512
  const ALL = 0x3FE;

  const empties = [];
  for (let r=0;r<9;r++){
    for (let c=0;c<9;c++){
      const v=p[r][c]|0;
      if (v){
        const bi=Math.floor(r/3)*3 + Math.floor(c/3);
        const bit = BIT(v);
        if (ROW[r]&bit || COL[c]&bit || BOX[bi]&bit) return 0; // 与え衝突
        ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
      }else{
        empties.push([r,c]);
      }
    }
  }

  // MRV: 毎回小さいドメインから
  function domainMask(r,c){
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    const forbid = ROW[r] | COL[c] | BOX[bi];
    return (ALL ^ forbid);
  }

  let solutions = 0;
  function dfs(){
    if (solutions >= limit) return;
    // 未確定セルの中で候補が最少のものを探す
    let best=-1, bestMask=0, bestPop=10;
    for (let i=0;i<empties.length;i++){
      const [r,c]=empties[i];
      if (p[r][c]!==0) continue; // すでに仮置きで埋まっている
      const mask = domainMask(r,c);
      const pc = popcnt(mask);
      if (pc===0) return; // 行き止まり
      if (pc < bestPop){ best=i; bestMask=mask; bestPop=pc; if (pc===1) break; }
    }
    if (best===-1){ solutions++; return; }

    const [r,c] = empties[best];
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);

    // 候補を小さい数から
    let mask = bestMask;
    while(mask){
      const v = ctz(mask); mask &= (mask-1);
      const bit = 1<<v;
      // 置く
      p[r][c]=v; ROW[r]|=bit; COL[c]|=bit; BOX[bi]|=bit;
      dfs();
      // 戻す
      ROW[r]&=~bit; COL[c]&=~bit; BOX[bi]&=~bit; p[r][c]=0;
      if (solutions >= limit) return;
    }
  }

  dfs();
  return Math.min(solutions, limit);

  function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
  function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }
}

/* 共有位置にも伝播する安全な与え追加 */
function applyGiven(puzzles, i, r, c, val, overlaps){
  if (puzzles[i][r][c] === val) return;
  puzzles[i][r][c] = val;
  // 共有先にも同値を書き込む
  for (const e of overlaps[i]){
    if (e && e.cells){
      for (const {r:rr,c:cc,r2,c2} of e.cells){
        if (rr===r && cc===c){
          puzzles[e.j][r2][c2] = val;
        }
      }
    }
  }
}

/* 各盤の唯一性を強制（solutionをヒントとして段階的に追加） */
function enforcePerBoardUniqueness(puzzles, solved, overlaps, deadlineMs){
  const n = puzzles.length;
  const target = Math.min(n, MAX_UNI_BOARDS);
  for (let i=0;i<target;i++){
    // まず現在の与えで解数を数える
    let count = countSolutionsBoard(puzzles[i], 2);
    if (count === 1) continue; // 既に一意

    // 0または2以上の場合、solution からヒントを追加して一意化
    // 候補: まだ 0 のセルの中からランダムに選んで追加
    const blanks = [];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if ((puzzles[i][r][c]|0)===0) blanks.push([r,c]);
    shuffle(blanks);

    for (const [r,c] of blanks){
      if (now() > deadlineMs) return false; // タイムアウト
      const val = solved[i][r][c] | 0;
      if (!val) continue;
      applyGiven(puzzles, i, r, c, val, overlaps);

      // 共有に書き込んだので、クランプ＆共有整合も再度行う
      clampPuzzleToSolution(puzzles[i], solved[i]);
      unifyGivenCells(puzzles, overlaps);
      enforceOverlapBySolution(puzzles, solved, overlaps);

      const vAll = validateAll(puzzles, overlaps);
      if (!vAll.ok) continue; // このヒント追加は無効（別のセルを試す）

      count = countSolutionsBoard(puzzles[i], 2);
      if (count === 1) break; // 一意化できた
    }

    // それでも一意にならない場合は失敗
    if (count !== 1) return false;
  }
  return true;
}

/* ---------- エンドポイント ---------- */
export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTargetBase = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // タイムバジェット（ms）
  const BUDGET = Number(env?.GEN_TIMEOUT_MS)||DEFAULT_GEN_TIMEOUT_MS;
  const deadline = now() + Math.max(1000, BUDGET);

  for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++){
    if (now() > deadline) break;

    // 1) 完全解
    const pattern = makeGlobalPattern();
    const solved = nlayout.map(({ ox, oy }) =>
      Array.from({ length: GRID }, (_, r) =>
        Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
      )
    );

    // 2) 穴あけ（難易度調整：リトライで少しヒント数を増やして収束性UP）
    const hintTarget = Math.min(81, hintTargetBase + Math.floor((attempt-1)/10)*2);
    let puzzles = solved.map(g => carveBoard(g, hintTarget));

    // 3) 共有整合（与えの統一＋与えがあれば solution で固定）
    unifyGivenCells(puzzles, overlaps);
    enforceOverlapBySolution(puzzles, solved, overlaps);
    for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);

    // 4) バリデーション（与え矛盾／共有矛盾）
    let valid = validateAll(puzzles, overlaps);
    if (!valid.ok) continue;

    // 5) ★各盤の唯一性を強制（大規模時は先頭 MAX_UNI_BOARDS 枚のみ）
    if (!enforcePerBoardUniqueness(puzzles, solved, overlaps, deadline)) continue;

    // 6) 最終バリデーション
    valid = validateAll(puzzles, overlaps);
    if (!valid.ok) continue;

    // OK
    const boards = nlayout.map((o, idx) => ({
      id: layout[idx].id,
      x: o.rawx,
      y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx]
    }));
    return json({ ok:true, puzzle:{ boards } });
  }

  return json({ ok:false, reason:"generator failed to produce a unique puzzle within time budget" }, 500);
}
