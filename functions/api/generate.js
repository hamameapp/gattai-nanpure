// functions/api/generate.js
// 速い合体ナンプレ生成API（Cloudflare Pages Functions）
//
// 方針：
// - 1つの“無限”完成パターン valueAt(R,C) を作り、各盤は (ox,oy) からの 9x9 ウィンドウとして切り出す
//   → どの盤同士が重なっても、共有セルは必ず同じ数字（合体ルール厳守）
// - その後、各盤ごとにヒントを削る（carve）。最後に共有セルの与え/非与えを整合
// - バックトラック不要で O(盤数×81)。CPU制限（Error 1102）を回避
//
// 受信JSON: { layout: [{id,x,y}, ...], adShown?: boolean, difficulty?: "easy"|"normal"|"hard" }
// 応答JSON: { ok:true, puzzle:{ boards:[{id,x,y,grid:number[9][9]}...] } }
//
// 環境変数（wrangler.toml / ダッシュボードで設定）:
// - DISABLE_QUOTA ("1"でレート制限無効)
// - DAILY_LIMIT, DAILY_LIMIT_WITH_AD
// - MAX_BOARDS, GEN_TIMEOUT_MS（この実装では未使用でもOK）

const GRID = 9;
// ★フロントの CELL と同じにしてください（script.js が 30 なら 30）
const CELL_PX = 30;

// 難易度ごとのヒント数設定（大きいほど易しい）
const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 30 };

// -------------------- 共通ヘルパ --------------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// -------------------- レート制限 --------------------
async function checkQuota(env, { ip, adShown }) {
  // 無効化フラグ
  if (env.DISABLE_QUOTA === "1") return true;

  // バインドが無ければチェックしない
  if (!env.QUOTA) return true;

  // 上限（広告表示なら緩める想定）
  const base = parseInt(env.DAILY_LIMIT || "20", 10);
  const withAd = parseInt(env.DAILY_LIMIT_WITH_AD || String(base), 10);
  const LIMIT = adShown ? withAd : base;

  const day = new Date().toISOString().slice(0, 10); // UTC日でカウント
  const key = `quota:${day}:${ip}`;

  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  if (used >= LIMIT) return false;

  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

// -------------------- 乱択 --------------------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// -------------------- グローバル完成パターン --------------------
// base(r,c) は (r*3 + floor(r/3) + c) % 9 で 0..8 を返す定番の数独テンプレート。
// これに行/列の順序シャッフル＋数字置換をかけると完成盤になる。
// (R,C) に対して (R%9, C%9) で参照するため、どの 9x9 ウィンドウも完成盤になる。
function makeGlobalPattern() {
  function makeOrder() {
    const bandOrder = shuffle([0, 1, 2]); // 3行(列)のバンド順
    const order = [];
    for (const b of bandOrder) {
      const inner = shuffle([0, 1, 2]);   // バンド内の3行(列)順
      for (const k of inner) order.push(b * 3 + k);
    }
    return order; // 0..8 の並び替え
  }

  const rowOrder = makeOrder();
  const colOrder = makeOrder();
  const digitPerm = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 数字置換

  const base = (r, c) => (r * 3 + Math.floor(r / 3) + c) % 9;

  function valueAt(R, C) {
    const r = rowOrder[((R % 9) + 9) % 9];
    const c = colOrder[((C % 9) + 9) % 9];
    const v0 = base(r, c); // 0..8
    return digitPerm[v0];  // 1..9
  }

  return { valueAt };
}

// -------------------- ヒント削り（対称） --------------------
function carveBoard(solved, hintTarget) {
  const g = solved.map((r) => r.slice());
  const cells = [...Array(81).keys()];
  shuffle(cells);
  let toRemove = Math.max(0, 81 - hintTarget);
  for (const idx of cells) {
    if (toRemove <= 0) break;
    const r = (idx / 9) | 0, c = idx % 9;
    const or = 8 - r, oc = 8 - c;
    if (g[r][c] === 0 && g[or][oc] === 0) continue;
    g[r][c] = 0;
    g[or][oc] = 0;
    toRemove -= (r === or && c === oc) ? 1 : 2;
  }
  return g;
}

// -------------------- レイアウト＆重なり --------------------
function normalizeLayout(layout) {
  return layout.map((o) => ({
    id: String(o.id),
    ox: Math.round((Number(o.x) || 0) / CELL_PX), // マス単位
    oy: Math.round((Number(o.y) || 0) / CELL_PX),
    rawx: Number(o.x) || 0, // 応答に元のpx座標も返す
    rawy: Number(o.y) || 0,
  }));
}

function buildOverlaps(nlayout) {
  const n = nlayout.length;
  const overlaps = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = nlayout[i], B = nlayout[j];
      const R0 = Math.max(0, B.oy - A.oy);
      const C0 = Math.max(0, B.ox - A.ox);
      const R1 = Math.min(8, (B.oy + 8) - A.oy);
      const C1 = Math.min(8, (B.ox + 8) - A.ox);
      if (R0 <= R1 && C0 <= C1) {
        const cells = [];
        for (let r = R0; r <= R1; r++) {
          for (let c = C0; c <= C1; c++) {
            const r2 = r + A.oy - B.oy;
            const c2 = c + A.ox - B.ox;
            cells.push({ r, c, r2, c2 });
          }
        }
        overlaps[i].push({ j, cells });
        overlaps[j].push({
          j: i,
          cells: cells.map(({ r, c, r2, c2 }) => ({ r: r2, c: c2, r2: r, c2: c })),
        });
      }
    }
  }
  return overlaps;
}

function unifyGivenCells(puzzles, overlaps) {
  // 共有マスで片側だけ与えになっている場合、もう片側にも与える
  for (let i = 0; i < overlaps.length; i++) {
    for (const e of overlaps[i]) {
      const j = e.j;
      for (const { r, c, r2, c2 } of e.cells) {
        const a = puzzles[i][r][c];
        const b = puzzles[j][r2][c2];
        if (a !== 0 && b === 0) puzzles[j][r2][c2] = a;
        else if (b !== 0 && a === 0) puzzles[i][r][c] = b;
      }
    }
  }
}

// -------------------- メイン（POST） --------------------
export const onRequestPost = async ({ request, env }) => {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  // 入力を読む
  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  const adShown = !!body.adShown;
  const difficulty = String(body.difficulty || "normal");

  if (layout.length === 0) {
    return json({ ok: false, reason: "layout required" }, 400);
  }

  // レート制限
  if (!(await checkQuota(env, { ip, adShown }))) {
    return json({ ok: false, reason: "daily limit exceeded" }, 429);
  }

  // 盤数制限
  const maxBoards = parseInt(env.MAX_BOARDS || "40", 10);
  if (layout.length > maxBoards) {
    return json({ ok: false, reason: `too many boards (>${maxBoards})` }, 400);
  }

  // レイアウトをマス単位に正規化
  const nlayout = normalizeLayout(layout);

  // 完成パターンを1つ作成（全盤共通）
  const pattern = makeGlobalPattern();

  // 各盤の“完成盤”を切り出す（(ox,oy) から 9x9）
  const solved = nlayout.map(({ ox, oy }) => {
    const g = Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
    );
    return g;
  });

  // 難易度に応じてヒント数を決定
  const hintTarget = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // 各盤でヒント削り
  let puzzles = solved.map((g) => carveBoard(g, hintTarget));

  // 共有マスの与え整合
  const overlaps = buildOverlaps(nlayout);
  unifyGivenCells(puzzles, overlaps);

  // 応答（フロントのID/px座標を透過）
  const boards = nlayout.map((o, idx) => ({
    id: layout[idx].id,
    x: o.rawx,
    y: o.rawy,
    grid: puzzles[idx],
  }));

  return json({ ok: true, puzzle: { boards } });
};
