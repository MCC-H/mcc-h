import { readFileSync } from "node:fs";
import sharp from "sharp";
import { record } from "./timing.js";
import type { McpServerConfig } from "./config.js";
import { getAiBaseUrl } from "../houston-ports.js";
import { getIconCaptionUrl } from "../icon-model-manager.js";
import { captionImagesViaIconModel } from "./localization.js";
function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().finally(() => {
    const sec = (performance.now() - start) / 1000;
    record(`ocr.${label}`, sec);
    console.log(`[Houston MCP] OCR ${label}: ${sec.toFixed(2)}s`);
  });
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_VL_MODEL = "qwen/qwen3-vl-8b-instruct";
const VISION_PROMPT_INITIAL = "Annotate screenshot, detect interface type (GUI or TUI) and describe UI elements and inputs hierarchically down to very last element and their state. Answer in plaintext";
const VISION_PROMPT_CHANGES = "Annotate changes, detect interface type (GUI or TUI) and describe changed UI elements and inputs hierarchically down to very last element and their state. Answer in plaintext";

let previousScreenshotBase64: string | null = null;

/** Mutex to prevent race when parallel runOCR calls read/write previousScreenshotBase64. */
let ocrMutex = Promise.resolve<void>(undefined);
async function withOcrMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = ocrMutex;
  let resolve: () => void = () => { };
  ocrMutex = new Promise<void>((r) => {
    resolve = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

/** Resize image 1.5x down for vision (Qwen) to reduce token/payload size. */
async function resizeBase64ForVision(base64: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  const { width, height } = await sharp(buf).metadata();
  if (!width || !height) return base64;
  const resized = await sharp(buf)
    .resize(Math.round(width / 1.5), Math.round(height / 1.5))
    .png()
    .toBuffer();
  return resized.toString("base64");
}

const OCR_FETCH_TIMEOUT_MS = 120_000; // 2 min for heavy IconCaption workloads

async function runAppleOCR(config: McpServerConfig, base64: string): Promise<Record<string, unknown>> {
  let base = getAiBaseUrl().replace(/\/$/, "");
  if (base.includes("localhost")) {
    base = base.replace(/localhost/g, "127.0.0.1");
  }
  const url = base + "/ocr";
  const body: Record<string, string> = { image_base64: base64 };
  if (config.guestType) body.guest_type = config.guestType;

  const doFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OCR_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await doFetch();
      if (!res.ok) {
        const text = await res.text();
        console.error("[Houston MCP] OCR request failed", res.status, text.slice(0, 200));
        throw new Error(`OCR request failed (${res.status}): ${text}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message;
      const cause = lastErr.cause instanceof Error ? lastErr.cause.message : "";
      const isOtherSideClosed = msg.includes("other side closed") || cause.includes("other side closed");
      const isAborted = msg.includes("aborted");
      const isConnectionError = isOtherSideClosed || isAborted;
      if (attempt === 0 && isConnectionError) {
        console.warn("[Houston MCP] OCR fetch failed (attempt 1):", msg, cause ? "cause:" + cause : "");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.error("[Houston MCP] OCR fetch failed:", msg, cause ? "cause:" + cause : "");
      throw new Error(
        `OCR fetch failed: ${msg}. Houston AI service may have crashed or timed out. Restart the AI service and try again.`
      );
    }
  }
  throw lastErr ?? new Error("OCR fetch failed");
}

/** Run VL vision via OpenAI-compatible API (OpenRouter or custom). */
async function runVisionApi(
  config: McpServerConfig,
  base64: string,
  previousBase64: string | null
): Promise<string> {
  const useCustom = !!config.vlApiUrl?.trim();
  const base = (config.vlApiUrl ?? "").trim().replace(/\/$/, "");
  const apiUrl = useCustom
    ? (base.includes("chat/completions") ? base : `${base}/v1/chat/completions`)
    : OPENROUTER_URL;
  const apiKey = useCustom
    ? config.vlApiKey?.trim()
    : config.openrouterApiKey?.trim();
  const model = config.vlModel?.trim() || DEFAULT_VL_MODEL;

  if (!apiKey) {
    return "";
  }

  try {
    const isChanges = previousBase64 != null;
    const prompt = isChanges ? VISION_PROMPT_CHANGES : VISION_PROMPT_INITIAL;
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
      { type: "text", text: prompt },
    ];
    if (isChanges) {
      content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${previousBase64}` } });
    }
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } });

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 512,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("[Houston MCP] Vision API error:", res.status, errText.slice(0, 200));
      return "";
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const visionText = data.choices?.[0]?.message?.content?.trim() ?? "";
    return visionText;
  } catch (err) {
    console.error("[Houston MCP] Vision API failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

export interface RunOCROptions {
  /** When true, return full annotation (fresh view). When false/default, return changes vs previous screenshot. */
  freshView?: boolean;
}

/**
 * Run OCR on an image. Apple OCR and Qwen VL vision run in parallel.
 * Returns JSON: { image, checkboxes, ui_elements, texts, vision_description? }
 */
export async function runOCR(
  config: McpServerConfig,
  imagePath: string,
  options?: RunOCROptions
): Promise<string> {
  return withOcrMutex(async () => {
    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString("base64");
    const freshView = options?.freshView === true;
    const previousForVision = freshView ? null : previousScreenshotBase64;

    const meta = await sharp(Buffer.from(base64, "base64")).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    console.log(
      "[Houston MCP] OCR input: image",
      imgW,
      "×",
      imgH,
      "base64",
      Math.round(base64.length / 1024),
      "KB",
      "fresh_view:",
      freshView
    );

    const parallelTasks: Promise<unknown>[] = [
      timed("Apple (HoustonVM)", async () => {
        console.log("[Houston MCP] OCR Apple (HoustonVM): fetching layout, checkboxes, ui_elements, texts...");
        const json = await runAppleOCR(config, base64);
        const cbs = Array.isArray(json.checkboxes) ? json.checkboxes.length : 0;
        const rbs = Array.isArray(json.radio_buttons) ? json.radio_buttons.length : 0;
        const uis = Array.isArray(json.ui_elements) ? json.ui_elements.length : 0;
        const txts = Array.isArray(json.texts) ? json.texts.length : 0;
        console.log(
          "[Houston MCP] OCR Apple result: checkboxes",
          cbs,
          "radio_buttons",
          rbs,
          "ui_elements",
          uis,
          "texts",
          txts
        );
        return json;
      }),
      timed("Vision (VL)", async () => {
        const visionW = Math.round((imgW || 1920) / 1.5);
        const visionH = Math.round((imgH || 1200) / 1.5);
        const visionMode = freshView ? "initial" : previousForVision ? "changes" : "initial";
        const vlModel = config.vlModel?.trim() || DEFAULT_VL_MODEL;
        const vlSource = config.vlApiUrl?.trim() ? "custom" : "OpenRouter";
        console.log(
          "[Houston MCP] OCR Vision: model",
          vlModel,
          "source:",
          vlSource,
          "resize",
          visionW,
          "×",
          visionH,
          "mode:",
          visionMode
        );
        const visionBase64 = await timed("Vision.resize", () => resizeBase64ForVision(base64));
        const visionPrevious = previousForVision ? await timed("Vision.resize_prev", () => resizeBase64ForVision(previousForVision)) : null;
        const text = await timed("Vision.api", () => runVisionApi(config, visionBase64, visionPrevious));
        console.log(
          "[Houston MCP] OCR Vision result:",
          text ? `${text.length} chars` : "skipped (no API key or error)"
        );
        return text;
      }),
    ];

    const results = await Promise.all(parallelTasks);
    const ocrJson = results[0] as Record<string, unknown>;
    const visionText = results[1] as string;

    const cbs = Array.isArray(ocrJson.checkboxes) ? ocrJson.checkboxes.length : 0;
    const rbs = Array.isArray(ocrJson.radio_buttons) ? ocrJson.radio_buttons.length : 0;
    const uis = Array.isArray(ocrJson.ui_elements) ? ocrJson.ui_elements.length : 0;
    const txts = Array.isArray(ocrJson.texts) ? ocrJson.texts.length : 0;
    const total = cbs + rbs + uis + txts;
    console.log(
      "[Houston MCP] OCR done: total",
      total,
      "(checkboxes:",
      cbs,
      "radio:",
      rbs,
      "ui_elements:",
      uis,
      "texts:",
      txts,
      ") vision:",
      visionText ? "ok" : "skipped"
    );

    previousScreenshotBase64 = base64;

    const result = { ...ocrJson } as Record<string, unknown>;

    // Icon captioning: replace generic "icon" captions with descriptive labels from the icon model
    const iconCaptionUrl = getIconCaptionUrl();
    const uiElements = Array.isArray(result.ui_elements) ? (result.ui_elements as Record<string, unknown>[]) : [];
    if (iconCaptionUrl && uiElements.length > 0) {
      const imgBuf = Buffer.from(base64, "base64");
      const imgMeta = await sharp(imgBuf).metadata();
      const imgW = imgMeta.width ?? 1920;
      const imgH = imgMeta.height ?? 1200;
      const crops: string[] = [];
      for (const el of uiElements) {
        const bbox = el.bbox2d as number[] | undefined;
        if (!bbox || bbox.length < 4) {
          crops.push("");
          continue;
        }
        const [x1, y1, x2, y2] = bbox;
        const w = Math.max(1, x2 - x1);
        const h = Math.max(1, y2 - y1);
        const left = Math.max(0, Math.min(x1, imgW - 1));
        const top = Math.max(0, Math.min(y1, imgH - 1));
        const cropBuf = await sharp(imgBuf)
          .extract({ left, top, width: Math.min(w, imgW - left), height: Math.min(h, imgH - top) })
          .resize(64, 64, { fit: "fill" })
          .png()
          .toBuffer();
        crops.push(cropBuf.toString("base64"));
      }
      if (crops.some((c) => c.length > 0)) {
        try {
          const captionResult = await timed("IconCaption", () => captionImagesViaIconModel(iconCaptionUrl, crops));
          if (captionResult.ok && captionResult.captions) {
            for (let i = 0; i < uiElements.length && i < captionResult.captions.length; i++) {
              const desc = captionResult.captions[i]?.description?.trim();
              if (desc && desc !== "icon") {
                (uiElements[i] as Record<string, unknown>).caption = desc;
              }
            }
            console.log("[Houston MCP] OCR IconCaption: updated", captionResult.captions.length, "ui_elements");
          }
        } catch (err) {
          console.warn("[Houston MCP] OCR IconCaption failed:", err instanceof Error ? err.message : err);
        }
      }
    }

    if (visionText) {
      result.vision_description = visionText;
    }

    return JSON.stringify(result);
  });
}

export type OcrCenter = {
  x: number;
  y: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  kind: "icon" | "text";
};

/** Parse OCR JSON to overlay format. Returns null if parse fails. */
export function parseOcrToOverlay(
  text: string
): { centers: OcrCenter[]; imgW: number; imgH: number } | null {
  let data: {
    image?: number[];
    checkboxes?: unknown[];
    ui_elements?: unknown[];
    texts?: unknown[];
    radio_buttons?: unknown[];
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return null;
  }
  const img = Array.isArray(data.image) && data.image.length >= 2 ? data.image : [1920, 1200];
  const imgW = Number(img[0]) || 1920;
  const imgH = Number(img[1]) || 1200;
  const centers: OcrCenter[] = [];

  function parseCenter(c: Record<string, unknown>): { x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number } {
    const center = c.center as number[] | undefined;
    const bbox = c.bbox2d as number[] | undefined;
    const x = (center?.[0] ?? (c.x != null ? Number(c.x) : 0)) as number;
    const y = (center?.[1] ?? (c.y != null ? Number(c.y) : 0)) as number;
    const x1 = bbox?.[0] != null ? Number(bbox[0]) : (c.x1 != null ? Number(c.x1) : undefined);
    const y1 = bbox?.[1] != null ? Number(bbox[1]) : (c.y1 != null ? Number(c.y1) : undefined);
    const x2 = bbox?.[2] != null ? Number(bbox[2]) : (c.x2 != null ? Number(c.x2) : undefined);
    const y2 = bbox?.[3] != null ? Number(bbox[3]) : (c.y2 != null ? Number(c.y2) : undefined);
    return { x, y, x1, y1, x2, y2 };
  }

  for (const cb of data.checkboxes ?? []) {
    const c = cb as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(c);
    centers.push({ x, y, x1, y1, x2, y2, kind: "icon" });
  }
  for (const rb of data.radio_buttons ?? []) {
    const r = rb as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(r);
    centers.push({ x, y, x1, y1, x2, y2, kind: "icon" });
  }
  for (const el of data.ui_elements ?? []) {
    const e = el as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(e);
    centers.push({ x, y, x1, y1, x2, y2, kind: "icon" });
  }
  for (const t of data.texts ?? []) {
    const item = t as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(item);
    centers.push({ x, y, x1, y1, x2, y2, kind: "text" });
  }

  return { centers, imgW, imgH };
}
