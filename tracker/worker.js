// Correo read-tracker: a tiny Cloudflare Worker + KV namespace (binding: OPENS).
//   GET /p/<id>.gif   public 1x1 pixel; records the hit, returns a transparent GIF
//   GET /status?ids=  (Authorization: Bearer <API_TOKEN>) hit lists for the given ids
// Pixel ids look like "<base36 send time>-<random>" and are minted by the extension.

const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);
const TTL = 60 * 60 * 24 * 120; // keep records 120 days
const MAX_HITS = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const pixel = url.pathname.match(/^\/p\/([a-z0-9]+-[a-z0-9]{6,32})\.gif$/);
    if (pixel) {
      ctx.waitUntil(record(env, pixel[1], req));
      return new Response(GIF, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      });
    }

    if (url.pathname === "/status") {
      if (req.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) {
        return new Response("unauthorized", { status: 401, headers: CORS });
      }
      if (url.searchParams.get("list")) {
        const l = await env.OPENS.list({ prefix: "o:", limit: 100 });
        return Response.json(l.keys.map((k) => k.name.slice(2)), { headers: CORS });
      }
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          const hits = await env.OPENS.get(`o:${id}`, "json");
          if (hits) out[id] = hits;
        }),
      );
      return Response.json(out, { headers: CORS });
    }

    return new Response("ok");
  },
};

async function record(env, id, req) {
  const key = `o:${id}`;
  const hits = (await env.OPENS.get(key, "json")) || [];
  if (hits.length >= MAX_HITS) return;
  hits.push({ t: Date.now(), ua: (req.headers.get("User-Agent") || "").slice(0, 80) });
  await env.OPENS.put(key, JSON.stringify(hits), { expirationTtl: TTL });
}
