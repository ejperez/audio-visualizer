import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import FFT from "fft.js";

const [imagePath, audioPath, outputPath = "output.mp4", color = "#E8E8E8"] =
  process.argv.slice(2);

if (!imagePath || !audioPath) {
  console.error(
    "Usage: node src/cli.js <image> <audio> [output.mp4] [#RRGGBB]",
  );
  process.exit(1);
}

// Output video settings
const VIDEO_W = 1280;
const VIDEO_H = 720;
const FPS = 30;

// Visualizer settings
const W = 420;
const H = 90;
const BAR_COUNT = 100;
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BASELINE = 65;
const MAX_BAR_HEIGHT = 65;
const BOTTOM = 20;

// Audio analysis settings
const SAMPLE_RATE = 22050;
const FFT_SIZE = 2048;

function parseColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error("Color must be a hex value like #E8E8E8");

  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const [red, green, blue] = parseColor(color);
const fft = new FFT(FFT_SIZE);
const spectrum = fft.createComplexArray();
const input = new Array(FFT_SIZE).fill(0);
const binCount = FFT_SIZE / 2;

const MIN_FREQ = 30;
const MAX_FREQ = 10000;
const SENSITIVITY = 200;

const ATTACK = 0.9;
const RELEASE = 0.6;

let smoothedHeights = new Array(BAR_COUNT).fill(0);

// Spread the bars logarithmically across the frequency spectrum.
const ranges = Array.from({ length: BAR_COUNT }, (_, i) => {
  const f0 = MIN_FREQ * (MAX_FREQ / MIN_FREQ) ** (i / BAR_COUNT);
  const f1 = MIN_FREQ * (MAX_FREQ / MIN_FREQ) ** ((i + 1) / BAR_COUNT);

  return [
    Math.max(1, Math.floor((f0 * FFT_SIZE) / SAMPLE_RATE)),
    Math.min(
      binCount - 1,
      Math.max(2, Math.ceil((f1 * FFT_SIZE) / SAMPLE_RATE)),
    ),
  ];
});

function setPixel(frame, x, y) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;

  const p = (y * W + x) * 4;
  frame[p] = red;
  frame[p + 1] = green;
  frame[p + 2] = blue;
  frame[p + 3] = 255;
}

function drawRect(frame, x, y, width, height) {
  for (let py = Math.max(0, y); py < Math.min(H, y + height); py++) {
    for (let px = Math.max(0, x); px < Math.min(W, x + width); px++) {
      setPixel(frame, px, py);
    }
  }
}

function getBarHeights(samples, centerSample) {
  // Center the FFT window around this video frame's audio position.
  const start = Math.floor(centerSample - FFT_SIZE / 2);

  // Apply a Hann window to reduce spectral leakage.
  for (let i = 0; i < FFT_SIZE; i++) {
    const sampleIndex = start + i;
    const sample =
      sampleIndex >= 0 && sampleIndex < samples.length
        ? samples[sampleIndex]
        : 0;

    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

    input[i] = sample * hann;
  }

  fft.realTransform(spectrum, input);

  return ranges.map(([first, last]) => {
    let peak = 0;

    for (let bin = first; bin <= last; bin++) {
      const re = spectrum[2 * bin];
      const im = spectrum[2 * bin + 1];
      const magnitude = Math.hypot(re, im) / FFT_SIZE;

      peak = Math.max(peak, magnitude);
    }

    // Logarithmic compression keeps quiet details visible.
    const level = Math.min(1, Math.log1p(peak * SENSITIVITY) / Math.log1p(60));

    return Math.max(1, Math.round(level * MAX_BAR_HEIGHT));
  });
}

async function writeFrame(stream, frame) {
  if (!stream.write(frame)) {
    await once(stream, "drain");
  }
}

async function main() {
  console.log("Decoding audio...");

  // FFmpeg decodes MP3/WAV into mono 32-bit floating-point PCM.
  const pcmBuffer = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      audioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 1024 * 1024 * 512 },
  );

  // Copy into an aligned Float32Array.
  const samples = new Float32Array(
    pcmBuffer.buffer.slice(
      pcmBuffer.byteOffset,
      pcmBuffer.byteOffset + pcmBuffer.byteLength,
    ),
  );

  const duration = samples.length / SAMPLE_RATE;
  const frameCount = Math.ceil(duration * FPS);

  console.log(`Audio duration: ${duration.toFixed(2)} seconds`);
  console.log(`Rendering ${frameCount} visualizer frames...`);

  // Encode raw RGBA frames into a video that preserves alpha.
  const encoder = spawn(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${W}x${H}`,
      "-framerate",
      String(FPS),
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "qtrle",
      "-pix_fmt",
      "argb",
      "visualizer.mov",
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );

  encoder.on("error", (err) => {
    console.error("Could not start FFmpeg:", err.message);
  });

  const step = BAR_WIDTH + BAR_GAP;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frame = Buffer.alloc(W * H * 4);

    const centerSample = (frameIndex * SAMPLE_RATE) / FPS;
    const rawHeights = getBarHeights(samples, centerSample);

    const heights = rawHeights.map((target, i) => {
      const previous = smoothedHeights[i];

      const factor = target > previous ? ATTACK : RELEASE;

      const next = previous + (target - previous) * factor;

      smoothedHeights[i] = next;

      return Math.round(next);
    });

    // Closely packed vertical bars.
    for (let i = 0; i < BAR_COUNT; i++) {
      const x = Math.round((W - (BAR_COUNT * step - BAR_GAP)) / 2 + i * step);

      drawRect(frame, x, BASELINE - heights[i], BAR_WIDTH, heights[i]);
    }

    await writeFrame(encoder.stdin, frame);

    if (frameIndex % (FPS * 10) === 0) {
      console.log(`Rendered ${frameIndex}/${frameCount} frames`);
    }
  }

  encoder.stdin.end();

  const [encoderCode] = await once(encoder, "close");

  if (encoderCode !== 0) {
    throw new Error(`Visualizer encoder exited with code ${encoderCode}`);
  }

  console.log("Compositing final video...");

  // Composite the transparent visualizer over the full-screen image.
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-framerate",
      String(FPS),
      "-i",
      imagePath,
      "-i",
      audioPath,
      "-i",
      "visualizer.mov",
      "-filter_complex",
      `[0:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_W}:${VIDEO_H},setsar=1[bg];` +
        `[bg][2:v]overlay=(W-w)/2:H-h-${BOTTOM}:shortest=1,` +
        `format=yuv420p[v]`,
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outputPath,
    ],
    { stdio: "inherit" },
  );

  console.log(`Done: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
