// functions/api/generate.js
// 合体ナンプレ生成API（軽量版）
// ・共有マスは既定で空欄（overlapEmpty=true）
// ・各盤を「個別に唯一解」に削る → 合体も一意（同一グローバル完成盤に基づくため）
// ・Cloudflare Workers の CPU 制限を踏まえ、重い「合体ソルバ」は使用しない

const GRID = 9;
const CELL_PX = 30;

// 難易度 = 残すヒント数（大きいほど易しい）
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

/* ------------------ ユーティリティ ------------------ */
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  // 完成盤を行/列/数字の置換で作る（同一パターンを全盤で参照）
  function makeOrder(){
    const band = shuffle([0,1,2]);
    const order = [];
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
    const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
}

function normalizeLayout(layout){
  // y は 3 セルにスナップ（箱境界を合わせる）
  return layout.map(o=>{
    const rawx = Number(o.x)||0, rawy = Number(o.y)||0;
    const ox = Math.round(rawx / CELL_PX);
    let oy = Math.round(rawy / CELL_PX); oy -= oy % 3;
    return { id:String(o.id), ox, oy, rawx, rawy };
  });
}

function buildOverlaps(nlayout){
  const n = nlayout.length;
  const overlaps = Array.from({length:n},()=>[]);
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
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
    }
  }
  return overlaps;
}

/* ------------------ 単盤ソルバ（0/1/2 解） ------------------ */
function countSolutions(grid, limit=2){
  // 行/列/箱の使用状況をビットで管理（bit d = 数字 d 使用）
  const row = new Uint16Array(9), col = new Uint16Array(9), box = new Uint16Array(9);
  const ALL = 0x3FE; // 1..9 が 1 のマスク

  // 初期与えを反映（衝突があれば 0 解）
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v = grid[r][c]|0; if (!v) continue;
    const bi = Math.floor(r/3)*3 + Math.floor(c/3), bit = 1<<v;
    if ((row[r]&bit) || (col[c]&bit) || (box[bi]&bit)) return 0;
    row[r] |= bit; col[c] |= bit; box[bi] |= bit;
  }

  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) empties.push([r,c]);

  const popcnt=x=>{ let y=x-(x>>>1&0x55555555); y=(y&0x33333333)+(y>>>2&0x33333333); return ((y+(y>>>4)&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz=x=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };

  const domain=(r,c)=>{
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    return ALL ^ (row[r] | col[c] | box[bi]);
  };

  // MRV 並べ替え
  empties.sort((a,b)=> popcnt(domain(a[0],a[1])) - popcnt(domain(b[0],b[1])) );

  let sol=0;
  (function dfs(k){
    if (sol>=limit) return;
    if (k===empties.length){ sol++; return; }
    const [r,c]=empties[k], bi=Math.floor(r/3)*3 + Math.floor(c/3);
    let m = domain(r,c); if (!m) return;
    while(m){
      const d = ctz(m); m &= m-1; // 最下位ビット取り出し
      const bit = 1<<d;
      if (!(row[r]&bit) && !(col[c]&bit) && !(box[bi]&bit)){
        row[r]|=bit; col[c]|=bit; box[bi]|=bit;
        dfs(k+1);
        row[r]&=~bit; col[c]&=~bit; box[bi]&=~bit;
      }
      if (sol>=limit) return;
    }
  })(0);

  return Math.min(sol, limit);
}

/* ------------------ 唯一解を保ちながら削る ------------------ */
function carveUniqueFromSolved(solved, targetHints, forbidMask=null){
  // forbidMask[r][c] が true のマスは常に空欄にする
  const g = solved.map(r=>r.slice());

  // forbid 先行で空ける
  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (forbidMask[r][c]) g[r][c]=0;
  }

  const target = Math.max(17, Math.min(81, targetHints));
  let hints=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) hints++;

  // 点対称ペアで削る（見た目を整えつつ、常に唯一性チェック）
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);

  for (const [r,c,or,oc] of pairs){
    if (hints<=target) break;
    if ((forbidMask && (forbidMask[r]?.[c] || forbidMask[or]?.[oc]))) continue;
    if (!g[r][c] && !g[or][oc]) continue;

    const keep1=g[r][c], keep2=g[or][oc];
    g[r][c]=0; g[or][oc]=0;

    if (countSolutions(g,2)===1){
      hints -= (r===or && c===oc) ? 1 : 2;
    }else{
      g[r][c]=keep1; g[or][oc]=keep2;
    }
  }

  // まだ多ければ単点で微調整
  if (hints>target){
    const singles=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c] && !(forbidMask && forbidMask[r]?.[c])) singles.push([r,c]);
    }
    shuffle(singles);
    for (const [r,c] of singles){
      if (hints<=target) break;
      const k=g[r][c]; g[r][c]=0;
      if (countSolutions(g,2)===1) hints--; else g[r][c]=k;
    }
  }

  return g;
}

/* ------------------ 形式検証（保険） ------------------ */
function puzzleHasContradiction(p){
  // 行
  for (let r=0;r<9;r++){
    const seen=new Set();
    for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; if(seen.has(v)) return true; seen.add(v); }
  }
  // 列
  for (let c=0;c<9;c++){
    const seen=new Set();
    for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; if(seen.has(v)) return true; seen.add(v); }
  }
  // 箱
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    const seen=new Set();
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; if(seen.has(v)) return true; seen.add(v);
    }
  }
  return false;
}

/* ------------------ ハンドラ ------------------ */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定: 共有マスは空欄にする

  if (layout.length===0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 共有マス forbid マスクを作成
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

  // 盤が多いほど計算量が増えるので、試行回数は控えめに
  const B = nlayout.length;
  const MAX_ATTEMPTS =
    B >= 24 ? 3 :
    B >= 12 ? 4 :
    6;

  for (let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
    const pattern = makeGlobalPattern();

    // 同一完成盤から各盤の完成形を取得
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

    // 各盤を「唯一解」を保ちつつ目標ヒント数まで削る（共有マスは空欄維持）
    const puzzles = solved.map((sol, idx)=> carveUniqueFromSolved(sol, hintTarget, forbids[idx]));

    // 与え矛盾の保険（通常は起きない）
    let bad = false;
    for (const p of puzzles){ if (puzzleHasContradiction(p)) { bad=true; break; } }
    if (bad) continue;

    // 共有マスも、どちらも与えになっている場合は一致しているか（overlapEmpty=false の時のみ）
    if (!overlapEmpty){
      for (let i=0;i<overlaps.length && !bad;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ bad=true; break; }
          }
          if (bad) break;
        }
      }
      if (bad) continue;
    }

    // OK
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
