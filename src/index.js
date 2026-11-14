// cfb-live Worker: serves the static screen from ./public and relays ESPN's
// public college-football API under /api/* (same-origin, short edge cache).
const VERSION = "0.1.0-placeholder";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/version") {
      return Response.json({ version: VERSION });
    }

    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api/".length);
      if (!/^(scoreboard|summary|teams(\/\d+)?)$/.test(path)) {
        return Response.json({ error: "unknown endpoint" }, { status: 404 });
      }
      const upstream = await fetch(ESPN + path + url.search, {
        headers: { "User-Agent": "cfb-live/1.0" },
        cf: { cacheTtl: 5, cacheEverything: true },
      });
      const res = new Response(upstream.body, upstream);
      res.headers.set("Cache-Control", "public, max-age=5");
      res.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    }

    return env.ASSETS.fetch(request);
  },
};
