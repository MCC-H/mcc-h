import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const HOUSTON_DIR = join(homedir(), "houston");
export const CONFIG_PATH = join(HOUSTON_DIR, "config.json");

export type AiProvider = "claude" | "openrouter";

export interface HoustonConfig {
  vmId: string;
  mcpPort: number;
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
}

const DEFAULT_CONFIG: HoustonConfig = {
  vmId: "",
  mcpPort: 10000,
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
};

const SENSITIVE_KEYS = new Set(["password", "claudeApiKey", "openrouterApiKey"]);

export function loadConfig(): HoustonConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.warn("[Houston] Config load failed:", err);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: HoustonConfig): void {
  try {
    mkdirSync(HOUSTON_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("[Houston] Failed to save config:", err);
  }
}

/** Get config for display, masking sensitive values */
export function getConfigForDisplay(): Record<string, unknown> {
  const c = loadConfig();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    out[k] = SENSITIVE_KEYS.has(k) && typeof v === "string" && v.length > 0 ? "***" : v;
  }
  return out;
}

/** Set value at dotted path. Creates nested objects as needed. */
export function setConfigValue(path: string, value: string | number | boolean): void {
  const config = loadConfig() as Record<string, unknown>;
  const parts = path.split(".");
  let obj: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = obj[key];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      obj = next as Record<string, unknown>;
    } else {
      const nextObj: Record<string, unknown> = {};
      obj[key] = nextObj;
      obj = nextObj;
    }
  }
  obj[parts[parts.length - 1]] = value;
  saveConfig(config as HoustonConfig);
}
