import { describe, it, expect } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";

const TOKEN = "test-token-123"; // matches vitest.config.js miniflare binding
const BASE = "https://clip-to-car.test";
const authHeaders = { Authorization: "Bearer " + TOKEN };

function req(path, init = {}) {
  return SELF.fetch(BASE + path, init);
}
function postJSON(path, body, headers = {}) {
  return req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function storeStub() {
  return env.STORE.get(env.STORE.idFromName("clip-to-car"));
}

// Age a stored record so its TTL has lapsed, without waiting in real time.
async function expire(key) {
  await runInDurableObject(storeStub(), async (_inst, state) => {
    const rec = await state.storage.get(key);
    if (rec) await state.storage.put(key, { ...rec, expiresAt: Date.now() - 1000 });
  });
}

describe("pages", () => {
  it("GET / serves the car page as no-store HTML", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toMatch(/Clip.?to.?Car/i);
  });

  it("serves /send, /pair, /vault-view, /nav-benchmark", async () => {
    for (const p of ["/send", "/pair", "/vault-view", "/nav-benchmark"]) {
      const res = await req(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("Content-Type"), p).toMatch(/text\/html/);
    }
  });
});

describe("auth", () => {
  it("rejects the API without a bearer token (401)", async () => {
    expect((await req("/latest")).status).toBe(401);
    expect((await postJSON("/set", { text: "x" })).status).toBe(401);
    expect((await postJSON("/vault", { v: 1, iv: "a", ct: "b" })).status).toBe(401);
    expect((await req("/vault/peek")).status).toBe(401);
    expect((await req("/vault/claim")).status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await req("/latest", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });
});

describe("address flow (§6)", () => {
  it("set -> latest round-trips a plain address", async () => {
    const set = await postJSON("/set", { text: "10 Downing St" }, authHeaders);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true });

    const res = await req("/latest", { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const data = await res.json();
    expect(data.text).toBe("10 Downing St");
    expect(typeof data.ts).toBe("number");
    expect(data.kind).toBeUndefined(); // plain address, not enriched
  });

  it("latest is empty when nothing is stored", async () => {
    // Establish the precondition explicitly rather than relying on the pool's
    // per-test storage isolation, so the test holds whatever order it runs in.
    await runInDurableObject(storeStub(), async (_inst, state) => state.storage.deleteAll());
    const data = await (await req("/latest", { headers: authHeaders })).json();
    expect(data).toEqual({ text: null, ts: null });
  });

  it("rejects empty / whitespace text (400 empty text)", async () => {
    const res = await postJSON("/set", { text: "   " }, authHeaders);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("empty text");
  });

  it("rejects malformed JSON (400)", async () => {
    const res = await req("/set", { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("enriches a real Yandex share (label + coords + short link) with no network", async () => {
    const shared = "Կետը քարտեզի վրա 40.204753,44.542365 https://yandex.ru/maps/-/CTxeFV-J";
    await postJSON("/set", { text: shared }, authHeaders);
    const data = await (await req("/latest", { headers: authHeaders })).json();
    expect(data.kind).toBe("place");
    expect(data.lat).toBeCloseTo(40.204753, 6);
    expect(data.lon).toBeCloseTo(44.542365, 6);
    expect(data.name).toBe("Կետը քարտեզի վրա");
    expect(data.text).toBe(shared); // original preserved for Copy / Open link
  });

  it("enriches a full Yandex map link into a place (no network needed)", async () => {
    await postJSON("/set", { text: "https://yandex.com/maps/?ll=44.512600,40.177200&z=17&text=Republic%20Square" }, authHeaders);
    const data = await (await req("/latest", { headers: authHeaders })).json();
    expect(data.kind).toBe("place");
    expect(data.lat).toBeCloseTo(40.1772, 4);
    expect(data.lon).toBeCloseTo(44.5126, 4);
    expect(data.name).toBe("Republic Square");
    expect(data.text).toContain("yandex.com"); // original preserved
  });
});

describe("vault flow (§6/§7)", () => {
  it("post -> peek -> claim once -> second claim empty", async () => {
    const put = await postJSON("/vault", { v: 1, iv: "aXZfYjY0dQ", ct: "Y3RfYjY0dQ" }, authHeaders);
    expect(put.status).toBe(200);

    const peek = await (await req("/vault/peek", { headers: authHeaders })).json();
    expect(peek.present).toBe(true);
    expect(typeof peek.ts).toBe("number");

    const claim1 = await (await req("/vault/claim", { headers: authHeaders })).json();
    expect(claim1.present).toBe(true);
    expect(claim1.v).toBe(1);
    expect(claim1.iv).toBe("aXZfYjY0dQ");
    expect(claim1.ct).toBe("Y3RfYjY0dQ");

    const claim2 = await (await req("/vault/claim", { headers: authHeaders })).json();
    expect(claim2.present).toBe(false); // single-use

    const peek2 = await (await req("/vault/peek", { headers: authHeaders })).json();
    expect(peek2.present).toBe(false);
  });

  it("peek never returns ciphertext", async () => {
    await postJSON("/vault", { v: 1, iv: "aXY", ct: "Y3Q" }, authHeaders);
    const peek = await (await req("/vault/peek", { headers: authHeaders })).json();
    expect(peek.ct).toBeUndefined();
    expect(peek.iv).toBeUndefined();
  });

  it("expires after its TTL without a claim", async () => {
    await postJSON("/vault", { v: 1, iv: "aXY", ct: "Y3Q" }, authHeaders);
    expect((await (await req("/vault/peek", { headers: authHeaders })).json()).present).toBe(true);

    // DO storage has no native TTL — we enforce it on read. Age the record.
    await expire("vault");

    expect((await (await req("/vault/peek", { headers: authHeaders })).json()).present).toBe(false);
    expect((await (await req("/vault/claim", { headers: authHeaders })).json()).present).toBe(false);
  });

  it("rejects a bad ciphertext body (400)", async () => {
    expect((await postJSON("/vault", { v: 2, iv: "a", ct: "b" }, authHeaders)).status).toBe(400);
    expect((await postJSON("/vault", { v: 1, iv: "", ct: "b" }, authHeaders)).status).toBe(400);
    expect((await postJSON("/vault", { v: 1, iv: "has space", ct: "b" }, authHeaders)).status).toBe(400);
  });
});

describe("pairing flow (§5.1 — unauthenticated by design)", () => {
  const id = "AbCdEfGhIjKlMnOpQrStUv"; // 22-char base64url

  it("put -> claim once -> second claim empty, no auth required", async () => {
    const put = await postJSON("/pair/put", { id, iv: "aXY", ct: "Y3Q" });
    expect(put.status).toBe(200);

    const claim1 = await (await postJSON("/pair/claim", { id })).json();
    expect(claim1.present).toBe(true);
    expect(claim1.iv).toBe("aXY");
    expect(claim1.ct).toBe("Y3Q");

    const claim2 = await (await postJSON("/pair/claim", { id })).json();
    expect(claim2.present).toBe(false); // single-use
  });

  it("claim for an unknown id returns present:false", async () => {
    const data = await (await postJSON("/pair/claim", { id: "ZZZZZZZZZZZZZZZZZZZZZZ" })).json();
    expect(data.present).toBe(false);
  });

  it("expires a pairing slot after its TTL", async () => {
    await postJSON("/pair/put", { id, iv: "aXY", ct: "Y3Q" });
    await expire(`pair:${id}`);
    expect((await (await postJSON("/pair/claim", { id })).json()).present).toBe(false);
  });

  it("rejects a malformed pair id (400)", async () => {
    expect((await postJSON("/pair/put", { id: "short", iv: "a", ct: "b" })).status).toBe(400);
    expect((await postJSON("/pair/claim", { id: "also/bad/id/xxxxxxxxxx" })).status).toBe(400);
  });
});

describe("routing", () => {
  it("unknown route -> 404 JSON", async () => {
    const res = await req("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found");
  });
});
