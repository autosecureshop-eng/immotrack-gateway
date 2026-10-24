// When a cut command may be sent, and when it must not be.
//
// This lives on its own because it is the one decision in the gateway that can
// hurt somebody. It is a pure function of the command and the speed reading,
// so it can be tested by running it rather than by reasoning about it.
//
// The rule: an immobilise is only allowed when we have a RECENT reading that
// shows the vehicle slow enough. Unknown is not stationary, and old is not
// now. Releasing (mobilise) is never withheld.

const MOVING_KMH = 3;
const INSTANT_KMH = 32; // 20 mph — consented, hire-fleet style, never faster

// How long a speed reading counts as evidence of what the vehicle is doing
// now. `lastSpeed` is null until the first fix of a TCP connection, so a unit
// that reconnects mid-journey — out of a tunnel, back into signal — has no
// reading at all; and the API's queue-time check cannot know the car drove off
// after the command was queued. Both cases used to pass the guard.
const SPEED_FRESH_MS = Number(process.env.SPEED_FRESH_MS || 90_000);

/** km/h ceiling for a command, or null if it is not a cut at all. */
function limitFor(command) {
  if (command === "immobilise_instant") return INSTANT_KMH;
  if (command === "immobilise") return MOVING_KMH;
  return null;
}

/**
 * Should this command be held?
 *
 * @param {string} command
 * @param {{kmh: ?number, at: ?number}} speed  last reading and when it arrived
 * @param {number} now
 * @returns {null | {why: string, askFix: boolean}}
 *          null to send it; otherwise why it is held, and whether asking the
 *          device for a fix would clear the hold (it would, for unknown or
 *          stale — not for a vehicle that is simply moving too fast).
 */
function holdCheck(command, speed, now = Date.now()) {
  const limit = limitFor(command);
  if (limit == null) return null;                    // mobilise and the rest

  if (!speed || speed.kmh == null) {
    return { why: "no speed reading yet on this connection", askFix: true };
  }
  const age = speed.at == null ? Infinity : now - speed.at;
  if (age > SPEED_FRESH_MS) {
    const s = age === Infinity ? "unknown" : `${Math.round(age / 1000)}s`;
    return { why: `last speed reading is ${s} old`, askFix: true };
  }
  if (speed.kmh > limit) {
    return { why: `vehicle moving (${Math.round(speed.kmh)} km/h > ${limit})`, askFix: false };
  }
  return null;
}

module.exports = { holdCheck, limitFor, MOVING_KMH, INSTANT_KMH, SPEED_FRESH_MS };
