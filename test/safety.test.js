// The cut guard. This is the one decision in the gateway that can hurt
// somebody, so it is tested by running it on every case that matters.
//
// The bug these pin: `lastSpeed` is null until the first fix of a TCP
// connection, and the old guard read `lastSpeed != null && lastSpeed > limit`
// — so a unit that reconnected mid-journey had no reading, fell through, and
// cut a vehicle at speed. The API's queue-time check does not cover it either:
// queue while parked, car drives off, device reconnects, both guards passed.

const test = require("node:test");
const assert = require("node:assert");

const { holdCheck, MOVING_KMH, INSTANT_KMH, SPEED_FRESH_MS } = require("../src/safety");

const NOW = 1_700_000_000_000;
const fresh = (kmh) => ({ kmh, at: NOW - 1000 });
const stale = (kmh) => ({ kmh, at: NOW - SPEED_FRESH_MS - 1000 });

test("stationary and recent: immobilise is allowed", () => {
  assert.equal(holdCheck("immobilise", fresh(0), NOW), null);
  assert.equal(holdCheck("immobilise", fresh(MOVING_KMH), NOW), null);
});

test("moving: immobilise is held", () => {
  const h = holdCheck("immobilise", fresh(MOVING_KMH + 1), NOW);
  assert.ok(h, "must hold above the limit");
  assert.match(h.why, /vehicle moving/);
  assert.equal(h.askFix, false, "a fix will not make a moving car stationary");
});

test("UNKNOWN speed is held, not treated as stationary", () => {
  // The regression. Reconnect mid-journey -> no reading -> used to be sent.
  const h = holdCheck("immobilise", { kmh: null, at: null }, NOW);
  assert.ok(h, "unknown speed must NOT pass the guard");
  assert.match(h.why, /no speed reading/);
  assert.equal(h.askFix, true, "asking for a fix would clear this");
});

test("STALE speed is held, even if it said zero", () => {
  const h = holdCheck("immobilise", stale(0), NOW);
  assert.ok(h, "an old reading is not evidence of now");
  assert.match(h.why, /old/);
  assert.equal(h.askFix, true);
});

test("a reading right on the freshness edge still counts", () => {
  assert.equal(holdCheck("immobilise", { kmh: 0, at: NOW - SPEED_FRESH_MS }, NOW), null);
  assert.ok(holdCheck("immobilise", { kmh: 0, at: NOW - SPEED_FRESH_MS - 1 }, NOW));
});

test("immobilise_instant allows up to 20 mph and no further", () => {
  assert.equal(holdCheck("immobilise_instant", fresh(INSTANT_KMH), NOW), null);
  assert.ok(holdCheck("immobilise_instant", fresh(INSTANT_KMH + 1), NOW));
  // ...but it is still a cut, so unknown speed holds it too.
  assert.ok(holdCheck("immobilise_instant", { kmh: null, at: null }, NOW));
});

test("instant is more permissive than safe, but both are capped", () => {
  const speed = fresh(20); // between the two limits
  assert.ok(holdCheck("immobilise", speed, NOW), "safe cut holds at 20 km/h");
  assert.equal(holdCheck("immobilise_instant", speed, NOW), null, "instant allows it");
});

test("releasing is never withheld, whatever the speed", () => {
  for (const s of [fresh(0), fresh(200), stale(200), { kmh: null, at: null }]) {
    assert.equal(holdCheck("mobilise", s, NOW), null,
      "mobilise must never be held — releasing a car is not dangerous");
  }
});

test("non-cut commands are not subject to the speed guard", () => {
  for (const c of ["locate_now", "set_timing", "live_on", "live_off", "custom", "clear_cache"]) {
    assert.equal(holdCheck(c, { kmh: null, at: null }, NOW), null, c);
  }
});
