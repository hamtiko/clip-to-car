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
} from "./generated/pages.js";
import { looksLikeMapLink, isShortMapLink, parseMapLink } from "./maplink.js";

// --- Config knobs (surfaced here per §15) -----------------------------------

const DEFAULT_VAULT_TTL_SECONDS = 120; // credential lifetime in KV
const DEFAULT_PAIR_TTL_SECONDS = 120; // pairing-slot lifetime in KV
const MAX_BODY_BYTES = 8192; // reject oversized POST bodies (§6 validation)
const SHORT_LINK_TIMEOUT_MS = 4000; // cap on the map short-link redirect fetch
const PAIR_ID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes as base64url (no pad)
const B64U_RE = /^[A-Za-z0-9_-]+$/;

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

// Read a JSON body with a size cap. Returns { ok, data } or { ok:false }.
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const isNonEmptyB64u = (v) => typeof v === "string" && v.length > 0 && B64U_RE.test(v);

// --- Map-link enrichment (§9.1) ---------------------------------------------

async function expandShortLink(shortUrl) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SHORT_LINK_TIMEOUT_MS);
    // isShortMapLink() already restricted this to a known Yandex host.
    const res = await fetch(shortUrl, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": "clip-to-car" },
    });
    clearTimeout(timer);
    return res.url || null;
  } catch {
    return null;
  }
}

async function buildLatestRecord(text) {
  const record = { text, ts: Date.now() };
  if (!looksLikeMapLink(text)) return record;
  let toParse = text;
  if (isShortMapLink(text)) {
    const expanded = await expandShortLink(text);
    if (expanded) toParse = expanded;
  }
  const place = parseMapLink(toParse);
  if (place) {
    record.kind = place.kind;
    record.name = place.name;
    record.lat = place.lat;
    record.lon = place.lon;
    record.source = place.source;
  }
  return record;
}

// --- Route handlers ---------------------------------------------------------

async function handleSet(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, "bad request");
  const text = body.data && typeof body.data.text === "string" ? body.data.text : null;
  if (text === null || text.trim() === "") return errorRes(400, "empty text");
  const record = await buildLatestRecord(text);
  await env.CLIPBOARD.put("latest", JSON.stringify(record));
  return json({ ok: true });
}

async function handleLatest(env) {
  const raw = await env.CLIPBOARD.get("latest");
  if (!raw) return json({ text: null, ts: null });
  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ text: null, ts: null });
  }
}

async function handleVaultPut(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, "bad request");
  const d = body.data || {};
  if (d.v !== 1 || !isNonEmptyB64u(d.iv) || !isNonEmptyB64u(d.ct)) {
    return errorRes(400, "bad ciphertext");
  }
  const ttl = Number(env.VAULT_TTL_SECONDS) || DEFAULT_VAULT_TTL_SECONDS;
  const record = { v: 1, iv: d.iv, ct: d.ct, ts: Date.now() };
  await env.CLIPBOARD.put("vault", JSON.stringify(record), { expirationTtl: ttl });
  return json({ ok: true });
}

async function handleVaultPeek(env) {
  const raw = await env.CLIPBOARD.get("vault");
  if (!raw) return json({ present: false, ts: null });
  try {
    const rec = JSON.parse(raw);
    return json({ present: true, ts: rec.ts ?? null });
  } catch {
    return json({ present: false, ts: null });
  }
}

async function handleVaultClaim(env) {
  const raw = await env.CLIPBOARD.get("vault");
  if (!raw) return json({ present: false });
  // Single-use: delete before returning so a second claim finds nothing.
  await env.CLIPBOARD.delete("vault");
  try {
    const rec = JSON.parse(raw);
    return json({ present: true, v: 1, iv: rec.iv, ct: rec.ct, ts: rec.ts ?? null });
  } catch {
    return json({ present: false });
  }
}

async function handlePairPut(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, "bad request");
  const d = body.data || {};
  if (typeof d.id !== "string" || !PAIR_ID_RE.test(d.id)) return errorRes(400, "bad id");
  if (!isNonEmptyB64u(d.iv) || !isNonEmptyB64u(d.ct)) return errorRes(400, "bad payload");
  const ttl = Number(env.PAIR_TTL_SECONDS) || DEFAULT_PAIR_TTL_SECONDS;
  const record = { iv: d.iv, ct: d.ct, ts: Date.now() };
  await env.CLIPBOARD.put(`pair:${d.id}`, JSON.stringify(record), { expirationTtl: ttl });
  return json({ ok: true });
}

async function handlePairClaim(request, env) {
  const body = await readJson(request);
  if (!body.ok) return errorRes(400, "bad request");
  const d = body.data || {};
  if (typeof d.id !== "string" || !PAIR_ID_RE.test(d.id)) return errorRes(400, "bad id");
  const key = `pair:${d.id}`;
  const raw = await env.CLIPBOARD.get(key);
  if (!raw) return json({ present: false });
  await env.CLIPBOARD.delete(key); // single-use
  try {
    const rec = JSON.parse(raw);
    return json({ present: true, iv: rec.iv, ct: rec.ct });
  } catch {
    return json({ present: false });
  }
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
    }

    // Unauthenticated pairing API (safe by design — see §5.1).
    if (method === "POST" && path === "/pair/put") return handlePairPut(request, env);
    if (method === "POST" && path === "/pair/claim") return handlePairClaim(request, env);

    // Authenticated API.
    const authedRoutes =
      (method === "POST" && path === "/set") ||
      (method === "GET" && path === "/latest") ||
      (method === "POST" && path === "/vault") ||
      (method === "GET" && path === "/vault/peek") ||
      (method === "GET" && path === "/vault/claim");

    if (authedRoutes) {
      if (!isAuthed(request, env)) return unauthorized();
      if (path === "/set") return handleSet(request, env);
      if (path === "/latest") return handleLatest(env);
      if (path === "/vault") return handleVaultPut(request, env);
      if (path === "/vault/peek") return handleVaultPeek(env);
      if (path === "/vault/claim") return handleVaultClaim(env);
    }

    return notFound();
  },
};
