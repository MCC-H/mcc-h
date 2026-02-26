import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseOcrToOverlay } from "./mcp-server/ocr.js";

const COLORS = { icon: "#f44", text: "#48f" } as const;
const DOT_R = 5;
const CLICK_X_SIZE = 12;

/**
 * Pre-render screenshot with OCR boxes and center dots (click areas).
 * Matches the Screenshot + OCR overlay UI: boxes for bboxes, dots at centers.
 * Icon: red (#f44), Text: blue (#48f).
 * Optional clickAt draws an X at the click position (e.g. after mouse_click).
 */
export async function renderScreenshotWithOcrBoxes(
  screenshotPath: string,
  ocrText: string,
  options?: { clickAt?: { x: number; y: number } }
): Promise<{ path: string; base64: string }> {
  const overlay = parseOcrToOverlay(ocrText);
  if (!overlay) {
    const buf = readFileSync(screenshotPath);
    const base64 = buf.toString("base64");
    return { path: screenshotPath, base64 };
  }

  const { centers, imgW, imgH } = overlay;
  const meta = await sharp(screenshotPath).metadata();
  const screenW = meta.width ?? imgW;
  const screenH = meta.height ?? imgH;
  const scaleX = screenW / imgW;
  const scaleY = screenH / imgH;

  const scale = (v: number, s: number) => Math.round(v * s);

  const rects: string[] = [];
  const dots: string[] = [];

  for (const c of centers) {
    const stroke = COLORS[c.kind];
    const x = c.x;
    const y = c.y;

    if (c.x1 != null && c.y1 != null && c.x2 != null && c.y2 != null) {
      const x1 = Math.max(0, Math.min(scale(c.x1, scaleX), screenW));
      const y1 = Math.max(0, Math.min(scale(c.y1, scaleY), screenH));
      const w = Math.max(1, Math.min(scale(c.x2 - c.x1, scaleX), screenW - x1));
      const h = Math.max(1, Math.min(scale(c.y2 - c.y1, scaleY), screenH - y1));
      rects.push(`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="2"/>`);
    }

    const cx = Math.max(0, Math.min(scale(x, scaleX), screenW));
    const cy = Math.max(0, Math.min(scale(y, scaleY), screenH));
    dots.push(`<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${stroke}"/>`);
  }

  let clickX = "";
  if (options?.clickAt) {
    const cx = scale(options.clickAt.x, scaleX);
    const cy = scale(options.clickAt.y, scaleY);
    const s = CLICK_X_SIZE;
    clickX = `<line x1="${cx - s}" y1="${cy - s}" x2="${cx + s}" y2="${cy + s}" stroke="#b0ff00" stroke-width="3"/>
  <line x1="${cx - s}" y1="${cy + s}" x2="${cx + s}" y2="${cy - s}" stroke="#b0ff00" stroke-width="3"/>`;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${screenW}" height="${screenH}" viewBox="0 0 ${screenW} ${screenH}">
  ${rects.join("\n  ")}
  ${dots.join("\n  ")}
  ${clickX}
</svg>`;

  const outPath = join(tmpdir(), `houston-recipe-${randomUUID()}.png`);
  const overlayBuffer = Buffer.from(svg);

  await sharp(screenshotPath)
    .composite([{ input: overlayBuffer, blend: "over" }])
    .png()
    .toFile(outPath);

  const buf = readFileSync(outPath);
  const base64 = buf.toString("base64");
  return { path: outPath, base64 };
}

/**
 * Render terminal output as an image (terminal-style: black bg, green text).
 */
export async function renderTerminalToImage(output: string): Promise<{ path: string; base64: string }> {
  const raw = (output || "").trim() || "(no output)";
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const lineHeight = 18;
  const padding = 12;
  const width = 640;
  const height = Math.max(400, Math.min(lines.length * lineHeight + padding * 2, 1200));

  const textLines = lines
    .map((line) => {
      const sanitized = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // strip null bytes and control chars
      const safe = sanitized
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return safe;
    })
    .map((line, i) => `<text x="${padding}" y="${padding + (i + 2) * lineHeight}" font-family="monospace" font-size="14" fill="#39ff14">${line}</text>`)
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0d1117"/>
  <text x="${padding}" y="${padding + lineHeight}" font-family="monospace" font-size="12" fill="#8b949e">$ terminal output</text>
  ${textLines}
</svg>`;

  const outPath = join(tmpdir(), `houston-recipe-term-${randomUUID()}.png`);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(outPath);

  const buf = readFileSync(outPath);
  const base64 = buf.toString("base64");
  return { path: outPath, base64 };
}
