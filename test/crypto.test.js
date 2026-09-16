import { describe, it, expect } from "vitest";
import {
  b64uEncode,
  b64uDecode,
  randomBytes,
  genKeyB64u,
  encryptJSON,
  decryptJSON,
  keyProblem,
} from "../src/crypto.js";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 100]) {
      const bytes = randomBytes(n);
      const enc = b64uEncode(bytes);
      expect(enc).not.toMatch(/[+/=]/); // url-safe, no padding
      expect([...b64uDecode(enc)]).toEqual([...bytes]);
    }
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const bytes = randomBytes(20);
    expect(b64uEncode(bytes.buffer)).toBe(b64uEncode(bytes));
  });

  it("tolerates padding and whitespace on decode", () => {
    const bytes = randomBytes(16);
    const std = btoa(String.fromCharCode(...bytes)); // standard base64 with padding
    expect([...b64uDecode(std)]).toEqual([...bytes]);
  });
});

describe("AES-GCM JSON (plan §8 wire format)", () => {
  it("encrypts then decrypts back to the same value (phone -> car)", async () => {
    const key = genKeyB64u();
    const payload = { kind: "login", label: "Spotify", username: "me@x.com", password: "hunter2" };
    const wire = await encryptJSON(key, payload);

    expect(wire.v).toBe(1);
    expect(wire.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wire.ct).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b64uDecode(wire.iv).length).toBe(12); // 96-bit IV

    const out = await decryptJSON(key, wire.iv, wire.ct);
    expect(out).toEqual(payload);
  });

  it("works with a raw-bytes key (pairing uses the optical W bytes)", async () => {
    const w = randomBytes(32);
    const wire = await encryptJSON(w, { t: "tok", k: "key" });
    expect(await decryptJSON(w, wire.iv, wire.ct)).toEqual({ t: "tok", k: "key" });
  });

  it("pairing interop: encrypt with base64url W (phone) decrypts with raw W bytes (car)", async () => {
    // The phone reads W as base64url from the QR fragment; the car holds the raw
    // bytes it generated. Both must resolve to the same key.
    const wBytes = randomBytes(32);
    const wB64u = b64uEncode(wBytes);
    const wire = await encryptJSON(wB64u, { t: "TOKEN", k: "KEY" });
    expect(await decryptJSON(wBytes, wire.iv, wire.ct)).toEqual({ t: "TOKEN", k: "KEY" });
  });

  it("fails to decrypt with the wrong key (GCM auth tag)", async () => {
    const wire = await encryptJSON(genKeyB64u(), { value: "secret" });
    await expect(decryptJSON(genKeyB64u(), wire.iv, wire.ct)).rejects.toBeTruthy();
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = genKeyB64u();
    const wire = await encryptJSON(key, { value: "secret" });
    const bytes = b64uDecode(wire.ct);
    bytes[0] ^= 0xff; // flip a bit
    await expect(decryptJSON(key, wire.iv, b64uEncode(bytes))).rejects.toBeTruthy();
  });

  it("uses a fresh IV per message", async () => {
    const key = genKeyB64u();
    const a = await encryptJSON(key, { n: 1 });
    const b = await encryptJSON(key, { n: 1 });
    expect(a.iv).not.toBe(b.iv);
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptJSON(b64uEncode(randomBytes(16)), {})).rejects.toBeTruthy();
  });
});


describe("keyProblem (pre-flight KEY validation)", () => {
  // The pairing form accepts free text, so a mistyped KEY used to reach the car
  // and only fail later as "couldn't decrypt" — which reads as a mismatch and
  // points at the wrong bug. Every entry point now checks up front.
  it("accepts a real 256-bit key", () => {
    expect(keyProblem(genKeyB64u())).toBeNull();
    expect(keyProblem(randomBytes(32))).toBeNull();
  });

  it("rejects a missing key", () => {
    expect(keyProblem("")).toMatch(/no key/);
    expect(keyProblem(null)).toMatch(/no key/);
  });

  it("rejects a key of the wrong length, and says what to do", () => {
    const msg = keyProblem("hunter2");
    expect(msg).toMatch(/32 bytes/);
    expect(msg).toMatch(/openssl rand/); // actionable, not just a complaint
    expect(keyProblem(b64uEncode(randomBytes(16)))).toMatch(/is 16/);
  });

  it("agrees with what encryptJSON will actually accept", async () => {
    const good = genKeyB64u();
    expect(keyProblem(good)).toBeNull();
    await expect(encryptJSON(good, { a: 1 })).resolves.toBeTruthy();

    const bad = b64uEncode(randomBytes(16));
    expect(keyProblem(bad)).toBeTruthy();
    await expect(encryptJSON(bad, { a: 1 })).rejects.toBeTruthy();
  });
});
