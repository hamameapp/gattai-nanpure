// functions/api/generate.js — KVテスト版
export const onRequestPost = async (context) => {
  const kv = context.env.QUOTA ?? context.env.MY_KV;
  if (!kv) {
    return new Response(JSON.stringify({ ok:false, reason:"no_kv_binding" }), {
      status: 500, headers: { "content-type":"application/json" }
    });
  }

  const key = "diag:" + new Date().toISOString().slice(0,10);
  await kv.put(key, "ok", { expirationTtl: 120 });
  const val = await kv.get(key);

  return new Response(JSON.stringify({ ok:true, kv_ok: val === "ok" }), {
    headers: { "content-type":"application/json" }
  });
};
