// clip-to-car — one Cloudflare Worker serving both the HTML pages and the JSON
// API (plan §4/§6). Storage is Workers KV (§7). The server is deliberately
// "blind": it stores/returns ciphertext for credentials and pairing and never
// sees KEY or the optical pairing key W (§5).
//
// Security rules baked in here (§5): every response is `no-store`; no secret or
// user value is ever placed in a URL/query/path (POST bodies only); the server
// performs no crypto.

import {
  CAR_HTML,
  SEND_HTML,
  PAIR_HTML,
  VAULT_HTML,
  NAV_BENCHMARK_HTML,
  BUILD_ID,
  BUILT_AT,
} from "./generated/pages.js";
import {
  looksLikeMapLink,
  isShortMapLink,
  parseMapLink,
  extractUrl,
  parseBareCoords,
  labelFromText,
  parseCoordsFromHtml,
  coordHints,
} from "./maplink.js";
import { ClipStore } from "./store.js";

// The Durable Object class must be exported from the Worker entrypoint so the
// STORE binding in wrangler.toml can resolve it.
export { ClipStore };

// --- Config knobs (surfaced here per §15) -----------------------------------

const DEFAULT_VAULT_TTL_SECONDS = 120; // credential lifetime in KV
const DEFAULT_PAIR_TTL_SECONDS = 120; // pairing-slot lifetime in KV
const MAX_BODY_BYTES = 8192; // reject oversized POST bodies (§6 validation)
const SHORT_LINK_TIMEOUT_MS = 6000; // cap on the map short-link redirect fetch
// How much of a fetched map page to scan. A real Yandex org page hit a 400k
// cap exactly, so this is well above it — the body is already fully read, so a
// larger window costs regex time, not bandwidth.
const MAX_HTML_SCAN = 1500000;
const PAIR_ID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes as base64url (no pad)
const B64U_RE = /^[A-Za-z0-9_-]+$/;

// --- Storage (Durable Object, strongly consistent) --------------------------

// One named instance holds all state, so a write from the phone is visible to
// the car's very next poll regardless of which PoP each one hits. See
// src/store.js for why KV was not viable here.
async function store(env, op, args = {}) {
  const stub = env.STORE.get(env.STORE.idFromName("clip-to-car"));
  const res = await stub.fetch("https://store.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
  return res.json();
}

// --- Response helpers -------------------------------------------------------

const NO_STORE = { "Cache-Control": "no-store" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_STORE,
    },
  });
}

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

const errorRes = (status, message) => json({ error: message }, status);
const unauthorized = () => errorRes(401, "unauthorized");
const notFound = () => errorRes(404, "not found");

// Constant-time-ish string compare so a wrong TOKEN can't be timed out.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAuthed(request, env) {
  const header = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  return safeEqual(m[1], env.TOKEN || "");
}

// Read a JSON body with a size cap. Returns { ok, data } or { ok:false, reason }.
// The reason is specific on purpose: these routes are driven by hand-built
// clients (an iOS Shortcut, curl), where a bare "bad request" gives the author
// nothing to act on. All of it is behind the bearer token anyway.
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, reason: "body too large (max " + MAX_BODY_BYTES + " bytes)" };
  }
  if (text.trim() === "") {
    return { ok: false, reason: 'empty body — expected JSON like {"text":"..."}' };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      reason: 'body is not valid JSON — send a JSON request body, not form or raw text',
    };
  }
}

const isNonEmptyB64u = (v) => typeof v === "string" && v.length > 0 && B64U_RE.test(v);

// --- Map-link enrichment (§9.1) ---------------------------------------------

// Follow a map link and return both where it landed and (a capped slice of)
// the page. Org/place links often carry no coordinates in the expanded URL —
// they are only in the page body — so we need both.
async function fetchExpanded(mapUrl) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SHORT_LINK_TIMEOUT_MS);
    // Callers restrict this to a known map host before calling.
    const res = await fetch(mapUrl, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      // A real UA: some map pages serve a stub to unknown agents.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        "Accept-Language": "en,ru;q=0.8",
      },
    });
    clearTimeout(timer);
    let html = null;
    try {
      html = (await res.text()).slice(0, MAX_HTML_SCAN);
    } catch {
      /* body unreadable — the final URL may still be enough */
    }
    return { finalUrl: res.url || null, html };
  } catch {
    return { finalUrl: null, html: null };
  }
}

function assignPlace(record, place) {
  record.kind = place.kind;
  record.name = place.name;
  record.lat = place.lat;
  record.lon = place.lon;
  record.source = place.source;
}

async function buildLatestRecord(text) {
  const record = { text, ts: Date.now() };

  // 1. Coordinates written directly in the shared text. Preferred: it is exact
  //    and needs no network round-trip to resolve a short link.
  const bare = parseBareCoords(text);
  if (bare) {
    assignPlace(record, {
      kind: "place",
      name: labelFromText(text),
      lat: bare.lat,
      lon: bare.lon,
      source: "shared text",
    });
    return record;
  }

  // 2. Otherwise look for a map URL anywhere in the text (a share is rarely a
  //    bare URL). A short link needs expanding; an org/place link usually keeps
  //    its coordinates in the page body rather than the URL, so read both.
  const url = extractUrl(text) || text;
  if (!looksLikeMapLink(url)) return record;

  let toParse = url;
  let html = null;
  if (isShortMapLink(url) || /\/maps\/org\//.test(url)) {
    const res = await fetchExpanded(url);
    if (res.finalUrl) toParse = res.finalUrl;
    html = res.html;
  }

  const place = parseMapLink(toParse);
  if (place) {
    assignPlace(record, place);
    return record;
  }

  // Coordinates only in the page (a named business, say). `via` records which
  // extractor matched, so a mislocated pin points at the exact strategy.
  const fromHtml = html ? parseCoordsFromHtml(html) : null;
  if (fromHtml) {
    assignPlace(record, {
      kind: "place",
      name: labelFromText(text),
      lat: fromHtml.lat,
      lon: fromHtml.lon,
      source: "page:" + fromHtml.via,
    });
  }
  return record;
}

// --- Route handlers ---------------------------------------------------------

async function handleSet(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, body.reason);
  const raw = body.data ? body.data.text : undefined;
  if (typeof raw !== "string") {
    return errorRes(400, 'expected a "text" field holding a string');
  }
  const text = raw;
  if (text.trim() === "") return errorRes(400, "empty text");
  const record = await buildLatestRecord(text);
  await store(env, "setLatest", { record });
  return json({ ok: true });
}

// Diagnostic: resolve a map link and report exactly what could be extracted.
// Authenticated, and restricted to recognised map hosts — it performs a fetch
// on our behalf, so it must not be an open relay.
async function handleResolve(request) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, body.reason);
  const u = body.data ? body.data.url : undefined;
  if (typeof u !== "string" || !looksLikeMapLink(u)) {
    return errorRes(400, "expected a recognised map url");
  }
  const { finalUrl, html } = await fetchExpanded(u);
  return json({
    finalUrl,
    htmlBytes: html ? html.length : 0,
    fromUrl: finalUrl ? parseMapLink(finalUrl) : null,
    fromHtml: html ? parseCoordsFromHtml(html) : null,
    hints: html ? coordHints(html) : [],
  });
}

async function handleLatest(env) {
  const { record } = await store(env, "getLatest");
  if (!record) return json({ text: null, ts: null });
  return json(record);
}

async function handleVaultPut(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, body.reason);
  const d = body.data || {};
  if (d.v !== 1 || !isNonEmptyB64u(d.iv) || !isNonEmptyB64u(d.ct)) {
    return errorRes(400, "bad ciphertext");
  }
  const ttl = Number(env.VAULT_TTL_SECONDS) || DEFAULT_VAULT_TTL_SECONDS;
  const record = { v: 1, iv: d.iv, ct: d.ct, ts: Date.now() };
  await store(env, "putVault", { record, ttl });
  return json({ ok: true });
}

async function handleVaultPeek(env) {
  const { record } = await store(env, "peekVault");
  if (!record) return json({ present: false, ts: null });
  return json({ present: true, ts: record.ts ?? null });
}

async function handleVaultClaim(env) {
  // Single-use: the store deletes the record as it hands it back.
  const { record } = await store(env, "claimVault");
  if (!record) return json({ present: false });
  return json({ present: true, v: 1, iv: record.iv, ct: record.ct, ts: record.ts ?? null });
}

async function handlePairPut(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, body.reason);
  const d = body.data || {};
  if (typeof d.id !== "string" || !PAIR_ID_RE.test(d.id)) return errorRes(400, "bad id");
  if (!isNonEmptyB64u(d.iv) || !isNonEmptyB64u(d.ct)) return errorRes(400, "bad payload");
  const ttl = Number(env.PAIR_TTL_SECONDS) || DEFAULT_PAIR_TTL_SECONDS;
  const record = { iv: d.iv, ct: d.ct, ts: Date.now() };
  await store(env, "putPair", { id: d.id, record, ttl });
  return json({ ok: true });
}

async function handlePairClaim(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, body.reason);
  const d = body.data || {};
  if (typeof d.id !== "string" || !PAIR_ID_RE.test(d.id)) return errorRes(400, "bad id");
  const { record } = await store(env, "claimPair", { id: d.id }); // single-use
  if (!record) return json({ present: false });
  return json({ present: true, iv: record.iv, ct: record.ct });
}

// --- Router -----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Public pages (no secret embedded; secrets live in the URL fragment or
    // localStorage on the client, never reaching the server).
    if (method === "GET") {
      if (path === "/") return html(CAR_HTML);
      if (path === "/send") return html(SEND_HTML);
      if (path === "/pair") return html(PAIR_HTML);
      if (path === "/vault-view") return html(VAULT_HTML);
      if (path === "/nav-benchmark") return html(NAV_BENCHMARK_HTML);
      // Which build is live. Public: the repo is public and this is only a
      // commit id, but it settles "did my deploy land?" in one request.
      if (path === "/version") return json({ sha: BUILD_ID, builtAt: BUILT_AT });
    }

    // Unauthenticated pairing API (safe by design — see §5.1).
    if (method === "POST" && path === "/pair/put") return handlePairPut(request, env);
    if (method === "POST" && path === "/pair/claim") return handlePairClaim(request, env);

    // Authenticated API.
    const authedRoutes =
      (method === "POST" && path === "/set") ||
      (method === "POST" && path === "/resolve") ||
      (method === "GET" && path === "/latest") ||
      (method === "POST" && path === "/vault") ||
      (method === "GET" && path === "/vault/peek") ||
      (method === "GET" && path === "/vault/claim");

    if (authedRoutes) {
      if (!isAuthed(request, env)) return unauthorized();
      if (path === "/set") return handleSet(request, env);
      if (path === "/resolve") return handleResolve(request);
      if (path === "/latest") return handleLatest(env);
      if (path === "/vault") return handleVaultPut(request, env);
      if (path === "/vault/peek") return handleVaultPeek(env);
      if (path === "/vault/claim") return handleVaultClaim(env);
    }

    return notFound();
  },
};
