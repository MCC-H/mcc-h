/**
 * Icon Classification model (Qwen3-VL-2B-Instruct-GGUF-Q4) manager.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUSTON_DIR = join(homedir(), "houston");
const MODELS_DIR = join(HOUSTON_DIR, "models");
const CONFIG_PATH = join(HOUSTON_DIR, "icon-caption.json");

const HF_BASE = "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main";
const MODEL_MAIN = "Qwen3VL-2B-Instruct-Q4_K_M.gguf";
const MODEL_MMPROJ = "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf";
export interface IconModelProgress {
  phase: string;
  fractionCompleted?: number;
  bytesReceived?: number;
  bytesTotal?: number;
  speedMBps?: number;
}

type ProgressCallback = (p: IconModelProgress) => void;

let progressCallback: ProgressCallback | null = null;
let llamaServerProcess: ChildProcess | null = null;
let iconModelPort: number | null = null;

export function setIconModelProgressCallback(cb: ProgressCallback | null): void {
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

async function downloadWithProgress(
  url: string,
  destPath: string,
  label: string
): Promise<void> {
  emitProgress(label, 0);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Houston/1.0 (https://github.com)" },
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
  throw new Error("llama-server not found. Run npm run electron:build to bundle it.");
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
    emitProgress("Model download", 0);
    await downloadWithProgress(`${HF_BASE}/${MODEL_MAIN}`, mainPath, "Model download");
    if (!isGgufValid(mainPath)) {
      unlinkSync(mainPath);
      throw new Error("Model main download invalid (not GGUF). Check network or try again.");
    }
  }

  if (!existsSync(mmprojPath) || !isGgufValid(mmprojPath)) {
    if (existsSync(mmprojPath)) unlinkSync(mmprojPath);
    emitProgress("Model download", 0);
    await downloadWithProgress(`${HF_BASE}/${MODEL_MMPROJ}`, mmprojPath, "Model download");
    if (!isGgufValid(mmprojPath)) {
      unlinkSync(mmprojPath);
      throw new Error("Model vision download invalid (not GGUF). Check network or try again.");
    }
  }

  return { main: mainPath, mmproj: mmprojPath };
}

export async function startIconModelServer(): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (iconModelPort != null && llamaServerProcess) {
    return { ok: true, port: iconModelPort };
  }

  try {
    emitProgress("Preparing Icon Classification...", undefined);
    const llama = ensureLlamaServer();
    const { main, mmproj } = await ensureModels();

    emitProgress("Starting Icon Classification server...", undefined);
    const port = await findFreePort();

    llamaServerProcess = spawn(llama.server, [
      "-m", main, "-mm", mmproj,
      "--port", String(port), "--host", "127.0.0.1",
      "-c", "4096",
      "-np", "6",
      "-ngl", "all",
    ], {
      cwd: llama.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, DYLD_LIBRARY_PATH: llama.cwd },
    });

    llamaServerProcess.stdout?.on("data", (d) => process.stdout.write(`[IconModel] ${d}`));
    llamaServerProcess.stderr?.on("data", (d) => process.stderr.write(`[IconModel] ${d}`));
    llamaServerProcess.unref();
    llamaServerProcess.on("exit", (code) => {
      console.log("[IconModel] llama-server exited, code:", code);
      llamaServerProcess = null;
      iconModelPort = null;
    });

    const url = `http://127.0.0.1:${port}`;
    mkdirSync(HOUSTON_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ url }), "utf-8");
    iconModelPort = port;

    emitProgress("Loading Icon Classification model...", undefined);
    const { request } = await import("node:http");
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
        emitProgress("Icon Classification ready", 1);
        console.log("[IconModel] Started on port", port);
        return { ok: true, port };
      }
    }
    return { ok: false, error: "Icon Classification server did not become ready in 60s" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitProgress(`Icon Classification failed: ${msg}`, undefined);
    console.error("[IconModel] Failed:", err);
    return { ok: false, error: msg };
  }
}

export function stopIconModelServer(): void {
  if (llamaServerProcess) {
    llamaServerProcess.kill("SIGTERM");
    llamaServerProcess = null;
  }
  iconModelPort = null;
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
  console.log("[IconModel] Stopped");
}

export function getIconCaptionUrl(): string | null {
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
