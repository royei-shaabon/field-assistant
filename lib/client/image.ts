// Shrinks phone media before upload: max 1280px on the long side, JPEG. Keeps requests small
// and the identify call fast (spec: answer within 8 seconds).
import type { ClientImage } from "../conversation";

const MAX_SIDE = 1280;

function toJpeg(source: CanvasImageSource, width: number, height: number, maxSide = MAX_SIDE, quality = 0.8): string {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export function dataUrlToImage(dataUrl: string): ClientImage {
  return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

export async function photoToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  return toJpeg(bitmap, bitmap.width, bitmap.height);
}

// A smaller copy kept in this browser so the marked photo can be shown again later.
export async function thumbnail(dataUrl: string, maxSide = 640): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return toJpeg(img, img.naturalWidth, img.naturalHeight, maxSide, 0.7);
}

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error("video could not be read")), { once: true });
  });
}

// The API takes images, not video: sample `count` frames spread over the clip, in time order.
export async function videoToDataUrls(file: File, count = 4): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await once(video, "loadeddata");
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const frames: string[] = [];
    // Without a known duration (some streamed formats) keep the first frame only.
    if (!duration) return [toJpeg(video, video.videoWidth, video.videoHeight)];
    for (let i = 0; i < count; i++) {
      video.currentTime = ((i + 0.5) / count) * duration;
      await once(video, "seeked");
      frames.push(toJpeg(video, video.videoWidth, video.videoHeight));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}
