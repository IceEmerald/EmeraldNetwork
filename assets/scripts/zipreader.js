/* ── Minimal in-browser ZIP reader (no third-party zip library loaded) ──
 * Parses classic ZIP local headers + central directory. Only stored (0) and
 * DEFLATE (8) entries are supported — that covers .pptx/.docx/.xlsx-style
 * archives, whose content is plain XML/media packed as DEFLATE entries.
 * DEFLATE uses the native DecompressionStream; on browsers without it (or for
 * exotic entries like Zip64/encrypted) the entry throws and the caller's
 * existing error path handles the failure. API mirrors the JSZip subset used
 * by the app: zip.files and zip.file(name).async("text"|"base64").
 */
function openZipBuffer(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const sig = (i, a, b, c, d) => u8[i] === a && u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d;
  // End-of-Central-Directory: last 22 bytes of the archive + up to 64 KiB comment.
  let eocd = -1;
  const min = Math.max(0, u8.length - (22 + 65535));
  for (let i = u8.length - 22; i >= min; i--) {
    if (sig(i, 0x50, 0x4b, 0x05, 0x06)) { eocd = i; break; }
  }
  const files = {};
  if (eocd >= 0) {
    const total = u16(eocd + 10);
    let p = u32(eocd + 16);
    const decodeName = (b) => new TextDecoder("utf-8").decode(b).replace(/\\/g, "/");
    for (let n = 0; n < total && p + 46 <= u8.length; n++) {
      if (!sig(p, 0x50, 0x4b, 0x01, 0x02)) break;      // central directory signature
      const method = u16(p + 10);
      const compSize = u32(p + 20);
      const nameLen = u16(p + 28);
      const extraLen = u16(p + 30);
      const commentLen = u16(p + 32);
      const localOff = u32(p + 42);
      const name = decodeName(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!name || name.endsWith("/")) continue;        // skip directory entries
      files[name] = _zipEntry(u8, dv, localOff, method, compSize);
    }
  }
  return { files, file(name) { return files[name] || null; } };
}
function _zipEntry(u8, dv, localOff, method, compSize) {
  async function raw() {
    const nameLen = dv.getUint16(localOff + 26, true);
    const extraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + nameLen + extraLen;
    return u8.subarray(dataOff, dataOff + compSize);
  }
  async function inflate(bytes) {
    if (method === 0) return bytes;
    if (method !== 8 || typeof DecompressionStream === "undefined") {
      throw new Error("zip method " + method + " not supported");
    }
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  return {
    async async(type) {
      const b = await inflate(await raw());
      if (type === "base64") {
        let s = "";
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(s);
      }
      return new TextDecoder("utf-8").decode(b);
    }
  };
}