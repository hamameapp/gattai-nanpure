// Cloudflare Pages Functions: /functions/api/generate.js
// 置き換え可（唯一解保証＋重なり整合＋難易度＝残すヒント数）

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

/* --------------------- 基本ユーティリティ --------------------- */
function shuffle(a) { for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  // 1つの完成盤を行/列/数字の置換で生成
  function makeOrder(){
    const bandOrder = shuffle([0,1,2]);
    const order = [];
    for (const b of bandOrder){
      const inner = shuffle([0,1,2]);
      for (const k of inner) order.push(b*3+k);
    }
    return order;
  }
  const rowOrder   = makeOrder();
  const colOrder   = makeOrder();
  const digitPerm  = shuffle([1,2,3,4,5,6,7,8,9]);
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;

  function valueAt(R, C){
    const r = rowOrder[((R%9)+9)%9];
    const c = colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
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
  const n = nlayout.length;
  const overlaps = Array.from({length:n}, ()=>[]);
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
      // 逆向きも登録
      overlaps[j].push({
        j: i,
        cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c }))
      });
    }
  }
  return overlaps;
}

/* --------------------- 単盤ソルバ（0/1/2 解） --------------------- */
function countSolutions(grid, limit=2){
  // ビットセットの簡易バックトラック（行/列/箱の使用を 1bit で持つ）
  const ROW = Array.from({length:9}, ()=> new Uint16Array(9));
  const COL = Array.from({length:9}, ()=> new Uint16Array(9));
  const BOX = Array.from({length:9}, ()=> new Uint16Array(9));
  const BIT = d => 1<<d;
  const ALL = 0x3FE; // 1..9

  // 初期与えの矛盾チェックとセット
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=grid[r][c]|0; if (!v) continue;
    const bi = Math.floor(r/3)*3 + Math.floor(c/3);
    if (ROW[r][v-1] || COL[c][v-1] || BOX[bi][v-1]) return 0;
    ROW[r][v-1]=1; COL[c][v-1]=1; BOX[bi][v-1]=1;
  }

  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) empties.push([r,c]);

  function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
  function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }

  function domainMask(r,c){
    const bi=Math.floor(r/3)*3+Math.floor(c/3);
    let mask = ALL;
    for (let d=1; d<=9; d++){
      if (ROW[r][d-1] || COL[c][d-1] || BOX[bi][d-1]) mask &= ~(1<<d);
    }
    return mask;
  }

  // MRV で並べ替え
  empties.sort((a,b)=>{
    const da=popcnt(domainMask(a[0],a[1]));
    const db=popcnt(domainMask(b[0],b[1]));
    return da-db;
  });

  let solutions=0;
  (function dfs(k){
    if (solutions>=limit) return;
    if (k===empties.length){ solutions++; return; }

    const [r,c]=empties[k];
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    let mask = domainMask(r,c); if (!mask) return;

    while(mask){
      const d = ctz(mask); mask &= mask-1;
      const bit = 1<<d;
      if (!ROW[r][d-1] && !COL[c][d-1] && !BOX[bi][d-1]){
        ROW[r][d-1]=1; COL[c][d-1]=1; BOX[bi][d-1]=1;
        dfs(k+1);
        ROW[r][d-1]=0; COL[c][d-1]=0; BOX[bi][d-1]=0;
        if (solutions>=limit) return;
      }
    }
  })(0);

  return Math.min(solutions, limit);
}

/* --------------------- 削り：唯一解を保って削る --------------------- */
function carveUniqueFromSolved(solved, targetHints, forbidMask=null){
  // forbidMask[r][c] === true は必ず空欄（与えにしない）
  const g = solved.map(r=>r.slice());

  // forbid を先に空ける
  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (forbidMask[r][c]) g[r][c]=0;
    }
  }

  const target = Math.max(17, Math.min(81, targetHints));
  let currentHints = 0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) currentHints++;

  // 点対称ペアを作る
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);

  // ペアごとに試し削り（唯一解なら採用）
  for (const [r,c,or,oc] of pairs){
    if (currentHints<=target) break;

    // 既に空 or forbid はスキップ
    if (!g[r][c] && !g[or][oc]) continue;
    if ((forbidMask && (forbidMask[r]?.[c])) || (forbidMask && (forbidMask[or]?.[oc]))) continue;

    const keep1=g[r][c], keep2=g[or][oc];
    g[r][c]=0; g[or][oc]=0;

    if (countSolutions(g,2) === 1){
      currentHints -= (r===or && c===oc) ? 1 : 2;
    }else{
      g[r][c]=keep1; g[or][oc]=keep2;
    }
  }

  // まだ多ければ単点で微調整
  if (currentHints > target){
    const singles=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c] && !(forbidMask && forbidMask[r]?.[c])) singles.push([r,c]);
    }
    shuffle(singles);
    for (const [r,c] of singles){
      if (currentHints<=target) break;
      const k=g[r][c]; g[r][c]=0;
      if (countSolutions(g,2)===1) currentHints--; else g[r][c]=k;
    }
  }

  return g;
}

/* --------------------- 検証（与え矛盾・共有矛盾） --------------------- */
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
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true（共有マスは空欄）

  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 何度かトライ（運悪く唯一解が作れない配置もあるため）
  for (let attempt=0; attempt<40; attempt++){
    const pattern = makeGlobalPattern();

    // 解（重なり整合）
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

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

    // 各盤：唯一解になるように削る
    const puzzles = solved.map((sol, idx)=> carveUniqueFromSolved(sol, hintTarget, forbids[idx]));

    // ---- 検証 ----
    // A) 与え矛盾がないか
    let bad=false;
    for (const p of puzzles){ if (puzzleHasContradiction(p)) { bad=true; break; } }
    if (bad) continue;

    // B) 共有マスの矛盾がないか（どちらも与えなら一致しているか）
    if (!overlapEmpty && !bad){
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ bad=true; break; }
          }
          if (bad) break;
        }
        if (bad) break;
      }
    }
    if (bad) continue;

    // C) 各盤が唯一解（= 1解）
    for (let i=0;i<puzzles.length;i++){
      const cnt = countSolutions(puzzles[i], 2);
      if (cnt !== 1){ bad=true; break; }
    }
    if (bad) continue;

    // ここまで通れば OK
    const boards = nlayout.map((o, idx)=>({
      id: layout[idx].id,             // 元の id を維持
      x: o.rawx, y: o.rawy,           // 表示座標（ピクセル）
      grid: puzzles[idx],             // 問題
      solution: solved[idx],          // 正解
    }));

    return json({ ok:true, puzzle:{ boards } });
  }

  return json({ ok:false, reason:"failed to generate unique puzzles" }, 500);
};
