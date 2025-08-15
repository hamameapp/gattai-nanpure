// functions/api/generate.js
// 高速合体ナンプレ + 解答返却 + パズル整合(0 か solution と一致) + 妥当性検証

const GRID = 9;
const CELL_PX = 30; // ★script.js の CELL と一致

const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 30 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// ---- レート制限（DISABLE_QUOTA=1 で無効化） ----
async function checkQuota(env, { ip, adShown }) {
  if (env.DISABLE_QUOTA === "1") return true;
  if (!env.QUOTA) return true;
  const base = parseInt(env.DAILY_LIMIT || "20", 10);
  const withAd = parseInt(env.DAILY_LIMIT_WITH_AD || String(base), 10);
  const LIMIT = adShown ? withAd : base;
  const day = new Date().toISOString().slice(0, 10);
  const key = `quota:${day}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  if (used >= LIMIT) return false;
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

// ---- 乱択 ----
function shuffle(a) { for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

// ---- グローバル完成パターン ----
function makeGlobalPattern() {
  function makeOrder() {
    const bandOrder = shuffle([0,1,2]);
    const order = [];
    for (const b of bandOrder) { const inner = shuffle([0,1,2]); for (const k of inner) order.push(b*3+k); }
    return order; // 0..8
  }
  const rowOrder = makeOrder(), colOrder = makeOrder(), digitPerm = shuffle([1,2,3,4,5,6,7,8,9]);
  const base = (r,c)=> (r*3 + Math.floor(r/3) + c) % 9;
  function valueAt(R,C){
    const r = rowOrder[((R%9)+9)%9], c = colOrder[((C%9)+9)%9];
    return digitPerm[ base(r,c) ];
  }
  return { valueAt };
}

// ---- ヒント削り（対称）----
function carveBoard(solved, hintTarget) {
  const g = solved.map(r=>r.slice());
  const cells = [...Array(81).keys()]; shuffle(cells);
  let toRemove = Math.max(0, 81 - hintTarget);
  for (const idx of cells) {
    if (toRemove<=0) break;
    const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
    if (g[r][c]===0 && g[or][oc]===0) continue;
    g[r][c]=0; g[or][oc]=0;
    toRemove -= (r===or && c===oc) ? 1 : 2;
  }
  return g;
}

// ---- レイアウト＆重なり ----
function normalizeLayout(layout) {
  return layout.map(o=>({
    id:String(o.id),
    ox: Math.round((Number(o.x)||0)/CELL_PX),
    oy: Math.round((Number(o.y)||0)/CELL_PX),
    rawx: Number(o.x)||0,
    rawy: Number(o.y)||0
  }));
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

// ---- 妥当性チェック ----
function isValidSolved(grid){
  // 各行/列/ブロックが 1..9 を1回ずつ含むか
  const okSet = '123456789';
  const row = (r)=> grid[r].join('');
  const col = (c)=> grid.map(r=>r[c]).join('');
  const box = (br,bc)=>{
    const arr=[]; for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++) arr.push(grid[br+dr][bc+dc]);
    return arr.join('');
  };
  const sorted = s => s.split('').sort().join('');
  for (let i=0;i<9;i++){
    if (sorted(row(i))!==okSet) return false;
    if (sorted(col(i))!==okSet) return false;
  }
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    if (sorted(box(br,bc))!==okSet) return false;
  }
  return true;
}

// 片側だけ与え→もう片側へコピー
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

// ★共有マスの与えは「解答値」で統一（両側与え不一致も解消）
function enforceOverlapBySolution(puzzles, solved, overlaps){
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const sVal = solved[i][r][c]; // solved[j][r2][c2] も同じ
        if (puzzles[i][r][c]!==0 || puzzles[j][r2][c2]!==0) {
          puzzles[i][r][c] = sVal;
          puzzles[j][r2][c2] = sVal;
        }
      }
    }
  }
}

// ★与えは必ず 0 か solution と一致（単盤でも保証）
function clampPuzzleToSolution(puzzle, solution){
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v = puzzle[r][c] | 0;
    if (v === 0) continue;
    puzzle[r][c] = solution[r][c]; // 万一違っていても解答値に合わせる
  }
}

// ---- メイン ----
export const onRequestPost = async ({ request, env }) => {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  let body = {}; try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const adShown = !!body.adShown;
  const difficulty = String(body.difficulty || "normal");

  if (layout.length === 0) return json({ ok:false, reason:"layout required" }, 400);
  if (!(await checkQuota(env, { ip, adShown }))) return json({ ok:false, reason:"daily limit exceeded" }, 429);

  const maxBoards = parseInt(env.MAX_BOARDS || "40", 10);
  if (layout.length > maxBoards) return json({ ok:false, reason:`too many boards (>${maxBoards})` }, 400);

  const nlayout = normalizeLayout(layout);
  const pattern = makeGlobalPattern();

  // 完成盤/解答
  const solved = nlayout.map(({ ox, oy }) =>
    Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
    )
  );

  // 妥当性チェック（念のため）
  for (const g of solved) {
    if (!isValidSolved(g)) {
      // まれにでも失敗したら再生成（実際は起こらない想定）
      return json({ ok:false, reason:"internal: invalid solution pattern" }, 500);
    }
  }

  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 問題化
  let puzzles = solved.map(g => carveBoard(g, hintTarget));

  // 共有マス整合 → 与えを解答値で統一
  const overlaps = buildOverlaps(nlayout);
  unifyGivenCells(puzzles, overlaps);
  enforceOverlapBySolution(puzzles, solved, overlaps);

  // 各盤の与えを最終整合（単盤でも 0 か solution）
  for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);

  // 応答
  const boards = nlayout.map((o, idx) => ({
    id: layout[idx].id, x: o.rawx, y: o.rawy,
    grid: puzzles[idx],         // 与え（0 or solution）
    solution: solved[idx]       // 完成盤
  }));
  return json({ ok:true, puzzle:{ boards } });
};
