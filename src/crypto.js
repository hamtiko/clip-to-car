// Shared crypto + encoding helpers — the SINGLE source of truth used by the
// phone sender, the car vault view, and the QR-pairing pages. The build step
// (build.mjs) inlines this file into each page by stripping the `export`
// keywords, so the exact same code runs on both sides of every handoff.
//
// Contract (plan §8), do not change without bumping the wire `v`:
//   - AES-GCM, 256-bit key, 96-bit (12-byte) random IV per message,
//     128-bit auth tag (WebCrypto appends the tag to the ciphertext).
//   - Key distributed as base64url (no padding).
//   - Wire format: { v:1, iv:<base64url>, ct:<base64url> } where ct is
//     ciphertext||tag as returned by crypto.subtle.encrypt.
//
// Runs unchanged in the browser, in a Cloudflare Worker, and in Node 20+
// (all expose WebCrypto as the global `crypto`).

// --- base64url (no padding) -------------------------------------------------

// Encode bytes (ArrayBuffer or Uint8Array) as base64url without `=` padding.
export function b64uEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode a base64url string to a Uint8Array. Tolerates padding and whitespace.
export function b64uDecode(str) {
  const clean = String(str).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 === 0 ? "" : "=".repeat(4 - (clean.length % 4));
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- key material -----------------------------------------------------------

// `n` cryptographically-random bytes.
export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// A fresh 256-bit key as a base64url string (for generating KEY in-browser).
export function genKeyB64u() {
  return b64uEncode(randomBytes(32));
}

// Accept a key as either a base64url string or raw 32 bytes; return bytes.
function keyToBytes(key) {
  return typeof key === "string" ? b64uDecode(key) : new Uint8Array(key);
}

async function importKey(key, usage) {
  const bytes = keyToBytes(key);
  if (bytes.length !== 32) {
    throw new Error("key must be 32 bytes (256-bit); got " + bytes.length);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
}

// --- AES-GCM over JSON ------------------------------------------------------

// Encrypt a JS value as JSON. Returns the wire object { v:1, iv, ct } with
// base64url fields, ready to be POSTed as-is.
export async function encryptJSON(key, obj) {
  const cryptoKey = await importKey(key, ["encrypt"]);
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
  return { v: 1, iv: b64uEncode(iv), ct: b64uEncode(ct) };
}

// Decrypt the base64url { iv, ct } pair back into the original JS value.
// Throws on a wrong key or tampered ciphertext (GCM auth-tag failure) — callers
// must surface that as an explicit error, never a silent empty state (§8).
export async function decryptJSON(key, ivB64u, ctB64u) {
  const cryptoKey = await importKey(key, ["decrypt"]);
  const iv = b64uDecode(ivB64u);
  const ct = b64uDecode(ctB64u);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
