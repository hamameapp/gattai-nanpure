// functions/api/generate.js
// 速い合体ナンプレ生成API：
// - グローバルな「完成パターン」を作り、各盤はその9x9ウィンドウとして切り出す。
// - これにより重なりセルは必ず同じ数字になる（合体ルール厳守）。
// - その後、各盤でヒントを削る。重なりセルの与え/非与えは最後に整合させる。
// - バックトラック不要なので Cloudflare の CPU 制限（1102）を回避できます。

const GRID = 9;
// ★フロントの 1マスpx と同じにしてください（あなたの script.js は CELL=30）
const CELL_PX = 30;

const HINT_TARGET = 36;           // 1盤あたりの目標ヒント数（大きいほど易しい）
const MAX_TRIES_PER_BOARD = 1;    // 今回はバックトラックを使わないので未使用（将来用）

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function checkQuota(env, ip) {
  if (!env.QUOTA) return true;
  const key = `quota:${new Date().toISOString().slice(0, 10)}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || "20", 10);
  if (used >= DAILY_LIMIT) return false;
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

// ---------- 乱択ユーティリティ ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 9x9完成パターン（任意の 9x9 ウィンドウも完成盤になる） ----------
function makeGlobalPattern() {
  // 行/列の順序：バンド（3行/3列単位）をシャッフル→各バンド内の3行/3列もシャッフル
  function makeOrder() {
    const bandOrder = shuffle([0, 1, 2]);
    const order = [];
    for (const b of bandOrder) {
      const inner = shuffle([0, 1, 2]);
      for (const k of inner) order.push(b * 3 + k);
    }
    return order; // 0..8 の並び替え
  }

  const rowOrder = makeOrder();
  const colOrder = makeOrder();
  const digitPerm = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 数字置換

  // ベースパターン（0..8 を返す）
  const base = (r, c) => (r * 3 + Math.floor(r / 3) + c) % 9;

  // 任意のグローバル座標 (R,C) に対して 1..9 を返す
  function valueAt(R, C) {
    const r = rowOrder[((R % 9) + 9) % 9];
    const c = colOrder[((C % 9) + 9) % 9];
    const v0 = base(r, c); // 0..8
    return digitPerm[v0];  // 1..9
  }

  return { valueAt };
}

// ---------- ヒント削り（対称） ----------
function carveBoard(solved, hintTarget = HINT_TARGET) {
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

// ---------- レイアウト処理 ----------
function normalizeLayout(layout) {
  return layout.map((o) => ({
    id: String(o.id),
    ox: Math.round((o.x || 0) / CELL_PX), // マス単位に正規化
    oy: Math.round((o.y || 0) / CELL_PX),
    rawx: o.x || 0, // 応答用（フロントの位置を透過）
    rawy: o.y || 0,
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

// ---------- メイン ----------
export const onRequestPost = async ({ request, env }) => {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!(await checkQuota(env, ip))) {
    return json({ ok: false, reason: "daily limit exceeded" }, 429);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  if (layout.length === 0) return json({ ok: false, reason: "layout required" }, 400);

  const maxBoards = parseInt(env.MAX_BOARDS || "40", 10);
  if (layout.length > maxBoards) {
    return json({ ok: false, reason: `too many boards (>${maxBoards})` }, 400);
  }

  // レイアウト正規化（マス座標）
  const nlayout = normalizeLayout(layout);

  // グローバル完成パターンを1つだけ作る（全盤共通）
  const pattern = makeGlobalPattern();

  // 各盤の完成盤を切り出し
  const solved = nlayout.map(({ ox, oy }) => {
    const g = Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => pattern.valueAt(oy + r, ox + c))
    );
    return g;
  });

  // 各盤でヒントを削る（個別）
  let puzzles = solved.map((g) => carveBoard(g, HINT_TARGET));

  // 共有マスの与え整合（片側だけ与え → もう片側にも与える）
  const overlaps = buildOverlaps(nlayout);
  unifyGivenCells(puzzles, overlaps);

  // レスポンス整形（IDと元のピクセル座標を透過）
  const boards = nlayout.map((o, idx) => ({
    id: layout[idx].id,
    x: o.rawx,
    y: o.rawy,
    grid: puzzles[idx],
  }));

  return json({ ok: true, puzzle: { boards } });
};
