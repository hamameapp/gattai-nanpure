// functions/api/generate.js — ルート&バインド診断版
export const onRequestPost = async (context) => {
  const { env, request } = context;
  // 受け取ったボディも返して確認
  const bodyText = await request.text();
  return new Response(JSON.stringify({
    ok: true,
    bindings: {
      has_QUOTA: !!env.QUOTA,
      has_MY_KV: !!env.MY_KV
    },
    echo: bodyText
  }), { headers: { "content-type": "application/json" }});
};
