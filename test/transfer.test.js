import { beforeEach, describe, it, expect } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { encryptJSON, decryptJSON, genKeyB64u, b64uEncode, randomBytes } from "../src/crypto.js";

const BASE = "https://clip-to-car.test";
const headers = { Authorization: "Bearer test-token-123", "Content-Type": "application/json" };
const stub = () => env.STORE.get(env.STORE.idFromName("clip-to-car"));
const post = (path, data, auth = true) => SELF.fetch(BASE + path, { method: "POST", headers: auth ? headers : {}, body: JSON.stringify(data) });
const peek = () => SELF.fetch(BASE + "/outbox/peek", { headers });
const id = () => b64uEncode(randomBytes(16));
const wire = (transferId = id()) => ({ id: transferId, v: 1, iv: "a".repeat(16), ct: "b".repeat(24) });

describe("car-to-device reports", () => {
  beforeEach(async () => {
    // The Workers pool shares storage between tests in this file.
    const meta = await (await peek()).json();
    if (meta.present) await post("/outbox/delete", { id:meta.id });
  });
  it("serves both transfer pages and requires authentication on every API operation", async () => {
    for (const path of ["/from-car", "/receive"]) {
      const res = await SELF.fetch(BASE + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    for (const path of ["/outbox", "/outbox/read", "/outbox/delete"]) {
      expect((await post(path, wire(), false)).status).toBe(401);
    }
    expect((await SELF.fetch(BASE + "/outbox/peek")).status).toBe(401);
    expect((await SELF.fetch(BASE + "/outbox/peek", { headers: { Authorization:"Bearer wrong" } })).status).toBe(401);
  });

  it("preserves a large Unicode JSON report across chunks, repeated reads, and explicit deletion", async () => {
    const key = genKeyB64u();
    const text = " \n" + JSON.stringify({ report: Array.from({ length: 7000 }, (_, i) => ({ i, name: "XPeng Երևան 🚗", data: "some diagnostic details" })) }, null, 2) + "\n ";
    const encrypted = { ...await encryptJSON(key, { text }), id: id() };
    expect(encrypted.ct.length).toBeGreaterThan(128 * 1024);
    const put = await post("/outbox", encrypted);
    expect(put.status).toBe(200);
    const putData = await put.json();
    expect(putData.expiresAt).toBeGreaterThan(Date.now());
    const metadata = await (await peek()).json();
    expect(metadata.id).toBe(encrypted.id);
    expect(metadata.iv).toBeUndefined(); expect(metadata.ct).toBeUndefined();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post("/outbox/read", { id: encrypted.id });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const received = await res.json();
      expect((await decryptJSON(key, received.iv, received.ct)).text).toBe(text);
    }
    await runInDurableObject(stub(), async (_instance, state) => {
      const chunks = await state.storage.list({ prefix: "outbox:" });
      expect(chunks.size).toBeGreaterThan(1);
      for (const value of chunks.values()) expect(value.length).toBeLessThan(128 * 1024);
    });
    expect((await post("/outbox/delete", { id: encrypted.id })).status).toBe(200);
    expect((await (await peek()).json()).present).toBe(false);
    expect((await post("/outbox/read", { id: encrypted.id })).status).toBe(404);
    await runInDurableObject(stub(), async (_instance, state) => expect((await state.storage.list({ prefix: "outbox" })).size).toBe(0));
  });

  it("accepts an identical retry, refuses a conflicting send, and isolates the existing phone-to-car slots", async () => {
    await post("/set", { text: "Phone to car" });
    await post("/vault", { v:1, iv:"aXY", ct:"Y3Q" });
    const report = wire();
    const first = await (await post("/outbox", report)).json();
    const retry = await (await post("/outbox", report)).json();
    expect(retry.expiresAt).toBe(first.expiresAt);
    expect((await post("/outbox", wire())).status).toBe(409);
    expect((await post("/outbox", { ...report, ct: "c".repeat(24) })).status).toBe(409);
    expect((await (await SELF.fetch(BASE + "/latest", { headers })).json()).text).toBe("Phone to car");
    expect((await (await SELF.fetch(BASE + "/vault/peek", { headers })).json()).present).toBe(true);
  });

  it("allows only one of two concurrent sends to win", async () => {
    const results = await Promise.all([post("/outbox", wire()), post("/outbox", wire())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it("refuses stale reads/deletes so they cannot remove a newer report", async () => {
    const old = wire(), current = wire();
    await post("/outbox", old);
    await post("/outbox/delete", { id:old.id });
    await post("/outbox", current);
    expect((await post("/outbox/read", { id:old.id })).status).toBe(404);
    expect((await post("/outbox/delete", { id:old.id })).status).toBe(404);
    expect((await (await peek()).json()).id).toBe(current.id);
  });

  it("deletes expired metadata and every chunk via the alarm, and permits another send", async () => {
    const report = wire();
    await post("/outbox", report);
    await runInDurableObject(stub(), async (instance, state) => {
      const meta = await state.storage.get("outbox");
      expect(await state.storage.getAlarm()).toBe(meta.expiresAt);
      await state.storage.put("outbox", { ...meta, expiresAt: Date.now() - 1 });
      await instance.alarm();
      expect((await state.storage.list({ prefix: "outbox" })).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect((await post("/outbox/read", { id:report.id })).status).toBe(404);
    expect((await post("/outbox", wire())).status).toBe(200);
  });

  it("rejects malformed or oversized uploads without storing a partial report", async () => {
    for (const report of [{}, { ...wire(), v:2 }, { ...wire(), id:"bad" }, { ...wire(), iv:"bad" }, { ...wire(), ct:"?".repeat(24) }]) {
      expect((await post("/outbox", report)).status).toBe(400);
    }
    expect((await post("/outbox", { ...wire(), ct:"a".repeat(2 * 1024 * 1024) })).status).toBe(413);
    expect((await (await peek()).json()).present).toBe(false);
  });
});
