// Reads GPS position and capture time from a JPEG's EXIF block. Pure parsing, no network.
// Returns { lat, lng, takenAt } with nulls for anything missing. HEIC/PNG return all nulls.

export function parseExif(buffer) {
  const out = { lat: null, lng: null, takenAt: null };
  const v = new DataView(buffer);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return out;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    if (v.getUint8(off) !== 0xFF) break;
    const marker = v.getUint8(off + 1);
    const len = v.getUint16(off + 2);
    if (marker === 0xE1 && off + 10 <= v.byteLength &&
        v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) { // "Exif\0\0"
      readTiff(v, off + 10, out);
      return out;
    }
    if (marker === 0xDA) break; // start of scan, no more metadata
    off += 2 + len;
  }
  return out;
}

function readTiff(v, tiff, out) {
  const order = v.getUint16(tiff);
  const le = order === 0x4949;
  if (!le && order !== 0x4D4D) return;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const ifd0 = tiff + u32(tiff + 4);

  const entries = (ifd) => {
    const res = {};
    if (ifd + 2 > v.byteLength) return res;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      res[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 };
    }
    return res;
  };
  const rationals = (ent) => {
    const p = tiff + u32(ent.valueOff);
    const vals = [];
    for (let i = 0; i < ent.count; i++) {
      const num = u32(p + i * 8);
      const den = u32(p + i * 8 + 4);
      vals.push(den ? num / den : 0);
    }
    return vals;
  };
  const ascii = (ent) => {
    const p = ent.count <= 4 ? ent.valueOff : tiff + u32(ent.valueOff);
    let s = '';
    for (let i = 0; i < ent.count; i++) {
      const c = v.getUint8(p + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const e0 = entries(ifd0);
  if (e0[0x8769]) {
    const ex = entries(tiff + u32(e0[0x8769].valueOff));
    const dto = ex[0x9003] || ex[0x9004];
    if (dto) {
      const m = ascii(dto).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (m) out.takenAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
  }
  if (e0[0x8825]) {
    const g = entries(tiff + u32(e0[0x8825].valueOff));
    if (g[2] && g[4]) {
      const toDeg = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
      let lat = toDeg(rationals(g[2]));
      let lng = toDeg(rationals(g[4]));
      if (g[1] && ascii(g[1]) === 'S') lat = -lat;
      if (g[3] && ascii(g[3]) === 'W') lng = -lng;
      if (isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0)) {
        out.lat = Math.round(lat * 1e6) / 1e6;
        out.lng = Math.round(lng * 1e6) / 1e6;
      }
    }
  }
}

export function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
