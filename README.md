# clip-to-car

A tiny personal tool to move text — first **addresses**, later **credentials** — from an
iPhone to an **XPeng P7+** (China-spec) car screen, where no third-party apps can be
installed. The car opens one bookmarked page in its built-in browser, the value appears with
a big **Copy** button, and one tap puts it on the car's clipboard to paste into native
navigation or an app's login fields.

Everything is one **Cloudflare Worker** — it serves the pages *and* the JSON API, so there is
a single deploy, one origin (no CORS), and a generous free tier. Storage is a single
**Durable Object** (strongly consistent — see [Why not KV](#why-not-kv)).

> Full design rationale lives in the build plan. This README is the operator's guide:
> how to deploy it, provision the car, and use it.

---

## What's in the box

| Phase | What | Status |
|------|------|--------|
| 1 | **Address hand-off** — phone → car, plaintext, persists | ✅ **live on the car** |
| 1.5 | **QR pairing** — provision the car without typing secrets | ✅ **live on the car** |
| 2 | **Map link → place** — resolve a Yandex share to name + coords, open in maps | ✅ **live on the car** (one-tap nav ruled out — [why](#why-one-tap-navigation-doesnt-work-and-what-would-fix-it)) |
| 3 | **Encrypted credentials** — E2E-encrypted, single-use, TTL, auto-clear | ✅ built & tested, **not yet exercised live** |

The server never sees credential plaintext, the encryption `KEY`, or the pairing key `W` — it
only stores and returns ciphertext.

---

## Architecture

```
 iPhone                         Cloudflare Worker (one URL)              Car browser
 ──────                         ───────────────────────────             ───────────
 Address:  Shortcut ─POST /set──►  GET  /            car page  ◄──bookmark  polls /latest
                                   POST /set   (auth)                       tap → Copy
 Credential: /send page ─POST───►  GET  /latest (auth)
   (encrypts in-browser)           POST /vault (auth)          ◄──bookmark  /vault-view
                                   GET  /vault/peek  (auth)                 Reveal → claim
                                   GET  /vault/claim (auth,1-use)          decrypt in-browser
 Pairing:   /pair page ─POST────►  POST /pair/put            ◄── QR ── car shows QR
                                   POST /pair/claim (1-use)               car decrypts W
                              Durable Object: latest · vault · pair:<id>
```

Two independent secrets:

- **`TOKEN`** — bearer auth. The server knows it. Sent as `Authorization: Bearer <TOKEN>`.
  Keeps strangers out.
- **`KEY`** — the AES-256 key for credentials (Phase 3). The server **never** sees it. Lives
  only on the phone sender and the car; used purely for `crypto.subtle`.

---

## Repository layout

```
clip-to-car/
  wrangler.toml          # Worker, Durable Object binding + migration
  build.mjs              # inlines shared helpers into pages -> src/generated/pages.js
  src/
    worker.js            # routing, auth, handlers (the API)
    store.js             # ClipStore Durable Object — all persisted state
    crypto.js            # SINGLE source of the base64url + AES-GCM helpers (§8)
    maplink.js           # Yandex share/link parsing -> coordinates (§9.1)
    navschemes.js        # nav deep-link catalogue + on-car results
    qr.js                # vendored QR generator (MIT, no CDN)
    pages/
      car.html           # address/place view + QR pairing mode
      vault.html         # car credential view  (served at /vault-view)
      send.html          # phone credential sender (/send)
      pair.html          # phone pairing page (/pair)
      nav-benchmark.html # Spike 3 tool (/nav-benchmark)
  test/                  # vitest (Workers pool): api, crypto, maplink
```

`src/crypto.js` is the single source of truth for the crypto helpers; `build.mjs` inlines it
(and `qr.js`) into the pages so the exact same code runs on phone and car — no copy-paste.
`src/generated/` is a build artifact (git-ignored); `wrangler deploy` and `npm test` rebuild it.

---

## Prerequisites

- **Node.js 22+** (Wrangler 4 requires `node >=22`; Node 24/26 are fine). npm ships with it.
  - npm **11+** recommended — npm 10 has an arborist bug that crashes on Vitest 4's peer graph
    (`Cannot read properties of null (reading 'edgesOut')`). If you hit it, run the install with
    `npx npm@11 install`.
- **git**, and a **Cloudflare account** (the free plan is enough: Workers 100k req/day, and
  SQLite-backed Durable Objects are free-plan eligible).
- A **browser** on the machine — `wrangler login` approves via OAuth in the browser.

Wrangler is a devDependency (run via `npx wrangler`) — no global install needed. macOS, Linux and
Windows all work.

## Deploy

```bash
npm install
npx wrangler login

# 1. Set the auth token (generate a strong one)
openssl rand -hex 16              # copy the output
npx wrangler secret put TOKEN     # paste it when prompted

# 2. Deploy (build.mjs runs automatically via [build] command; the Durable
#    Object migration applies itself on the first deploy)
npm run deploy
```

Your Worker is now at `https://clip-to-car.<your-subdomain>.workers.dev`. Load it — you should
see the car page (in pairing mode, since the car has no secret yet).

### Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` deploys on every push to `main`, after the test suite passes.
Docs-only pushes are skipped. You can also run it by hand from the **Actions** tab
(*Deploy → Run workflow*).

It needs two repository secrets — **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → use the **"Edit Cloudflare Workers"** template → scope it to your account. Copy it immediately; it is shown only once. |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami`, or the Workers & Pages sidebar in the dashboard. Not secret, but kept out of the repo. |

The Worker's own `TOKEN` secret is **not** managed by CI — `wrangler deploy` never touches
secrets set with `wrangler secret put`, so it survives every deploy.

Local `npm run deploy` keeps working; use it when you want to push a change without a commit.

### Generate the encryption KEY (Phase 3)

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='    # base64url, no padding
```

Cross-platform equivalents using the Node you already have (handy on Windows):

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"        # TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # KEY
```

Keep `TOKEN` and `KEY` somewhere safe (a password manager). They are **not** stored in the repo.

---

## Bookmarks & provisioning

Let `BASE = https://clip-to-car.<your-subdomain>.workers.dev`.

| Where | Bookmark | Notes |
|-------|----------|-------|
| **Car — main** | `BASE/` | No secrets in the URL. On first open it shows a **QR**; scan it with the iPhone to pair (below). |
| **Car — credentials** | `BASE/vault-view` | Reuses the paired secrets from the car's `localStorage`. |
| **Phone — sender** | `BASE/send#t=TOKEN&k=KEY` | First open remembers the secrets on the phone (so `/pair` can reuse them). |
| **Phone — pairing** | opened from the QR, not bookmarked | The QR encodes `BASE/pair#id=…&w=…`. |

**Fallback (no pairing):** if pairing isn't usable on the car, bookmark
`BASE/#t=TOKEN&k=KEY` (address view) and `BASE/vault-view#t=TOKEN&k=KEY` directly. The page
reads the secrets from the `#…` fragment (never sent to the server), stores them, and strips
them from the visible address bar.

### Pairing the car (the car shows, the phone scans)

The car browser can't scan, but it can display, and the iPhone camera scans natively — so the
direction is reversed:

1. Open `BASE/` on the car. With no stored secret it shows a QR encoding `BASE/pair#id=…&w=…`.
   `w` is a fresh one-time key generated by the car; it rides in the **fragment**, so it goes
   phone-side optically and **never touches the network**.
2. Point the iPhone camera at the car screen and tap the link. The `/pair` page opens.
3. `/pair` loads `TOKEN`+`KEY` from the phone's `localStorage` (or asks you to paste them once),
   encrypts `{t,k}` under `w`, and POSTs only ciphertext to the Worker.
4. The car's next poll claims that ciphertext (single-use), decrypts it with the `w` it kept,
   stores `TOKEN`+`KEY` locally, and switches to the address view.

The server only ever holds `{iv,ct}` for `pair:<id>` — never `w`, `TOKEN`, or `KEY`. Clearing
the car browser's data de-authorizes the car (you just re-pair).

---

## iOS Shortcut for addresses (Phase 1)

Addresses stay plaintext and use a Shortcut (fast, no page to open):

### One-tap install

Open this on the iPhone and Shortcuts will install it, asking only for your token:

**`BASE/shortcut`**

The Worker generates the shortcut with its own URL already baked in, so the
`TOKEN` — filled in by an import question — is the only thing you type. The file
contains no secret, so the link is safe to keep in this README.

It installs as **To Car**: share text or a map link from any app, or run it from the
Home Screen / Siri to send whatever is on the clipboard.

> **If Shortcuts refuses to import it**, iOS is blocking unsigned shortcuts. Enable
> **Settings → Shortcuts → Advanced → Allow Untrusted Shortcuts** (the toggle only
> appears once you have run at least one shortcut), then open the link again. If it
> still will not import, build it by hand from the steps below and tell me — the
> generated file is the one piece of this I cannot test from here.

### Building it by hand (fallback)

Build it so it works **both** from the Share Sheet and from the clipboard:

1. **Shortcuts → +**, then open the shortcut's **ⓘ Details**:
   - Enable **Show in Share Sheet**.
   - Under **Share Sheet Types**, keep only **Text** and **URLs** (richer types can arrive as
     objects rather than a string).
2. The shortcut now starts with **"Receive [Text and URLs] input from Share Sheet"**. Tap
   **"If there's no input"** and set it to **Get Clipboard**. That one setting makes the same
   shortcut work from the Share Sheet *and* when launched from the Home Screen or Siri — no
   `If` block needed. (Don't add a separate *Get Clipboard* action; it would ignore the
   shared item.)
3. Add a **Text** action containing the **Shortcut Input** variable. This coerces a shared URL
   object into a plain string.
4. Add **Get Contents of URL**:
   - URL: `BASE/set`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer YOUR_TOKEN`, `Content-Type` = `application/json`
   - Request Body: **JSON** → key `text`, value = the **Text** variable from step 3.
     (`/set` also accepts a raw `text/plain` body, which is what the generated
     shortcut posts — simpler to configure than a nested JSON field.)
5. (Optional) add **Show Result** to confirm `{"ok":true}`.
6. Rename it (e.g. "To Car").

Now either path works: **share** an address or a map link from any app, or **copy** it and run
the shortcut. It appears on the car within one poll (~3s).

Sharing a **Yandex Maps link** is the Phase 2 case — the Worker expands and parses it, and the
car shows the place name + coordinates instead of a raw URL.

> Credentials do **not** go through this Shortcut — iOS Shortcuts can't do AES-GCM. Use the
> `/send` page, which encrypts in Safari's `crypto.subtle`.

---

## Troubleshooting

**Read *who* sent the error first — it localizes the fault immediately:**

| What you see | Who answered | Meaning |
|---|---|---|
| Cloudflare-branded **HTML** "400 Bad Request" | Cloudflare edge | The request is malformed HTTP. **The Worker never ran.** |
| **JSON** `{"error":"…"}` | The Worker | The request arrived; the message names the problem. |
| JSON `{"error":"unauthorized"}` | The Worker | `TOKEN` missing or wrong. |

**iOS Shortcut sends a Cloudflare HTML 400.** Something in the *URL or headers* is malformed —
the body is not the issue. The classic cause is an **empty header row** in *Get Contents of URL*
(a blank Key with a blank value): an empty header name is invalid HTTP and the edge rejects it.
Delete the blank row. Also check the URL field is plain text with no stray variable chips.

**Sharing does nothing / posts the wrong thing.** Restrict the *Receive from Share Sheet* action
to **Text** and **URLs** only. The default accepts Apps, Files and Images, and a rich object
shared from another app will not serialize into a usable `text` string.

## curl smoke tests

```bash
BASE=https://clip-to-car.<your-subdomain>.workers.dev
TOKEN=your-token

# auth is enforced (expect 401)
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/latest"

# address round-trip
curl -s -X POST "$BASE/set" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"text":"Republic Square, Yerevan"}'
curl -s "$BASE/latest" -H "Authorization: Bearer $TOKEN"; echo

# map link -> place enrichment
curl -s -X POST "$BASE/set" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"https://yandex.com/maps/?ll=44.512600,40.177200&z=17&text=Republic%20Square"}'
curl -s "$BASE/latest" -H "Authorization: Bearer $TOKEN"; echo   # -> kind":"place", lat, lon

# vault (dummy ciphertext) — post, peek, claim once, claim again
curl -s -X POST "$BASE/vault" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"v":1,"iv":"aXY","ct":"Y3Q"}'
curl -s "$BASE/vault/peek"  -H "Authorization: Bearer $TOKEN"; echo   # present:true
curl -s "$BASE/vault/claim" -H "Authorization: Bearer $TOKEN"; echo   # returns it
curl -s "$BASE/vault/claim" -H "Authorization: Bearer $TOKEN"; echo   # present:false (single-use)
```

---

## Configuration knobs

- **Server** (`src/worker.js`, top of file): `DEFAULT_VAULT_TTL_SECONDS` (120),
  `DEFAULT_PAIR_TTL_SECONDS` (120), `MAX_BODY_BYTES`, `SHORT_LINK_TIMEOUT_MS`.
  Override the TTLs without editing code via `wrangler.toml` `[vars]`
  `VAULT_TTL_SECONDS` / `PAIR_TTL_SECONDS`.
- **Car page** (`src/pages/car.html`): `POLL_MS` (3000), `PAIR_POLL_MS`, `NAV_SCHEMES`.
- **Car vault view** (`src/pages/vault.html`): `PEEK_POLL_MS`, `CLEAR_MS` (clipboard auto-clear, 20s).

---

## Why not KV

The first implementation stored everything in Workers KV. It failed in practice: KV is
**eventually consistent**, and this app is a cross-device read-after-write — the phone writes,
the car polls — with the two requests landing on different Cloudflare PoPs. Measured on the
real deployment, a write from the phone took *tens of seconds* to become visible to the car:
pairing appeared to hang, and the "address shows up in ~3s" promise would have been a minute.
KV offers no fix — `cacheTtl` has a 60s floor.

A single Durable Object instance is strongly consistent with read-your-writes globally, so a
write is visible to the very next poll from anywhere. The tradeoff is that all requests reach
one object's location; for a single-owner tool that is the right trade. DO storage has no
native TTL, so the vault and pairing slots carry an `expiresAt` enforced on read.

## Security model (summary)

- Every API route except the pages requires `Authorization: Bearer <TOKEN>`.
- Credentials are AES-256-GCM encrypted **in the browser** on the phone and decrypted **in the
  browser** on the car. The Worker stores/returns only `{v,iv,ct}`; it performs no crypto.
- No secret or user value is ever put in a URL query/path — POST bodies and the `Authorization`
  header only. Fragments (`#…`) are client-only and never sent to the server.
- All responses are `Cache-Control: no-store`.
- Credentials are single-use (deleted on claim), TTL-bound in the Durable Object, and the
  clipboard auto-clears a few seconds after paste.

**Accepted risks:** anyone with physical access to the car while a value is on-screen, or with
the car's stored secrets, can see it. The car is a semi-shared device — don't send anything you
wouldn't want a passenger to glimpse. Addresses are plaintext (low sensitivity).

---

## Tests

```bash
npm test        # builds, then runs vitest in the Cloudflare Workers pool
```

Covers: auth on/off, `/set` validation + map-link enrichment, `/latest` shape, vault
post/peek/claim single-use, pairing put/claim single-use, and the crypto wire format
(round-trip, wrong-key failure, tamper detection, fresh IV, phone↔car interop).

---

## On-car results

Verified on the actual XPeng P7+ (Xmart OS):

- ✅ **Spike 1 — clipboard survives an app switch.** Copy on the car page, switch to a native
  app, paste works. This was the gate for the whole paste model.
- ✅ **Spike 2 — car storage + crypto.** The car pairs by QR and stays paired, so
  `localStorage` persists and `crypto.subtle` is available.
- 🟡 **Spike 3 — nav launch.** Partially answered; see below.

### Nav launch: what the car does

Recorded per-scheme as `status` in `src/navschemes.js`, so results live in the repo rather
than in memory. Schemes marked `works` are promoted to real buttons automatically.

| Mechanism | Result |
|---|---|
| `geo:` and `intent://…scheme=geo` | ✅ Opens a map at the point — but you must still tap **Get directions** |
| `yandexnavi://build_route_on_map` | 🟡 **Opens Yandex Navigator** but does not start routing |
| AMap (`androidamap`/`amapuri`, both packages) | ❌ Nothing — this car does not appear to run AMap |
| Yandex web route | ✅ Always opens (in the browser, by definition) |

| `google.navigation:` (bare and intent) | ❌ Nothing registers for it |
| Yandex **Maps** app (`yandexmaps://`) | ❌ Nothing — Maps is not installed; **Navigator** is |

**Yandex Navigator IS installed** — the plan assumed no Yandex app could be present on a
China-spec car. Note Navigator and Yandex Maps are *different apps*; only Navigator is here.

### Why one-tap navigation doesn't work

Every Navigator command failed — bare and `intent://`-wrapped, route and show-point. The
syntax is not the problem; it matches Yandex's published scheme exactly.

The cause is that **Yandex requires third-party launches to be signed with an access key**:

```
yandexnavi://<path>?<params>&client=<client id>&signature=<signature>
```

Unsigned launches are restricted from Navigator 2.40 onward (reportedly ~5 per device per
day), which is precisely the observed behaviour: the app opens and the command is discarded.
See Yandex's [commercial-use terms](https://yandex.ru/dev/navigator/doc/ru/concepts/navigator-commercial-use)
and [access-key signing](https://yandex.ru/dev/navigator/doc/ru/concepts/navigator-commercial-use-signature).

**Decision: closed, not pursued.** Yandex only issues an access key to an app published on
the Play Store — absurd overhead for a personal tool with one user. One-tap navigation into
Navigator is off the table.

**What ships:** `geo:` as the primary **Open in maps** button. It opens the point in a map and
the driver taps **Get directions** once. Tapping twice is a fine price for not shipping an app
to a store.

Every candidate remains recorded in `src/navschemes.js` with what the car actually did, and
`/nav-benchmark` still renders the full list — so if the situation ever changes, the evidence
is there rather than needing to be rediscovered. The car page itself shows only what works.
```
