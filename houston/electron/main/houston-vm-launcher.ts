import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { waitForPortFile, getVmPort, VM_PORT_FILE } from "./houston-ports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isPackaged = app.isPackaged;

function getHoustonVmDir(): string {
  if (isPackaged) {
    return process.resourcesPath;
  }
  return join(__dirname, "..", "resources");
}

function getHoustonVmBinary(): string | null {
  if (isPackaged) {
    const packagedPath = join(process.resourcesPath, "HoustonVM");
    console.log("[Houston] (packaged) Looking for HoustonVM at:", packagedPath, "exists:", existsSync(packagedPath));
    if (existsSync(packagedPath)) return packagedPath;
    return null;
  }
  const resourcesDir = join(__dirname, "..", "resources");
  const binaryPath = join(resourcesDir, "HoustonVM");
  console.log("[Houston] (dev) __dirname:", __dirname, "| Looking for HoustonVM at:", binaryPath, "| exists:", existsSync(binaryPath));
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

let houstonVmProcess: ChildProcess | null = null;

export async function startHoustonVm(options?: {
  iconCaptionUrl?: string;
  onProgress?: (message: string) => void;
}): Promise<{ ok: boolean; message: string }> {
  if (houstonVmProcess) {
    return { ok: true, message: "HoustonVM already running" };
  }

  const existingPort = getVmPort();
  if (existingPort != null) {
    const alreadyRunning = await isPortInUse(existingPort);
    if (alreadyRunning) {
      console.log("[Houston] HoustonVM already running on port", existingPort);
      return { ok: true, message: "HoustonVM already running" };
    }
  }

  const binary = getHoustonVmBinary();
  const vmDir = getHoustonVmDir();
  console.log("[Houston] isPackaged:", isPackaged, "| binary:", binary, "| vmDir:", vmDir);

  if (!binary || !existsSync(binary)) {
    const debugMsg = `HoustonVM binary not found. Tried: ${binary ?? "null"} (cwd for spawn: ${vmDir}). Build with: cd houston-vm && swift build, then npm run electron:build`;
    console.warn("[Houston]", debugMsg);
    return {
      ok: false,
      message: debugMsg,
    };
  }

  const env: Record<string, string> = { ...process.env, HOUSTON_PARENT_PID: String(process.pid) };
  if (options?.iconCaptionUrl) env.ICON_CAPTION_URL = options.iconCaptionUrl;
  const onProgress = options?.onProgress;

  try {
    onProgress?.("Spawning HoustonVM...");
    if (existsSync(VM_PORT_FILE)) {
      try {
        unlinkSync(VM_PORT_FILE);
      } catch {
        /* ignore */
      }
    }
    houstonVmProcess = spawn(binary, [], {
      cwd: vmDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    });
    houstonVmProcess.stdout?.on("data", (d) => process.stdout.write(`[HoustonVM] ${d}`));
    houstonVmProcess.stderr?.on("data", (d) => process.stderr.write(`[HoustonVM] ${d}`));
    houstonVmProcess.unref();
    houstonVmProcess.on("error", (err) => console.error("[Houston] HoustonVM error:", err));
    houstonVmProcess.on("exit", (code) => {
      console.log("[Houston] HoustonVM exited, code:", code);
      houstonVmProcess = null;
    });
    onProgress?.("Waiting for HoustonVM port (up to 15s)...");
    const port = await waitForPortFile(VM_PORT_FILE, 15_000);
    if (port == null) {
      return { ok: false, message: "HoustonVM started but vm.port not written after 15s" };
    }
    onProgress?.(`HoustonVM port ${port} found, verifying...`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await isPortInUse(port);
      if (ready) {
        console.log("[Houston] HoustonVM started (port", port, "ready after", (i + 1) * 500, "ms)");
        return { ok: true, message: "HoustonVM started" };
      }
    }
    return { ok: false, message: `HoustonVM started but port ${port} not ready after 10s` };
  } catch (err) {
    console.error("[Houston] HoustonVM spawn failed:", err);
    return {
      ok: false,
      message: err instanceof Error ? err.message : "HoustonVM spawn failed",
    };
  }
}

export function stopHoustonVm(): void {
  if (houstonVmProcess) {
    houstonVmProcess.kill("SIGTERM");
    houstonVmProcess = null;
    console.log("[Houston] HoustonVM stopped");
  }
}
