/**
 * Localization model (Holo2-4B-GGUF) manager.
 * Used for element-based mouse_click, mouse_double_click, mouse_scroll.
 * Bundles llama-server in app resources; models in ~/houston/models.
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUSTON_DIR = join(homedir(), "houston");
const MODELS_DIR = join(HOUSTON_DIR, "models");
const CONFIG_PATH = join(HOUSTON_DIR, "localization.json");

const HF_BASE = "https://huggingface.co/mradermacher/Holo2-4B-GGUF/resolve/main";
const MODEL_MAIN = "Holo2-4B.f16.gguf";
const MODEL_MMPROJ = "Holo2-4B.mmproj-f16.gguf";

export interface LocalizationModelProgress {
  phase: string;
  fractionCompleted?: number;
  bytesReceived?: number;
  bytesTotal?: number;
  speedMBps?: number;
}

type ProgressCallback = (p: LocalizationModelProgress) => void;

let progressCallback: ProgressCallback | null = null;
let llamaServerProcess: ChildProcess | null = null;
let localizationPort: number | null = null;

export function setLocalizationModelProgressCallback(cb: ProgressCallback | null): void {
  progressCallback = cb;
}

function emitProgress(
  phase: string,
  fractionCompleted?: number,
  extra?: { bytesReceived: number; bytesTotal: number; speedMBps: number }
): void {
  progressCallback?.({ phase, fractionCompleted, ...extra });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function downloadWithProgress(url: string, destPath: string, label: string): Promise<void> {
  emitProgress(label, 0);
  const headers: Record<string, string> = { "User-Agent": "Houston/1.0 (https://github.com)" };
  const hfToken = process.env.HF_TOKEN;
  if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers,
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  const body = res.body;
  if (!body) throw new Error("No response body");
  const file = createWriteStream(destPath);
  let received = 0;
  const startTime = Date.now();
  let lastEmitTime = startTime;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(value);
      received += value.length;
      const now = Date.now();
      if (total > 0 && now - lastEmitTime >= 200) {
        lastEmitTime = now;
        const elapsedSec = (now - startTime) / 1000;
        const speedMBps = elapsedSec > 0 ? received / (1024 * 1024) / elapsedSec : 0;
        emitProgress(label, received / total, {
          bytesReceived: received,
          bytesTotal: total,
          speedMBps,
        });
      }
    }
  } finally {
    file.end();
    await new Promise<void>((resolve, reject) => {
      file.on("finish", resolve);
      file.on("error", reject);
    });
  }
  if (total > 0) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const speedMBps = elapsedSec > 0 ? received / (1024 * 1024) / elapsedSec : 0;
    emitProgress(label, 1, { bytesReceived: received, bytesTotal: total, speedMBps });
  } else {
    emitProgress(label, 1);
  }
}

function getBundledLlamaPath(): { server: string; cwd: string } | null {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "resources");
  const llamaDir = join(resourcesDir, "llama-b8149");
  const serverPath = join(llamaDir, "llama-server");
  if (existsSync(serverPath)) {
    return { server: serverPath, cwd: llamaDir };
  }
  return null;
}

function ensureLlamaServer(): { server: string; cwd: string } {
  const bundled = getBundledLlamaPath();
  if (bundled) return bundled;
  throw new Error("llama-server not found. Run npm run electron:pack to bundle it.");
}

function isGgufValid(path: string): boolean {
  try {
    const buf = Buffer.alloc(4);
    const fd = openSync(path, "r");
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf.toString("ascii") === "GGUF";
  } catch {
    return false;
  }
}

async function ensureModels(): Promise<{ main: string; mmproj: string }> {
  mkdirSync(MODELS_DIR, { recursive: true });
  const mainPath = join(MODELS_DIR, MODEL_MAIN);
  const mmprojPath = join(MODELS_DIR, MODEL_MMPROJ);

  if (!existsSync(mainPath) || !isGgufValid(mainPath)) {
    if (existsSync(mainPath)) unlinkSync(mainPath);
    await downloadWithProgress(`${HF_BASE}/${MODEL_MAIN}`, mainPath, "Downloading Holo2-4B main");
    if (!isGgufValid(mainPath)) {
      unlinkSync(mainPath);
      throw new Error("Localization model main download invalid (not GGUF).");
    }
  }

  if (!existsSync(mmprojPath) || !isGgufValid(mmprojPath)) {
    if (existsSync(mmprojPath)) unlinkSync(mmprojPath);
    await downloadWithProgress(`${HF_BASE}/${MODEL_MMPROJ}`, mmprojPath, "Downloading Holo2-4B mmproj");
    if (!isGgufValid(mmprojPath)) {
      unlinkSync(mmprojPath);
      throw new Error("Localization model mmproj download invalid (not GGUF).");
    }
  }

  return { main: mainPath, mmproj: mmprojPath };
}

export async function startLocalizationModelServer(): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (localizationPort != null && llamaServerProcess) {
    return { ok: true, port: localizationPort };
  }

  try {
    emitProgress("Preparing Holo2-4B...", undefined);
    const llama = ensureLlamaServer();
    const { main, mmproj } = await ensureModels();

    emitProgress("Starting localization server...", undefined);
    const port = await findFreePort();

    llamaServerProcess = spawn(
      llama.server,
      [
        "-m",
        main,
        "-mm",
        mmproj,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "-c",
        "4096",
        "-np",
        "1",
        "-ngl",
        "all",
      ],
      {
        cwd: llama.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, DYLD_LIBRARY_PATH: llama.cwd },
      }
    );

    llamaServerProcess.stdout?.on("data", (d) => process.stdout.write(`[LocalizationModel] ${d}`));
    llamaServerProcess.stderr?.on("data", (d) => process.stderr.write(`[LocalizationModel] ${d}`));
    llamaServerProcess.unref();
    llamaServerProcess.on("exit", (code) => {
      console.log("[LocalizationModel] Server exited, code:", code);
      llamaServerProcess = null;
      localizationPort = null;
    });

    const url = `http://127.0.0.1:${port}`;
    mkdirSync(HOUSTON_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ url }), "utf-8");
    localizationPort = port;

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await new Promise<boolean>((resolve) => {
        const req = request({ host: "127.0.0.1", port, path: "/v1/models", method: "GET" }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(2000, () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ready) {
        emitProgress("Localization ready", 1);
        console.log("[LocalizationModel] Ready on port", port);
        return { ok: true, port };
      }
    }
    return { ok: false, error: "Localization server did not become ready in 60s" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[LocalizationModel] Failed:", err);
    return { ok: false, error: msg };
  }
}

export function stopLocalizationModelServer(): void {
  if (llamaServerProcess) {
    llamaServerProcess.kill("SIGTERM");
    llamaServerProcess = null;
  }
  localizationPort = null;
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
  console.log("[LocalizationModel] Stopped");
}

export function getLocalizationUrl(): string | null {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return data?.url ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}
