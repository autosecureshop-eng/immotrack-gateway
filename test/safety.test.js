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

const {
  holdCheck, MOVING_KMH, INSTANT_KMH, SPEED_FRESH_MS, IGNITION_FRESH_MS,
} = require("../src/safety");

const NOW = 1_700_000_000_000;
const fresh = (kmh) => ({ kmh, at: NOW - 1000 });
const stale = (kmh) => ({ kmh, at: NOW - SPEED_FRESH_MS - 1000 });
// No fix at all — what a jammed, underground or broken-aerial vehicle looks
// like. `ign` is what the tracker last said about the engine.
const noFix = (ign, age = 1000) =>
  ({ kmh: null, at: null, ignition: ign, ignitionAt: ign == null ? null : NOW - age });

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

// ---- ignition as the second stationary signal -----------------------------
// The case these exist for: a thief jams GPS, so there is never a fix and so
// never a speed reading. Speed alone would mean the car can never be cut.

test("no fix but the engine is off: immobilise goes through", () => {
  assert.equal(holdCheck("immobilise", noFix(false), NOW), null,
    "a parked car with a jammed GPS must still be immobilisable");
  assert.equal(holdCheck("immobilise_instant", noFix(false), NOW), null);
});

test("no fix and the engine is RUNNING: still held", () => {
  const h = holdCheck("immobilise", noFix(true), NOW);
  assert.ok(h, "ignition on with no speed could be a car at motorway speed");
  assert.match(h.why, /ignition is on/);
  assert.equal(h.askFix, true);
});

test("no fix and no ignition reading either: still held", () => {
  const h = holdCheck("immobilise", noFix(null), NOW);
  assert.ok(h, "two unknowns do not add up to stationary");
  assert.match(h.why, /ignition is not reported/);
});

test("an old ignition-off is not evidence of now", () => {
  const h = holdCheck("immobilise", noFix(false, IGNITION_FRESH_MS + 1000), NOW);
  assert.ok(h, "past the window the engine could have been started since");
  assert.match(h.why, /too old/);
  // ...and right on the edge it still counts.
  assert.equal(holdCheck("immobilise", noFix(false, IGNITION_FRESH_MS), NOW), null);
});

test("a current speed reading always beats the ignition", () => {
  // Rolling with the engine off — on a transporter, or coasting. The vehicle
  // is demonstrably moving, so "ignition off" must not let the cut through.
  const rolling = { ...fresh(40), ignition: false, ignitionAt: NOW - 1000 };
  const h = holdCheck("immobilise", rolling, NOW);
  assert.ok(h, "a measured 40 km/h outranks any claim about the engine");
  assert.match(h.why, /vehicle moving/);
  assert.equal(h.askFix, false);
});

test("stale speed plus a current ignition-off is allowed", () => {
  // A parked car heartbeating: its last fix is hours old, but it says every
  // few minutes that the engine is off.
  const parked = { ...stale(0), ignition: false, ignitionAt: NOW - 1000 };
  assert.equal(holdCheck("immobilise", parked, NOW), null);
});

test("stale speed plus ignition ON is held", () => {
  const driving = { ...stale(0), ignition: true, ignitionAt: NOW - 1000 };
  const h = holdCheck("immobilise", driving, NOW);
  assert.ok(h);
  assert.match(h.why, /ignition is on/);
});

// The break test the safety doc asks for: prove these tests would catch the
// guard being loosened, rather than just passing alongside it.
test("BREAK: treating a missing ignition reading as 'off' is caught", () => {
  const brokenEngineIsOff = (s, now) =>
    !!s && s.ignition !== true && s.ignitionAt != null ? true : (!!s && s.ignition !== true);
  // Replay the two cases that must stay held, against the broken rule.
  const held = [noFix(null), noFix(false, IGNITION_FRESH_MS + 1000)];
  for (const s of held) {
    assert.ok(holdCheck("immobilise", s, NOW), "the real guard holds this");
    assert.ok(brokenEngineIsOff(s, NOW), "the broken guard would send it");
  }
});
