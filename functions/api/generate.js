// functions/api/generate.js
// 合体ナンプレ（今は1盤のみ）を "純JS" で返す軽量版。
// 後でWASMに差し替え可能な形にしてあります。

/** 9x9 空配列 */
const emptyGrid = () => Array.from({ length: 9 }, () => Array(9).fill(0));

/** 行/列/ブロック制約チェック */
function isSafe(grid, r, c, n) {
  for (let i = 0; i < 9; i++) {
    if (grid[r][i] === n || grid[i][c] === n) return false;
  }
  const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (grid[br + i][bc + j] === n) return false;
  }
  return true;
}

/** ランダムな順序の1..9 */
const randDigits = () => {
  const a = [1,2,3,4,5,6,7,8,9];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** バックトラックで完成盤を1つ作る */
function makeSolved() {
  const grid = emptyGrid();
  function dfs(idx = 0) {
    if (idx === 81) return true;
    const r = (idx / 9) | 0, c = idx % 9;
    const order = randDigits();
    for (const n of order) {
      if (isSafe(grid, r, c, n)) {
        grid[r][c] = n;
        if (dfs(idx + 1)) return true;
        grid[r][c] = 0;
      }
    }
    return false;
  }
  dfs(0);
  return grid;
}

/** ヒントを削る（難易度はとりあえず固定で30〜40ヒント程度） */
function carve(g, hintTarget = 36) {
  const grid = g.map(row => row.slice());
  // 81→hintTarget まで消す
  // 位置をランダムに舐めて対称に消す（簡易）
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
    const keepA = grid[r][c], keepB = grid[or][oc];
    if (keepA === 0 && keepB === 0) continue;
    grid[r][c] = 0;
    grid[or][oc] = 0;
    toRemove -= (r === or && c === oc) ? 1 : 2;
  }
  return grid;
}

/** JSON レスポンス整形 */
function json(data, init = 200) {
  return new Response(JSON.stringify(data), {
    status: init,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/** 簡易レート制限（KV QUOTAを使う） */
async function checkQuota(env, ip) {
  if (!env.QUOTA) return true; // KV未設定ならスキップ
  const key = `quota:${new Date().toISOString().slice(0,10)}:${ip}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || "20", 10);
  if (used >= DAILY_LIMIT) return false;
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

export const onRequestPost = async ({ request, env }) => {
  // CORS（同一オリジンなら不要。必要なら _headers で統一管理もOK）
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ok = await checkQuota(env, ip);
  if (!ok) return json({ ok: false, reason: "daily limit exceeded" }, 429);

  let body = {};
  try { body = await request.json(); } catch {}
  // layout/adHint/difficulty は将来拡張用。今は無視か軽く利用。
  // const { layout = [{id:"A",x:0,y:0}], adHint = 0, difficulty = "normal" } = body;

  // 盤面生成
  const solved = makeSolved();
  const puzzle = carve(solved, 36);

  return json({
    ok: true,
    puzzle: {
      boards: [
        {
          id: "A",
          x: 0,
          y: 0,
          grid: puzzle   // 0 は空白
        }
      ]
    }
  });
};
