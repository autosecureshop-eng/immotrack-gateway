// The bridge to IMMOSTOP's Supabase `tracker` function. The gateway is a trusted
// server, so it authenticates with one shared GATEWAY_KEY (not a per-device
// secret) and acts on behalf of whichever IMEI connected.

const BASE = process.env.SUPABASE_URL + "/functions/v1/tracker";
const ANON = process.env.SUPABASE_ANON_KEY;
const GATEWAY_KEY = process.env.TRACKER_GATEWAY_KEY;

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
  return { status: res.status, json };
}

/** Push a position. Silent best-effort. */
async function report(imei, pos) {
  try {
    await call({
      action: "report", imei,
      lat: pos.lat, lng: pos.lng, speed: pos.speed,
      heading: pos.heading, battery: pos.battery,
      ignition: pos.ignition, voltage: pos.voltage, odometer_km: pos.odometerKm,
      gsm: pos.gsm, sats: pos.satellites,
      fix_at: pos.time ? new Date(pos.time).toISOString() : undefined,
    });
  } catch (e) { console.error("report failed", imei, e.message); }
}

/** Fetch queued commands for this IMEI (the function marks them sent). */
async function poll(imei) {
  try {
    const { json } = await call({ action: "poll", imei });
    return json.commands || [];
  } catch (e) { console.error("poll failed", imei, e.message); return []; }
}

/** Report a command result. */
async function ack(imei, commandId, ok, result) {
  try {
    await call({ action: "ack", imei, command_id: commandId, ok, result });
  } catch (e) { console.error("ack failed", imei, e.message); }
}

module.exports = { report, poll, ack };
