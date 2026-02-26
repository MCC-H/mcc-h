import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOUSTON_DIR = join(homedir(), ".houston");
const VM_PORT_FILE = join(HOUSTON_DIR, "vm.port");
const AI_PORT_FILE = join(HOUSTON_DIR, "ai.port");

/** Read port from ~/.houston/vm.port. Returns null if file missing or invalid. */
export function getVmPort(): number | null {
  try {
    if (!existsSync(VM_PORT_FILE)) return null;
    const s = readFileSync(VM_PORT_FILE, "utf-8").trim();
    const p = parseInt(s, 10);
    return Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/** Read port from ~/.houston/ai.port. Returns null if file missing or invalid. */
export function getAiPort(): number | null {
  try {
    if (!existsSync(AI_PORT_FILE)) return null;
    const s = readFileSync(AI_PORT_FILE, "utf-8").trim();
    const p = parseInt(s, 10);
    return Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/** Houston VM base URL. Throws if port not available. */
export function getVmBaseUrl(): string {
  const port = getVmPort();
  if (port == null) throw new Error("HoustonVM port not found. Start HoustonVM first.");
  return `http://127.0.0.1:${port}`;
}

/** Houston AI base URL. Throws if port not available. */
export function getAiBaseUrl(): string {
  const port = getAiPort();
  if (port == null) throw new Error("Houston AI port not found. Start Houston AI service first.");
  return `http://127.0.0.1:${port}`;
}

/** Wait for port file to appear (polling). Returns port or null on timeout. */
export async function waitForPortFile(
  portFile: string,
  timeoutMs: number = 15_000
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (existsSync(portFile)) {
        const s = readFileSync(portFile, "utf-8").trim();
        const p = parseInt(s, 10);
        if (Number.isFinite(p) && p > 0 && p < 65536) return p;
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export { VM_PORT_FILE, AI_PORT_FILE };
