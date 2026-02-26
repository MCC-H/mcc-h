/**
 * Element localization via Holo2-4B-GGUF vision model.
 * Supports image caching: prime with system prompt + image + target "center", then when real target
 * arrives send just the target (e.g. "Continue button") — model has cached prompt.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

/** Target size for screenshots sent to the model (max dimension 1280px, aspect ratio preserved). */
const TARGET_SIZE = 1280;

const LOCALIZATION_SYSTEM_PROMPT = `Localize an element on the GUI image according to the provided target and output the center point to click.
Output a valid JSON: {"action": "click_absolute", "x": <0-1000 normalized>, "y": <0-1000 normalized>}
x and y are the center of the target; normalized 0-1000 (500,500 = center of image).
Target:`;

const PRIME_TARGET = "center";

const LOCALIZATION_TIMEOUT_MS = 30_000;

export interface CachedHoloImage {
  base64: string;
  originalW: number;
  originalH: number;
  /** Assistant response from prime (image + "center") — used for multi-turn when real target arrives. */
  primeAssistantResponse?: string;
}

let lastCachedImage: CachedHoloImage | null = null;

export function getCachedHoloImage(): CachedHoloImage | null {
  return lastCachedImage;
}

export function setCachedHoloImage(cached: CachedHoloImage | null): void {
  lastCachedImage = cached;
}

type ChatMessage = { role: "user" | "assistant" | "system"; content: string | Array<{ type: string; image_url?: { url: string }; text?: string }> };

/** Resize image for localization (max dimension 1280px, JPEG). Preserves aspect ratio, returns dimensions for coordinate scaling. */
async function resizeForLocalization(
  imagePath: string
): Promise<{ base64: string; originalW: number; originalH: number; resizedW: number; resizedH: number }> {
  const buf = readFileSync(imagePath);
  const meta = await sharp(buf).metadata();
  const origW = meta.width ?? 1920;
  const origH = meta.height ?? 1200;
  const resized = await sharp(buf)
    .resize(TARGET_SIZE, TARGET_SIZE, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const resizedMeta = await sharp(resized).metadata();
  return {
    base64: resized.toString("base64"),
    originalW: origW,
    originalH: origH,
    resizedW: resizedMeta.width ?? TARGET_SIZE,
    resizedH: resizedMeta.height ?? TARGET_SIZE,
  };
}

function parseLocalizationResponse(content: string): { x: number; y: number } | null {
  try {
    const match = content.match(/\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}/);
    if (match) {
      const x = parseInt(match[1], 10);
      const y = parseInt(match[2], 10);
      return { x, y };
    }
    const parsed = JSON.parse(content) as { x?: number; y?: number; action?: string };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface LocalizeOptions {
  /** Base URL of OpenAI-compatible vision API (Holo1.5-3B localization server). */
  baseUrl: string;
  /** Model name (default: holo2-4b). */
  model?: string;
}

const ICON_CAPTION_PROMPT = "Describe this icon in 2-3 words.";
const ICON_CAPTION_BATCH_PROMPT = "Describe each of the icons above in 2-3 words. Output exactly one phrase per line, in the same order as the images. No numbering or bullets.";

/** Batch size for icon captioning. */
const ICON_CAPTION_BATCH_SIZE = 12;

/** Icon crop size (smaller = less tokens, fits more in context). */
const ICON_CROP_SIZE = 64;

/** Caption icon images via OpenAI-compatible vision API (e.g. llama-server with Qwen VL). Batches of 12. */
export async function captionImagesViaIconModel(
  baseUrl: string,
  base64Images: string[]
): Promise<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }> {
  const captions: { label: string; description: string }[] = [];
  const base = baseUrl.replace(/\/$/, "");
  const url = base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const model = "default";
  const timeoutMs = 30_000;

  for (let batchStart = 0; batchStart < base64Images.length; batchStart += ICON_CAPTION_BATCH_SIZE) {
    const batch = base64Images.slice(batchStart, batchStart + ICON_CAPTION_BATCH_SIZE);
    const content: Array<{ type: "image_url"; image_url: { url: string } } | { type: "text"; text: string }> = [];

    for (const b64 of batch) {
      if (!b64) {
        content.push({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
        continue;
      }
      try {
        const buf = Buffer.from(b64, "base64");
        const resized = await sharp(buf)
          .resize(ICON_CROP_SIZE, ICON_CROP_SIZE, { fit: "fill" })
          .jpeg({ quality: 85 })
          .toBuffer();
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${resized.toString("base64")}` } });
      } catch {
        content.push({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
      }
    }
    content.push({ type: "text", text: ICON_CAPTION_BATCH_PROMPT });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user" as const, content }],
          max_tokens: 256,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        console.warn("[Houston MCP] Icon caption API error:", res.status, errText.slice(0, 200));
        for (let i = 0; i < batch.length; i++) captions.push({ label: "icon", description: "icon" });
        continue;
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = (data.choices?.[0]?.message?.content?.trim() ?? "").trim();
      const lines = text.split(/\r?\n/).map((s) => s.replace(/^[\d.)\-\*]\s*/, "").trim()).filter(Boolean);
      for (let i = 0; i < batch.length; i++) {
        const caption = (lines[i] ?? "").trim() || "icon";
        captions.push({ label: caption, description: caption });
      }
    } catch (err) {
      console.warn("[Houston MCP] Icon caption batch failed:", err instanceof Error ? err.message : err);
      for (let i = 0; i < batch.length; i++) captions.push({ label: "icon", description: "icon" });
    }
  }
  return { ok: true, captions };
}

async function fetchHoloChat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  maxTokens = 64
): Promise<string | null> {
  const base = baseUrl.replace(/\/$/, "");
  const url = base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Houston MCP] Localization API error:", res.status, errText.slice(0, 200));
      return null;
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    clearTimeout(timeout);
    console.error("[Houston MCP] Holo fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchLocalization(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<string | null> {
  return fetchHoloChat(baseUrl, model, messages, timeoutMs, 64);
}

/**
 * Caption icon images via Holo. Returns { label, description }[] matching input order.
 */
export async function captionImagesHolo(
  base64Images: string[],
  options: LocalizeOptions
): Promise<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }> {
  const { baseUrl, model = "holo2-4b" } = options;
  const captions: { label: string; description: string }[] = [];
  for (let i = 0; i < base64Images.length; i++) {
    const b64 = base64Images[i];
    if (!b64) {
      captions.push({ label: "", description: "" });
      continue;
    }
    try {
      const buf = Buffer.from(b64, "base64");
      const meta = await sharp(buf).metadata();
      const w = meta.width ?? 256;
      const h = meta.height ?? 256;
      const resized = await sharp(buf)
        .resize(Math.min(w, TARGET_SIZE), Math.min(h, TARGET_SIZE), { fit: "inside" })
        .jpeg({ quality: 85 })
        .toBuffer();
      const dataUrl = `data:image/jpeg;base64,${resized.toString("base64")}`;
      const messages: ChatMessage[] = [
        {
          role: "user" as const,
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: ICON_CAPTION_PROMPT },
          ],
        },
      ];
      const text = await fetchHoloChat(baseUrl, model, messages, LOCALIZATION_TIMEOUT_MS, 128);
      const caption = (text ?? "").trim();
      captions.push({ label: caption, description: caption });
    } catch (err) {
      console.warn("[Houston MCP] Holo caption failed for image", i, err instanceof Error ? err.message : err);
      captions.push({ label: "", description: "" });
    }
  }
  return { ok: true, captions };
}

/**
 * Prime Holo cache: system prompt + image + target "center". Store image and assistant response.
 * Fire-and-forget; call when screenshot is captured (take_snapshot, takeSnapshotAfterAction).
 */
export function primeHoloCache(imagePath: string, options: LocalizeOptions): void {
  const { baseUrl, model = "holo2-4b" } = options;
  resizeForLocalization(imagePath)
    .then(async ({ base64, originalW, originalH }) => {
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      const messages: ChatMessage[] = [
        { role: "system" as const, content: LOCALIZATION_SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: PRIME_TARGET },
          ],
        },
      ];
      const primeResponse = await fetchLocalization(baseUrl, model, messages, LOCALIZATION_TIMEOUT_MS);
      setCachedHoloImage({
        base64,
        originalW,
        originalH,
        primeAssistantResponse: primeResponse ?? undefined,
      });
      console.log("[Houston MCP] Holo cache primed (system + image + center)");
    })
    .catch((err) => {
      console.warn("[Houston MCP] Holo prime failed:", err instanceof Error ? err.message : err);
    });
}

/**
 * Localize an element. Uses cached image if available (from prime).
 * When cache has primeAssistantResponse: send [system, user(img,center), assistant, user(target)]
 * so model continues from cached prompt — last message is just the target (e.g. "Continue button").
 */
export async function localizeElement(
  imagePath: string | null,
  elementDescription: string,
  options: LocalizeOptions
): Promise<{ x: number; y: number } | null> {
  const { baseUrl, model = "holo2-4b" } = options;

  let base64: string;
  let originalW: number;
  let originalH: number;
  let primeAssistantResponse: string | undefined;

  const cached = getCachedHoloImage();
  if (cached) {
    base64 = cached.base64;
    originalW = cached.originalW;
    originalH = cached.originalH;
    primeAssistantResponse = cached.primeAssistantResponse;
    console.log("[Houston MCP] Localize using cached image", originalW, "×", originalH, primeAssistantResponse ? "(with prime)" : "");
  } else if (imagePath) {
    const resized = await resizeForLocalization(imagePath);
    base64 = resized.base64;
    originalW = resized.originalW;
    originalH = resized.originalH;
  } else {
    return null;
  }

  const dataUrl = `data:image/jpeg;base64,${base64}`;
  let messages: ChatMessage[];

  if (primeAssistantResponse) {
    // Model has cached prompt: send continuation with just the new target.
    messages = [
      { role: "system" as const, content: LOCALIZATION_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: PRIME_TARGET },
        ],
      },
      { role: "assistant" as const, content: primeAssistantResponse },
      { role: "user" as const, content: elementDescription },
    ];
  } else {
    // No prime: full request with image + target.
    messages = [
      { role: "system" as const, content: LOCALIZATION_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: elementDescription },
        ],
      },
    ];
  }

  const content = await fetchLocalization(baseUrl, model, messages, LOCALIZATION_TIMEOUT_MS);
  if (!content) return null;

  console.log("[Houston MCP] Localize raw response:", content);

  const coords = parseLocalizationResponse(content);
  if (!coords) return null;

  // Holo model outputs 0-1000 normalized (same as Computer-Use-Agent). Convert to VM pixels.
  const origX = Math.round((coords.x / 1000) * originalW);
  const origY = Math.round((coords.y / 1000) * originalH);
  const result = {
    x: Math.max(0, Math.min(origX, originalW - 1)),
    y: Math.max(0, Math.min(origY, originalH - 1)),
  };
  console.log(
    "[Houston MCP] Localize parsed:",
    elementDescription,
    "->",
    result,
    `| norm ${coords.x},${coords.y} -> ${originalW}×${originalH} px`
  );
  return result;
}
