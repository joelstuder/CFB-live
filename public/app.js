"use strict";
/* CFB Live: the games you pick, live, with alerts in team colours.
   Data: /api/board (all FBS games this week, for the picker) and /api/game/:id (one game, trimmed). */

const TZ = "Europe/Zurich";
const POLL_LIVE = 7000, POLL_SOON = 20000, POLL_PRE = 120000, POLL_POST = 300000, POLL_ERR = 15000;
const BOARD_MS = 60000;
const MS = { td: 11000, fg: 8500, safety: 8500, turnover: 8500, final: 10000 };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- settings (kept on this device) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("cfb." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cfb." + k, JSON.stringify(v)); } catch {} },
};
let selected = store.get("games", []);
const opts = Object.assign({ sound: true, firstDown: true, possession: true }, store.get("opts", {}));
const saveOpts = () => store.set("opts", opts);

const urlGames = new URLSearchParams(location.search).get("games");
if (urlGames) { selected = urlGames.split(",").filter((x) => /^\d+$/.test(x)); store.set("games", selected); }

/* ---------- state ---------- */
let board = [];
const gs = {}; // id -> { data, base, seenScore, seenDrive, seenPlay, next, inflight, err }
let lastOk = 0, lastErr = false;

function gameState(id) {
  return gs[id] || (gs[id] = { data: null, base: false, seenScore: new Set(), seenDrive: new Set(), seenPlay: new Set(), next: 0, inflight: false, err: 0 });
}

/* ---------- colours ---------- */
function lum(hex) {
  const h = (hex || "#000").replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function palette(t) {
  const main = t?.color || "#3a4656";
  let alt = t?.alt && t.alt.toLowerCase() !== main.toLowerCase() ? t.alt : "#ffffff";
  if (contrast(main, alt) < 1.6) alt = contrast(main, "#ffffff") > contrast(main, "#111111") ? "#ffffff" : "#111111";
  const ink = contrast(main, "#ffffff") >= contrast(main, "#111111") ? "#ffffff" : "#111111";
  const cs = [...new Set([main, alt, "#ffffff"])];
  return { main, accent: alt, ink, cs };
}
// a version of the team colour that reads on the dark card
function onDark(t) {
  const bg = "#131a22";
  for (const c of [t?.color, t?.alt]) if (c && contrast(c, bg) >= 2.6) return c;
  return "#d5dbe3";
}

/* ---------- formatting ---------- */
const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayKey = (d) => d.toLocaleDateString("en-GB", { timeZone: TZ });
const isToday = (iso) => dayKey(new Date()) === dayKey(new Date(iso));
const whenLabel = (iso) => (isToday(iso) ? hhmm(iso) : new Date(iso).toLocaleDateString("en-GB", { weekday: "short", timeZone: TZ }) + " " + hhmm(iso));
const ord = (n) => ({ 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" }[n] || `${n}th`);
const perName = (p) => (p <= 4 ? ord(p) : p === 5 ? "OT" : `${p - 4}OT`);
function countdown(iso) {
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  if (m <= 0) return "any minute";
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `in ${h} h ${String(m % 60).padStart(2, "0")}` : "";
}
function cleanPlay(t) {
  return String(t || "")
    .replace(/^\(\d{1,2}:\d{2}\)\s*/, "")
    .replace(/^((No Huddle-)?(Shotgun|Pistol|No Huddle|Under Center)\s+)+/i, "")
    .replace(/\s*\((H|LS):[^)]*\)/g, "")
    .trim();
}

/* ---------- game helpers ---------- */
const away = (g) => g.teams.find((t) => t.homeAway === "away") || g.teams[0];
const home = (g) => g.teams.find((t) => t.homeAway === "home") || g.teams[1];
const teamById = (g, id) => g.teams.find((t) => t.id === id);
const other = (g, id) => g.teams.find((t) => t.id !== id);
// ESPN's yardLine counts from the HOME team's goal line (0) to the away team's (100).
const toGo = (g, teamId, yl) => (teamId === away(g).id ? yl : 100 - yl);
function spot(g, yl) {
  if (yl === 50) return "50";
  return yl < 50 ? `${home(g).abbr} ${yl}` : `${away(g).abbr} ${100 - yl}`;
}

// Where things stand right now: possession, down, distance, ball spot.
function situation(g) {
  if (g.state !== "in") return null;
  const sit = g.sit || {};
  // after kickoffs ESPN's situation can lose the possession and credit the kicking team with an empty drive;
  // the last play's end state knows who has the ball
  const lastEnd = [...g.plays].reverse().find((x) => x.e?.team && ![2, 21, 65].includes(x.t))?.e.team;
  const poss = sit.possession || lastEnd || g.teams.find((t) => t.possession)?.id || g.drive?.team || null;
  let down = sit.down, dist = sit.dist, yl = sit.yl;
  if (!(down > 0)) {
    // timeouts, reviews and kicks blank the down: fall back to the last real snap of the current drive
    const p = [...g.plays].reverse().find((x) => x.e && x.e.down > 0 && x.e.team === poss);
    if (p && (!g.drive || p.d === g.drive.id)) { down = p.e.down; dist = p.e.dist; yl = p.e.yl; }
  }
  if (yl == null || poss == null) return { poss, down: 0 };
  const ytez = toGo(g, poss, yl);
  const goal = down > 0 && dist >= ytez;
  // computed rather than taken from ESPN's isRedZone, which lags a play behind after turnovers
  const redZone = down > 0 && ytez <= 20;
  const dd = down > 0 ? `${ord(down)} & ${goal ? "Goal" : dist} at ${spot(g, yl)}` : "";
  return { poss, down, dist, yl, ytez, goal, redZone, dd };
}

function periodInfo(g) {
  if (g.state === "pre") return { per: "Kickoff", clk: hhmm(g.date), live: false };
  if (g.state === "post") return { per: g.shortDetail || "Final", clk: "", live: false };
  const sd = g.shortDetail || "";
  if (/half/i.test(sd)) return { per: "Halftime", clk: "", live: true };
  if (/^end/i.test(sd)) return { per: sd.replace(/^end of\s*/i, "End ").replace(/\s*quarter/i, ""), clk: "", live: true };
  return { per: perName(g.period), clk: g.clock || "", live: true };
}

// ESPN opens an empty "0 plays" drive for the kicking team after scores: not a real drive yet
const realDrive = (g) => !!(g.drive && g.drive.desc && !/^0 plays/.test(g.drive.desc) && g.drive.startYl > 0 && g.drive.startYl < 100);

/* ---------- field graphic ---------- */
const X = (yl) => 100 + (100 - yl) * 10; // away end zone on the left, home end zone on the right
function fieldSVG(g, s, fh = 170) {
  const a = away(g), h = home(g);
  const pa = palette(a), ph = palette(h);
  const cy = fh / 2;
  let out = `<svg class="field" viewBox="0 0 1200 ${fh}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`;
  for (let i = 0; i < 10; i++) out += `<rect x="${100 + i * 100}" y="0" width="100" height="${fh}" fill="${i % 2 ? "#2b7335" : "#2f7d3a"}"/>`;
  out += `<rect x="0" y="0" width="100" height="${fh}" fill="${pa.main}"/><rect x="1100" y="0" width="100" height="${fh}" fill="${ph.main}"/>`;
  out += `<text x="50" y="${cy}" fill="${pa.ink}" font-size="38" font-weight="900" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 50 ${cy})" letter-spacing="3">${esc(a.abbr)}</text>`;
  out += `<text x="1150" y="${cy}" fill="${ph.ink}" font-size="38" font-weight="900" text-anchor="middle" dominant-baseline="central" transform="rotate(90 1150 ${cy})" letter-spacing="3">${esc(h.abbr)}</text>`;
  if (s && s.redZone && s.poss) {
    const x0 = s.poss === a.id ? 900 : 100;
    out += `<rect x="${x0}" y="0" width="200" height="${fh}" fill="#ff3b3b" opacity=".35"/>`;
  }
  for (let k = 1; k < 20; k++) {
    const x = 100 + k * 50, ten = k % 2 === 0;
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${fh}" stroke="#fff" stroke-opacity="${ten ? 0.5 : 0.22}" stroke-width="${ten ? 3 : 2}"/>`;
  }
  out += `<line x1="100" y1="0" x2="100" y2="${fh}" stroke="#fff" stroke-width="5"/><line x1="1100" y1="0" x2="1100" y2="${fh}" stroke="#fff" stroke-width="5"/>`;
  for (let y = 10; y <= 90; y += 10) {
    const n = y <= 50 ? y : 100 - y, x = 100 + y * 10;
    out += `<text x="${x}" y="${fh - 14}" fill="#fff" fill-opacity=".55" font-size="26" font-weight="700" text-anchor="middle">${n}</text>`;
  }
  if (s && s.poss && s.yl != null) {
    const pt = teamById(g, s.poss), pp = palette(pt), dir = s.poss === a.id ? 1 : -1, bx = X(s.yl);
    if (realDrive(g) && g.drive.team === s.poss) {
      const x1 = X(g.drive.startYl), lo = Math.min(x1, bx), w = Math.abs(bx - x1);
      if (w > 2) out += `<rect x="${lo}" y="${cy - 13}" width="${w}" height="26" rx="10" fill="${onDark(pt)}" opacity=".55"/>`;
    }
    out += `<line x1="${bx}" y1="0" x2="${bx}" y2="${fh}" stroke="#4da3ff" stroke-width="6"/>`;
    if (s.down > 0 && !s.goal) {
      const fx = Math.max(100, Math.min(1100, bx + dir * s.dist * 10));
      out += `<line x1="${fx}" y1="0" x2="${fx}" y2="${fh}" stroke="#ffcc33" stroke-width="7"/>`;
    }
    // the ball: a big disc in the colours of the team that has it, pointing the way they're going
    const r = Math.min(52, cy - 8);
    out += `<polygon points="${bx + dir * (r + 6)},${cy - 20} ${bx + dir * (r + 34)},${cy} ${bx + dir * (r + 6)},${cy + 20}" fill="#fff"/>`;
    out += `<circle cx="${bx}" cy="${cy}" r="${r}" fill="#fff" stroke="${pp.main}" stroke-width="9"/>`;
    out += `<circle cx="${bx}" cy="${cy}" r="${r + 5}" fill="none" stroke="${pp.accent === "#ffffff" ? "#111" : pp.accent}" stroke-width="2.5"/>`;
    const logo = pt.logo || pt.logoDark;
    if (logo) out += `<image href="${esc(logo)}" x="${bx - r * 0.68}" y="${cy - r * 0.68}" width="${r * 1.36}" height="${r * 1.36}"/>`;
  }
  return out + "</svg>";
}

/* ---------- cards ---------- */
// one team: logo, abbreviation, score; filled with the team colour when it has the ball
function teamHTML(g, t, s, isHome) {
  const live = g.state === "in";
  const has = live && s && s.poss === t.id;
  const p = palette(t);
  const left = isHome ? g.sit?.homeTO : g.sit?.awayTO;
  const dots = live && left != null ? [0, 1, 2].map((i) => `<i class="${i < left ? "on" : ""}"></i>`).join("") : "";
  const line2 = `${t.rank ? `<span class="rk">#${t.rank}</span>` : ""}${has ? `<span class="fb">🏈</span>` : ""}${dots}`;
  const o = other(g, t.id);
  const trail = g.state !== "pre" && t.score != null && o.score != null && t.score < o.score ? "trail" : "";
  const style = has ? `style="--tc:${p.main};--ta:${p.accent};--ti:${p.ink}"` : "";
  return `<div class="team ${isHome ? "home" : "away"} ${has ? "ball" : ""} ${trail}" ${style}>
    <img class="logo" src="${esc(has ? t.logo || t.logoDark : t.logoDark || t.logo)}" alt="">
    <div class="tid"><div class="abbr">${esc(t.abbr)}</div><div class="tos">${line2}</div></div>
    <div class="pts">${g.state === "pre" ? "" : t.score ?? ""}</div>
  </div>`;
}

function cardHTML(g, fh) {
  const s = situation(g), a = away(g), h = home(g), p = periodInfo(g);
  let mid = `<div class="per ${p.live ? "live" : ""}">${esc(p.per)}</div>`;
  if (p.clk) mid += `<div class="clk">${esc(p.clk)}</div>`;
  if (g.state === "pre") mid += `<div class="cd">${esc(isToday(g.date) ? countdown(g.date) : new Date(g.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }))}</div>`;

  // where the ball is, in words: how far from scoring, coloured by zone
  let situ = "";
  if (s && s.yl != null && s.poss) {
    const zone = s.redZone ? "rz" : s.ytez < 50 ? "opp" : "own";
    // OWN 25 = own half, OPP 32 = 32 yards from scoring; colour says how close (grey, gold, red zone)
    const where = s.ytez === 50 ? "50" : s.ytez < 50 ? `OPP ${s.ytez}` : `OWN ${100 - s.ytez}`;
    situ = `<div class="pos ${zone}"><b>${where}</b></div>`;
    if (s.down > 0) situ += `<div class="down">${ord(s.down)} & ${s.goal ? "Goal" : s.dist}</div>`;
  } else if (g.state === "in") {
    situ = `<div class="pos own"><span>${esc(cleanPlay([...g.plays].reverse().find((x) => x.text)?.text || "").slice(0, 60))}</span></div>`;
  } else if (g.state === "pre") {
    situ = `<div class="pos own"><span>${esc(g.venue || "")}</span></div>`;
  }

  let wp = "";
  if (g.state === "in" && g.wpHome != null) {
    const ph = Math.round(g.wpHome * 100), pa = 100 - ph;
    wp = `<div class="wp"><span>${esc(a.abbr)} ${pa}%</span><div class="wpbar"><div style="width:${pa}%;background:${onDark(a)}"></div><div style="width:${ph}%;background:${onDark(h)}"></div></div><span>${ph}% ${esc(h.abbr)}</span></div>`;
  }
  return `<div class="scoreline">${teamHTML(g, a, s, false)}<div class="mid">${mid}</div>${teamHTML(g, h, s, true)}</div>
    ${fieldSVG(g, s, fh)}<div class="situ">${situ}</div>${wp}`;
}

function placeholderHTML(id) {
  const b = board.find((x) => x.id === id);
  return `<div class="scoreline"><div class="team away"><div class="tid"><div class="abbr">${esc(b ? b.away.abbr : "…")}</div></div></div>
    <div class="mid"><div class="per">Loading</div></div>
    <div class="team home"><div class="tid"><div class="abbr">${esc(b ? b.home.abbr : "")}</div></div></div></div>`;
}

const STATE_ORDER = { in: 0, pre: 1, post: 2 };
function render() {
  const wrap = $("#games");
  if (!selected.length) {
    wrap.style.setProperty("--cols", 1); wrap.style.setProperty("--rows", 1);
    wrap.innerHTML = `<div class="empty">No games picked yet.<br><button id="emptyPick">Pick your games</button></div>`;
    $("#emptyPick").onclick = openSheet;
    return;
  }
  $(".empty", wrap)?.remove();
  layout();
  const ids = [...selected].sort((x, y) => {
    const a = gs[x]?.data, b = gs[y]?.data;
    const sa = a ? STATE_ORDER[a.state] : 1, sb = b ? STATE_ORDER[b.state] : 1;
    return sa !== sb ? sa - sb : selected.indexOf(x) - selected.indexOf(y);
  });
  // remove cards no longer picked
  for (const el of [...wrap.querySelectorAll(".game")]) if (!ids.includes(el.dataset.id)) el.remove();
  ids.forEach((id, i) => {
    let el = wrap.querySelector(`.game[data-id="${id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "game"; el.dataset.id = id;
      el.innerHTML = `<div class="content"></div><div class="flash"></div>`;
    }
    if (wrap.children[i] !== el) wrap.insertBefore(el, wrap.children[i] || null);
    const g = gs[id]?.data;
    const content = $(".content", el);
    const paint = (fh) => {
      const html = g ? cardHTML(g, fh) : placeholderHTML(id);
      if (content.dataset.h !== html) { content.innerHTML = html; content.dataset.h = html; }
    };
    paint(Number(el.dataset.fh) || 170);
    // let the field fill whatever height the card has left (its box is sized by the layout, not the drawing)
    const svg = $(".field", content);
    if (svg) {
      const r = svg.getBoundingClientRect();
      const fit = Math.round(Math.max(150, Math.min(380, (r.height / Math.max(1, r.width)) * 1200)));
      if (Math.abs(fit - (Number(el.dataset.fh) || 170)) > 8) { el.dataset.fh = fit; paint(fit); }
    }
    const s = g ? situation(g) : null;
    el.classList.toggle("rz", !!(s && s.redZone));
    for (const st of ["in", "pre", "post"]) el.classList.toggle(st, g?.state === st);
  });
}

// pick the column count that gives the biggest cards (cards look best around 1.75:1)
function layout() {
  const wrap = $("#games"), n = selected.length || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight, gap = 12;
  let best = 1, bestScale = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols - 1)) / cols, ch = (H - gap * (rows - 1)) / rows;
    const scale = Math.min(cw / 1.75, ch);
    if (scale > bestScale + 0.5) { bestScale = scale; best = cols; }
  }
  wrap.style.setProperty("--cols", best);
  wrap.style.setProperty("--rows", Math.ceil(n / best));
}

/* ---------- polling ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// Down, distance, timeouts and possession: ESPN's core API, fetched straight from the browser
// (it allows CORS but blocks Cloudflare's servers).
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
async function fetchSituation(id) {
  try {
    const j = await getJSON(`${CORE}/events/${id}/competitions/${id}/situation`);
    return {
      down: j.down, dist: j.distance, yl: j.yardLine, redZone: !!j.isRedZone,
      homeTO: j.homeTimeouts, awayTO: j.awayTimeouts,
      possession: (String(j.team?.$ref || "").match(/teams\/(\d+)/) || [])[1] || null,
    };
  } catch { return null; }
}

async function loadBoard() {
  try { board = await getJSON("/api/board"); if (!$("#sheet").hidden) renderList(); }
  catch {}
}

async function pollGame(id) {
  const st = gameState(id);
  if (st.inflight) return;
  st.inflight = true;
  try {
    const wasLive = !st.data || st.data.state === "in";
    const [g, sit] = await Promise.all([getJSON(`/api/game/${id}`), wasLive ? fetchSituation(id) : null]);
    if (!selected.includes(id)) return;
    if (sit && g.state === "in") g.sit = sit;
    process(id, g);
    st.err = 0; lastOk = Date.now(); lastErr = false;
    const soon = g.state === "pre" && new Date(g.date) - Date.now() < 15 * 60000;
    st.next = Date.now() + (g.state === "in" ? POLL_LIVE : soon ? POLL_SOON : g.state === "pre" ? POLL_PRE : POLL_POST);
    render();
  } catch {
    st.err++; lastErr = true;
    st.next = Date.now() + POLL_ERR;
  } finally {
    st.inflight = false;
    updateStatus();
  }
}

function tick() {
  const now = Date.now();
  for (const id of selected) { const st = gameState(id); if (!st.inflight && st.next <= now) pollGame(id); }
}

function updateStatus() {
  const el = $("#status");
  el.classList.toggle("err", lastErr);
  const live = selected.filter((id) => gs[id]?.data?.state === "in").length;
  $("#statusText").textContent = lastErr ? "Connection problem, retrying…"
    : lastOk ? `Updated ${new Date(lastOk).toLocaleTimeString("en-GB", { timeZone: TZ })} · ${live} live`
    : "Loading…";
  $("#now").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

/* ---------- turning feed changes into alerts ---------- */
const TURNOVER_PLAYS = new Set([26, 29, 63]); // interception return, fumble recovery (opponent), interception
const NOT_A_SNAP = new Set([2, 12, 21, 52, 53, 65, 66, 79]); // end period, kickoff return, timeout, punt, kickoff, end half/game…

function isFirstDown(g, p) {
  if (!p.s || !p.e || !p.s.team || p.e.team !== p.s.team || p.sp || p.to || NOT_A_SNAP.has(p.t)) return false;
  if (p.e.down !== 1 || !(p.s.down >= 1)) return false;
  if (/1ST DOWN/i.test(p.text)) return true;
  if (p.s.down > 1) return true;
  // 1st down to 1st down: only a new set of downs if the gain covered the distance (not a replayed down)
  return toGo(g, p.s.team, p.s.yl) - toGo(g, p.e.team, p.e.yl) >= p.s.dist;
}

function process(id, g) {
  const st = gameState(id), prev = st.data;
  if (!st.base) {
    g.scoring.forEach((s) => st.seenScore.add(s.id));
    g.drives.forEach((d) => d.result && st.seenDrive.add(d.id));
    g.plays.forEach((p) => st.seenPlay.add(p.id));
    st.base = true; st.data = g;
    return;
  }
  const big = [], small = [];
  const newScoring = g.scoring.filter((s) => !st.seenScore.has(s.id));
  newScoring.forEach((s) => st.seenScore.add(s.id));
  const returnTD = newScoring.some((s) => /return/i.test(s.tt));
  const newPlays = g.plays.filter((p) => !st.seenPlay.has(p.id));
  newPlays.forEach((p) => st.seenPlay.add(p.id));

  // turnovers, as soon as the play shows up
  for (const p of newPlays) {
    if (p.sp || !(TURNOVER_PLAYS.has(p.t) || p.to) || st.seenDrive.has(p.d) || !p.s?.team) continue;
    st.seenDrive.add(p.d);
    if (!returnTD) big.push({ type: "turnover", g, word: p.t === 29 ? "FUMBLE" : "INTERCEPTION", team: other(g, p.s.team), play: p.text, per: p.per, clk: p.clk });
  }
  // drive results: turnovers the play type missed, turnovers on downs, punts and missed kicks
  for (const d of g.drives) {
    if (!d.result || st.seenDrive.has(d.id)) continue;
    st.seenDrive.add(d.id);
    const r = d.result.toUpperCase(), gainer = other(g, d.team);
    if (/TD|TOUCHDOWN|SAFETY|^SF$|END OF/.test(r) || r === "FG") continue;
    if (/INT|FUMBLE/.test(r)) { if (!returnTD) big.push({ type: "turnover", g, word: /INT/.test(r) ? "INTERCEPTION" : "FUMBLE", team: gainer, play: d.lastText }); }
    else if (/DOWNS/.test(r)) big.push({ type: "turnover", g, word: "TURNOVER ON DOWNS", team: gainer, play: d.lastText });
    else small.push({ kind: "poss", team: gainer, text: `${gainer.abbr} ball`, sub: d.display || "Change of possession" });
  }
  // scores
  const before = prev ? { a: away(prev).score ?? 0, h: home(prev).score ?? 0 } : { a: 0, h: 0 };
  for (const s of newScoring) {
    const type = s.kind === "touchdown" || /touchdown/i.test(s.tt) ? "td" : s.kind === "field-goal" || /field goal/i.test(s.tt) ? "fg" : /safety/i.test(s.kind + s.tt) ? "safety" : null;
    if (!type) continue;
    big.push({ type, g, s, team: teamById(g, s.team) || teamById(g, newPlays.at(-1)?.s?.team), before });
  }
  // the end
  if (prev && prev.state === "in" && g.state === "post") big.push({ type: "final", g });
  if (prev && prev.state === "pre" && g.state === "in") small.push({ kind: "kickoff", team: home(g), text: "Kickoff", sub: `${away(g).abbr} at ${home(g).abbr}` });

  // smaller things, only when nothing big happened in this game just now
  if (!big.length) {
    if (opts.firstDown) {
      const fd = newPlays.filter((p) => isFirstDown(g, p)).at(-1);
      if (fd) small.push({ kind: "first", team: teamById(g, fd.s.team), text: "First down", sub: teamById(g, fd.s.team)?.abbr || "" });
    }
    const was = prev && situation(prev), now = situation(g);
    if (now && now.redZone && !(was && was.redZone && was.poss === now.poss)) small.push({ kind: "rz", team: teamById(g, now.poss), text: "Red zone", sub: teamById(g, now.poss)?.abbr || "" });
  }
  st.data = g;
  big.forEach(queueAlert);
  const show = small.filter((x) => x.kind !== "poss" || opts.possession);
  show.forEach((x, i) => setTimeout(() => flashCard(id, x), i * 3400));
}

/* ---------- small alerts, on the card ---------- */
function flashCard(id, x) {
  const el = $(`.game[data-id="${id}"]`);
  if (!el) return;
  const f = $(".flash", el);
  const p = x.kind === "rz" ? { main: "#c62828", accent: "#ffffff", ink: "#ffffff" } : palette(x.team);
  f.style.setProperty("--fc1", p.main); f.style.setProperty("--fc2", p.accent); f.style.setProperty("--fink", p.ink);
  const logo = x.team?.logoDark || x.team?.logo;
  f.innerHTML = `${logo ? `<img src="${esc(logo)}" alt="">` : ""}<span>${esc(x.text)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}`;
  f.classList.remove("show"); void f.offsetWidth; f.classList.add("show");
  el.style.setProperty("--pc", x.kind === "rz" ? "#ff3b3b" : onDark(x.team));
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
}

/* ---------- big alerts, full screen ---------- */
const queue = [];
let current = null, alertTimer = 0, flashTimer = 0, lateTimers = [];
function queueAlert(item) { queue.push(item); if (!current) nextAlert(); }
function nextAlert() {
  clearTimeout(alertTimer); clearInterval(flashTimer); lateTimers.forEach(clearTimeout); lateTimers = [];
  const box = $("#alert");
  const item = queue.shift();
  if (!item) { current = null; box.classList.remove("on"); box.innerHTML = ""; return; }
  current = item;
  alertTimer = setTimeout(nextAlert, showBig(item));
}
$("#alert").addEventListener("click", () => { queue.length = 0; nextAlert(); });

function paint(box, team, flash) {
  const p = palette(team);
  box.style.setProperty("--c1", p.main); box.style.setProperty("--c2", p.accent); box.style.setProperty("--ink", p.ink);
  const stripes = `repeating-linear-gradient(135deg, ${p.cs.map((c, i) => `${c} ${i * 60}px ${(i + 1) * 60}px`).join(", ")})`;
  if (!flash) { box.style.setProperty("--stripes", stripes); return p; }
  let n = 0;
  box.style.setProperty("--stripes", p.cs[0]);
  flashTimer = setInterval(() => {
    n++;
    if (n >= 14) { clearInterval(flashTimer); box.style.setProperty("--stripes", stripes); return; }
    box.style.setProperty("--stripes", p.cs[n % p.cs.length]);
  }, 260);
  return p;
}

function scoreLine(g, a, h, scorerId) {
  const A = away(g), H = home(g);
  const sa = scorerId === A.id ? `<span class="w">${a}</span>` : a, sh = scorerId === H.id ? `<span class="w">${h}</span>` : h;
  return `${esc(A.abbr)} ${sa} – ${sh} ${esc(H.abbr)}`;
}

function headlineFor(item) {
  const { g, s, team, before } = item;
  if (/interception return/i.test(s.tt)) return "Pick six!";
  if (/fumble return/i.test(s.tt)) return "Scoop and score!";
  if (/(punt|kickoff) return/i.test(s.tt)) return "Return touchdown!";
  const isHome = team?.id === home(g).id;
  const us = isHome ? s.h : s.a, them = isHome ? s.a : s.h;
  const usB = isHome ? before.h : before.a, themB = isHome ? before.a : before.h;
  if (us === them) return "Ties it up!";
  if (us > them && usB <= themB) return "Takes the lead!";
  return "";
}

function showBig(item) {
  const box = $("#alert"), g = item.g;
  let team = item.team, word = "", headline = "", play = "", chips = [], score = "", flash = true, party = false, ms = MS[item.type];
  if (item.type === "final") {
    const A = away(g), H = home(g);
    team = (H.score ?? 0) > (A.score ?? 0) ? H : A;
    word = "FINAL";
    headline = g.period > 4 ? "After overtime" : "";
    item.winner = true;
    score = scoreLine(g, A.score, H.score, team.id);
    flash = false; party = true;
  } else if (item.type === "turnover") {
    word = item.word;
    headline = `${team.name} ball`;
    play = cleanPlay(item.play);
    if (item.per) chips.push(`${perName(item.per)} · ${item.clk || ""}`);
    score = scoreLine(g, away(g).score, home(g).score, null);
  } else {
    const s = item.s;
    word = { td: "TOUCHDOWN", fg: "FIELD GOAL", safety: "SAFETY" }[item.type];
    headline = headlineFor(item);
    play = s.text;
    if (s.per) chips.push(`${perName(s.per)} · ${s.clk || ""}`);
    score = scoreLine(g, s.a, s.h, team?.id);
    party = item.type !== "safety";
  }
  const logo = team?.logo || team?.logoDark || "";
  const p = paint(box, team, flash);
  box.innerHTML = `
    <canvas id="confetti"></canvas>
    ${logo ? `<img class="intro" src="${esc(logo)}" alt="">` : ""}
    <div class="box">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : ""}
      <div class="big" style="${word.length > 12 ? "font-size:clamp(2rem,8vh,5rem)" : ""}">${esc(word)}</div>
      <div class="tname">${esc(team?.full || "")}${item.winner ? " win" : ""}</div>
      ${headline ? `<div class="headline">${esc(headline)}</div>` : ""}
      ${play ? `<div class="play">${esc(play)}</div>` : ""}
      ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
      <div class="newscore">${score}</div>
    </div>`;
  box.classList.add("on");
  if (party) lateTimers.push(setTimeout(() => confetti(p.cs), 1600));
  if (item.type === "td") horn(); else if (item.type === "final") { buzzer(); lateTimers.push(setTimeout(horn, 1800)); } else shortHorn();
  return ms;
}

/* ---------- confetti ---------- */
function confetti(colors) {
  const c = document.getElementById("confetti"); if (!c) return;
  const ctx2 = c.getContext("2d");
  const W = (c.width = innerWidth), H = (c.height = innerHeight);
  const parts = Array.from({ length: 180 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.45,
    vx: (Math.random() - 0.5) * 18, vy: -Math.random() * 18 - 6,
    r: Math.random() * 6 + 4, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    col: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    if (!document.getElementById("confetti") || t - t0 > 5000) return;
    ctx2.clearRect(0, 0, W, H);
    for (const q of parts) {
      q.vy += 0.45; q.vx *= 0.99; q.x += q.vx; q.y += q.vy; q.a += q.va;
      ctx2.save(); ctx2.translate(q.x, q.y); ctx2.rotate(q.a);
      ctx2.fillStyle = q.col; ctx2.strokeStyle = "rgba(0,0,0,.25)";
      ctx2.fillRect(-q.r, -q.r / 2, q.r * 2, q.r); ctx2.strokeRect(-q.r, -q.r / 2, q.r * 2, q.r);
      ctx2.restore();
    }
    requestAnimationFrame(frame);
  })(t0);
}

/* ---------- sounds (synthesised, no files) ---------- */
let actx = null;
function tone(freqs, type, pattern, peak, cutoff) {
  if (!opts.sound || !actx) return;
  const t0 = actx.currentTime, end = pattern[pattern.length - 1][1] + 0.2;
  const master = actx.createGain(); master.gain.value = 0.0001; master.connect(actx.destination);
  const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = cutoff; lp.connect(master);
  for (const f of freqs) { const o = actx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(lp); o.start(t0); o.stop(t0 + end); }
  master.gain.setValueAtTime(0.0001, t0);
  for (const [on, off] of pattern) {
    master.gain.exponentialRampToValueAtTime(peak, t0 + on + 0.08);
    master.gain.setValueAtTime(peak, t0 + off - 0.12);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + off);
  }
}
const horn = () => tone([174.6, 220, 261.6], "sawtooth", [[0, 1.45], [1.55, 3.15]], 0.35, 1400);
const shortHorn = () => tone([174.6, 220, 261.6], "sawtooth", [[0, 1.2]], 0.3, 1400);
const buzzer = () => tone([110, 116], "square", [[0, 1.6]], 0.18, 900);

/* ---------- game picker ---------- */
function openSheet() {
  $("#optSound").checked = opts.sound; $("#optFirst").checked = opts.firstDown; $("#optPoss").checked = opts.possession;
  $("#sheet").hidden = false;
  renderList(); loadBoard();
}
function closeSheet() { $("#sheet").hidden = true; }

function rowHTML(b) {
  const on = selected.includes(b.id);
  const t = (x) => `<div class="t"><img src="${esc(x.logo ? x.logo.replace("/500/", "/500-dark/") : "")}" alt="" onerror="this.style.visibility='hidden'">
    ${x.rank ? `<span class="rk">${x.rank}</span>` : ""}<span class="n">${esc(x.name)}</span>${b.state !== "pre" ? `<span class="sc">${x.score ?? ""}</span>` : ""}</div>`;
  const st = b.state === "in" ? `<div class="st live">${esc(b.detail)}${b.redZone ? `<span class="rz">Red zone</span>` : ""}</div>`
    : b.state === "pre" ? `<div class="st">${esc(whenLabel(b.date))}</div>` : `<div class="st">${esc(b.detail)}</div>`;
  return `<button class="row ${on ? "on" : ""}" data-id="${b.id}"><span class="check">${on ? "✓" : ""}</span><span class="teams">${t(b.away)}${t(b.home)}</span>${st}</button>`;
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const match = (b) => !q || [b.away, b.home].some((x) => [x.name, x.abbr, x.full].some((v) => (v || "").toLowerCase().includes(q)));
  const list = board.filter(match);
  const sect = (title, items) => (items.length ? `<h3>${title}</h3>${items.map(rowHTML).join("")}` : "");
  const pickedFirst = (arr) => [...arr].sort((x, y) => (selected.includes(y.id) - selected.includes(x.id)));
  const orphans = selected.filter((id) => !board.some((b) => b.id === id)).map((id) => {
    const g = gs[id]?.data;
    return g ? { id, state: g.state, date: g.date, detail: g.shortDetail, away: away(g), home: home(g), redZone: false } : null;
  }).filter(Boolean);
  $("#list").innerHTML =
    (!board.length ? `<h3>Loading games…</h3>` : "") +
    sect("Live now", pickedFirst(list.filter((b) => b.state === "in"))) +
    sect("Upcoming", pickedFirst(list.filter((b) => b.state === "pre")).sort((x, y) => new Date(x.date) - new Date(y.date))) +
    sect("Final", pickedFirst(list.filter((b) => b.state === "post"))) +
    sect("Picked earlier", orphans);
}

$("#list").addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  const id = row.dataset.id;
  if (selected.includes(id)) { selected = selected.filter((x) => x !== id); delete gs[id]; }
  else { selected.push(id); gameState(id).next = 0; }
  store.set("games", selected);
  renderList(); render(); tick();
});
$("#search").addEventListener("input", renderList);
$("#pickBtn").addEventListener("click", openSheet);
$("#doneBtn").addEventListener("click", closeSheet);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
$("#optSound").addEventListener("change", (e) => { opts.sound = e.target.checked; saveOpts(); paintSound(); });
$("#optFirst").addEventListener("change", (e) => { opts.firstDown = e.target.checked; saveOpts(); });
$("#optPoss").addEventListener("change", (e) => { opts.possession = e.target.checked; saveOpts(); });
function paintSound() { $("#soundBtn").textContent = opts.sound ? "🔊" : "🔇"; }
$("#soundBtn").addEventListener("click", () => { opts.sound = !opts.sound; saveOpts(); paintSound(); });

/* ---------- test alerts (Games panel, or ?demo=td,fg,int,downs,final,first,poss,rz) ---------- */
function testAlert(kind) {
  const id = selected.find((x) => gs[x]?.data?.state === "in") || selected.find((x) => gs[x]?.data);
  const g = id && gs[id].data;
  if (!g) { alert("Pick a game first, then test."); return; }
  const A = away(g), H = home(g), a = A.score ?? 0, h = H.score ?? 0;
  const before = { a, h };
  const mk = (type, tt, text, pts) => ({ type, g, team: A, before, s: { id: "test", team: A.id, tt, text, a: a + pts, h, per: g.period || 2, clk: g.clock || "7:42" } });
  if (kind === "td") queueAlert(mk("td", "Passing Touchdown", `J. Receiver 34 yd pass from A. Quarterback (K. Kicker KICK)`, 7));
  if (kind === "fg") queueAlert(mk("fg", "Field Goal Good", "K. Kicker 47 yd FG GOOD", 3));
  if (kind === "int") queueAlert({ type: "turnover", g, word: "INTERCEPTION", team: H, play: `A. Quarterback pass intercepted by #9 D. Back at the ${A.abbr} 41, returned 22 yards`, per: g.period || 2, clk: g.clock || "7:42" });
  if (kind === "downs") queueAlert({ type: "turnover", g, word: "TURNOVER ON DOWNS", team: A, play: `4th & 2: R. Back rush for 1 yard to the ${H.abbr} 34` });
  if (kind === "final") queueAlert({ type: "final", g: { ...g, teams: g.teams.map((t) => ({ ...t, score: t.homeAway === "home" ? h + 3 : a })) } });
  if (kind === "first") flashCard(id, { kind: "first", team: A, text: "First down", sub: A.abbr });
  if (kind === "poss") flashCard(id, { kind: "poss", team: H, text: `${H.abbr} ball`, sub: "Punt" });
  if (kind === "rz") flashCard(id, { kind: "rz", team: A, text: "Red zone", sub: A.abbr });
}
document.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", () => { closeSheet(); testAlert(b.dataset.test); }));

/* ---------- full screen ---------- */
const fsEl = document.documentElement;
const canFS = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
const isFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function toggleFS() {
  if (isFS()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
}
if (!canFS) $("#fsBtn").remove();
else {
  $("#fsBtn").addEventListener("click", toggleFS);
  const paintFS = () => { $("#fsBtn").textContent = isFS() ? "Exit full screen" : "⛶ Full screen"; setTimeout(render, 150); };
  document.addEventListener("fullscreenchange", paintFS); document.addEventListener("webkitfullscreenchange", paintFS);
  addEventListener("keydown", (e) => { if (e.key === "f" && !e.target.closest("input")) toggleFS(); });
}

/* ---------- keep the screen awake ---------- */
async function keepAwake() {
  try { if ("wakeLock" in navigator && document.visibilityState === "visible") await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); selected.forEach((id) => (gameState(id).next = 0)); tick(); }
});

/* ---------- start ---------- */
$("#go").addEventListener("click", () => {
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {}
  keepAwake();
  $("#start").remove();
  if (!selected.length) openSheet();
});

let resizeTimer = 0;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 120); });

// demo hook for testing: ?demo=td,first … fires once the first game has loaded
const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
  const t = setInterval(() => {
    if (!selected.some((id) => gs[id]?.data)) return;
    clearInterval(t);
    demo.split(",").forEach((k, i) => setTimeout(() => testAlert(k), i * 600));
  }, 300);
}
if (new URLSearchParams(location.search).has("nostart")) $("#start").remove();

paintSound();
render();
loadBoard();
tick();
setInterval(tick, 1000);
setInterval(loadBoard, BOARD_MS);
setInterval(() => { updateStatus(); if (selected.some((id) => gs[id]?.data?.state === "pre")) render(); }, 15000);
updateStatus();
