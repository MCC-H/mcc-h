import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

export interface OCRLayout {
  image: [number, number];
  layout: Array<Record<string, [number, number]>>;
}

export async function runOCR(config: Config, imagePath: string): Promise<OCRLayout> {
  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString("base64");

  const url = config.ocrEndpoint.replace(/\/$/, "") + "/ocr";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: base64 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OCR request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as OCRLayout;
  return data;
}
