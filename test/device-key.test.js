// An IMEI does not identify one tracker.
//
// Cheap GT06-family units ship with cloned or recycled IMEIs, so two physical
// trackers — different protocols, different vehicles — can present the same
// digits. Anything the gateway keeps per device therefore has to be keyed on
// (protocol, imei), not on the imei alone.
//
// These tests model the registry rather than importing server.js, which opens
// TCP listeners on require. They fail against a Map keyed on imei alone, which
// is what the session registry originally was.

const test = require("node:test");
const assert = require("node:assert");

const deviceKey = (protocol, imei) => `${protocol}:${imei}`;

/** The registry's behaviour, isolated from the sockets. */
function makeRegistry() {
  const sessions = new Map();
  return {
    sessions,
    open(protocol, imei, session) {
      if (!imei) return null;
      const key = deviceKey(protocol, imei);
      const stored = { ...session, protocol, imei, key };
      sessions.set(key, stored);
      return stored;
    },
    close(protocol, imei, session) {
      if (!imei || !session) return;
      const key = deviceKey(protocol, imei);
      if (sessions.get(key) === session) sessions.delete(key);
    },
  };
}

const IMEI = "865190074455927";

test("the same IMEI on two protocols is two devices", () => {
  const r = makeRegistry();
  const a = r.open("gt06", IMEI, { send: () => "a" });
  const b = r.open("teltonika", IMEI, { send: () => "b" });

  assert.equal(r.sessions.size, 2, "one IMEI, two protocols, two sessions");
  assert.notEqual(a.key, b.key);
  assert.equal(r.sessions.get("gt06:" + IMEI).send(), "a");
  assert.equal(r.sessions.get("teltonika:" + IMEI).send(), "b",
    "the second connection must not have replaced the first");
});

test("closing one does not unregister the other", () => {
  const r = makeRegistry();
  const a = r.open("gt06", IMEI, { send: () => "a" });
  const b = r.open("teltonika", IMEI, { send: () => "b" });

  r.close("gt06", IMEI, a);
  assert.equal(r.sessions.size, 1);
  assert.ok(r.sessions.has("teltonika:" + IMEI), "the Teltonika must survive");
  assert.equal(r.sessions.get("teltonika:" + IMEI), b);
});

test("a stale close cannot evict the session that replaced it", () => {
  const r = makeRegistry();
  const first = r.open("gt06", IMEI, { send: () => "first" });
  const second = r.open("gt06", IMEI, { send: () => "second" }); // reconnect
  // The first socket's close event arrives late, after the reconnect.
  r.close("gt06", IMEI, first);
  assert.equal(r.sessions.get("gt06:" + IMEI), second,
    "the live session must not be removed by the old socket closing");
});

test("the in-flight guard is per device, not per IMEI", () => {
  const inFlight = new Set();
  inFlight.add(deviceKey("gt06", IMEI));
  assert.ok(inFlight.has("gt06:" + IMEI));
  assert.ok(!inFlight.has("teltonika:" + IMEI),
    "a flush on one must not block the other");
});

test("the carry-over fix cache is per device too", () => {
  const lastByImei = new Map();
  lastByImei.set(deviceKey("gt06", IMEI), { fix: { lat: 51.5, lng: -0.1 }, odo: 10 });
  assert.ok(lastByImei.has("gt06:" + IMEI));
  assert.equal(lastByImei.get(deviceKey("teltonika", IMEI)), undefined,
    "a Teltonika must not inherit a GT06's last fix");
});
