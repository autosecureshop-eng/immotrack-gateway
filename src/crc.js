// CRCs for the two device protocols.
//
//  - Teltonika (FMB/FMC): CRC-16/IBM (ARC) — poly 0xA001 reflected, init 0x0000,
//    computed over Codec ID .. Number of Data 2.
//  - GT06/Concox: CRC-ITU (CRC-16/X25) — poly 0x8408 reflected, init 0xFFFF,
//    final xor 0xFFFF, computed over Length .. Serial number.

function crc16ibm(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

function crcItu(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (~crc) & 0xffff;
}

module.exports = { crc16ibm, crcItu };
