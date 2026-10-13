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
const GPS_LBS_2 = 0x16;

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

module.exports = {
  nextFrame, parseFrame, parseLogin, parseLocation, ack, buildCommand, immobiliseText,
  LOGIN, GPS, STATUS, GPS_LBS, GPS_LBS_2,
};
