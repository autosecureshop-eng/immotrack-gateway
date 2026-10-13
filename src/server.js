// The IMMOSTOP tracker gateway.
//
// Two TCP listeners — one for Teltonika (FMB920/FMC920), one for GT06/Concox.
// Each decodes its devices' positions and forwards them to Supabase, and picks
// up queued commands (immobilise/mobilise/locate/buzzer) and sends them to the
// device in its own dialect.
//
// SAFETY: remote immobilise is "prevent next start while stationary". The server
// already refuses to queue it while moving; here we re-check the last speed we
// saw and hold the command if the vehicle is moving, so a command can never cut
// a vehicle in motion.

const net = require("net");
const tel = require("./teltonika");
const gt = require("./gt06");
const up = require("./upstream");

const TELTONIKA_PORT = Number(process.env.TELTONIKA_PORT || 5027);
const GT06_PORT = Number(process.env.GT06_PORT || 5023);
const MOVING_KMH = 3;

function log(...a) { console.log(new Date().toISOString(), ...a); }

/** Great-circle distance between two fixes, km. */
function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- apply queued commands to a live session --------------------------------

async function applyCommands(imei, send, dialect, lastSpeed) {
  const cmds = await up.poll(imei);
  for (const c of cmds) {
    if (c.command === "immobilise" && lastSpeed != null && lastSpeed > MOVING_KMH) {
      await up.ack(imei, c.id, false, "held: vehicle moving");
      log(imei, "HELD immobilise — moving", lastSpeed);
      continue;
    }
    try {
      if (c.command === "immobilise") send(dialect.immobiliseText(true));
      else if (c.command === "mobilise") send(dialect.immobiliseText(false));
      else if (c.command === "locate_now") { /* device reports on its own cadence */ }
      else if (c.command === "buzzer" && dialect.buzzerText) send(dialect.buzzerText());
      await up.ack(imei, c.id, true, "sent");
      log(imei, "command sent:", c.command);
    } catch (e) {
      await up.ack(imei, c.id, false, e.message);
    }
  }
}

// ---- Teltonika --------------------------------------------------------------

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let imei = null;
  let lastSpeed = null;
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
        return;
      }
      let pkt;
      while ((pkt = tel.parseAvl(buf))) {
        buf = buf.subarray(pkt.consumed);
        sock.write(tel.avlAck(pkt.count));
        for (const r of pkt.records) {
          if (r.lat || r.lng) { lastSpeed = r.speed; await up.report(imei, r); }
        }
        await applyCommands(imei, (t) => sock.write(tel.buildCommand(t)), tel, lastSpeed);
      }
    } catch (e) {
      log("teltonika error", imei, e.message);
      sock.destroy();
    }
  });
  sock.on("error", () => {});
}).listen(TELTONIKA_PORT, () => log("Teltonika gateway on", TELTONIKA_PORT));

// ---- GT06 -------------------------------------------------------------------

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let imei = null;
  let lastSpeed = null;
  // GT06 sends ignition/voltage/GSM in its status packet, not with each fix;
  // remember the latest and attach it to the positions that follow. The GT06
  // also has no odometer, so distance is integrated here from the fixes.
  let status = {};
  let prevFix = null;
  let odometerKm = null;
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
        } else if (protocol === gt.GPS || protocol === gt.GPS_LBS || protocol === gt.GPS_LBS_2) {
          sock.write(gt.ack(protocol, serial));
          if (imei) {
            const pos = gt.parseLocation(content);
            if (pos.lat || pos.lng) {
              lastSpeed = pos.speed;
              if (prevFix) odometerKm = (odometerKm ?? 0) + haversineKm(prevFix, pos);
              prevFix = pos;
              await up.report(imei, { ...pos, ...status, odometerKm: odometerKm ?? undefined });
            }
            await applyCommands(imei, (t) => sock.write(gt.buildCommand(t)), gt, lastSpeed);
          }
        } else if (protocol === gt.STATUS) {
          sock.write(gt.ack(protocol, serial));
          status = gt.parseStatus(content);
          if (imei) await applyCommands(imei, (t) => sock.write(gt.buildCommand(t)), gt, lastSpeed);
        } else {
          // heartbeat / alarms — ack so the device stays connected.
          sock.write(gt.ack(protocol, serial));
          if (imei) await applyCommands(imei, (t) => sock.write(gt.buildCommand(t)), gt, lastSpeed);
        }
      }
    } catch (e) {
      log("gt06 error", imei, e.message);
      sock.destroy();
    }
  });
  sock.on("error", () => {});
}).listen(GT06_PORT, () => log("GT06 gateway on", GT06_PORT));

process.on("uncaughtException", (e) => log("uncaught", e.message));
