// GT06 / Concox — login, location, status/heartbeat, and online command
// (relay cut/restore for immobilise).
//
// Frame: 0x7878 [len:1] [protocol:1] [content...] [serial:2] [crc:2] 0x0D0A
//    or  0x7979 [len:2] ... (extended frames). CRC-ITU over [len .. serial].

const { crcItu } = require("./crc");

/**
 * Pull the next complete frame off the front of [buf].
 * Returns { frame, rest } or null if a whole frame isn't present yet.
 */
function nextFrame(buf) {
  if (buf.length < 5) return null;
  let headerLen, lenBytes, bodyLen;
  if (buf[0] === 0x78 && buf[1] === 0x78) {
    bodyLen = buf[2]; lenBytes = 1; headerLen = 2;
  } else if (buf[0] === 0x79 && buf[1] === 0x79) {
    bodyLen = buf.readUInt16BE(2); lenBytes = 2; headerLen = 2;
  } else {
    // resync: drop one byte and let the caller retry
    return { frame: null, rest: buf.subarray(1) };
  }
  const total = headerLen + lenBytes + bodyLen + 2; // start + len + body + stop(0D0A)
  if (buf.length < total) return null;
  return { frame: buf.subarray(0, total), rest: buf.subarray(total), lenBytes, headerLen };
}

/** { protocol, content, serial } from a validated frame. Throws on bad CRC. */
function parseFrame(frame, lenBytes, headerLen) {
  const bodyStart = headerLen + lenBytes;
  const protocol = frame[bodyStart];
  const stop = frame.length - 2;
  const crcGot = frame.readUInt16BE(stop - 2);
  // CRC-ITU covers from the length byte(s) up to and including the serial.
  const crcCalc = crcItu(frame.subarray(headerLen, stop - 2));
  if (crcGot !== crcCalc) throw new Error(`gt06 crc ${crcGot.toString(16)} != ${crcCalc.toString(16)}`);
  const serial = frame.readUInt16BE(stop - 4);
  const content = frame.subarray(bodyStart + 1, stop - 4);
  return { protocol, content, serial };
}

const LOGIN = 0x01;
const GPS = 0x12;
const STATUS = 0x13;
const GPS_LBS = 0x22;
const GPS_LBS_2 = 0x16;      // GPS + LBS + status + alarm byte (the alarm packet)
const ALARM_1 = 0x26;        // alarm packet, multi-fence variant (same layout)
const ALARM_2 = 0x27;        // alarm packet, some newer firmware (same layout)
const COMMAND_RESP = 0x15;   // device's answer to an online command (older firmware)
const COMMAND_RESP_2 = 0x21; // same, newer firmware

/** IMEI from a login packet (8 bytes BCD, 16 nibbles; drop a leading 0). */
function parseLogin(content) {
  const imei = content.subarray(0, 8).toString("hex");
  return imei.replace(/^0/, "");
}

/** Position from a 0x12 / 0x22 / 0x16 location packet. */
function parseLocation(content) {
  // 6 bytes datetime, 1 byte (sat count / gps len), then lat/lng/speed/course.
  const yy = content[0], mm = content[1], dd = content[2], HH = content[3], MM = content[4], SS = content[5];
  const time = Date.UTC(2000 + yy, mm - 1, dd, HH, MM, SS);
  let p = 7; // skip datetime(6) + gps info length/sat(1)
  let lat = content.readUInt32BE(p) / 1800000; p += 4;
  let lng = content.readUInt32BE(p) / 1800000; p += 4;
  const speed = content[p++];
  const flags = content.readUInt16BE(p); p += 2;
  const course = flags & 0x03ff;
  if ((flags & 0x0400) === 0) lat = -lat; // bit10 clear = south
  if ((flags & 0x0800) !== 0) lng = -lng; // bit11 set   = west
  return { time, lat, lng, speed, heading: course };
}

/** Terminal-info bits 3..5 alarm code -> our alarm names. */
const INFO_ALARM = { 1: "vibration", 2: "powercut", 3: "lowbattery", 4: "sos" };

/** Alarm byte of a 0x16 / 0x26 / 0x27 alarm packet -> our alarm names. */
const ALARM_BYTE = {
  0x01: "sos", 0x02: "powercut", 0x03: "vibration", 0x04: "geofence_in", 0x05: "geofence_out",
  0x06: "overspeed", 0x09: "movement", 0x0a: "gps_lost", 0x0b: "gps_restored", 0x0c: "poweron",
  0x0d: "first_fix", 0x0e: "lowbattery", 0x0f: "lowbattery", 0x11: "poweroff", 0x13: "powercut",
  0x14: "tow", 0x17: "jamming", 0x18: "tamper", 0x19: "poweroff",
  // Concox extended driving-behaviour codes
  0x29: "harsh_accel", 0x30: "harsh_brake", 0x2a: "harsh_turn", 0x2b: "harsh_turn", 0x2c: "collision",
};

/**
 * Status / heartbeat (0x13): terminal info byte, voltage level, GSM level.
 * Terminal info: bit 0 = defence (armed), bit 1 = ACC (ignition) on, bit 2 =
 * charging (external 12 V feed connected), bits 3..5 = alarm (001 vibration,
 * 010 power cut, 011 low battery, 100 SOS), bit 6 = GPS tracking on, bit 7 =
 * oil & electricity disconnected (our relay cut).
 * Voltage level 0..6 is the tracker's OWN backup battery (no battery .. full),
 * so it stays high after the car feed is cut.
 * GSM level 0..4.
 */
function parseStatus(content) {
  const info = content[0] ?? 0;
  const voltageLevel = content[1];
  const gsmLevel = content[2];
  return {
    ignition: (info & 0x02) !== 0,
    armed: (info & 0x01) !== 0,
    // Bit 2 tracks the car feed on the test unit (0 while unplugged, 1 straight
    // after reconnect, verified 2026-10-19). The server only alerts on a seen
    // true -> false change, so units that never set it can't false-alarm.
    extPower: (info & 0x04) !== 0,
    alarm: INFO_ALARM[(info >> 3) & 0x07] || undefined,
    relayCut: (info & 0x80) !== 0,
    voltageLevel: voltageLevel == null ? undefined : voltageLevel,
    battery: voltageLevel == null ? undefined : Math.round(Math.min(voltageLevel, 6) / 6 * 100),
    gsm: gsmLevel == null ? undefined : gsmLevel,
  };
}

/**
 * Alarm packet (0x16 / 0x26 / 0x27): a location block (18 bytes), then LBS
 * (its first byte is the LBS length incl. itself, usually 9), then the same
 * terminal info / voltage / GSM bytes as a status frame, then the alarm byte.
 * Returns { ...position, ...status, alarm } — alarm from the alarm byte wins
 * over the terminal-info alarm bits.
 */
function parseAlarm(content) {
  const pos = parseLocation(content);
  let p = 18;
  const lbsLen = content[p];
  p += lbsLen >= 8 && lbsLen <= 12 ? lbsLen : 9;
  if (content.length < p + 4) return { ...pos };
  const st = parseStatus(content.subarray(p, p + 3));
  const code = content[p + 3];
  return { ...pos, ...st, alarm: ALARM_BYTE[code] || st.alarm };
}

/** Standard ack: echo the protocol + serial back. */
function ack(protocol, serial) {
  const body = Buffer.from([protocol, (serial >> 8) & 0xff, serial & 0xff]);
  const lenAndBody = Buffer.concat([Buffer.from([body.length + 2]), body]);
  const crc = crcItu(lenAndBody);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]), lenAndBody,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, 0x0d, 0x0a]),
  ]);
}

/**
 * Online command (protocol 0x80): send an ASCII command to the device.
 * Immobilise relay cut = "DYD,<pwd>#"; restore = "HFYD,<pwd>#".
 */
function buildCommand(text, serial = 0x0001) {
  const cmd = Buffer.from(text, "ascii");
  const serverFlag = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  // 0x80 content = [cmdLen:1][serverFlag:4][command:M][language:2]
  const cmdLen = serverFlag.length + cmd.length; // 4 + M
  const lang = Buffer.from([0x00, 0x02]); // English
  const body = Buffer.concat([
    Buffer.from([0x80, cmdLen]), serverFlag, cmd, lang,
    Buffer.from([(serial >> 8) & 0xff, serial & 0xff]),
  ]);
  // length byte counts protocol..serial plus the 2 CRC bytes that follow.
  const lenAndBody = Buffer.concat([Buffer.from([body.length + 2]), body]);
  const crc = crcItu(lenAndBody);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]), lenAndBody,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, 0x0d, 0x0a]),
  ]);
}

function immobiliseText(on, password = "000000") {
  return on ? `DYD,${password}#` : `HFYD,${password}#`;
}

/** Upload interval: T1 seconds while ACC (ignition) is on, T2 while off. Range 5..18000. */
const clampPeriod = (s) => Math.min(18000, Math.max(5, Math.round(s)));
function timingText(onS, offS) {
  return `TIMER,${clampPeriod(onS)},${clampPeriod(offS)}#`;
}

/** Ask for the current position; the device answers with a text line. */
function locateText() { return "WHERE#"; }

/**
 * Clear the device's cached (blind-spot) data.
 *
 * A GT06 buffers fixes while it has no GPRS and replays them on reconnect. A
 * unit that has been out of signal for a long time can come back and flood the
 * gateway with stale positions, which land on the platform as a trail the
 * vehicle drove hours ago. BACKUP,0# turns that buffer off and drops what is
 * in it. Verified on a GS900 (IMEI 8651900744xxxxx).
 *
 * Destructive by design: anything cached and not yet uploaded is gone.
 */
function clearCacheText() { return "BACKUP,0#"; }

/** ASCII text from a 0x15 / 0x21 command-response content block:
 *  [len:1][server flag:4][text][language:2]; len covers the flag + text. */
function parseResponseText(content) {
  const len = content[0] ?? 0;
  const text = content.subarray(5, Math.min(content.length, 1 + len)).toString("ascii");
  return text.replace(/[^\x20-\x7e]/g, "");
}

/** Position from a WHERE# reply, e.g. "Lat:N52.473210,Lon:W1.903280,Course:0.00,Speed:0.0,DateTime:..." */
function parseWhere(text) {
  const m = /Lat:\s*([NS])?\s*(-?\d+(?:\.\d+)?)\s*,?\s*Lon\w*:\s*([EW])?\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  let lat = Number(m[2]), lng = Number(m[4]);
  if ((m[1] || "").toUpperCase() === "S") lat = -Math.abs(lat);
  if ((m[3] || "").toUpperCase() === "W") lng = -Math.abs(lng);
  const spd = /Speed:\s*(\d+(?:\.\d+)?)/i.exec(text);
  const crs = /Course:\s*(\d+(?:\.\d+)?)/i.exec(text);
  return { lat, lng, time: Date.now(), speed: spd ? Number(spd[1]) : undefined, heading: crs ? Number(crs[1]) : undefined };
}

module.exports = {
  nextFrame, parseFrame, parseLogin, parseLocation, parseStatus, parseAlarm, ack, buildCommand,
  immobiliseText, timingText, locateText, clearCacheText, parseResponseText, parseWhere,
  LOGIN, GPS, STATUS, GPS_LBS, GPS_LBS_2, ALARM_1, ALARM_2, COMMAND_RESP, COMMAND_RESP_2,
};
