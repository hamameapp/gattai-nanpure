// Cloudflare Pages Functions: /functions/api/generate.js
// 合体ナンプレ生成API（共有マスは空欄＆唯一解保証＆軽量化）

const GRID = 9;
const CELL_PX = 30;

// 難易度 = 「残すヒント数（多いほど易しい）」の目安
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

/* ========== 基本ユーティリティ ========== */
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  // 1つの完成盤を行/列/数字置換で生成（全盤で共通基盤）
  function makeOrder(){
    const band = shuffle([0,1,2]);
    const order = [];
    for (const b of band){ const inner = shuffle([0,1,2]); for (const k of inner) order.push(b*3+k); }
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
  // y は 3セルにスナップ（箱境界を揃える）
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
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2, c:c2, r2:r, c2:c })) });
    }
  }
  return overlaps;
}

/* ========== 単盤ソルバ（0/1/2解） ========== */
function countSolutions(grid, limit=2){
  // 行/列/箱の使用をビットで管理（bit d = 数字 d 使用、d=1..9）
  const row = new Uint16Array(9), col = new Uint16Array(9), box = new Uint16Array(9);
  const ALL = 0x3FE; // 1..9 のビットが 1

  // 初期与えを反映（衝突があれば 0解）
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=grid[r][c]|0; if (!v) continue;
    const bi=Math.floor(r/3)*3 + Math.floor(c/3), bit=1<<v;
    if ((row[r]&bit) || (col[c]&bit) || (box[bi]&bit)) return 0;
    row[r]|=bit; col[c]|=bit; box[bi]|=bit;
  }

  const empties=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) empties.push([r,c]);

  const popcnt=x=>{ let y=x-(x>>>1&0x55555555); y=(y&0x33333333)+(y>>>2&0x33333333); return ((y+(y>>>4)&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz=x=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };
  const domain=(r,c)=> {
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    return ALL ^ (row[r] | col[c] | box[bi]); // 許可ビット
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
      const d = ctz(m); m &= m-1;
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

/* ========== 唯一性を保ちながら削る（共有マスは必ず空欄） ========== */
function carveUniqueWithRequiredBlanks(solved, requireZeroSet, targetHints){
  // solved: 9x9 解
  // requireZeroSet: Set('r,c') 形式で「必ず空欄にするセル」
  // targetHints: 目標の残すヒント数（到達できなくても唯一解ならOK）
  const g = solved.map(r=>r.slice());

  // 1) 共有マスを「一つずつ」空欄にし、その都度 唯一性をチェック
  //    （ここで唯一性が壊れるなら、この完成盤では無理 → null）
  const reqCells = Array.from(requireZeroSet).map(s=>s.split(',').map(n=>parseInt(n,10)));
  // 固定順だと偏るのでシャッフル
  shuffle(reqCells);
  for (const [r,c] of reqCells){
    if (g[r][c]===0) continue; // 既に空ならスキップ
    const keep = g[r][c];
    g[r][c]=0;
    if (countSolutions(g,2) !== 1){
      // このセルを空けると唯一性が壊れる → 失敗
      return null;
    }
    // 成功ならそのまま続行
  }

  // 2) 残りのセルから「点対称優先」で削る（共有マスは候補から除外）
  const target = Math.max(17, Math.min(81, targetHints|0 || 34));
  let hints = 0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) hints++;

  // 点対称のペア
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    // 共有マスに関わるセルは除外（すでに空欄になっている想定）
    if (requireZeroSet.has(`${r},${c}`) || requireZeroSet.has(`${or},${oc}`)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);

  for (const [r,c,or,oc] of pairs){
    if (hints <= target) break;
    if (!g[r][c] && !g[or][oc]) continue;
    const k1=g[r][c], k2=g[or][oc];
    g[r][c]=0; g[or][oc]=0;
    if (countSolutions(g,2) === 1){
      hints -= (r===or && c===oc) ? 1 : 2;
    }else{
      g[r][c]=k1; g[or][oc]=k2;
    }
  }

  // 3) 微調整（単点）。共有マスは除外。
  if (hints > target){
    const singles=[];
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (g[r][c] && !requireZeroSet.has(`${r},${c}`)) singles.push([r,c]);
    }
    shuffle(singles);
    for (const [r,c] of singles){
      if (hints <= target) break;
      const k=g[r][c]; g[r][c]=0;
      if (countSolutions(g,2) === 1) hints--; else g[r][c]=k;
    }
  }

  // 念のため最終唯一性チェック
  if (countSolutions(g,2) !== 1) return null;
  return g;
}

/* ========== 形式検証（保険） ========== */
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

/* ========== ハンドラ ========== */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定: 共有マスは空欄にする

  if (layout.length===0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 盤数に応じて試行上限を調整（多いほど少なめに）
  const B = nlayout.length;
  const MAX_ATTEMPTS =
    B <= 4  ? 30 :
    B <= 8  ? 16 :
    B <= 16 ? 10 :
              6;

  // 共有マス → 各盤ごとの「必ず空欄」集合を作る
  const requiredZeroSets = Array.from({length:B}, ()=> new Set());
  if (overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        const j=e.j;
        for (const {r,c,r2,c2} of e.cells){
          requiredZeroSets[i].add(`${r},${c}`);
          requiredZeroSets[j].add(`${r2},${c2}`);
        }
      }
    }
  }

  for (let attempt=0; attempt<MAX_ATTEMPTS; attempt++){
    const pattern = makeGlobalPattern();

    // 同一完成盤
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

    // 共有マスを必ず空けつつ、唯一解を維持して削る
    const puzzles = new Array(B);
    let failed=false;
    for (let b=0;b<B;b++){
      const req = requiredZeroSets[b];
      const puz = carveUniqueWithRequiredBlanks(solved[b], req, hintTarget);
      if (!puz){ failed=true; break; }
      // 保険（通常は不要）
      if (puzzleHasContradiction(puz)){ failed=true; break; }
      if (countSolutions(puz,2)!==1){ failed=true; break; }
      puzzles[b]=puz;
    }
    if (failed) continue;

    // 共有マスが与えで食い違っていないか（共有を空欄にしない運用の場合のみ）
    if (!overlapEmpty){
      outer:
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b!==0 && a!==b){ failed=true; break outer; }
          }
        }
      }
      if (failed) continue;
    }

    // 成功
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
