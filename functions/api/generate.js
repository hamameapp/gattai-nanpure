// functions/api/generate.js
// 高速合体ナンプレ + 解答返却 + 共有マスを「解答値」で強制整合
//
// ・1つの“無限”完成パターンから各盤の 9x9 を切り出し（共有セルは必ず同じ数字）
// ・各盤でヒントを削る
// ・最後に、共有マスに関して puzzle の与えを「解答値」で上書き（矛盾が出ない）
// ・解答（solution）も返す

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
    return order;
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

// ★両側が与えだが不一致 → 解答値で両側を上書き（矛盾排除）
function enforceOverlapBySolution(puzzles, solved, overlaps){
  for (let i=0;i<overlaps.length;i++){
    for (const e of overlaps[i]){
      const j=e.j;
      for (const {r,c,r2,c2} of e.cells){
        const sVal = solved[i][r][c]; // グローバルパターン由来なので solved[j][r2][c2] と一致する
        if (puzzles[i][r][c]!==0 || puzzles[j][r2][c2]!==0) {
          puzzles[i][r][c] = sVal;
          puzzles[j][r2][c2] = sVal;
        }
      }
    }
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

  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 問題化
  let puzzles = solved.map(g => carveBoard(g, hintTarget));

  // 共有マス整合：片側与え→コピー
  const overlaps = buildOverlaps(nlayout);
  unifyGivenCells(puzzles, overlaps);

  // 共有マスが両側与えで不一致のケースを "解答値" で強制一致
  enforceOverlapBySolution(puzzles, solved, overlaps);

  // 応答
  const boards = nlayout.map((o, idx) => ({
    id: layout[idx].id, x: o.rawx, y: o.rawy,
    grid: puzzles[idx],
    solution: solved[idx]
  }));
  return json({ ok:true, puzzle:{ boards } });
};
