// Map-link parsing for Phase 2 (§9.1). PURE string logic only — no network —
// so it is fully unit-testable. The Worker does short-link redirect expansion
// (a fetch) around these helpers and stays backward-compatible: a plain address
// that these functions don't recognize just flows through as `text`.
//
// Yandex coordinate order is lon,lat in `ll=`, `pt=`, and `whatshere[point]=`.

function safeUrl(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    return new URL(t);
  } catch {
    return null;
  }
}

function isYandexHost(url) {
  // yandex.com / yandex.ru / yandex.com.tr / maps.yandex.* / ya.ru ...
  return /(^|\.)yandex\.[a-z.]+$/i.test(url.hostname) || /(^|\.)ya\.ru$/i.test(url.hostname);
}

// Does this text look like a Yandex Maps / Navigator link we might resolve?
export function looksLikeMapLink(text) {
  const url = safeUrl(text);
  if (!url) return false;
  if (!isYandexHost(url)) return false;
  return /\/maps(\/|$|\?)/i.test(url.pathname + url.search) ||
    /\/navi(\/|$|\?)/i.test(url.pathname) ||
    /^maps\./i.test(url.hostname);
}

// Short links (…/maps/-/CODE) carry no coordinates and must be expanded by
// following their redirect before parsing.
export function isShortMapLink(text) {
  const url = safeUrl(text);
  if (!url) return false;
  return isYandexHost(url) && /\/-\//.test(url.pathname);
}

function parseLonLat(pair) {
  // "lon,lat" → { lat, lon } with range validation, else null.
  if (typeof pair !== "string") return null;
  const m = pair.split(",");
  if (m.length !== 2) return null;
  const lon = Number(m[0]);
  const lat = Number(m[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// Parse an (already-expanded) Yandex Maps URL into a place, or null if it has
// no usable coordinates (e.g. an org/place link that needs a geocoder).
export function parseMapLink(text) {
  const url = safeUrl(text);
  if (!url || !isYandexHost(url)) return null;
  const q = url.searchParams;

  // Coordinates, in priority order. All are lon,lat.
  const coords =
    parseLonLat(q.get("whatshere[point]")) ||
    parseLonLat(q.get("pt")) ||
    parseLonLat(q.get("ll"));
  if (!coords) return null;

  // Place name: `text=` is the human label; fall back to `whatshere[]`.
  const name = (q.get("text") || q.get("whatshere") || "").trim() || null;

  return {
    kind: "place",
    name,
    lat: coords.lat,
    lon: coords.lon,
    source: url.hostname,
  };
}

// --- free-text shares -------------------------------------------------------
// Real shares are not bare URLs. Yandex's "point on the map" share looks like:
//   "Կետը քարտեզի վրա 40.204753,44.542365 https://yandex.ru/maps/-/CTxeFV-J"
// i.e. a label, a coordinate pair, and a short link, in one string.

// First http(s) URL embedded anywhere in the text (trailing punctuation trimmed).
export function extractUrl(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, "") : null;
}

// A bare "lat,lon" pair inside free text.
//
// NOTE THE ORDER: plain-text coordinate pairs are lat,lon (the usual geographic
// convention, and what Yandex puts in its share text), whereas Yandex URL
// params ll=/pt=/whatshere[point]= are lon,lat. Do not unify these.
//
// At least three decimal places are required so ordinary prose with two
// comma-separated numbers ("Apt 12, 34") cannot be mistaken for a location.
export function parseBareCoords(text) {
  if (typeof text !== "string") return null;
  // Strip URLs first. Coordinates inside a Yandex URL are lon,lat and belong to
  // parseMapLink; reading them here as lat,lon silently swaps them.
  const prose = text.replace(/https?:\/\/[^\s<>"']+/g, " ");
  // The digit guards stop "200.1234" from matching as "00.1234".
  const m = prose.match(/(?<![\d.])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?![\d.])/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// Whatever is left once the coordinates and the URL are removed — the human
// label Yandex prefixes to the share. Null when nothing meaningful remains.
export function labelFromText(text) {
  if (typeof text !== "string") return null;
  const rest = text
    .replace(/https?:\/\/[^\s<>"']+/g, " ")
    .replace(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest || null;
}
