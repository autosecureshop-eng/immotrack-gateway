// When a cut command may be sent, and when it must not be.
//
// This lives on its own because it is the one decision in the gateway that can
// hurt somebody. It is a pure function of the command and the speed reading,
// so it can be tested by running it rather than by reasoning about it.
//
// The rule: an immobilise is only allowed when we have RECENT evidence that
// the vehicle is not being driven. Unknown is not stationary, and old is not
// now. Releasing (mobilise) is never withheld.
//
// There are two independent sources of that evidence, and the second one
// matters more than it looks. Speed comes from a GPS fix. Ignition comes from
// the tracker's own status frame and needs no fix at all (GT06 terminal-info
// bit 1, Teltonika IO 239). A vehicle underground, with a snapped aerial, or
// with a thief's GPS jammer running reports ignition and no position — so
// speed alone would mean such a vehicle could never be immobilised, which is
// the exact attack this product exists to stop.
//
// Ignition OFF is not the absence of a reading; it is a positive statement
// that the engine is not running, from the same device the speed would have
// come from. It is used only to answer "is this vehicle being driven", never
// to override a speed reading that says it is.

const MOVING_KMH = 3;
const INSTANT_KMH = 32; // 20 mph — consented, hire-fleet style, never faster

// How long a speed reading counts as evidence of what the vehicle is doing
// now. `lastSpeed` is null until the first fix of a TCP connection, so a unit
// that reconnects mid-journey — out of a tunnel, back into signal — has no
// reading at all; and the API's queue-time check cannot know the car drove off
// after the command was queued. Both cases used to pass the guard.
const SPEED_FRESH_MS = Number(process.env.SPEED_FRESH_MS || 90_000);

// Ignition gets a longer window than speed, because a parked vehicle only
// speaks at its parked heartbeat (report_off_s, 300s by default) and would
// otherwise always look stale. The window is safe to be this wide precisely
// because the thing it is used for is "ignition is OFF": the moment somebody
// turns the key, the tracker switches to its driving cadence and says so
// within seconds. So a last-known OFF this recent means the device has not
// reported an ON — and a device silent for longer than this is offline, which
// the platform already treats as unreachable.
const IGNITION_FRESH_MS = Number(process.env.IGNITION_FRESH_MS || 900_000);

/** km/h ceiling for a command, or null if it is not a cut at all. */
function limitFor(command) {
  if (command === "immobilise_instant") return INSTANT_KMH;
  if (command === "immobilise") return MOVING_KMH;
  return null;
}

/** Is there a usable speed reading — present, and recent enough to mean now? */
function speedIsCurrent(state, now) {
  return !!state && state.kmh != null && state.at != null && now - state.at <= SPEED_FRESH_MS;
}

/** Has the tracker recently told us the engine is off? */
function engineIsOff(state, now) {
  return !!state && state.ignition === false && state.ignitionAt != null
    && now - state.ignitionAt <= IGNITION_FRESH_MS;
}

/** How to describe the ignition in a hold message. */
function ignitionWord(state, now) {
  if (!state || state.ignition == null || state.ignitionAt == null) return "the ignition is not reported";
  if (now - state.ignitionAt > IGNITION_FRESH_MS) return "the last ignition reading is too old to use";
  return state.ignition ? "the ignition is on" : "the ignition is off";
}

/**
 * Should this command be held?
 *
 * @param {string} command
 * @param {{kmh: ?number, at: ?number, ignition: ?boolean, ignitionAt: ?number}} state
 *        the last speed and ignition readings, and when each arrived
 * @param {number} now
 * @returns {null | {why: string, askFix: boolean}}
 *          null to send it; otherwise why it is held, and whether asking the
 *          device for a fix would clear the hold (it would, for unknown or
 *          stale — not for a vehicle that is simply moving too fast).
 */
function holdCheck(command, state, now = Date.now()) {
  const limit = limitFor(command);
  if (limit == null) return null;                    // mobilise and the rest

  // A current speed reading decides it on its own, either way. In particular a
  // reading above the limit holds the command even with the ignition off: the
  // vehicle is demonstrably moving, and that beats any claim about the engine.
  if (speedIsCurrent(state, now)) {
    if (state.kmh > limit) {
      return { why: `vehicle moving (${Math.round(state.kmh)} km/h > ${limit})`, askFix: false };
    }
    return null;
  }

  // No usable speed. The engine being off is the other way to know this
  // vehicle is not being driven, and it survives a jammer.
  if (engineIsOff(state, now)) return null;

  const ign = ignitionWord(state, now);
  if (!state || state.kmh == null) {
    return { why: `no speed reading yet on this connection, and ${ign}`, askFix: true };
  }
  const age = state.at == null ? Infinity : now - state.at;
  const s = age === Infinity ? "unknown" : `${Math.round(age / 1000)}s`;
  return { why: `last speed reading is ${s} old, and ${ign}`, askFix: true };
}

module.exports = {
  holdCheck, limitFor, speedIsCurrent, engineIsOff,
  MOVING_KMH, INSTANT_KMH, SPEED_FRESH_MS, IGNITION_FRESH_MS,
};
