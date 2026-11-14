// CFB Live: small relay between the page and ESPN's public college-football feeds.
// The page lives in /public (static assets); only /api/* reaches this code.
// Responses are trimmed to what the screen needs (an ESPN summary is ~400 KB,
// a trimmed game is ~20 KB) and cached at the edge for a few seconds.

const VERSION = "0.3.1";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";

const json = (data, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });

async function upstream(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "cfb-live-screen/1.0" } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

// Serve from the edge cache when fresh, otherwise build and store.
async function cached(request, ctx, ttl, build) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = json(await build(), 200, ttl);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const hex = (c) => (c ? "#" + String(c).replace(/^#/, "") : null);
const darkLogo = (url) => (url ? url.replace("/500/", "/500-dark/") : null);
const rankOf = (r) => (r && r < 99 ? r : null);

/* ---------- scoreboard: every FBS game of the current week (for the game picker) ---------- */
function trimBoard(d) {
  return (d.events || []).map((e) => {
    const c = e.competitions[0];
    const st = c.status || e.status;
    const team = (side) => {
      const x = c.competitors.find((t) => t.homeAway === side);
      const t = x.team;
      return {
        id: t.id, abbr: t.abbreviation, name: t.shortDisplayName || t.location, full: t.displayName,
        rank: rankOf(x.curatedRank?.current), score: x.score != null ? Number(x.score) : null,
        color: hex(t.color), alt: hex(t.alternateColor), logo: t.logo || null,
      };
    };
    const s = c.situation || {};
    return {
      id: e.id, date: e.date, state: st.type.state, detail: st.type.shortDetail,
      away: team("away"), home: team("home"),
      possession: s.possession || null, redZone: !!s.isRedZone,
    };
  });
}

/* ---------- one game: summary + live situation ---------- */
const compactPlay = (p, driveId) => ({
  id: p.id, d: driveId, t: Number(p.type?.id), tt: p.type?.text || "", text: p.text || "",
  sp: !!p.scoringPlay, to: !!p.isTurnover, a: p.awayScore, h: p.homeScore,
  per: p.period?.number, clk: p.clock?.displayValue,
  s: p.start ? { team: p.start.team?.id, down: p.start.down, dist: p.start.distance, yl: p.start.yardLine } : null,
  e: p.end ? { team: p.end.team?.id, down: p.end.down, dist: p.end.distance, yl: p.end.yardLine } : null,
});

function trimGame(d, sit) {
  const comp = d.header.competitions[0];
  const st = comp.status;
  const teams = comp.competitors.map((x) => {
    const t = x.team;
    const logos = t.logos || [];
    const logo = logos.find((l) => (l.rel || []).includes("default"))?.href || logos[0]?.href || null;
    const dark = logos.find((l) => (l.rel || []).includes("dark"))?.href || darkLogo(logo);
    return {
      id: t.id, homeAway: x.homeAway, abbr: t.abbreviation, name: t.location, nick: t.name, full: t.displayName,
      rank: rankOf(x.rank), record: (x.record || []).find((r) => r.type === "total")?.summary || "",
      score: x.score != null ? Number(x.score) : null, possession: !!x.possession,
      color: hex(t.color), alt: hex(t.alternateColor), logo, logoDark: dark,
      lines: (x.linescores || []).map((l) => Number(l.displayValue)),
    };
  });

  const drivesSrc = [...(d.drives?.previous || [])];
  const cur = d.drives?.current;
  if (cur && !drivesSrc.some((x) => x.id === cur.id)) drivesSrc.push(cur);
  const drives = drivesSrc.map((dr) => ({
    id: dr.id, team: dr.team?.id, result: dr.result || null, display: dr.displayResult || null,
    desc: dr.description || "", startYl: dr.start?.yardLine ?? null,
    lastText: (dr.plays || []).at(-1)?.text || "",
  }));
  const plays = [];
  for (const dr of drivesSrc) for (const p of dr.plays || []) plays.push(compactPlay(p, dr.id));

  const wp = (d.winprobability || []).at(-1);
  const teamFromRef = (ref) => (ref ? (String(ref).match(/teams\/(\d+)/) || [])[1] || null : null);

  return {
    id: comp.id, date: comp.date, state: st.type.state, detail: st.type.detail, shortDetail: st.type.shortDetail,
    period: st.period, clock: st.displayClock, completed: !!st.type.completed,
    venue: d.gameInfo?.venue?.fullName || "",
    teams,
    sit: sit ? {
      down: sit.down, dist: sit.distance, yl: sit.yardLine, redZone: !!sit.isRedZone,
      homeTO: sit.homeTimeouts, awayTO: sit.awayTimeouts, possession: teamFromRef(sit.team?.$ref),
    } : null,
    drive: cur ? { id: cur.id, team: cur.team?.id, desc: cur.description || "", startYl: cur.start?.yardLine ?? null } : null,
    wpHome: wp ? wp.homeWinPercentage : null,
    scoring: (d.scoringPlays || []).map((s) => ({
      id: s.id, team: s.team?.id, kind: s.scoringType?.name || "", tt: s.type?.text || "", text: s.text || "",
      a: s.awayScore, h: s.homeScore, per: s.period?.number, clk: s.clock?.displayValue,
    })),
    drives,
    plays: plays.slice(-80),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === "/api/version") return json({ version: VERSION });

      if (url.pathname === "/api/board") {
        return await cached(request, ctx, 20, async () =>
          trimBoard(await upstream(`${SITE}/scoreboard?groups=80&limit=300`)));
      }

      const m = url.pathname.match(/^\/api\/game\/(\d+)$/);
      if (m) {
        const id = m[1];
        // The live situation (down, distance, timeouts) comes from ESPN's core API, which refuses
        // Cloudflare's servers (403); the page fetches that small file directly instead.
        return await cached(request, ctx, 4, async () => trimGame(await upstream(`${SITE}/summary?event=${id}`), null));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
