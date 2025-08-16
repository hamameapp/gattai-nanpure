// functions/api/generate.js
// 合体ナンプレ生成API（Cloudflare Pages Functions）
// ・共有マスは既定で空欄
// ・全体（合体）の唯一性を保証（複数解なら自動修復）
// ・難易度＝残すヒント数
// そのまま置き換え可

const GRID = 9;
const CELL_PX = 30;

// 難易度ごとの目標ヒント数（大きいほど易しい）
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

/* ========== ユーティリティ ========== */
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function makeGlobalPattern(){
  // 完成盤パターン（行/列/数字の置換）
  function makeOrder(){
    const band = shuffle([0,1,2]); const o=[];
    for (const b of band){ const inner = shuffle([0,1,2]); for (const k of inner) o.push(b*3+k); }
    return o;
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
  return layout.map(o=>{
    const rawx=Number(o.x)||0, rawy=Number(o.y)||0;
    const ox=Math.round(rawx/CELL_PX);
    let oy=Math.round(rawy/CELL_PX); oy -= oy%3; // 箱合わせ
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
      overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2,c:c2,r2:r,c2:c })) });
    }
  }
  return overlaps;
}

/* ========== 単盤の解数カウント（0/1/2） ========== */
function countSolutions(grid, limit=2){
  const ROW = Array.from({length:9}, ()=> new Uint16Array(9));
  const COL = Array.from({length:9}, ()=> new Uint16Array(9));
  const BOX = Array.from({length:9}, ()=> new Uint16Array(9));
  const ALL = 0x3FE; // 1..9
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v=grid[r][c]|0; if (!v) continue;
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    if (ROW[r][v-1] || COL[c][v-1] || BOX[bi][v-1]) return 0;
    ROW[r][v-1]=COL[c][v-1]=BOX[bi][v-1]=1;
  }
  const empties=[]; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if(!grid[r][c]) empties.push([r,c]);
  const popcnt=x=>{ let y=x-(x>>>1&0x55555555); y=(y&0x33333333)+(y>>>2&0x33333333); return ((y+(y>>>4)&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz=x=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };
  const domain=(r,c)=>{ const bi=Math.floor(r/3)*3+Math.floor(c/3); let m=ALL;
    for (let d=1; d<=9; d++){ if (ROW[r][d-1]||COL[c][d-1]||BOX[bi][d-1]) m&=~(1<<d); } return m;
  };
  empties.sort((a,b)=>popcnt(domain(a[0],a[1]))-popcnt(domain(b[0],b[1])));
  let sol=0;
  (function dfs(k){
    if (sol>=limit) return;
    if (k===empties.length){ sol++; return; }
    const [r,c]=empties[k], bi=Math.floor(r/3)*3+Math.floor(c/3);
    let m=domain(r,c); if(!m) return;
    while(m){
      const d=ctz(m); m&=m-1; const bit=d-1;
      if(!ROW[r][bit] && !COL[c][bit] && !BOX[bi][bit]){
        ROW[r][bit]=COL[c][bit]=BOX[bi][bit]=1;
        dfs(k+1);
        ROW[r][bit]=COL[c][bit]=BOX[bi][bit]=0;
      }
      if (sol>=limit) return;
    }
  })(0);
  return Math.min(sol,limit);
}

/* ========== 合体（共有制約込み）解数カウント（0/1/2） ========== */
function countSolutionsCombined(puzzles){
  const B = puzzles.length;
  const idOf = (b,r,c)=> b*81 + r*9 + c;

  // Union-Find（共有セルを同一変数に）
  const N = B*81;
  const parent = new Int32Array(N); for (let i=0;i<N;i++) parent[i]=i;
  const find=x=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const unite=(a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

  // 共有検出（盤の配置は不要：ここでは値の等価のみ扱うので呼び出し側で済ませる）
  // 呼び出し側で overlaps を持っているので、ここでは puzzles に対して均一等価は行わない
  // → 呼び出し時に unite を渡す形にするのが簡単だが、今回は内部で構築し直す

  // ※ ここでは「共有は同じ位置にある」と仮定しない。呼び出しで overlaps を渡す版を下で用意。
  throw new Error("countSolutionsCombined needs overlaps; use countSolutionsCombinedWithOverlaps");
}

function countSolutionsCombinedWithOverlaps(puzzles, overlaps){
  const B = puzzles.length;
  const idOf = (b,r,c)=> b*81 + r*9 + c;
  const N = B*81;
  const parent = new Int32Array(N); for (let i=0;i<N;i++) parent[i]=i;
  const find=x=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const unite=(a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

  // 等価クラスを構築
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        unite(idOf(i,r,c), idOf(j,r2,c2));
      }
    }
  }

  // 変数クラス
  const classes = new Map(); // root -> [{b,r,c}]
  for (let b=0;b<B;b++) for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const root=find(idOf(b,r,c));
    const arr = classes.get(root) || [];
    arr.push({b,r,c});
    classes.set(root, arr);
  }
  const vars = Array.from(classes.values());

  // 盤ごとの使用マスク（行/列/箱）
  const ROW = Array.from({length:B}, ()=> new Uint16Array(9));
  const COL = Array.from({length:B}, ()=> new Uint16Array(9));
  const BOX = Array.from({length:B}, ()=> new Uint16Array(9));
  const ALL = 0x3FE;

  // 与えの反映＆矛盾チェック
  const fixed = new Map(); // varIndex -> value(1..9)
  for (let vi=0; vi<vars.length; vi++){
    let forced = 0;
    for (const {b,r,c} of vars[vi]){
      const v = puzzles[b][r][c]|0;
      if (v){
        if (forced===0) forced=v;
        else if (forced!==v) return 0; // 同一変数に矛盾
      }
    }
    if (forced){
      fixed.set(vi, forced);
      for (const {b,r,c} of vars[vi]){
        const bi=Math.floor(r/3)*3 + Math.floor(c/3);
        const bit=forced-1;
        if (ROW[b][bit] && ROW[b][bit] && COL[b][bit]){} // no-op
        if (ROW[b][r] && ROW[b][r][bit]){} // 旧実装の名残対策
        if (ROW[b][r] || 0){} // nothing
        if (ROW[b][r] && ROW[b][r][bit]){} // nothing
      }
    }
  }
  // ↑ 上は最小限だけ残して、実際の更新は下の関数内で一括で行う

  // 行/列/箱ビット更新の安全関数
  const setBit = (b,r,c,val, on) => {
    const bi=Math.floor(r/3)*3 + Math.floor(c/3);
    const bit = val-1;
    if (on){
      if (ROW[b][r]&(1<<val) || COL[b][c]&(1<<val) || BOX[b][bi]&(1<<val)) return false;
      ROW[b][r] |= (1<<val); COL[b][c] |= (1<<val); BOX[b][bi] |= (1<<val);
      return true;
    }else{
      ROW[b][r] &= ~(1<<val); COL[b][c] &= ~(1<<val); BOX[b][bi] &= ~(1<<val);
      return true;
    }
  };

  // まず与えを反映
  for (let b=0;b<B;b++){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      const v = puzzles[b][r][c]|0; if (!v) continue;
      if (!setBit(b,r,c,v,true)) return 0; // 盤内衝突
    }
  }

  // 未確定変数の並び替え（MRV）

  const popcnt=x=>{ let y=x-(x>>>1&0x55555555); y=(y&0x33333333)+(y>>>2&0x33333333); return ((y+(y>>>4)&0x0F0F0F0F)*0x01010101)>>>24; };
  const ctz=x=>{ let n=0; while(((x>>>n)&1)===0) n++; return n; };

  function domainMask(vi){
    let mask = ALL;
    for (const {b,r,c} of vars[vi]){
      const bi=Math.floor(r/3)*3 + Math.floor(c/3);
      const forbid = ROW[b][r] | COL[b][c] | BOX[b][bi];
      mask &= (ALL ^ forbid);
      if (!mask) break;
    }
    return mask;
  }

  const order=[];
  for (let i=0;i<vars.length;i++){
    // すでに与えで固定済みならスキップ
    let forced=0;
    for (const {b,r,c} of vars[i]){ const v=puzzles[b][r][c]|0; if (v){ forced=v; break; } }
    if (!forced) order.push(i);
  }
  order.sort((a,b)=> popcnt(domainMask(a)) - popcnt(domainMask(b)));

  let solutions=0;
  const LIMIT = 250000;

  (function dfs(k, nodes=0){
    if (solutions>=2 || nodes>LIMIT) return;
    if (k===order.length){ solutions++; return; }

    const vi = order[k];
    let mask = domainMask(vi); if (!mask) return;

    while(mask){
      const d = ctz(mask); mask &= mask-1;
      const v = d; // 1..9

      // 置いてみる
      const touched=[];
      let ok=true;
      for (const {b,r,c} of vars[vi]){
        if (!setBit(b,r,c,v,true)){ ok=false; break; }
        touched.push({b,r,c});
      }
      if (ok){
        dfs(k+1, nodes+1);
      }
      // 戻す
      for (const {b,r,c} of touched){
        setBit(b,r,c,v,false);
      }
      if (solutions>=2) return;
    }
  })(0);

  return Math.min(solutions,2);
}

/* ========== 見た目重視の対称削り（唯一性はここでは見ない） ========== */
function carveSymmetric(solved, targetHints, forbidMask){
  const g = solved.map(r=>r.slice());
  // forbid は必ず空欄
  if (forbidMask){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (forbidMask[r][c]) g[r][c]=0;
  }
  const target = Math.max(17, Math.min(81, targetHints));
  let hints=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (g[r][c]) hints++;
  const pairs=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const or=8-r, oc=8-c;
    if (r>or || (r===or && c>oc)) continue;
    pairs.push([r,c,or,oc]);
  }
  shuffle(pairs);
  for (const [r,c,or,oc] of pairs){
    if (hints<=target) break;
    if ((!g[r][c] && !g[or][oc]) ||
        (forbidMask && (forbidMask[r]?.[c] || forbidMask[or]?.[oc]))) continue;
    const a=g[r][c], b=g[or][oc];
    g[r][c]=0; g[or][oc]=0;
    // 対称性だけ守って削る（唯一性は後段の“全体修復”で担保）
    hints -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

/* ========== 追加ヒントで“全体唯一化”する修復 ========== */
function repairToUnique(puzzles, solved, forbids, overlaps, maxAdd=60){
  // 複数解なら、共有以外のセルから解答値をヒントとして追加していく
  const B=puzzles.length;
  // 候補リスト（各盤で 0 かつ forbid でない場所）
  const candidates=[];
  for (let b=0;b<B;b++){
    for (let r=0;r<9;r++) for (let c=0;c<9;c++){
      if (forbids[b][r][c]) continue;
      if ((puzzles[b][r][c]|0)===0) candidates.push({b,r,c});
    }
  }
  shuffle(candidates);

  for (let k=0; k<maxAdd; k++){
    const cnt = countSolutionsCombinedWithOverlaps(puzzles, overlaps);
    if (cnt===1) return true;           // 一意化完了
    if (cnt===0) return false;          // 与え矛盾（設計上ほぼ無い）

    // 1つ足してみる
    let placed=false;
    while (candidates.length){
      const {b,r,c} = candidates.pop();
      if ((puzzles[b][r][c]|0)===0){
        puzzles[b][r][c] = solved[b][r][c]; // 解答からヒントを復元
        placed=true;
        break;
      }
    }
    if (!placed) break; // もう足すところが無い
  }
  return countSolutionsCombinedWithOverlaps(puzzles, overlaps)===1;
}

/* ========== サーバ応答 ========== */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const difficulty = String(body.difficulty || "normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定: 共有は空欄

  if (layout.length===0) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // forbid（共有セルは空欄）
  const forbids = Array.from({length:nlayout.length}, ()=> Array.from({length:9},()=>Array(9).fill(false)));
  if (overlapEmpty){
    for (let i=0;i<overlaps.length;i++){
      for (const e of overlaps[i]){
        const j=e.j;
        for (const {r,c,r2,c2} of e.cells){
          forbids[i][r][c]=true;
          forbids[j][r2][c2]=true;
        }
      }
    }
  }

  // 何度かトライ
  for (let attempt=0; attempt<40; attempt++){
    const pattern = makeGlobalPattern();

    // 完成盤（全盤一貫）
    const solved = nlayout.map(({ox,oy}) =>
      Array.from({length:GRID}, (_,r)=>
        Array.from({length:GRID}, (_,c)=> pattern.valueAt(oy+r, ox+c))
      )
    );

    // 見た目重視の対称削り（共有は空欄維持）
    let puzzles = solved.map((sol, idx)=> carveSymmetric(sol, hintTarget, forbids[idx]));

    // まず与え矛盾（行/列/箱）は基本的に起きないが、念のためチェック
    // （完成盤から消しているだけなので通常は通る）
    // → 省略可

    // 合体全体の唯一性を確認。複数解なら“修復”して一意化
    const ok = repairToUnique(puzzles, solved, forbids, overlaps, /*maxAdd*/80);
    if (!ok) continue;

    // ここまで通れば OK
    const boards = nlayout.map((o, idx)=>({
      id: layout[idx].id,
      x: o.rawx, y: o.rawy,
      grid: puzzles[idx],
      solution: solved[idx],
    }));
    return json({ ok:true, puzzle:{ boards } });
  }

  return json({ ok:false, reason:"failed to generate unique combined puzzle" }, 500);
};
