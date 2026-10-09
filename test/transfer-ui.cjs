// Execute the built page's actual scripts with WebCrypto and a minimal DOM.
// The Workers suite covers storage; these checks cover the browser handoff,
// user actions, clipboard fallbacks, and recovery after a lost response.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const TOKEN = "ui-test-token";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const ORIGIN = "https://clip-to-car.test";
const waitFor = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Page interaction did not complete");
};

function server() {
  const state = { record:null, uploads:[], loseResponse:false };
  state.fetch = async (path, init) => {
    if (init.headers.Authorization !== "Bearer " + TOKEN) return Response.json({ error:"unauthorized" }, { status:401 });
    const data = init.body && JSON.parse(init.body);
    const meta = state.record && { id:state.record.id, expiresAt:state.record.expiresAt };
    if (path === "/outbox/peek") return Response.json(meta ? { present:true, ...meta } : { present:false });
    if (path === "/outbox") {
      state.uploads.push(data);
      if (state.record && JSON.stringify(data) !== JSON.stringify(state.uploads[0])) return Response.json({ error:"A report is waiting" }, { status:409 });
      state.record = { ...data, expiresAt:Date.now() + 3600000 };
      if (state.loseResponse) { state.loseResponse = false; throw new Error("Connection lost"); }
      return Response.json({ ok:true, id:data.id, expiresAt:state.record.expiresAt });
    }
    if (!state.record || data.id !== state.record.id) return Response.json({ error:"report expired" }, { status:404 });
    if (path === "/outbox/read") return Response.json({ present:true, ...state.record });
    if (path === "/outbox/delete") { state.record = null; return Response.json({ ok:true }); }
    throw Error("Unexpected API route: " + path);
  };
  return state;
}

async function page(path, backend, options = {}) {
  const { TRANSFER_HTML } = await import("../src/generated/pages.js");
  const elements = new Map(), timers = new Map(), downloads = [];
  let nextTimer = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value:"", textContent:"", hidden:false, disabled:false, open:false,
      addEventListener(name, callback) { this[name] = callback; },
      focus() { this.focused = true; }, select() { this.selected = true; },
      click() { this.clicked = true; }, remove() { this.removed = true; },
    });
    return elements.get(id);
  }
  for (const match of TRANSFER_HTML.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = element(match[1]);
    node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]);
  }
  const secrets = new Map(options.unpaired ? [] : [["ctc.token", TOKEN], ["ctc.key", KEY]]);
  const document = {
    hidden:false, getElementById:element, body:{ appendChild() {} },
    createElement() { const link = element("download-" + downloads.length); downloads.push(link); return link; },
  };
  class PageURL extends URL {
    static createObjectURL(blob) { document.blob = blob; return "blob:test"; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    document, location:{ pathname:path, origin:ORIGIN, hash:"" },
    navigator:options.navigator || {}, history:{ replaceState() {} },
    localStorage:{ getItem:name => secrets.get(name), setItem:(name, value) => secrets.set(name, value) },
    crypto:webcrypto, TextEncoder, TextDecoder, URLSearchParams, URL:PageURL, Blob, btoa, atob,
    fetch:backend.fetch,
    setTimeout(callback, ms) { const timer = ++nextTimer; timers.set(timer, { callback, ms }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  for (const match of TRANSFER_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  return {
    element, document, secrets, downloads,
    tick() { const timer = [...timers.entries()].find(([, value]) => value.ms === 3000); assert.ok(timer); timers.delete(timer[0]); timer[1].callback(); },
  };
}

test("car paste → encrypted transfer → new PC setup → copy, exact JSON download, delete", async () => {
  const backend = server();
  const text = " \n" + JSON.stringify({ data:"Երևան 🚗 ".repeat(15000) }, null, 2) + "\n ";
  const sender = await page("/from-car", backend, { navigator:{ clipboard:{ readText:async () => text } } });
  await waitFor(() => sender.element("status").textContent === "Ready to send.");
  sender.element("paste").onclick();
  await waitFor(() => sender.element("text").value === text);
  sender.element("send").onclick();
  await waitFor(() => sender.element("status").textContent.startsWith("Sent."));
  assert.ok(backend.record.ct.length > 128 * 1024);
  assert.equal(JSON.stringify(backend.record).includes("Երևան"), false);
  assert.equal(sender.element("link").href, ORIGIN + "/receive");
  const receiver = await page("/receive", backend, { unpaired:true });
  assert.equal(receiver.element("settings").open, true);
  assert.equal(receiver.element("copy").disabled, true);
  receiver.element("token").value = TOKEN; receiver.element("key").value = KEY;
  receiver.element("setup").onsubmit({ preventDefault() {} });
  await waitFor(() => receiver.element("text").value === text);
  assert.equal(receiver.secrets.get("ctc.key"), KEY);
  receiver.element("copy").onclick();
  assert.equal(receiver.element("text").selected, true);
  receiver.element("download").onclick();
  assert.equal(receiver.downloads[0].download, "car-report.json");
  assert.equal(await receiver.document.blob.text(), text);
  assert.ok(backend.record, "Reading and downloading must not consume the report");
  receiver.element("delete").onclick();
  await waitFor(() => receiver.element("status").textContent === "Report deleted.");
  assert.equal(backend.record, null); assert.equal(receiver.element("text").value, "");
});

test("a lost upload response retries the identical encrypted transfer", async () => {
  const backend = server(), sender = await page("/from-car", backend);
  await waitFor(() => sender.element("status").textContent === "Ready to send.");
  sender.element("text").value = '{"large":"report"}';
  backend.loseResponse = true;
  sender.element("send").onclick();
  await waitFor(() => sender.element("status").textContent.includes("tap Send to retry"));
  await waitFor(() => !sender.element("send").disabled);
  sender.element("send").onclick();
  await waitFor(() => sender.element("status").textContent.startsWith("Sent."));
  assert.equal(backend.uploads.length, 2); assert.deepEqual(backend.uploads[0], backend.uploads[1]);
});

test("clipboard exceptions offer manual paste and selectable-copy fallbacks", async () => {
  const backend = server();
  const navigator = { clipboard:{ readText() { throw Error("Blocked"); }, writeText() { throw Error("Blocked"); } } };
  const sender = await page("/from-car", backend, { navigator });
  sender.element("paste").onclick();
  assert.equal(sender.element("text").focused, true);
  assert.match(sender.element("status").textContent, /long-press/i);
  const receiver = await page("/receive", backend, { navigator });
  receiver.element("copy").onclick();
  assert.equal(receiver.element("text").selected, true);
});

test("wrong keys report decryption errors and oversized text is rejected before upload", async () => {
  const backend = server(), sender = await page("/from-car", backend);
  await waitFor(() => sender.element("status").textContent === "Ready to send.");
  sender.element("text").value = "a".repeat(1024 * 1024);
  sender.element("send").onclick();
  assert.match(sender.element("status").textContent, /too large/); assert.equal(backend.uploads.length, 0);
  sender.element("text").value = '{"diagnostic":"data"}'; sender.element("send").onclick();
  await waitFor(() => sender.element("status").textContent.startsWith("Sent."));
  const receiver = await page("/receive", backend, { unpaired:true });
  receiver.element("token").value = TOKEN; receiver.element("key").value = Buffer.alloc(32, 8).toString("base64url");
  receiver.element("setup").onsubmit({ preventDefault() {} });
  await waitFor(() => receiver.element("status").textContent.includes("Cannot decrypt"));
  assert.equal(receiver.element("text").value, "");
  assert.equal(receiver.element("copy").disabled, true); assert.ok(backend.record);
});
