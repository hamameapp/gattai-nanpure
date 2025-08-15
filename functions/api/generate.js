// functions/api/generate.js — 例外ゼロ＆高速テスト用（完成盤を数式で生成）
export const onRequestPost = async (context) => {
  try {
    const { request } = context;
    const body = await request.json().catch(() => ({}));
    const layout = Array.isArray(body.layout) && body.layout.length
      ? body.layout
      : [{ id: "a", x: 0, y: 0 }];

    // 9x9の完成盤を“計算で”一発生成（行入替・列入替不要の基本形）
    const solved = makeSolvedByPattern();

    // レイアウトのid/x/yを反映（とりあえず1枚目だけ返す）
    const boards = [{ id: layout[0].id, x: layout[0].x, y: layout[0].y, grid: solved }];

    return json({ ok: true, puzzle: { boards }, kind: "pattern-solved" });
  } catch (e) {
    return json({ ok:false, reason:"exception", message: String(e?.message || e) }, 500);
  }
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control":"no-store" }
  });
}

// 数式で作る完成盤（超高速・例外出ない）
function makeSolvedByPattern() {
  // 典型パターン: val(r,c) = ((r*3 + Math.floor(r/3) + c) % 9) + 1
  const g = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (let r=0; r<9; r++) {
    for (let c=0; c<9; c++) {
      g[r][c] = ((r*3 + Math.floor(r/3) + c) % 9) + 1;
    }
  }
  return g;
}
