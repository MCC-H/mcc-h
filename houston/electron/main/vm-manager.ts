import { request as httpRequest } from "node:http";
import { getVmPort, getAiPort } from "./houston-ports.js";
import { getIconCaptionUrl } from "./icon-model-manager.js";
import { captionImagesViaIconModel } from "./mcp-server/localization.js";

const HOUSTON_VM_HOST = "127.0.0.1";
const HOUSTON_AI_HOST = "127.0.0.1";

export interface VmInfo {
  id: string;
  name: string;
  path: string;
  status: "running" | "stopped";
  ramMb: number;
  diskGb: number;
  guestType?: string;
}

function request<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const port = getVmPort();
  if (port == null) {
    return Promise.reject(new Error("HoustonVM port not found. Start HoustonVM first."));
  }
  return new Promise((resolve, reject) => {
    const body = init?.body;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    const req = httpRequest(
      {
        host: HOUSTON_VM_HOST,
        port,
        path,
        method: init?.method ?? "GET",
        headers,
        family: 4,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(text || "Invalid JSON response"));
          }
        });
      }
    );
    req.on("error", (err) => {
      const msg = err.message;
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        reject(new Error("HoustonVM not running. Start HoustonVM (swift run in houston-vm/) or run the HoustonVM app."));
      } else {
        reject(err);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

function requestBinary(path: string): Promise<Buffer> {
  const port = getVmPort();
  if (port == null) {
    return Promise.reject(new Error("HoustonVM port not found. Start HoustonVM first."));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOUSTON_VM_HOST,
        port,
        path,
        method: "GET",
        family: 4,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(Buffer.concat(chunks).toString("utf-8") || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      }
    );
    req.on("error", (err) => {
      const msg = err.message;
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        reject(new Error("HoustonVM not running. Start HoustonVM (swift run in houston-vm/) or run the HoustonVM app."));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

export async function installProgress(vmId: string): Promise<{ ok: boolean; fractionCompleted?: number; phase?: string }> {
  try {
    const data = await request<{ ok: boolean; fractionCompleted?: number; phase?: string }>(
      "/install-progress/" + encodeURIComponent(vmId)
    );
    return data;
  } catch {
    return { ok: false };
  }
}

export async function listVms(): Promise<VmInfo[]> {
  const data = await request<{ ok: boolean; vms?: VmInfo[] }>("/vms");
  if (!data.ok || !data.vms) return [];
  return data.vms;
}

export interface ModelsStatus {
  ok: boolean;
  models?: Record<string, string>;
  isComplete?: boolean;
}

function requestAI<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const port = getAiPort();
  if (port == null) {
    return Promise.reject(new Error("Houston AI port not found. Start Houston AI service first."));
  }
  return new Promise((resolve, reject) => {
    const body = init?.body;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    const req = httpRequest(
      {
        host: HOUSTON_AI_HOST,
        port,
        path,
        method: init?.method ?? "GET",
        headers,
        family: 4,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(text || "Invalid JSON response"));
          }
        });
      }
    );
    req.on("error", (err) => {
      const msg = err.message;
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        reject(new Error("Houston AI service not running. Start the AI service binary."));
      } else {
        reject(err);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

function requestAIText(path: string, init?: { method?: string; body?: string }): Promise<string> {
  const port = getAiPort();
  if (port == null) {
    return Promise.reject(new Error("Houston AI port not found. Start Houston AI service first."));
  }
  return new Promise((resolve, reject) => {
    const body = init?.body;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
    const req = httpRequest(
      {
        host: HOUSTON_AI_HOST,
        port,
        path,
        method: init?.method ?? "GET",
        headers,
        family: 4,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(text || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on("error", (err) => {
      const msg = err.message;
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        reject(new Error("Houston AI service not running. Start the AI service binary."));
      } else {
        reject(err);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function modelsStatus(): Promise<ModelsStatus> {
  try {
    const data = await requestAI<{ ok: boolean; models?: Record<string, string>; isComplete?: boolean }>("/models-status");
    if (data.ok) return { ok: true, models: data.models ?? {}, isComplete: data.isComplete ?? false };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function checkIpswSupported(ipswPath: string): Promise<{ ok: boolean; supported?: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; supported?: boolean }>("/check-ipsw", {
      method: "POST",
      body: JSON.stringify({ ipsw_path: ipswPath }),
    });
    if (data.ok) return { ok: true, supported: data.supported ?? false };
    return { ok: false, error: "Check failed" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CreateVmOptions {
  guestType?: "linux" | "macos";
  isoPath?: string;
  ipswPath?: string;
  ramMb?: number;
  diskGb?: number;
}

export async function createVm(options?: CreateVmOptions | string): Promise<{ ok: boolean; vm?: VmInfo; error?: string }> {
  try {
    const opts: CreateVmOptions =
      typeof options === "string" ? { isoPath: options } : options ?? {};
    console.log("[Houston] createVm opts:", JSON.stringify(opts));
    const body = JSON.stringify({
      guest_type: opts.guestType ?? "linux",
      iso_path: opts.isoPath ?? undefined,
      ipsw_path: opts.ipswPath ?? undefined,
      ram_mb: opts.ramMb ?? undefined,
      disk_gb: opts.diskGb ?? undefined,
    });
    const data = await request<{ ok: boolean; vm?: VmInfo; error?: string }>("/create", {
      method: "POST",
      body,
    });
    if (data.ok && data.vm) return { ok: true, vm: data.vm };
    return { ok: false, error: data.error ?? "Failed to create VM" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function startVm(vmId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/start/" + encodeURIComponent(vmId), {
      method: "POST",
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: data.error ?? "Failed to start VM" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function stopVm(vmId: string, force?: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = force === true ? JSON.stringify({ force: true }) : undefined;
    const data = await request<{ ok: boolean; error?: string }>("/stop/" + encodeURIComponent(vmId), {
      method: "POST",
      body,
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: data.error ?? "Failed to stop VM" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteVm(vmId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/delete/" + encodeURIComponent(vmId), {
      method: "POST",
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: data.error ?? "Failed to delete VM" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function showConsoleVm(vmId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/console/" + vmId, { method: "POST" });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to show console" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const VM_POWERED_OFF_MSG = "VM is powered off. Use power_on to start it.";

function normalizeScreenshotError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(msg) as { error?: string };
    if (parsed?.error?.toLowerCase().includes("not running")) {
      return VM_POWERED_OFF_MSG;
    }
    return parsed.error ?? msg;
  } catch {
    if (msg.toLowerCase().includes("not running")) return VM_POWERED_OFF_MSG;
    return msg;
  }
}

export async function screenshotVm(vmId: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }> {
  try {
    const buf = await requestBinary("/screenshot/" + vmId);
    return { ok: true, pngBase64: buf.toString("base64") };
  } catch (err) {
    return {
      ok: false,
      error: normalizeScreenshotError(err),
    };
  }
}

export async function testOcrVm(
  vmId: string,
  imageBase64?: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    let base64: string;
    if (imageBase64) {
      base64 = imageBase64;
    } else {
      const screenshot = await screenshotVm(vmId);
      if (!screenshot.ok || !screenshot.pngBase64) {
        return { ok: false, error: screenshot.error ?? "Screenshot failed" };
      }
      base64 = screenshot.pngBase64;
    }
    const guestType = (await listVms()).find((v) => v.id === vmId)?.guestType ?? "linux";
    const text = await requestAIText("/ocr", {
      method: "POST",
      body: JSON.stringify({ image_base64: base64, guest_type: guestType }),
    });
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function testOcrVmWithOverlay(
  vmId: string,
  imageBase64?: string
): Promise<{ ok: boolean; text?: string; pngBase64?: string; error?: string }> {
  try {
    let base64: string;
    if (imageBase64) {
      base64 = imageBase64;
    } else {
      const screenshot = await screenshotVm(vmId);
      if (!screenshot.ok || !screenshot.pngBase64) {
        return { ok: false, error: screenshot.error ?? "Screenshot failed" };
      }
      base64 = screenshot.pngBase64;
    }
    const guestType = (await listVms()).find((v) => v.id === vmId)?.guestType ?? "linux";
    const text = await requestAIText("/ocr", {
      method: "POST",
      body: JSON.stringify({ image_base64: base64, guest_type: guestType }),
    });
    return { ok: true, text, pngBase64: base64 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function testOcrOmniParserVm(
  vmId: string,
  options?: { confidenceThreshold?: number; iouThreshold?: number; imageBase64?: string }
): Promise<{ ok: boolean; text?: string; pngBase64?: string; error?: string }> {
  try {
    let base64: string;
    if (options?.imageBase64) {
      base64 = options.imageBase64;
    } else {
      const screenshot = await screenshotVm(vmId);
      if (!screenshot.ok || !screenshot.pngBase64) {
        return { ok: false, error: screenshot.error ?? "Screenshot failed" };
      }
      base64 = screenshot.pngBase64;
    }
    const guestType = (await listVms()).find((v) => v.id === vmId)?.guestType ?? "linux";
    const body: Record<string, unknown> = { image_base64: base64, guest_type: guestType };
    if (options?.confidenceThreshold != null) body.confidence_threshold = options.confidenceThreshold;
    if (options?.iouThreshold != null) body.iou_threshold = options.iouThreshold;
    const text = await requestAIText("/ocr-omni-parser", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, text, pngBase64: base64 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function iconCaptions(
  images: string[]
): Promise<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }> {
  try {
    const iconCaptionUrl = getIconCaptionUrl();
    if (iconCaptionUrl) {
      const result = await captionImagesViaIconModel(iconCaptionUrl, images);
      if (result.ok && result.captions) return { ok: true, captions: result.captions };
      return { ok: false, error: result.error ?? "Icon caption failed" };
    }
    const data = await requestAI<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }>(
      "/captions",
      { method: "POST", body: JSON.stringify({ images }) }
    );
    if (data.ok && data.captions) return { ok: true, captions: data.captions };
    return { ok: false, error: data.error ?? "Icon caption failed" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function typeVm(vmId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/type/" + vmId, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to type" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function pressVm(vmId: string, key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/press/" + vmId, {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to press key" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function clickVm(vmId: string, x?: number, y?: number, doubleClick?: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: { x?: number; y?: number; doubleClick?: boolean } = {};
    if (x != null) body.x = x;
    if (y != null) body.y = y;
    if (doubleClick) body.doubleClick = true;
    const data = await request<{ ok: boolean; error?: string }>("/click/" + vmId, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to click" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function moveVm(vmId: string, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/move/" + vmId, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to move" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function mouseDownVm(vmId: string, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/mousedown/" + vmId, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to mouse down" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function moveVmDragging(vmId: string, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/move-dragging/" + vmId, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to move while dragging" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function mouseUpVm(vmId: string, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = await request<{ ok: boolean; error?: string }>("/mouseup/" + vmId, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to mouse up" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Overlay removed from HoustonVM. No-op for compatibility. */
export async function setOverlayVm(
  _vmId: string,
  _overlay: { centers: Array<{ x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number; kind?: string }>; imgW: number; imgH: number } | null
): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}

export async function scrollVm(
  vmId: string,
  scrollY: number,
  scrollX?: number,
  x?: number,
  y?: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: { scrollY: number; scrollX?: number; x?: number; y?: number } = { scrollY };
    if (scrollX != null && scrollX !== 0) body.scrollX = scrollX;
    if (x != null) body.x = x;
    if (y != null) body.y = y;
    const data = await request<{ ok: boolean; error?: string }>("/scroll/" + vmId, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (data.ok) return { ok: true };
    return { ok: false, error: (data as { error?: string }).error ?? "Failed to scroll" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
