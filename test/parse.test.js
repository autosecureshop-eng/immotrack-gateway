const test = require("node:test");
const assert = require("node:assert");
const { crc16ibm, crcItu } = require("../src/crc");
const tel = require("../src/teltonika");
const gt = require("../src/gt06");

const hex = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// ---- Teltonika Codec 8: the canonical wiki example, one record, CRC 0xC7CF ---
// Teltonika's own documented Codec 8 example packet (one record, CRC 0xC7CF).
const TEL_CODEC8 = hex(
  "000000000000003608010000016B40D8EA30" +
  "010000000000000000000000000000000105" +
  "021503010101425E0F01F10000601A014E00" +
  "00000000000000010000C7CF",
);

test("teltonika: IMEI handshake parses", () => {
  const b = Buffer.concat([Buffer.from([0x00, 0x0f]), Buffer.from("356307042441013", "ascii")]);
  assert.equal(tel.parseImei(b), "356307042441013");
});

test("teltonika: Codec 8 record parses and CRC validates", () => {
  const r = tel.parseAvl(TEL_CODEC8);
  assert.equal(r.count, 1);
  assert.equal(r.records.length, 1);
  assert.equal(r.consumed, TEL_CODEC8.length);
});

test("teltonika: a tampered CRC is rejected", () => {
  const bad = Buffer.from(TEL_CODEC8);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => tel.parseAvl(bad), /crc/);
});

test("teltonika: command builder round-trips its own CRC", () => {
  const pkt = tel.buildCommand("setdigout 1");
  const dataLen = pkt.readUInt32BE(4);
  const data = pkt.subarray(8, 8 + dataLen);
  assert.equal(pkt.readUInt32BE(8 + dataLen) & 0xffff, crc16ibm(data));
});

// ---- GT06: a real login frame (Traccar test vector), IMEI 864717003283581 ---
const GT06_LOGIN = hex("78 78 0d 01 08 64 71 70 03 28 35 81 00 09 3f 04 0d 0a");

test("gt06: login frame CRC validates and IMEI decodes", () => {
  const step = gt.nextFrame(GT06_LOGIN);
  assert.ok(step && step.frame);
  const { protocol, content, serial } = gt.parseFrame(step.frame, step.lenBytes, step.headerLen);
  assert.equal(protocol, gt.LOGIN);
  assert.equal(serial, 0x0009);
  assert.equal(gt.parseLogin(content), "864717003283581");
});

test("gt06: ack is well-formed with a valid CRC", () => {
  const a = gt.ack(gt.LOGIN, 0x0009);
  assert.equal(a[0], 0x78); assert.equal(a[1], 0x78);
  const lenByte = a[2];
  const body = a.subarray(2, 2 + 1 + lenByte - 2); // len + protocol..serial
  const crc = a.readUInt16BE(a.length - 4);
  assert.equal(crc, crcItu(body));
});

test("gt06: immobilise command builds with a valid CRC", () => {
  const f = gt.buildCommand(gt.immobiliseText(true));
  const lenByte = f[2];
  const lenAndBody = f.subarray(2, 2 + 1 + lenByte - 2);
  const crc = f.readUInt16BE(f.length - 4);
  assert.equal(crc, crcItu(lenAndBody));
  assert.ok(f.includes(Buffer.from("DYD,000000#", "ascii")));
});
