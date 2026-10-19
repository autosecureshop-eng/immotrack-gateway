// Teltonika FMB920 / FMC920 — Codec 8 & 8 Extended (AVL data) and Codec 12
// (GPRS commands, used here to drive the digital output for immobilise).
//
// Session flow:
//   1. device connects and sends IMEI: [2-byte length][IMEI ASCII]
//      -> reply one byte 0x01 to accept.
//   2. device sends AVL packets (Codec 8/8E)
//      -> reply 4 bytes = number of records accepted.
//   3. to command the device, send a Codec 12 packet; it replies Codec 12.

const { crc16ibm } = require("./crc");

/** Parse the IMEI handshake. Returns the IMEI string, or null if incomplete. */
function parseImei(buf) {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  if (buf.length < 2 + len) return null;
  return buf.toString("ascii", 2, 2 + len);
}

const IMEI_ACCEPT = Buffer.from([0x01]);
const IMEI_REJECT = Buffer.from([0x00]);

/**
 * Parse an AVL data packet (Codec 8 = 0x08, Codec 8 Extended = 0x8E).
 * Returns { records:[{time,lat,lng,speed,heading,satellites,priority}], count }
 * or null if the buffer doesn't yet hold a whole packet. Throws on a bad CRC.
 */
function parseAvl(buf) {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) !== 0) throw new Error("bad preamble");
  const dataLen = buf.readUInt32BE(4);
  const total = 8 + dataLen + 4; // preamble+len + data + crc
  if (buf.length < total) return null;

  const data = buf.subarray(8, 8 + dataLen);
  const crcGot = buf.readUInt32BE(8 + dataLen) & 0xffff;
  const crcCalc = crc16ibm(data);
  if (crcGot !== crcCalc) throw new Error(`teltonika crc ${crcGot.toString(16)} != ${crcCalc.toString(16)}`);

  const codec = data[0];
  if (codec === 0x0c) {
    // Codec 12 = the device's reply to a GPRS command we sent:
    // [0x0C][qty 1][type 0x06][len:4][ASCII text][qty 2]. Returned as text so
    // the session can attach it to the command's ack instead of dropping.
    const len = data.readUInt32BE(3);
    const response = data.toString("ascii", 7, 7 + len).replace(/[^\x20-\x7e]/g, "");
    return { records: [], count: 0, consumed: total, response };
  }
  const ext = codec === 0x8e;
  if (codec !== 0x08 && codec !== 0x8e) throw new Error("not an AVL data packet (codec " + codec.toString(16) + ")");
  let p = 1;
  const n = data[p++];
  const records = [];
  for (let i = 0; i < n; i++) {
    const time = Number(data.readBigUInt64BE(p)); p += 8;
    const priority = data[p++];
    const lng = data.readInt32BE(p) / 1e7; p += 4;
    const lat = data.readInt32BE(p) / 1e7; p += 4;
    p += 2; // altitude
    const heading = data.readUInt16BE(p); p += 2;
    const satellites = data[p++];
    const speed = data.readUInt16BE(p); p += 2; // km/h

    // IO elements: keep the handful the app shows, walk past the rest.
    const io = {};
    const readVal = (sz) => {
      let v;
      if (sz === 1) v = data[p];
      else if (sz === 2) v = data.readUInt16BE(p);
      else if (sz === 4) v = data.readUInt32BE(p);
      else v = Number(data.readBigUInt64BE(p));
      p += sz;
      return v;
    };
    if (ext) {
      p += 2; // event IO id (2 bytes)
      const totalIo = data.readUInt16BE(p); p += 2; void totalIo;
      for (const sz of [1, 2, 4, 8]) {
        const cnt = data.readUInt16BE(p); p += 2;
        for (let k = 0; k < cnt; k++) {
          const id = data.readUInt16BE(p); p += 2;
          io[id] = readVal(sz);
        }
      }
      const nx = data.readUInt16BE(p); p += 2;
      for (let k = 0; k < nx; k++) {
        p += 2; // id
        const vlen = data.readUInt16BE(p); p += 2;
        p += vlen;
      }
    } else {
      p += 1; // event IO id (1 byte)
      const totalIo = data[p++]; void totalIo;
      for (const sz of [1, 2, 4, 8]) {
        const cnt = data[p++];
        for (let k = 0; k < cnt; k++) {
          const id = data[p++];
          io[id] = readVal(sz);
        }
      }
    }
    records.push({
      time, priority, lat, lng, speed, heading, satellites,
      // Teltonika AVL IDs (FMB/FMC): 239 ignition, 240 movement, 21 GSM level,
      // 66 external voltage mV, 67 battery mV, 16 total odometer m, 199 trip odometer m.
      ignition: io[239] == null ? undefined : io[239] === 1,
      moving: io[240] == null ? undefined : io[240] === 1,
      gsm: io[21],
      voltage: io[66] == null ? undefined : io[66] / 1000,
      batteryVolts: io[67] == null ? undefined : io[67] / 1000,
      odometerKm: io[16] == null ? undefined : io[16] / 1000,
      // External 12 V present: 252 "unplug" (1 = unplugged) wins, else 66 > 6 V.
      extPower: io[252] != null ? io[252] !== 1 : io[66] == null ? undefined : io[66] > 6000,
      // 252 unplug -> power cut, 246 towing, 247 crash (eventual-record IOs).
      alarm: io[252] === 1 ? "powercut" : io[246] === 1 ? "tow" : io[247] ? "crash" : undefined,
    });
  }
  return { records, count: n, consumed: total };
}

/** 4-byte ack = number of records accepted. */
function avlAck(count) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(count, 0);
  return b;
}

/**
 * Build a Codec 12 GPRS command packet carrying [text] (ASCII).
 * For immobilise we send "setdigout 1" (DOUT1 high) / "setdigout 0" (low).
 */
function buildCommand(text) {
  const cmd = Buffer.from(text, "ascii");
  const data = Buffer.concat([
    Buffer.from([0x0c, 0x01, 0x05]), // codec 12, quantity 1, type 0x05 (command)
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(cmd.length, 0); return b; })(),
    cmd,
    Buffer.from([0x01]), // quantity 2
  ]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(0, 0);               // preamble
  out.writeUInt32BE(data.length, 4);     // data length
  data.copy(out, 8);
  out.writeUInt32BE(crc16ibm(data), 8 + data.length);
  return out;
}

/** The command text for immobilise/mobilise via the configured digital output. */
function immobiliseText(on) {
  return on ? "setdigout 1" : "setdigout 0";
}

// Data-acquisition periods (seconds). FMB/FMC parameter IDs:
//   Home network:  on-stop Min Period 10000 / Send Period 10005,
//                  moving  Min Period 10050 / Send Period 10055
//   Roaming = +100 (10100/10105, 10150/10155), Unknown network = +200.
// UK IoT SIMs often attach as "roaming", so all three sets are written at once.
// If a firmware disagrees, check the FMB920 parameter list on the Teltonika wiki.
// Note: reporting while parked also needs Sleep Mode (param 102) left at 0/GPS
// sleep — deep sleep stops the device sending between wake-ups.
const PERIOD_IDS = {
  moveMin: [10050, 10150, 10250], moveSend: [10055, 10155, 10255],
  stopMin: [10000, 10100, 10200], stopSend: [10005, 10105, 10205],
};
/** setparam text for a heartbeat of [onS] seconds moving / [offS] seconds stopped. */
function timingText(onS, offS) {
  const on = Math.max(1, Math.round(onS)), off = Math.max(1, Math.round(offS));
  const parts = [];
  for (const id of PERIOD_IDS.moveMin) parts.push(`${id}:${on}`);
  for (const id of PERIOD_IDS.moveSend) parts.push(`${id}:${on}`);
  for (const id of PERIOD_IDS.stopMin) parts.push(`${id}:${off}`);
  for (const id of PERIOD_IDS.stopSend) parts.push(`${id}:${off}`);
  return "setparam " + parts.join(";");
}

/** Ask for the current fix; the device answers (Codec 12) with a text line. */
function locateText() { return "getgps"; }

/** Position from a getgps reply, e.g. "GPS:1 Sat:9 Lat:52.4862 Long:-1.8904 Alt:120 Speed:0 Dir:0 Date: ..." */
function parseGetGps(text) {
  const lat = /Lat:\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  const lng = /Lon\w*:\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (!lat || !lng) return null;
  const spd = /Speed:\s*(\d+(?:\.\d+)?)/i.exec(text);
  const dir = /Dir:\s*(\d+(?:\.\d+)?)/i.exec(text);
  const sat = /Sat:\s*(\d+)/i.exec(text);
  return {
    lat: Number(lat[1]), lng: Number(lng[1]), time: Date.now(),
    speed: spd ? Number(spd[1]) : undefined, heading: dir ? Number(dir[1]) : undefined,
    satellites: sat ? Number(sat[1]) : undefined,
  };
}

module.exports = {
  parseImei, IMEI_ACCEPT, IMEI_REJECT, parseAvl, avlAck, buildCommand,
  immobiliseText, timingText, locateText, parseGetGps, PERIOD_IDS,
};
