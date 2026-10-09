// Durable Object backing the clip-to-car state.
//
// WHY THIS EXISTS: Workers KV is eventually consistent. The whole product is a
// cross-device read-after-write — the phone writes, the car polls — and those
// two requests land on different Cloudflare PoPs. Measured on the real deploy,
// a write from the phone took tens of seconds to become visible to the car,
// which broke pairing and would equally have broken the "address appears in
// ~3s" promise. KV has no knob for this (cacheTtl bottoms out at 60s).
//
// A single Durable Object instance is strongly consistent with read-your-writes
// globally, so a write is visible to the very next poll from anywhere.
//
// Durable Object storage has no native TTL, so expiry is stored per record as
// `expiresAt` and enforced on read (plus an opportunistic sweep of stale
// pairing slots on write).

export class ClipStore {
  constructor(state) {
    this.state = state;
  }

  // Read a record, treating an expired one as absent (and deleting it).
  async read(key) {
    const rec = await this.state.storage.get(key);
    if (!rec) return null;
    if (rec.expiresAt && Date.now() > rec.expiresAt) {
      await this.state.storage.delete(key);
      return null;
    }
    return rec;
  }

  // Drop pairing slots that have aged out but were never claimed.
  async sweepPairs() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: "pair:" });
    const stale = [];
    for (const [key, rec] of entries) {
      if (rec && rec.expiresAt && now > rec.expiresAt) stale.push(key);
    }
    if (stale.length) await this.state.storage.delete(stale);
  }

  // Every stored value stays well below the DO's 128 KiB per-value limit.
  // Serialize the entire report operation so peeks/reads/deletes cannot observe
  // half a report, and simultaneous sends cannot overwrite each other.
  async outbox(op, args) {
    return this.state.storage.transaction(async (txn) => {
      let meta = await txn.get("outbox");
      const remove = async () => {
        await txn.delete(["outbox", ...Array.from({ length: meta.chunks }, (_, i) => "outbox:" + i)]);
        await txn.deleteAlarm();
      };
      if (meta && Date.now() >= meta.expiresAt) { await remove(); meta = null; }
      if (op === "putOutbox") {
        if (meta) {
          // An upload retry after a lost response is safe only for the same
          // transfer, including ciphertext. A new report never overwrites it.
          if (meta.id !== args.record.id || meta.iv !== args.record.iv) return { conflict: true };
          let ct = "";
          for (let i = 0; i < meta.chunks; i++) ct += await txn.get("outbox:" + i);
          return ct === args.record.ct ? { expiresAt: meta.expiresAt } : { conflict: true };
        }
        const { ct, ...record } = args.record;
        const values = {};
        const chunkSize = 60 * 1024;
        const chunks = Math.ceil(ct.length / chunkSize);
        for (let i = 0; i < chunks; i++) values["outbox:" + i] = ct.slice(i * chunkSize, (i + 1) * chunkSize);
        const expiresAt = Date.now() + args.ttl * 1000;
        values.outbox = { ...record, chunks, expiresAt };
        await txn.put(values);
        await txn.setAlarm(expiresAt);
        return { expiresAt };
      }
      if (!meta || args.id && args.id !== meta.id) return { record: null };
      const { chunks, ...record } = meta;
      if (op === "peekOutbox") return { record: { id: record.id, ts: record.ts, expiresAt: record.expiresAt } };
      if (op === "deleteOutbox") { await remove(); return { deleted: true }; }
      let ct = "";
      for (let i = 0; i < chunks; i++) ct += await txn.get("outbox:" + i);
      return { record: { ...record, ct } };
    });
  }

  async alarm() {
    // Unlike lazy expiry alone, this also removes unattended report chunks.
    await this.outbox("peekOutbox", {});
  }

  async handle(op, args) {
    if (["putOutbox", "peekOutbox", "readOutbox", "deleteOutbox"].includes(op)) return this.outbox(op, args);
    switch (op) {
      case "setLatest":
        await this.state.storage.put("latest", args.record);
        return { ok: true };

      case "getLatest":
        return { record: await this.read("latest") };

      case "putVault":
        await this.state.storage.put("vault", {
          ...args.record,
          expiresAt: Date.now() + args.ttl * 1000,
        });
        return { ok: true };

      case "peekVault": {
        const rec = await this.read("vault");
        // Metadata only — never hand back the ciphertext here (§6).
        return { record: rec ? { ts: rec.ts ?? null } : null };
      }

      case "claimVault": {
        const rec = await this.read("vault");
        if (rec) await this.state.storage.delete("vault"); // single-use
        return { record: rec };
      }

      case "putPair": {
        await this.sweepPairs();
        await this.state.storage.put(`pair:${args.id}`, {
          ...args.record,
          expiresAt: Date.now() + args.ttl * 1000,
        });
        return { ok: true };
      }

      case "claimPair": {
        const key = `pair:${args.id}`;
        const rec = await this.read(key);
        if (rec) await this.state.storage.delete(key); // single-use
        return { record: rec };
      }

      default:
        return { error: "bad op" };
    }
  }

  // Internal transport. Only this Worker can reach the object — it is not
  // routable from the internet — so no auth is repeated here.
  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }
    const { op, ...args } = body || {};
    const out = await this.handle(op, args);
    return new Response(JSON.stringify(out ?? null), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
