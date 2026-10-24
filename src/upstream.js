// The bridge to IMMOSTOP's Supabase `tracker` function. The gateway is a trusted
// server, so it authenticates with one shared GATEWAY_KEY (not a per-device
// secret) and acts on behalf of whichever IMEI connected.
//
// Every call carries the PROTOCOL as well as the IMEI. Cheap GT06-family
// units ship with cloned or recycled IMEIs, so the digits alone do not
// identify one physical tracker; (protocol, imei) does. The field is additive
// — a tracker function that ignores it behaves exactly as before — but until
// the function and the device page key on the pair too, two trackers sharing
// an IMEI will still land on one vehicle record.
//
// Every call here used to swallow HTTP errors. `fetch` only rejects on a
// network failure, not on a 401/403/404/500, so a wrong TRACKER_GATEWAY_KEY
// came back as `json.commands === undefined` -> an empty command list, and the
// gateway behaved exactly as if the queue were empty: commands sat in the
// portal forever with nothing in the log to say why. Non-2xx is now an error,
// and it says which setting to go and look at.

const BASE = process.env.SUPABASE_URL + "/functions/v1/tracker";
const ANON = process.env.SUPABASE_ANON_KEY;
const GATEWAY_KEY = process.env.TRACKER_GATEWAY_KEY;

const WARN_EVERY_MS = 60_000;

// How long to leave an IMEI alone after the API says it does not know it. A
// device that has been moved to another account, or never registered, keeps
// its TCP session open and would otherwise be polled every COMMAND_POLL_S for
// as long as it stays plugged in — 12 pointless round trips a minute, each
// one an error line that buries the real ones.
const UNKNOWN_BACKOFF_MS = Number(process.env.UNKNOWN_BACKOFF_MS || 600_000);

/**
 * What a status code almost always means here, in the fitter's terms.
 *
 * The body matters as much as the code: a 404 from the function means "I do
 * not know this tracker", while a 404 from the host means the URL is wrong.
 * Saying "check SUPABASE_URL" for the first one sends people to inspect a
 * setting that is correct, which is worse than saying nothing.
 */
function explain(status, body = "") {
  if (status === 401 || status === 403) {
    return `rejected (${status}) — TRACKER_GATEWAY_KEY in .env must equal the ` +
           "tracker function's secret of the same name";
  }
  if (status === 404) {
    return /unknown tracker/i.test(body)
      ? "unknown tracker (404) — this IMEI is not registered, or not active, on the platform"
      : "not found (404) — check SUPABASE_URL";
  }
  if (status >= 500) return `tracker API error (${status})`;
  return `HTTP ${status}`;
}

// A failing call usually fails on every packet, so the first one is logged at
// once and the rest are folded into a count once a minute. Recovery is logged
// too, so the journal shows when it started working again.
//
// The key is per call AND per device, not per call alone. With one key per
// call a healthy tracker's success cleared the failure state of a broken one
// sharing the gateway, so every cycle printed a fresh warning and a fresh
// "recovered" — the throttle never engaged and the journal filled with
// alternating pairs that said nothing.
const failing = new Map();

function warn(key, msg) {
  const now = Date.now();
  const seen = failing.get(key);
  if (!seen) {
    failing.set(key, { since: now, at: now, count: 1 });
    console.error("[upstream]", key, msg);
    return;
  }
  seen.count++;
  if (now - seen.at >= WARN_EVERY_MS) {
    console.error("[upstream]", key, msg,
      `(${seen.count} failures in ${Math.round((now - seen.since) / 1000)}s)`);
    seen.at = now;
  }
}

function recovered(key) {
  const seen = failing.get(key);
  if (!seen) return;
  failing.delete(key);
  console.log("[upstream]", key, "recovered after",
    `${seen.count} failures over ${Math.round((Date.now() - seen.since) / 1000)}s`);
}

async function call(body) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON,
      authorization: "Bearer " + ANON,
    },
    body: JSON.stringify({ ...body, gateway_key: GATEWAY_KEY }),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(explain(res.status, text) + (text ? ` — ${text.slice(0, 200)}` : ""));
    err.status = res.status;
    err.unknownTracker = res.status === 404 && /unknown tracker/i.test(text);
    throw err;
  }
  return { status: res.status, json };
}

/** Push a position. Best-effort, but no longer silent. */
async function report(imei, pos, protocol) {
  try {
    await call({
      action: "report", imei, protocol,
      lat: pos.lat, lng: pos.lng, speed: pos.speed,
      heading: pos.heading, battery: pos.battery,
      ignition: pos.ignition, voltage: pos.voltage, odometer_km: pos.odometerKm,
      gsm: pos.gsm, sats: pos.satellites,
      // external 12 V feed connected (true/false/undefined) + one-shot alarm
      ext_power: pos.extPower, alarm: pos.alarm,
      fix_at: pos.time ? new Date(pos.time).toISOString() : undefined,
    });
    recovered(`report ${protocol || "?"}:${imei}`);
  } catch (e) { warn(`report ${protocol || "?"}:${imei}`, e.message); }
}

/**
 * Fetch queued commands for this IMEI (the function marks them sent), plus the
 * vehicle's configured heartbeat { on, off } seconds so live_off can restore it.
 *
 * On failure this returns no commands — the same as an empty queue — so the
 * caller cannot tell the difference. That is exactly the bug this file used to
 * have, and it is why the failure is logged loudly here instead.
 */
// IMEIs the API has disowned, and when it is worth asking about them again.
const unknownUntil = new Map();

async function poll(imei, protocol) {
  const who = `${protocol || "?"}:${imei}`;
  const quiet = unknownUntil.get(who);
  if (quiet && Date.now() < quiet) return { commands: [], timing: null };

  try {
    const { json } = await call({ action: "poll", imei, protocol });
    if (unknownUntil.delete(who)) {
      console.log("[upstream]", "poll", who, "is registered now — polling resumed");
    }
    recovered("poll " + who);
    return { commands: json.commands || [], timing: json.timing || null };
  } catch (e) {
    if (e.unknownTracker) {
      // Not a fault to retry hard: nothing on this gateway can fix it, and
      // only registering the IMEI on the platform will. Say so once, then go
      // quiet rather than filling the journal for as long as it stays plugged in.
      unknownUntil.set(who, Date.now() + UNKNOWN_BACKOFF_MS);
      console.error("[upstream]", "poll", who, e.message,
        `— not asking again for ${Math.round(UNKNOWN_BACKOFF_MS / 60_000)} min`);
      return { commands: [], timing: null };
    }
    warn("poll " + who, `${e.message} — queued commands cannot be delivered`);
    return { commands: [], timing: null };
  }
}

/** Report a command result. */
async function ack(imei, commandId, ok, result, protocol) {
  try {
    await call({ action: "ack", imei, command_id: commandId, ok, result, protocol });
    recovered(`ack ${protocol || "?"}:${imei}`);
  } catch (e) { warn(`ack ${protocol || "?"}:${imei}`, e.message); }
}

/**
 * Shout at startup if the gateway is not configured at all — otherwise the
 * first symptom is silence, which is the thing this module exists to avoid.
 */
function checkConfig() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!ANON) missing.push("SUPABASE_ANON_KEY");
  if (!GATEWAY_KEY) missing.push("TRACKER_GATEWAY_KEY");
  if (missing.length) {
    console.error("[upstream] NOT CONFIGURED — missing", missing.join(", "),
      "— positions will not be stored and commands will never be delivered");
  }
  return missing;
}

module.exports = { report, poll, ack, checkConfig, explain, _call: call };
