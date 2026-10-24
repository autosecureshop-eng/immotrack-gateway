// The IMMOSTOP tracker gateway.
//
// Two TCP listeners — one for Teltonika (FMB920/FMC920), one for GT06/Concox.
// Each decodes its devices' positions and forwards them to Supabase, and picks
// up queued commands and sends them to the device in its own dialect:
//
//   immobilise / mobilise   relay output (Teltonika setdigout, GT06 DYD/HFYD)
//   locate_now              ask for a fix now (getgps / WHERE#) — the reply is
//                           parsed and posted as a position
//   set_timing on=,off=     heartbeat: seconds between reports with ignition on
//                           / off (Teltonika setparam periods, GT06 TIMER)
//   live_on / live_off      the panel's Live toggle: fast reporting while a
//                           panel is open, then back to the vehicle's own timing
//   custom <text>           raw device command typed by the fitter
//
// The device's text reply to a command is attached to that command's ack so
// the panel can show it.
//
// SAFETY: remote immobilise is "prevent next start while stationary". The server
// already refuses to queue it while moving; here we re-check the last speed we
// saw and hold the command if the vehicle is moving, so a command can never cut
// a vehicle in motion.

const net = require("net");
const tel = require("./teltonika");
const gt = require("./gt06");
const up = require("./upstream");
const safety = require("./safety");

const TELTONIKA_PORT = Number(process.env.TELTONIKA_PORT || 5027);
const GT06_PORT = Number(process.env.GT06_PORT || 5023);
const LIVE_S = Number(process.env.LIVE_PERIOD_S || 5); // reporting period while Live is on

function log(...a) { console.log(new Date().toISOString(), ...a); }

/** Great-circle distance between two fixes, km. */
function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "on=20,off=300" -> { on:20, off:300 } */
function parseTiming(arg) {
  const m = /on=(\d+)\s*,\s*off=(\d+)/.exec(arg || "");
  return m ? { on: Number(m[1]), off: Number(m[2]) } : null;
}

// ---- apply queued commands to a live session --------------------------------

/**
 * Pull this IMEI's queued commands and send them with [send] in [dialect].
 * Returns the last command sent ({id, command}) so the caller can attach the
 * device's text reply to its ack, or null if nothing was sent.
 */
async function applyCommands(imei, send, dialect, speed, protocol) {
  const { commands, timing } = await up.poll(imei, protocol);
  let sent = null;
  let askedForFix = false;
  for (const c of commands) {
    // Whether this may be sent at all is decided in src/safety.js — unknown
    // speed is not a stationary vehicle, and a stale reading is not "now".
    const hold = safety.holdCheck(c.command, speed);
    if (hold) {
      // For unknown or stale, ask for a fix so the operator's retry succeeds
      // in seconds rather than waiting on the vehicle's reporting interval.
      if (hold.askFix && !askedForFix && dialect.locateText) {
        try { send(dialect.locateText()); askedForFix = true; } catch (_e) { /* best effort */ }
      }
      const tail = hold.askFix ? " — asked the device for a fix, retry in a moment" : "";
      await up.ack(imei, c.id, false, `held: ${hold.why}${tail}`, protocol);
      log(imei, "HELD", c.command, "—", hold.why);
      continue;
    }
    try {
      let text = null;
      switch (c.command) {
        // An explicit arg (e.g. "RELAY,1#" for a GS900) overrides the protocol default.
        case "immobilise":
        case "immobilise_instant": text = (c.arg && c.arg.trim()) || dialect.immobiliseText(true); break;
        case "mobilise": text = (c.arg && c.arg.trim()) || dialect.immobiliseText(false); break;
        case "locate_now": text = dialect.locateText(); break;
        case "buzzer": text = dialect.buzzerText ? dialect.buzzerText() : null; break;
        // Drops the device's un-uploaded blind-spot buffer, so a unit back from
        // a long dead zone stops replaying hours-old fixes. Teltonika has no
        // equivalent and falls through to "not supported by this device".
        case "clear_cache": text = dialect.clearCacheText ? dialect.clearCacheText() : null; break;
        case "set_timing": { const t = parseTiming(c.arg); text = t ? dialect.timingText(t.on, t.off) : null; break; }
        case "live_on": text = dialect.timingText(LIVE_S, LIVE_S); break;
        case "live_off": text = dialect.timingText(timing?.on ?? 20, timing?.off ?? 300); break;
        case "custom": text = String(c.arg || "").trim() || null; break;
        default: text = null;
      }
      if (!text) {
        await up.ack(imei, c.id, false, "not supported by this device", protocol);
        log(imei, "unsupported command", c.command);
        continue;
      }
      send(text);
      await up.ack(imei, c.id, true, "sent: " + text.slice(0, 120), protocol);
      sent = { id: c.id, command: c.command };
      log(imei, "command sent:", c.command, text.length > 70 ? text.slice(0, 70) + "…" : text);
    } catch (e) {
      await up.ack(imei, c.id, false, e.message, protocol);
    }
  }
  return sent;
}

// ---- live sessions, so the queue can be flushed on a clock -------------------
//
// applyCommands used to run only when a device sent us a packet, so a queued
// command waited for the vehicle's next heartbeat — up to 5 minutes on the
// default off=300, and longer if it was asleep. The device still has to be
// connected (we cannot push to a unit that is not), but while it IS connected
// there is no reason to make the fitter wait for the next report.

// An IMEI is NOT a unique key here. Cheap GT06-family units ship with cloned
// or recycled IMEIs, so two different trackers — on different protocols, in
// different vehicles — can legitimately present the same digits. Keying this
// registry on the IMEI alone meant the second one to connect replaced the
// first, and the first silently stopped getting its queue flushed.
//
// Everything per-device is therefore keyed by protocol AND imei.

/** "gt06:35…" -> { send, dialect, speed(), setPending() } per connected device. */
const sessions = new Map();
const inFlight = new Set(); // guards against a timer tick racing a packet

const COMMAND_POLL_S = Number(process.env.COMMAND_POLL_S || 5);

/** The key for one physical tracker. */
const deviceKey = (protocol, imei) => `${protocol}:${imei}`;

function openSession(protocol, imei, session) {
  if (!imei) return null;
  const key = deviceKey(protocol, imei);
  const existing = sessions.get(key);
  if (existing) {
    // Same protocol AND same IMEI: either a reconnect whose old socket has not
    // closed yet, or two units genuinely cloned onto one IMEI. Either way the
    // newest connection is the one that can be written to, but say so — a pair
    // of clones on one protocol is a fitting error nobody will otherwise spot.
    log("WARNING", key, "already connected — replacing the earlier session;",
        "if both units are live, they share an IMEI on the same protocol and",
        "cannot be told apart");
  }
  sessions.set(key, { ...session, protocol, imei, key });
  return sessions.get(key);
}

function closeSession(protocol, imei, session) {
  if (!imei || !session) return;
  const key = deviceKey(protocol, imei);
  if (sessions.get(key) === session) sessions.delete(key);
}

/** Flush one connected device's queue. Shared by the timer and the packet path. */
async function flush(session) {
  if (!session) return;
  const { key, imei, protocol } = session;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const sent = await applyCommands(imei, session.send, session.dialect,
                                     session.speed(), protocol);
    if (sent) session.setPending(sent);
  } catch (e) {
    log("command flush failed", key, e.message);
  } finally {
    inFlight.delete(key);
  }
}

if (COMMAND_POLL_S > 0) {
  setInterval(() => {
    for (const session of sessions.values()) flush(session);
  }, COMMAND_POLL_S * 1000);
}

/**
 * A device's text reply. Attach it to the pending command's ack; if that
 * command was locate_now, turn the reply into a position report.
 */
async function handleReply(imei, pending, text, parsePos, protocol) {
  log(imei, "device reply:", text.slice(0, 120));
  if (!pending) return null;
  await up.ack(imei, pending.id, true, text.slice(0, 200), protocol);
  if (pending.command === "locate_now") {
    const pos = parsePos(text);
    if (pos) await up.report(imei, pos, protocol);
  }
  return null;
}

// ---- Teltonika --------------------------------------------------------------

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let imei = null;
  let lastSpeed = null;
  let pending = null; // last command sent, awaiting the device's Codec 12 reply
  let lastSpeedAt = null;
  // Ignition is tracked apart from speed because it arrives without a GPS fix,
  // which is what lets a jammed or underground vehicle still be immobilised.
  // See the note at the top of src/safety.js.
  let lastIgnition = null, lastIgnitionAt = null;
  const noteIgnition = (on) => { if (on != null) { lastIgnition = !!on; lastIgnitionAt = Date.now(); } };
  const speedNow = () => ({ kmh: lastSpeed, at: lastSpeedAt, ignition: lastIgnition, ignitionAt: lastIgnitionAt });
  let session = null;
  sock.on("close", () => closeSession("teltonika", imei, session));
  sock.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      if (!imei) {
        const got = tel.parseImei(buf);
        if (got == null) return;
        imei = got.replace(/[^0-9]/g, "");
        buf = buf.subarray(2 + got.length);
        sock.write(tel.IMEI_ACCEPT);
        log("teltonika login", imei, sock.remoteAddress);
        session = openSession("teltonika", imei, {
          send: (t) => sock.write(tel.buildCommand(t)),
          dialect: tel,
          speed: speedNow,
          setPending: (p) => { pending = p; },
        });
        return;
      }
      let pkt;
      while ((pkt = tel.parseAvl(buf))) {
        buf = buf.subarray(pkt.consumed);
        if (pkt.response != null) {
          // Codec 12 reply to something we sent — no AVL ack for these.
          pending = await handleReply(imei, pending, pkt.response, tel.parseGetGps, "teltonika");
          continue;
        }
        sock.write(tel.avlAck(pkt.count));
        for (const r of pkt.records) {
          // Ignition (IO 239) is on the record whether or not the fix is
          // valid, so take it from every record — not only the ones we report.
          noteIgnition(r.ignition);
          if (r.lat || r.lng) { lastSpeed = r.speed; lastSpeedAt = Date.now(); await up.report(imei, r, "teltonika"); }
        }
        pending = (await applyCommands(imei, (t) => sock.write(tel.buildCommand(t)), tel, speedNow(), "teltonika")) || pending;
      }
    } catch (e) {
      log("teltonika error", imei, e.message);
      sock.destroy();
    }
  });
  sock.on("error", () => {});
}).listen(TELTONIKA_PORT, () => log("Teltonika gateway on", TELTONIKA_PORT));

// ---- GT06 -------------------------------------------------------------------

/** Last fix + odometer per GT06 device, kept across reconnects (in memory).
 *  Keyed with the protocol for the same reason the session registry is. */
const lastByImei = new Map();

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let imei = null;
  let lastSpeed = null;
  let pending = null;
  // GT06 sends ignition/voltage/GSM in its status packet, not with each fix;
  // remember the latest and attach it to the positions that follow. The GT06
  // also has no odometer, so distance is integrated here from the fixes.
  let status = {};
  let prevFix = null;
  let odometerKm = null;
  // Real supply voltage: GT06-family status frames only carry a backup-battery
  // level, so we ask the unit (GS900 "POWERLEVEL#" -> "POWERLEVEL_OK:11.80V") on
  // login and every 5 min while idle. Units that don't know the command just
  // don't answer. A real reading is trusted for 20 min.
  let realVolt = null, realVoltAt = 0, voltAskedAt = 0;
  const VOLT_POLL_MS = 90_000, VOLT_TRUST_MS = 20 * 60_000;
  const sendCmd = (t) => sock.write(gt.buildCommand(t));
  const askVoltage = () => { sendCmd("POWERLEVEL#"); voltAskedAt = Date.now(); };
  let lastSpeedAt = null;
  // As on the Teltonika side: ignition is kept separately because the GT06
  // status frame carries it with no position at all. See src/safety.js.
  let lastIgnition = null, lastIgnitionAt = null;
  const noteIgnition = (on) => { if (on != null) { lastIgnition = !!on; lastIgnitionAt = Date.now(); } };
  const speedNow = () => ({ kmh: lastSpeed, at: lastSpeedAt, ignition: lastIgnition, ignitionAt: lastIgnitionAt });
  let session = null;
  sock.on("close", () => closeSession("gt06", imei, session));
  sock.on("data", async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      let step;
      while ((step = gt.nextFrame(buf))) {
        buf = step.rest;
        if (!step.frame) continue; // resynced past a stray byte
        const { protocol, content, serial } = gt.parseFrame(step.frame, step.lenBytes, step.headerLen);

        if (protocol === gt.LOGIN) {
          imei = gt.parseLogin(content);
          sock.write(gt.ack(protocol, serial));
          log("gt06 login", imei, sock.remoteAddress);
          if (imei) {
            askVoltage();
            setTimeout(() => { try { if (realVolt == null) askVoltage(); } catch (_e) {} }, 15_000);  // retry — GS900 often ignores the first POWERLEVEL#
            session = openSession("gt06", imei, {
              send: sendCmd, dialect: gt,
              speed: speedNow,
              setPending: (p) => { pending = p; },
            });
          }
          // A GT06 reboots when its power comes back; carry the last fix and
          // odometer over so its first heartbeats (before a new GPS fix) still
          // reach the platform — power/ignition changes show straight away.
          const saved = lastByImei.get(deviceKey("gt06", imei));
          if (saved && !prevFix) { prevFix = { ...saved.fix, speed: 0 }; odometerKm = saved.odo; }
        } else if (protocol === gt.GPS_LBS_2 || protocol === gt.ALARM_1 || protocol === gt.ALARM_2) {
          // Alarm packet: position + status + the alarm that caused it (power
          // cut, vibration, SOS…). Forward the alarm once; keep the status bits.
          sock.write(gt.ack(protocol, serial));
          if (imei) {
            const a = gt.parseAlarm(content);
            const { alarm, lat, lng, time, speed, heading, ...st } = a;
            if (st.ignition != null) status = { ...status, ...st };
            noteIgnition(st.ignition);
            const pos = (lat || lng) ? { lat, lng, time, speed, heading } : prevFix;
            if (alarm) log("gt06 alarm", imei, alarm, "ext=" + st.extPower);
            if (lat || lng) {
              lastSpeed = speed; lastSpeedAt = Date.now();
              if (prevFix) odometerKm = (odometerKm ?? 0) + haversineKm(prevFix, pos);
              prevFix = pos;
            }
            // Even with no fix at all the alarm still goes up (status-only report).
            await up.report(imei, { ...(pos || {}), ...status, alarm, odometerKm: odometerKm ?? undefined, time: (lat || lng) ? time : Date.now() }, "gt06");
            pending = (await applyCommands(imei, sendCmd, gt, speedNow(), "gt06")) || pending;
          }
        } else if (protocol === gt.GPS || protocol === gt.GPS_LBS) {
          sock.write(gt.ack(protocol, serial));
          if (imei) {
            const pos = gt.parseLocation(content);
            if (pos.lat || pos.lng) {
              lastSpeed = pos.speed; lastSpeedAt = Date.now();
              if (prevFix) odometerKm = (odometerKm ?? 0) + haversineKm(prevFix, pos);
              prevFix = pos;
              await up.report(imei, { ...pos, ...status, odometerKm: odometerKm ?? undefined }, "gt06");
            }
            pending = (await applyCommands(imei, sendCmd, gt, speedNow(), "gt06")) || pending;
          }
        } else if (protocol === gt.STATUS) {
          sock.write(gt.ack(protocol, serial));
          const { alarm: hbAlarm, ...st } = gt.parseStatus(content);
          if (st.extPower !== status.extPower) { log("gt06 ext power", imei, st.extPower ? "connected" : "disconnected", "info=0x" + (content[0] ?? 0).toString(16)); askVoltage(); }
          status = st;
          noteIgnition(st.ignition);
          if (realVolt != null && Date.now() - realVoltAt < VOLT_TRUST_MS) status.voltage = realVolt;
          if (!pending && Date.now() - voltAskedAt > VOLT_POLL_MS) askVoltage();
          // The status frame carries fresh GSM signal / voltage / ignition /
          // external-power but no GPS. Push it to the platform against the last
          // known position (stamped now) so signal, power and "online" stay
          // current between fixes — e.g. a parked vehicle that only heartbeats.
          // Skipped until we have a fix. Its alarm bits go on this report only.
          if (imei) {
            if (hbAlarm) log("gt06 status alarm", imei, hbAlarm);
            // No fix yet on this connection: send status only — the platform
            // pins it to the vehicle's last known position.
            await up.report(imei, { ...(prevFix || {}), ...status, alarm: hbAlarm, odometerKm: odometerKm ?? undefined, time: Date.now() }, "gt06");
            pending = (await applyCommands(imei, sendCmd, gt, speedNow(), "gt06")) || pending;
          }
        } else if (protocol === gt.COMMAND_RESP || protocol === gt.COMMAND_RESP_2) {
          // The device's text answer to an online command (no ack expected).
          const text = gt.parseResponseText(content);
          const mv = /POWERLEVEL_OK:\s*([\d.]+)\s*V/i.exec(text);
          if (mv) {
            realVolt = parseFloat(mv[1]); realVoltAt = Date.now(); status.voltage = realVolt;
            log("gt06 voltage", imei, realVolt + "V");
            if (imei) await up.report(imei, { ...(prevFix || {}), ...status, odometerKm: odometerKm ?? undefined, time: Date.now() }, "gt06");
          }
          if (imei && (!mv || pending)) pending = await handleReply(imei, pending, text, gt.parseWhere, "gt06");
        } else {
          // heartbeat / alarms — ack so the device stays connected.
          sock.write(gt.ack(protocol, serial));
          if (imei) pending = (await applyCommands(imei, sendCmd, gt, speedNow(), "gt06")) || pending;
        }
        if (imei && prevFix) lastByImei.set(deviceKey("gt06", imei), { fix: prevFix, odo: odometerKm });
      }
    } catch (e) {
      log("gt06 error", imei, e.message);
      sock.destroy();
    }
  });
  sock.on("error", () => {});
}).listen(GT06_PORT, () => log("GT06 gateway on", GT06_PORT));

up.checkConfig();
log("command queue polled every", COMMAND_POLL_S + "s while a device is connected");

process.on("uncaughtException", (e) => log("uncaught", e.message));
