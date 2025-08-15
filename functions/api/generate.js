// 生成ボタンから呼ぶ関数
async function generateFromServer(layout, adShown=false, difficulty="normal") {
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout, adHint: adShown ? 1 : 0, difficulty })
    });
    if (!res.ok) {
      // 429, 5xx など
      const err = await res.json().catch(() => ({}));
      throw new Error(err.reason || res.statusText);
    }
    const data = await res.json();
    // boards[0].grid が 9x9（0 は空白）
    const boards = data.puzzle.boards;
    // ← ここで既存の描画ロジックに流し込む
    renderBoards(boards);
  } catch (e) {
    showStatus(`生成に失敗: ${e.message}`);
  }
}

// 例：単盤レイアウトで呼ぶ
document.getElementById("generateProblemButton")?.addEventListener("click", () => {
  const layout = [{ id: "A", x: 0, y: 0 }]; // いまの軽量版は1盤のみ返します
  generateFromServer(layout, /*adShown=*/false, /*difficulty=*/"normal");
});
