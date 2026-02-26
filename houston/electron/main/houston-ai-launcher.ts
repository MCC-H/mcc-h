import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { waitForPortFile, getAiPort, AI_PORT_FILE } from "./houston-ports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;

function getHoustonAiDir(): string {
  if (isPackaged) {
    return process.resourcesPath;
  }
  return join(__dirname, "..", "resources");
}

function getHoustonAiBinary(): string | null {
  if (isPackaged) {
    const packagedPath = join(process.resourcesPath, "HoustonAI");
    if (existsSync(packagedPath)) return packagedPath;
    return null;
  }
  const resourcesDir = join(__dirname, "..", "resources");
  const binaryPath = join(resourcesDir, "HoustonAI");
  if (existsSync(binaryPath)) return binaryPath;
  return null;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

let houstonAiProcess: ChildProcess | null = null;

export async function startHoustonAI(options?: {
  onProgress?: (message: string) => void;
}): Promise<{ ok: boolean; message: string }> {
  if (houstonAiProcess) {
    return { ok: true, message: "HoustonAI already running" };
  }

  const existingPort = getAiPort();
  if (existingPort != null) {
    const alreadyRunning = await isPortInUse(existingPort);
    if (alreadyRunning) {
      console.log("[Houston] HoustonAI already running on port", existingPort);
      return { ok: true, message: "HoustonAI already running" };
    }
  }

  const binary = getHoustonAiBinary();
  const aiDir = getHoustonAiDir();

  if (!binary || !existsSync(binary)) {
    const debugMsg = `HoustonAI binary not found. Tried: ${binary ?? "null"}. Build with: cd houston-ai && swift build`;
    console.warn("[Houston]", debugMsg);
    return { ok: false, message: debugMsg };
  }

  const onProgress = options?.onProgress;

  try {
    onProgress?.("Spawning HoustonAI...");
    if (existsSync(AI_PORT_FILE)) {
      try {
        unlinkSync(AI_PORT_FILE);
      } catch {
        /* ignore */
      }
    }
    houstonAiProcess = spawn(binary, [], {
      cwd: aiDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, HOUSTON_PARENT_PID: String(process.pid) },
    });
    houstonAiProcess.stdout?.on("data", (d) => process.stdout.write(`[HoustonAI] ${d}`));
    houstonAiProcess.stderr?.on("data", (d) => process.stderr.write(`[HoustonAI] ${d}`));
    houstonAiProcess.unref();
    houstonAiProcess.on("error", (err) => console.error("[Houston] HoustonAI error:", err));
    houstonAiProcess.on("exit", (code) => {
      console.log("[Houston] HoustonAI exited, code:", code);
      houstonAiProcess = null;
    });

    onProgress?.("Waiting for HoustonAI port (up to 15s)...");
    const port = await waitForPortFile(AI_PORT_FILE, 15_000);
    if (port == null) {
      return { ok: false, message: "HoustonAI started but ai.port not written after 15s" };
    }
    onProgress?.(`HoustonAI port ${port} found, verifying...`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await isPortInUse(port);
      if (ready) {
        console.log("[Houston] HoustonAI started (port", port, "ready after", (i + 1) * 500, "ms)");
        return { ok: true, message: "HoustonAI started" };
      }
    }
    return { ok: false, message: `HoustonAI started but port ${port} not ready after 10s` };
  } catch (err) {
    console.error("[Houston] HoustonAI spawn failed:", err);
    return {
      ok: false,
      message: err instanceof Error ? err.message : "HoustonAI spawn failed",
    };
  }
}

export function stopHoustonAI(): void {
  if (houstonAiProcess) {
    houstonAiProcess.kill("SIGTERM");
    houstonAiProcess = null;
    console.log("[Houston] HoustonAI stopped");
  }
}
