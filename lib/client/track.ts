// Keeps a mark on its part while the camera moves a little. No model is involved: a small
// grey patch of the picture around the part is remembered, and a few times a second the same
// patch is looked for near where it last was. When it cannot be found any more (the camera
// turned away, something covers the part), the mark is reported lost and taken off, because a
// mark in the wrong place is worse than no mark.

export type Gray = { data: Uint8Array; w: number; h: number };
// A patch with its average brightness taken out, so a change of light does not lose it.
export type Template = { data: Float32Array; size: number };

export const PATCH = 21;
// Average difference per pixel (0 to 255) above which the patch is not the same place.
export const LOST = 20;
// A patch flatter than this (a blank wall, a dark tank) has nothing to hold on to.
const MIN_TEXTURE = 5;

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) data[i] = (rgba[p] * 3 + rgba[p + 1] * 6 + rgba[p + 2]) / 10;
  return { data, w, h };
}

// The patch centred on (cx, cy), or null when it does not fit in the picture or is featureless.
export function templateAt(g: Gray, cx: number, cy: number, size = PATCH): Template | null {
  const half = (size - 1) / 2;
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  if (x0 < 0 || y0 < 0 || x0 + size > g.w || y0 + size > g.h) return null;
  const data = new Float32Array(size * size);
  let sum = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) sum += data[y * size + x] = g.data[(y0 + y) * g.w + x0 + x];
  const mean = sum / data.length;
  let spread = 0;
  for (let i = 0; i < data.length; i++) spread += Math.abs((data[i] -= mean));
  return spread / data.length < MIN_TEXTURE ? null : { data, size };
}

function difference(g: Gray, t: Template, x0: number, y0: number, giveUp: number): number {
  const { size } = t;
  let sum = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) sum += g.data[(y0 + y) * g.w + x0 + x];
  const mean = sum / (size * size);
  const limit = giveUp * size * size;
  let diff = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) diff += Math.abs(g.data[(y0 + y) * g.w + x0 + x] - mean - t.data[y * size + x]);
    // Already worse than the best so far.
    if (diff > limit) return Infinity;
  }
  return diff / (size * size);
}

// Where the patch is now, looking up to `radius` pixels around (cx, cy). `score` is the
// average difference per pixel; above LOST the place was not found.
export function locate(g: Gray, t: Template, cx: number, cy: number, radius: number, step = 1): { x: number; y: number; score: number } {
  const half = (t.size - 1) / 2;
  let best = { x: cx, y: cy, score: Infinity };
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const x0 = Math.round(cx) + dx - half;
      const y0 = Math.round(cy) + dy - half;
      if (x0 < 0 || y0 < 0 || x0 + t.size > g.w || y0 + t.size > g.h) continue;
      const score = difference(g, t, x0, y0, best.score);
      if (score < best.score) best = { x: Math.round(cx) + dx, y: Math.round(cy) + dy, score };
    }
  }
  return best;
}
