// Width and height of a PNG, JPEG or WebP, read from its header. The model reports positions in
// the pixels of the picture it was given, so the code needs the real size to place a box.
export type Size = { width: number; height: number };

export function imageSize(base64: string, mediaType: string): Size | null {
  // The header is at the start; a JPEG may carry large metadata before its size marker.
  const b = Buffer.from(base64.slice(0, 400_000), "base64");
  try {
    if (mediaType === "image/png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mediaType === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        // Start-of-frame markers hold the size (not DHT 0xC4, JPG 0xC8, DAC 0xCC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (mediaType === "image/webp" && b.length >= 30) {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
  } catch {
    // A damaged header: treated as unknown size.
  }
  return null;
}
