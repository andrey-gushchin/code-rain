import type { DisplayDrawParams } from "@busy-app/busy-lib";
import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";

const WIDTH = 72;
const HEIGHT = 16;
const GLYPH_WIDTH = 4;
const GLYPH_HEIGHT = 6;
const COLUMN_PITCH = 5;
const ROW_PITCH = 7;
const COLUMNS = 14;
const FRAME_MS = 80;

// Normal katakana orientation. The renderer reads the row from right to left.
const GLYPHS = [
  [15, 1, 2, 4, 4, 8],   // ア
  [1, 2, 4, 12, 4, 4],   // イ
  [4, 15, 5, 5, 9, 2],   // カ
  [8, 15, 4, 15, 2, 2],  // キ
  [15, 1, 1, 1, 15, 0],  // コ
  [10, 15, 10, 2, 4, 8], // サ
  [14, 2, 4, 6, 9, 0],   // ス
  [8, 15, 9, 10, 8, 7],  // セ
  [14, 0, 15, 4, 4, 8],  // テ
  [8, 8, 12, 10, 8, 8],  // ト
  [4, 15, 4, 4, 8, 0],   // ナ
  [6, 6, 6, 9, 9, 9],    // ハ
  [15, 1, 1, 2, 4, 8],   // フ
  [4, 15, 4, 4, 10, 0],  // ホ
  [14, 8, 15, 8, 8, 7],  // モ
  [8, 15, 9, 6, 4, 4],   // ヤ
  [15, 1, 15, 1, 15, 0], // ヨ
  [9, 9, 9, 1, 2, 4],    // リ
  [15, 9, 9, 9, 15, 0],  // ロ
];

const TRAIL = ["a", "b", "c", "d"];
const XPM_HEADER = [
  "! XPM2", `${WIDTH} ${HEIGHT} 5 1`,
  ". c #000000", "a c #B3FFC2", "b c #2DEB62", "c c #13973D", "d c #095A24",
].join("\n") + "\n";

// Store lit points once so the hot path only clips and writes visible pixels.
const MIRRORED_GLYPHS = GLYPHS.map(function (rows) {
  return rows.map(function (bits) {
    const points = [];
    for (let x = 0; x < GLYPH_WIDTH; x += 1) {
      if ((bits & (1 << x)) !== 0) points.push(x);
    }
    return points;
  });
});

function randomInt(limit: number): number {
  return Math.floor(Math.random() * limit);
}

function randomGlyph(): number {
  return randomInt(MIRRORED_GLYPHS.length);
}

type Stream = {
  x: number;
  y: number;
  speed: number;
  glyphs: number[];
  headChange: number;
};

function makeStream(column: number): Stream {
  const length = 2 + randomInt(3);
  const glyphs = [];
  for (let glyph = 0; glyph < length; glyph += 1) {
    glyphs.push(randomGlyph());
  }
  return {
    x: 1 + column * COLUMN_PITCH,
    y: -GLYPH_HEIGHT - randomInt(15),
    speed: 13 + randomInt(13),
    glyphs: glyphs,
    headChange: 250 + randomInt(500),
  };
}

const streams: Stream[] = [];
for (let column = 0; column < COLUMNS; column += 1) {
  const stream = makeStream(column);
  const phaseRange = HEIGHT + (stream.glyphs.length - 1) * ROW_PITCH;
  stream.y += randomInt(phaseRange + GLYPH_HEIGHT);
  streams.push(stream);
}

const pixels = new Array<string>(WIDTH * HEIGHT);
const rows = new Array<string>(HEIGHT);

function drawStream(stream: Stream): void {
  const headY = Math.floor(stream.y);
  for (let tail = 0; tail < stream.glyphs.length; tail += 1) {
    const top = headY - tail * ROW_PITCH;
    const glyph = MIRRORED_GLYPHS[stream.glyphs[tail]];
    const firstRow = Math.max(0, -top);
    const endRow = Math.min(GLYPH_HEIGHT, HEIGHT - top);
    for (let row = firstRow; row < endRow; row += 1) {
      const offset = (top + row) * WIDTH + stream.x;
      const points = glyph[row];
      for (let point = 0; point < points.length; point += 1) {
        pixels[offset + points[point]] = TRAIL[tail];
      }
    }
  }
}

function renderFrame(elapsed: number): string {
  pixels.fill(".");
  for (let column = 0; column < COLUMNS; column += 1) {
    let stream = streams[column];
    stream.y += stream.speed * elapsed / 1000;
    if (stream.y - (stream.glyphs.length - 1) * ROW_PITCH >= HEIGHT) {
      stream = makeStream(column);
      streams[column] = stream;
    }
    stream.headChange -= elapsed;
    if (stream.headChange <= 0) {
      stream.glyphs[0] = randomGlyph();
      stream.headChange = 250 + randomInt(500);
    }
    drawStream(stream);
  }

  for (let row = 0; row < HEIGHT; row += 1) {
    const start = row * WIDTH;
    rows[row] = pixels.slice(start, start + WIDTH).join("");
  }
  return XPM_HEADER + rows.join("\n");
}

function main(): void {
  const bitmap = {
    id: "rain",
    type: "xpmbitmap",
    display: "front",
    x: 0,
    y: 0,
    data: "",
  } satisfies DisplayDrawParams["elements"][number];
  const drawing: DisplayDrawParams = {
    application_name: manifest.id,
    priority: 50,
    elements: [bitmap],
  };

  let previousFrame = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failed = false;

  const report = (error: unknown): void => {
    console.error(`${manifest.id}: display draw failed: ${String(error)}`);
  };

  async function draw(): Promise<void> {
    const now = Date.now();
    const elapsed = Math.min(250, Math.max(0, now - previousFrame));
    previousFrame = now;
    const frame = renderFrame(elapsed);

    try {
      if (failed || frame !== bitmap.data) {
        bitmap.data = frame;
        await device.DisplayDraw(drawing);
      }
      failed = false;
    } catch (error) {
      if (!failed) report(error);
      failed = true;
    }

    // Schedule the next frame after this request settles so draws never overlap.
    if (!stopped) {
      const delay = failed ? 750 : Math.max(0, FRAME_MS - (Date.now() - now));
      timer = setTimeout(queueFrame, delay);
    }
  }

  function queueFrame(): void {
    void draw().catch(report);
  }

  const unbind = listen("input", (event) => {
    if (stopped || event.key !== "back" || event.action !== "short") return;

    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    // Let the input callback return before the firmware releases the app.
    setTimeout(unbind, 0);
  });

  queueFrame();
}

main();
