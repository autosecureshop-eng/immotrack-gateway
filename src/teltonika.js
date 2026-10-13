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

    // IO element — we skip the values but must walk it to reach the next record.
    if (ext) {
      p += 2; // event IO id (2 bytes)
      const totalIo = data.readUInt16BE(p); p += 2; void totalIo;
      for (const sz of [1, 2, 4, 8]) {
        const cnt = data.readUInt16BE(p); p += 2;
        p += cnt * (2 + sz); // id(2) + value(sz)
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
        p += cnt * (1 + sz); // id(1) + value(sz)
      }
    }
    records.push({ time, priority, lat, lng, speed, heading, satellites });
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

module.exports = { parseImei, IMEI_ACCEPT, IMEI_REJECT, parseAvl, avlAck, buildCommand, immobiliseText };
