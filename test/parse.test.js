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

test("teltonika: GSM signal (IO id 21 / CSQ) is extracted", () => {
  // The canonical example packet carries IO id 0x15 (21) = 3.
  const r = tel.parseAvl(TEL_CODEC8);
  assert.equal(r.records[0].gsm, 3);
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

test("gt06: status frame yields GSM level (CSQ), voltage and ignition", () => {
  // [terminal info][voltage level 0..6][gsm level 0..4][alarm/lang:2]
  const content = Buffer.from([0x02, 0x05, 0x04, 0x00, 0x01]); // ACC on, volt 5, gsm 4
  const s = gt.parseStatus(content);
  assert.equal(s.gsm, 4);
  assert.equal(s.ignition, true);
  assert.equal(s.voltage, undefined);   // no pretend volts — real volts come from POWERLEVEL#
  assert.equal(s.battery, 83);          // backup-battery level 5/6
  assert.equal(s.extPower, false);
  assert.equal(s.alarm, undefined);
});

test("gt06: terminal info decodes external power, power-cut alarm bits and relay", () => {
  // 0x46 = GPS on + charging + ACC on; 0x12 = ACC on + alarm 010 (power cut), not charging
  assert.equal(gt.parseStatus(Buffer.from([0x46, 6, 4])).extPower, true);
  const cut = gt.parseStatus(Buffer.from([0x12, 6, 4]));
  assert.equal(cut.extPower, false);
  assert.equal(cut.alarm, "powercut");
  assert.equal(cut.ignition, true);
  assert.equal(gt.parseStatus(Buffer.from([0x80, 6, 4])).relayCut, true);
});

test("gt06: 0x16 alarm packet yields position, status and the alarm byte", () => {
  const loc = Buffer.alloc(18);
  loc.set([26, 10, 19, 15, 30, 0, 0xc9], 0);           // 2026-10-19 15:30:00, 9 sats
  loc.writeUInt32BE(Math.round(52.48 * 1800000), 7);
  loc.writeUInt32BE(Math.round(1.89 * 1800000), 11);
  loc[15] = 40;                                          // 40 km/h
  loc.writeUInt16BE(0x0400 | 0x0800 | 90, 16);           // north, west, course 90
  const lbs = Buffer.from([0x09, 0x00, 0xea, 0x0a, 0x12, 0x34, 0x00, 0x56, 0x78]);
  const tail = Buffer.from([0x42, 0x06, 0x04, 0x02, 0x02]); // ACC on, no charge, alarm 0x02
  const a = gt.parseAlarm(Buffer.concat([loc, lbs, tail]));
  assert.equal(a.alarm, "powercut");
  assert.equal(a.extPower, false);
  assert.equal(a.ignition, true);
  assert.equal(a.speed, 40);
  assert.ok(Math.abs(a.lng + 1.89) < 1e-5);
});

// ---- heartbeat timing, locate-now and device replies -------------------------

test("teltonika: timing command writes moving + stopped periods for all network modes", () => {
  const t = tel.timingText(20, 300);
  assert.ok(t.startsWith("setparam "));
  for (const id of [10050, 10055, 10150, 10155, 10250, 10255]) assert.ok(t.includes(`${id}:20`), String(id));
  for (const id of [10000, 10005, 10100, 10105, 10200, 10205]) assert.ok(t.includes(`${id}:300`), String(id));
});

test("teltonika: a Codec 12 reply comes back as text (not an error) and getgps parses", () => {
  const text = Buffer.from("GPS:1 Sat:9 Lat:52.4862 Long:-1.8904 Alt:120 Speed:0 Dir:0", "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(text.length, 0);
  const data = Buffer.concat([Buffer.from([0x0c, 0x01, 0x06]), len, text, Buffer.from([0x01])]);
  const pkt = Buffer.alloc(8 + data.length + 4);
  pkt.writeUInt32BE(0, 0); pkt.writeUInt32BE(data.length, 4); data.copy(pkt, 8); pkt.writeUInt32BE(crc16ibm(data), 8 + data.length);
  const r = tel.parseAvl(pkt);
  assert.equal(r.count, 0);
  assert.equal(r.consumed, pkt.length);
  assert.match(r.response, /Lat:52\.4862/);
  const pos = tel.parseGetGps(r.response);
  assert.equal(pos.lat, 52.4862); assert.equal(pos.lng, -1.8904); assert.equal(pos.satellites, 9);
});

test("gt06: timing command uses TIMER,<acc on>,<acc off># within device limits", () => {
  assert.equal(gt.timingText(20, 300), "TIMER,20,300#");
  assert.equal(gt.timingText(1, 99999), "TIMER,5,18000#");
});

test("gt06: WHERE# reply parses with hemisphere letters", () => {
  const p = gt.parseWhere("Lat:N52.473210,Lon:W1.903280,Course:12.00,Speed:0.0,DateTime:2026-10-15 09:00:00");
  assert.equal(p.lat, 52.47321); assert.equal(p.lng, -1.90328); assert.equal(p.heading, 12);
  assert.equal(gt.parseWhere("no fix"), null);
});

test("gt06: command-response text is extracted from a 0x15 content block", () => {
  const txt = Buffer.from("TIMER OK", "ascii");
  const content = Buffer.concat([Buffer.from([4 + txt.length]), Buffer.from([0, 0, 0, 1]), txt, Buffer.from([0x00, 0x02])]);
  assert.equal(gt.parseResponseText(content), "TIMER OK");
});
