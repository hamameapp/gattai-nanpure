// functions/api/generate.js
// 合体ナンプレ：レイアウト配列に対して複数盤を返す純JS版
const empty9 = () => Array.from({ length: 9 }, () => Array(9).fill(0));

function isSafe(g, r, c, n) {
  for (let i = 0; i < 9; i++) if (g[r][i] === n || g[i][c] === n) return false;
  const br = (r / 3 | 0) * 3, bc = (c / 3 | 0) * 3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    if (g[br + i][bc + j] === n) return false;
  return true;
}
const randDigits = () => {
  const a = [1,2,3,4,5,6,7,8,9];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function makeSolved() {
  const g = empty9();
  (function dfs(idx = 0) {
    if (idx === 81) return true;
    const r = (idx / 9) | 0, c = idx % 9;
    for (const n of randDigits()) {
      if (isSafe(g, r, c, n)) {
        g[r][c] = n;
        if (dfs(idx + 1)) return true;
        g[r][c] = 0;
      }
    }
    return false;
  })();
  return g;
}
function carve(g, hintTarget = 36) {
  const grid = g.map(r => r.slice());
  const cells = Array.from({ length: 81 }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  let toRemove = 81 - hintTarget;
  for (const idx of cells) {
    if (toRemove <= 0) break;
    const r = (idx / 9) | 0, c = idx % 9;
    const or = 8 - r, oc = 8 - c; // 中心対称
    if (grid[r][c] === 0 && grid[or][oc] === 0) continue;
    grid[r][c] = 0;
    grid[or][oc] = 0;
    toRemove -= (r === or && c === oc) ? 1 : 2;
  }
  return grid;
}
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function checkQuota(env, ip) {
  if (!env.QUOTA) return true;
  const key = `quota:${new Date().toISOString().slice(0,10)}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || "20", 10);
  if (used >= DAILY_LIMIT) return false;
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

export const onRequestPost = async ({ request, env }) => {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!(await checkQuota(env, ip))) {
    return json({ ok: false, reason: "daily limit exceeded" }, 429);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) ? body.layout : [];
  if (layout.length === 0) {
    return json({ ok: false, reason: "layout required" }, 400);
  }

  // 将来：難易度に応じて hintTarget を調整
  const hintTarget = 36;

  // レイアウト配列に対して複数盤を生成して返却
  const boards = layout.map(({ id, x = 0, y = 0 }) => {
    const solved = makeSolved();
    const puzzle = carve(solved, hintTarget);
    return { id: String(id), x, y, grid: puzzle };
  });

  return json({ ok: true, puzzle: { boards } });
};
