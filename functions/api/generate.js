// functions/api/generate.js — 最小ヘルスチェック版
export const onRequestPost = () => {
  return new Response(JSON.stringify({ ok: true, ping: "pong" }), {
    headers: { "content-type": "application/json" }
  });
};
