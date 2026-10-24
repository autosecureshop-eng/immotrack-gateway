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
  assert.ok(logs.some((l) => /ack \S+ recovered/.test(l)),
    "the journal should show when it started working again, and for which device");
});

// ---- one bad device must not drown the journal ---------------------------
// Live symptom: a tracker moved off the account kept its TCP session open, so
// the 5s queue poll asked about it 12 times a minute forever. Worse, a healthy
// tracker's success cleared the shared failure state, so the throttle never
// engaged — the journal filled with alternating "failed"/"recovered after 1
// failures over 0s" pairs and real faults were lost in it.

test("a 404 'unknown tracker' does not blame SUPABASE_URL", async () => {
  const { errors } = await withFetch(
    404, { error: "unknown tracker" },
    () => up.poll("111111111111111", "gt06"),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not registered, or not active/);
  assert.ok(!/SUPABASE_URL/.test(errors[0]),
    "the URL is fine — saying otherwise sends people to check a correct setting");
});

test("an unknown tracker is asked about once, then left alone", async () => {
  const imei = "222222222222222";
  const first = await withFetch(404, { error: "unknown tracker" },
    () => up.poll(imei, "gt06"));
  assert.equal(first.errors.length, 1, "say it once");
  assert.match(first.errors[0], /not asking again/);

  // Every later poll inside the back-off window must be silent, and must not
  // even reach the API.
  let calls = 0;
  for (let i = 0; i < 5; i++) {
    const again = await withFetch(404, { error: "unknown tracker" },
      () => up.poll(imei, "gt06"));
    calls += again.errors.length;
  }
  assert.equal(calls, 0, "no further noise while it stays unregistered");
});

test("one device's failure does not reset another's throttle", async () => {
  // The bad one fails...
  await withFetch(500, "boom", () => up.poll("333333333333333", "gt06"));
  // ...the good one succeeds. That must NOT log a recovery for the bad one.
  const { logs } = await withFetch(200, { commands: [] },
    () => up.poll("444444444444444", "gt06"));
  assert.ok(!logs.some((l) => /333333333333333.*recovered/.test(l)),
    "a healthy tracker must not 'recover' a broken one");
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
