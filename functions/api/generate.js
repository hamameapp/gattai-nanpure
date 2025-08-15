// 軽量・安定版：完成盤を数式で生成 → 低負荷の穴あけ（唯一性は未保証）＋KVクオータ
export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---- 入力 ----
  let body = {};
  try { body = await request.json(); } catch {}
  const layout = Array.isArray(body.layout) && body.layout.length
    ? body.layout
    : [{ id: "a", x: 0, y: 0 }];
  const adHint = !!body.adHint;

  // ---- KV クオータ ----
  const kv = env.QUOTA ?? env.MY_KV;
  if (!kv) return json({ ok:false, reason:"no_kv_binding" }, 500);

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date().toISOString().slice(0,10);
  const qKey = `${day}:${ip}`;
  const used = parseInt((await kv.get(qKey)) || "0", 10);
  const limit = parseInt(adHint ? (env.DAILY_LIMIT_WITH_AD || "100") : (env.DAILY_LIMIT || "20"), 10);
  if (used >= limit) return json({ ok:false, reason:"quota", limit }, 429);

  // ---- 完成盤（数式で一発）----
  const solved = makeSolvedByPattern();

  // ---- 低負荷の穴あけ（左右対称、唯一性は見ない）----
  const puzzle = punchHolesFast(solved, 45);

  const boards = [{ id: layout[0].id, x: layout[0].x, y: layout[0].y, grid: puzzle }];

  // ---- 回数更新（約30時間でリセット）----
  await kv.put(qKey, String(used + 1), { expirationTtl: 60 * 60 * 30 });

  return json({ ok:true, puzzle:{ boards }, kind:"fast-puzzle" });
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control":"no-store" }
  });
}

// 9x9完成盤（ラテン方格パターン）
function makeSolvedByPattern() {
  const g = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (let r=0; r<9; r++) for (let c=0; c<9; c++)
    g[r][c] = ((r*3 + Math.floor(r/3) + c) % 9) + 1;
  return g;
}

// 軽量穴あけ（左右対称に消す／中心は残す）
function punchHolesFast(solved, targetHoles=45) {
  const g = solved.map(row => row.slice());
  const cells = [];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!(r===4 && c===4)) cells.push([r,c]);
  shuffle(cells);

  let removed = 0;
  for (const [r,c] of cells) {
    if (removed >= targetHoles) break;
    const r2 = r, c2 = 8 - c;             // 左右対称
    if (g[r][c] === 0 && g[r2][c2] === 0) continue;
    g[r][c] = 0;
    g[r2][c2] = 0;
    removed += (r===r2 && c===c2) ? 1 : 2;
  }
  return g;
}

// ←ここが原因でした。正しいフィッシャー–イェーツに修正
function shuffle(a){
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}
