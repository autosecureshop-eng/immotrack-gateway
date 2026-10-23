// Regression tests for the bug that made queued commands look like an empty
// queue: `fetch` does not reject on a 401/403/404/500, so an unauthorised
// gateway used to get `json.commands === undefined`, return [], and log
// nothing at all. These tests pin the two halves of the fix — the call fails
// loudly, and poll still degrades to "no commands" rather than crashing the
// session.

const test = require("node:test");
const assert = require("node:assert");

process.env.SUPABASE_URL = "https://tracker.example.test";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.TRACKER_GATEWAY_KEY = "gateway-key";

const up = require("../src/upstream");

/** Run `fn` with global fetch stubbed and console.error captured. */
async function withFetch(status, body, fn) {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const errors = [];
  const logs = [];
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    return { result: await fn(), errors, logs };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
  }
}

test("explain names the setting to check for each status", () => {
  assert.match(up.explain(401), /TRACKER_GATEWAY_KEY/);
  assert.match(up.explain(403), /TRACKER_GATEWAY_KEY/);
  assert.match(up.explain(404), /SUPABASE_URL/);
  assert.match(up.explain(500), /tracker API error/);
});

test("poll returns the queued commands on success", async () => {
  const { result, errors } = await withFetch(
    200, { commands: [{ id: 7, command: "immobilise" }], timing: { on: 20, off: 300 } },
    () => up.poll("123456789012345"),
  );
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].command, "immobilise");
  assert.deepEqual(result.timing, { on: 20, off: 300 });
  assert.deepEqual(errors, [], "a successful poll must not log an error");
});

test("a 401 poll is LOUD, not an empty queue", async () => {
  const { result, errors } = await withFetch(
    401, { error: "bad gateway key" },
    () => up.poll("123456789012345"),
  );
  // It still degrades safely...
  assert.deepEqual(result.commands, [], "must not invent commands on failure");
  // ...but it must no longer be silent. This is the whole bug.
  assert.equal(errors.length, 1, "a rejected poll must be logged");
  assert.match(errors[0], /TRACKER_GATEWAY_KEY/);
  assert.match(errors[0], /queued commands cannot be delivered/);
});

test("a 404 report says to check SUPABASE_URL", async () => {
  const { errors } = await withFetch(
    404, "no such function",
    () => up.report("123456789012345", { lat: 51.5, lng: -0.1 }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SUPABASE_URL/);
});

test("a failing ack is logged rather than swallowed", async () => {
  const { errors } = await withFetch(
    500, "boom",
    () => up.ack("123456789012345", 42, true, "sent"),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tracker API error \(500\)/);
});

test("recovery is logged once the API works again", async () => {
  // `ack` is already in the failing state from the test above.
  const { logs } = await withFetch(200, { ok: true },
    () => up.ack("123456789012345", 42, true, "sent"));
  assert.ok(logs.some((l) => /ack recovered/.test(l)),
    "the journal should show when it started working again");
});

test("checkConfig names every missing setting", () => {
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  // SUPABASE_URL is read at module load for BASE, but checkConfig reads env
  // live so a running gateway can be diagnosed without a restart.
  assert.deepEqual(up.checkConfig(), ["SUPABASE_URL"]);
  process.env.SUPABASE_URL = saved;
  assert.deepEqual(up.checkConfig(), []);
});
