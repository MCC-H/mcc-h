import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { join } from "node:path";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { startMcpServer, getMcpServerPort } from "./mcp-server/index.js";
import { runOCR, parseOcrToOverlay } from "./mcp-server/ocr.js";
import { localizeElement, captionImagesHolo } from "./mcp-server/localization.js";
import { startAgent, stopAgent, sendMessage, requestAgentAbort, setPendingInjectMessage } from "./ai-agent/index.js";
import { deliverUserReply, isWaitingForAskUser } from "./ask-user-bridge.js";
import {
  listVms,
  createVm,
  checkIpswSupported,
  installProgress,
  startVm,
  stopVm,
  deleteVm,
  showConsoleVm,
  screenshotVm,
  testOcrVm,
  testOcrVmWithOverlay,
  testOcrOmniParserVm,
  setOverlayVm,
  typeVm,
  pressVm,
  clickVm,
  moveVm,
  moveVmDragging,
  mouseDownVm,
  mouseUpVm,
  scrollVm,
  iconCaptions,
  modelsStatus,
} from "./vm-manager.js";
import { startHoustonVm, stopHoustonVm } from "./houston-vm-launcher.js";
import { startHoustonAI, stopHoustonAI } from "./houston-ai-launcher.js";
import {
  startIconModelServer,
  stopIconModelServer,
  setIconModelProgressCallback,
  getIconCaptionUrl,
} from "./icon-model-manager.js";
import {
  startLocalizationModelServer,
  stopLocalizationModelServer,
  getLocalizationUrl,
  setLocalizationModelProgressCallback,
} from "./localization-model-manager.js";
import {
  secretsWipe,
  secretsListFull,
  secretsSet,
  secretsDelete,
  validateDetailedDescription as validateSecretsDesc,
} from "./secrets-store.js";
import {
  authorizeChatGPT,
  isChatGPTAuthorized,
  clearChatGPTOAuthTokens,
} from "./chatgpt-oauth.js";
import {
  agentConfigWipe,
  agentConfigList,
  agentConfigSet,
  agentConfigDelete,
  validateDetailedDescription as validateConfigDesc,
} from "./agent-config-store.js";
import * as recipeStore from "./recipe-store.js";

const HOUSTON_DIR = join(homedir(), "houston");

/** Ensure value is cloneable for Electron IPC (avoids "object could not be cloned" error) */
function safeForIPC<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (err) {
    console.warn("[Houston] IPC serialization failed:", err);
    return String(value) as unknown as T;
  }
}
const CONFIG_PATH = join(HOUSTON_DIR, "config.json");

app.setPath("userData", join(HOUSTON_DIR, "chromiumData"));

export type AiProvider = "claude" | "openrouter" | "chatgpt" | "custom";

export interface McpConfig {
  vmId: string;
  mcpPort: number;
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  chatgptModel: string;
  /** Custom OpenAI-compatible API for control model. Used when aiProvider === "custom". */
  customControlApiUrl?: string;
  customControlApiKey?: string;
  customControlModel?: string;
  /** VL observation model (e.g. qwen/qwen3-vl-8b-instruct). */
  vlModel?: string;
  /** Custom OpenAI-compatible API URL for VL. When set, uses this instead of OpenRouter. */
  vlApiUrl?: string;
  /** API key for VL custom server. When using OpenRouter, uses openrouterApiKey. */
  vlApiKey?: string;
}

const DEFAULT_CONFIG: McpConfig = {
  vmId: "",
  mcpPort: 10000, // >= 10k to avoid root on some systems
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  chatgptModel: "gpt-5.1-codex",
  vlModel: "qwen/qwen3-vl-8b-instruct",
};

function loadConfig(): McpConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      console.log("[Houston] Config loaded from", CONFIG_PATH);
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.warn("[Houston] Config load failed:", err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: McpConfig): void {
  try {
    mkdirSync(HOUSTON_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save config:", err);
  }
}

let mainWindow: BrowserWindow | null = null;
let mcpHttpServer: Server | null = null;

function createWindow() {
  const preloadPath = join(__dirname, "../preload/index.mjs");
  if (!existsSync(preloadPath)) {
    console.error("[Houston] Preload not found at:", preloadPath);
    console.error("[Houston] __dirname:", __dirname);
  } else {
    console.log("[Houston] Preload path:", preloadPath);
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for ESM (.mjs) preload per Electron docs
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
  }

  mainWindow.on("ready-to-show", () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopMcpServer();
  });
}

app.whenReady().then(() => {
  createWindow();
  setIconModelProgressCallback((p) => {
    mainWindow?.webContents?.send("icon-model-progress", p);
  });
  setLocalizationModelProgressCallback((p) => {
    mainWindow?.webContents?.send("localization-model-progress", p);
  });
  (async () => {
    const sendHypervisorProgress = (msg: string) =>
      mainWindow?.webContents?.send("hypervisor-start-progress", { phase: "starting" as const, message: msg });
    const sendAiProgress = (msg: string) =>
      mainWindow?.webContents?.send("ai-start-progress", { phase: "starting" as const, message: msg });

    const windowReady = new Promise<void>((resolve) => {
      if (!mainWindow?.webContents) {
        resolve();
        return;
      }
      if (!mainWindow.webContents.isLoading()) {
        resolve();
        return;
      }
      mainWindow.webContents.once("did-finish-load", () => resolve());
    });

    const iconLocPromise = Promise.all([
      startIconModelServer(),
      startLocalizationModelServer(),
    ]);
    await windowReady;
    sendHypervisorProgress("Starting services...");
    sendHypervisorProgress("Loading icon and localization models…");
    const [iconResult, locResult] = await iconLocPromise;
    const iconCaptionUrl = iconResult.ok && iconResult.port ? `http://127.0.0.1:${iconResult.port}` : undefined;
    sendHypervisorProgress("Starting HoustonVM...");
    const vmResult = await startHoustonVm({
      iconCaptionUrl,
      onProgress: (msg) => sendHypervisorProgress(msg),
    });
    if (vmResult.ok) {
      mainWindow?.webContents?.send("hypervisor-start-progress", { phase: "ready", message: "HoustonVM ready" });
      console.log("[Houston] HoustonVM started");
    } else {
      mainWindow?.webContents?.send("hypervisor-start-progress", { phase: "failed", message: vmResult.message });
      console.warn("[Houston] HoustonVM:", vmResult.message);
    }
    sendAiProgress("Starting HoustonAI...");
    const aiResult = await startHoustonAI({
      onProgress: (msg) => sendAiProgress(msg),
    });
    if (aiResult.ok) {
      mainWindow?.webContents?.send("ai-start-progress", { phase: "ready", message: "HoustonAI ready" });
      console.log("[Houston] HoustonAI started");
    } else {
      mainWindow?.webContents?.send("ai-start-progress", { phase: "failed", message: aiResult.message });
      console.warn("[Houston] HoustonAI:", aiResult.message);
    }
    if (!iconResult.ok) console.warn("[Houston] Icon model:", iconResult.error);
    if (!locResult.ok) console.warn("[Houston] Localization model (Holo1.5-3B):", locResult.error);
  })().catch((err) => console.warn("[Houston] Startup failed:", err));
});

let gracefulShutdownDone = false;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 70_000;  // 70s to match Linux VM 60s graceful timeout

app.on("before-quit", (event) => {
  if (gracefulShutdownDone) return;
  event.preventDefault();
  gracefulShutdownDone = true;

  (async () => {
    stopMcpServer();
    try {
      const vms = await listVms();
      const running = vms.filter((v) => v.status === "running");
      if (running.length > 0) {
        console.log("[Houston] Gracefully shutting down", running.length, "VM(s)...");
        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Graceful shutdown timeout")), GRACEFUL_SHUTDOWN_TIMEOUT_MS)
        );
        const stops = Promise.all(running.map((v) => stopVm(v.id, false)));
        await Promise.race([stops, timeout]);
        console.log("[Houston] VM(s) shut down");
      }
    } catch (err) {
      console.warn("[Houston] Graceful shutdown:", err instanceof Error ? err.message : err);
    }
    stopHoustonVm();
    stopHoustonAI();
    stopIconModelServer();
    stopLocalizationModelServer();
    gracefulShutdownDone = true;
    app.exit(0);
  })();
});

app.on("window-all-closed", () => {
  app.quit();
});

function stopMcpServer() {
  if (mcpHttpServer) {
    mcpHttpServer.close();
    mcpHttpServer = null;
  }
  stopAgent();
}

ipcMain.handle("start-mcp-server", async (_event, config: McpConfig) => {
  stopMcpServer();
  stopAgent();
  saveConfig(config);

  try {
    console.log("[Houston] Starting MCP server");
    const guestType = (await listVms()).find((v) => v.id === config.vmId)?.guestType ?? "linux";
    mcpHttpServer = await startMcpServer({
      vmId: config.vmId,
      mcpPort: 0,
      guestType,
      openrouterApiKey: config.openrouterApiKey,
      vlModel: config.vlModel,
      vlApiUrl: config.vlApiUrl,
      vlApiKey: config.vlApiKey,
      localizationApiUrl: getLocalizationUrl() ?? undefined,
      onAskUserRequest: (info) => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents?.send("ask-user-popup", info);
      },
      onAskUserTimeout: () => {
        mainWindow?.webContents?.send("ask-user-popup-close");
      },
      onStartTask: (info) => {
        mainWindow?.webContents?.send("task-start", info);
      },
      onFinalizeTask: (info) => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents?.send("finalize-task-popup", info);
      },
    });
    const mcpPort = getMcpServerPort(mcpHttpServer);
    console.log("[Houston] MCP server started on port", mcpPort);

    const modelName =
      config.aiProvider === "claude"
        ? config.claudeModel
        : config.aiProvider === "openrouter"
          ? config.openrouterModel
          : config.aiProvider === "custom"
            ? config.customControlModel ?? "custom"
            : config.chatgptModel ?? "gpt-5.1-codex";
    recipeStore.setModel(modelName);

    const hasApiKey =
      (config.aiProvider === "claude" && config.claudeApiKey?.trim()) ||
      (config.aiProvider === "openrouter" && config.openrouterApiKey?.trim()) ||
      (config.aiProvider === "custom" &&
        config.customControlApiUrl?.trim() &&
        config.customControlApiKey?.trim() &&
        config.customControlModel?.trim()) ||
      (config.aiProvider === "chatgpt" && isChatGPTAuthorized());
    if (hasApiKey) {
      try {
        await startAgent({
          mcpPort,
          aiProvider: config.aiProvider,
          claudeApiKey: config.claudeApiKey,
          claudeModel: config.claudeModel,
          openrouterApiKey: config.openrouterApiKey,
          openrouterModel: config.openrouterModel,
          chatgptModel: config.chatgptModel ?? "gpt-5.1-codex",
          customControlApiUrl: config.customControlApiUrl,
          customControlApiKey: config.customControlApiKey,
          customControlModel: config.customControlModel,
        });
        console.log(
          "[Houston] AI agent started with",
          config.aiProvider === "claude"
            ? `Claude (${config.claudeModel})`
            : config.aiProvider === "openrouter"
              ? `OpenRouter (${config.openrouterModel})`
              : config.aiProvider === "custom"
                ? `Custom (${config.customControlModel})`
                : `ChatGPT (${config.chatgptModel ?? "gpt-5.1-codex"})`
        );
        return safeForIPC({
          ok: true,
          agentReady: true,
          message: "Agent is ready — ask what you'd like to do.",
        });
      } catch (agentErr) {
        console.error("[Houston] AI agent failed:", agentErr);
        return safeForIPC({
          ok: true,
          agentReady: false,
          message: `Agent failed: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`,
        });
      }
    }

    return safeForIPC({
      ok: true,
      agentReady: false,
      message: "Add API key and restart to enable agent.",
    });
  } catch (err) {
    console.error("[Houston] MCP server failed:", err);
    return safeForIPC({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

ipcMain.handle("stop-mcp-server", () => {
  stopAgent();
  stopMcpServer();
  return safeForIPC({ ok: true });
});

ipcMain.handle("wipe-secrets", () => {
  secretsWipe();
  clearChatGPTOAuthTokens();
  return undefined;
});

ipcMain.handle("wipe-configs", () => {
  agentConfigWipe();
  return undefined;
});

ipcMain.handle("secrets-list-full", () => safeForIPC(secretsListFull()));

ipcMain.handle(
  "secrets-set",
  (
    _,
    args: {
      detailed_description: string;
      first_factor: string;
      first_factor_type: string;
      value: string;
      force?: boolean;
    }
  ) => {
    try {
      validateSecretsDesc(args.detailed_description);
      return secretsSet(
        args.detailed_description,
        args.first_factor,
        args.first_factor_type,
        args.value,
        args.force ?? false
      );
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);

ipcMain.handle("secrets-delete", (_, id: string) => {
  secretsDelete(id);
  return undefined;
});

ipcMain.handle("agent-config-list", () => safeForIPC(agentConfigList()));

ipcMain.handle(
  "agent-config-set",
  (
    _,
    args: {
      detailed_description: string;
      value: string;
      force?: boolean;
    }
  ) => {
    try {
      validateConfigDesc(args.detailed_description);
      return agentConfigSet(args.detailed_description, args.value, args.force ?? false);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
);

ipcMain.handle("agent-config-delete", (_, id: string) => {
  agentConfigDelete(id);
  return undefined;
});

const RECIPE_PORT = 17891;
let recipeServer: ReturnType<typeof createServer> | null = null;

function ensureRecipeServer(): void {
  if (recipeServer) return;
  recipeServer = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const entryMatch = url.match(/^\/entry-(\d+)\.png$/);
    if (entryMatch) {
      const idx = parseInt(entryMatch[1], 10) - 1;
      const r = recipeStore.getRecipe();
      const entry = r?.entries[idx];
      const base64 = entry?.screenshotBase64 ?? entry?.terminalBase64;
      if (base64) {
        const buf = Buffer.from(base64, "base64");
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (url === "/marked.js") {
      const { createRequire } = await import("node:module");
      const { dirname } = await import("node:path");
      const { readFileSync } = await import("node:fs");
      const require = createRequire(import.meta.url);
      const markedPath = dirname(require.resolve("marked/package.json")) + "/lib/marked.umd.js";
      const buf = readFileSync(markedPath);
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(buf);
      return;
    }
    if (url === "/RECIPE.md") {
      const md = recipeStore.generateMarkdown();
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(md);
      return;
    }
    if (url === "/" || url === "/index.html") {
      const md = recipeStore.generateMarkdown();
      const html = recipeStore.generateRecipeIndexHtml(md);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  recipeServer.listen(RECIPE_PORT, "127.0.0.1");
}

ipcMain.handle("recipe-view", async () => {
  ensureRecipeServer();
  shell.openExternal(`http://127.0.0.1:${RECIPE_PORT}/`);
  return undefined;
});

ipcMain.handle("recipe-save", async () => {
  const result = await dialog.showSaveDialog(mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined, {
    title: "Save recipe",
    defaultPath: `recipe-${Date.now()}.zip`,
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await recipeStore.saveRecipeToZip(result.filePath);
  return result.filePath;
});

ipcMain.handle("recipe-load", async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined, {
    title: "Load recipe",
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "No file selected" };
  const { loadRecipeFromZip } = await import("./recipe-load.js");
  return loadRecipeFromZip(result.filePaths[0]);
});

ipcMain.handle("agent-abort", () => {
  requestAgentAbort();
  return undefined;
});

ipcMain.handle("agent-inject-message", (_event, message: string) => {
  const msg = String(message ?? "").trim();
  const placeAfterAskUser = isWaitingForAskUser();
  recipeStore.appendUserInjection(msg, placeAfterAskUser);
  if (placeAfterAskUser) {
    deliverUserReply(msg);
  } else {
    setPendingInjectMessage(msg);
  }
  return undefined;
});

ipcMain.handle("agent-send-message", async (event, message: string, history: { role: "user" | "assistant"; content: string }[] = []) => {
  console.log("[Houston] agent-send-message received, length:", message?.length, "history:", history?.length ?? 0);
  recipeStore.setInitialPrompt(message);
  try {
    const result = await sendMessage(
      message,
      (chunk) => event.sender.send("agent-stream-chunk", String(chunk ?? "")),
      history ?? []
    );
    return safeForIPC(String(result.text ?? ""));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Houston] agent-send-message error:", msg);
    throw new Error(msg);
  }
});

ipcMain.handle("get-config", () => {
  console.log("[Houston] get-config");
  return safeForIPC(loadConfig());
});

ipcMain.handle("save-config", (_event, config: McpConfig) => {
  console.log("[Houston] save-config");
  saveConfig(config);
});

ipcMain.handle("chatgpt-authorize", async () => {
  const result = await authorizeChatGPT();
  return safeForIPC(result);
});

ipcMain.handle("chatgpt-auth-status", () => {
  return safeForIPC({ authorized: isChatGPTAuthorized() });
});

ipcMain.handle("vm-list", async () => safeForIPC(await listVms()));
ipcMain.handle(
  "vm-create",
  async (_event, options?: { guestType?: string; isoPath?: string; ipswPath?: string }) =>
    safeForIPC(await createVm(options))
);
ipcMain.handle(
  "vm-install-progress",
  async (_event, vmId: string) => safeForIPC(await installProgress(vmId))
);
ipcMain.handle(
  "vm-check-ipsw",
  async (_event, ipswPath: string) => safeForIPC(await checkIpswSupported(ipswPath))
);

ipcMain.handle(
  "dialog-show-open",
  async (
    _event,
    options: { title?: string; filters?: { name: string; extensions: string[] }[] }
  ): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined, {
      properties: ["openFile"],
      title: options.title ?? "Select ISO file",
      filters: options.filters ?? [{ name: "ISO images", extensions: ["iso"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  }
);

ipcMain.handle(
  "select-custom-screenshot",
  async (): Promise<{ ok: boolean; pngBase64?: string; error?: string }> => {
    const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined, {
      properties: ["openFile"],
      title: "Select screenshot image",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "No file selected" };
    }
    try {
      const buf = readFileSync(result.filePaths[0]);
      const pngBase64 = buf.toString("base64");
      return { ok: true, pngBase64 };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
);
ipcMain.handle("vm-start", async (_event, vmId: string) => safeForIPC(await startVm(vmId)));
ipcMain.handle("vm-stop", async (_event, vmId: string) => safeForIPC(await stopVm(vmId)));
ipcMain.handle("vm-delete", async (_event, vmId: string) => safeForIPC(await deleteVm(vmId)));
ipcMain.handle("vm-show-console", async (_event, vmId: string) => safeForIPC(await showConsoleVm(vmId)));
ipcMain.handle(
  "vm-set-overlay",
  async (
    _event,
    vmId: string,
    overlay: { centers: Array<{ x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number; kind?: string }>; imgW: number; imgH: number } | null
  ) => safeForIPC(await setOverlayVm(vmId, overlay))
);
ipcMain.handle("vm-screenshot", async (_event, vmId: string) => safeForIPC(await screenshotVm(vmId)));
ipcMain.handle(
  "vm-test-ocr",
  async (_event, vmId: string, imageBase64?: string) =>
    safeForIPC(await testOcrVm(vmId, imageBase64))
);
ipcMain.handle(
  "vm-test-ocr-overlay",
  async (_event, vmId: string, imageBase64?: string) =>
    safeForIPC(await testOcrVmWithOverlay(vmId, imageBase64))
);
async function testOcrVmWithVision(
  vmId: string,
  options?: { freshView?: boolean; imageBase64?: string }
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
    const localPath = join(tmpdir(), `houston_ocr_vision_${randomUUID()}.png`);
    writeFileSync(localPath, Buffer.from(base64, "base64"));
    const cfg = loadConfig();
    const guestType = (await listVms()).find((v) => v.id === vmId)?.guestType ?? "linux";
    const mcpConfig = {
      vmId,
      mcpPort: cfg.mcpPort,
      guestType,
      openrouterApiKey: cfg.openrouterApiKey,
      vlModel: cfg.vlModel,
      vlApiUrl: cfg.vlApiUrl,
      vlApiKey: cfg.vlApiKey,
    };
    const freshView = options?.freshView ?? true;
    const text = await runOCR(mcpConfig, localPath, { freshView });
    const overlay = parseOcrToOverlay(text);
    if (overlay) await setOverlayVm(vmId, overlay);
    return { ok: true, text, pngBase64: base64 };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
ipcMain.handle(
  "vm-test-ocr-vision",
  async (_event, vmId: string, options?: { freshView?: boolean; imageBase64?: string }) =>
    safeForIPC(await testOcrVmWithVision(vmId, options))
);
ipcMain.handle(
  "vm-test-ocr-omni-parser",
  async (
    _event,
    vmId: string,
    options?: { confidenceThreshold?: number; iouThreshold?: number; imageBase64?: string }
  ) => safeForIPC(await testOcrOmniParserVm(vmId, options))
);
ipcMain.handle("vm-icon-captions", async (_event, images: unknown) => {
  const plainImages = JSON.parse(JSON.stringify(images)) as string[];
  return safeForIPC(await iconCaptions(plainImages));
});
ipcMain.handle("vm-icon-captions-holo", async (_event, images: unknown) => {
  const plainImages = JSON.parse(JSON.stringify(images)) as string[];
  const baseUrl = getLocalizationUrl();
  if (!baseUrl) {
    return safeForIPC({ ok: false, error: "Holo model not ready. Start app and wait for localization model." });
  }
  return safeForIPC(await captionImagesHolo(plainImages, { baseUrl }));
});
ipcMain.handle("vm-models-status", async () => safeForIPC(await modelsStatus()));
ipcMain.handle("vm-type", async (_event, vmId: string, text: string) => safeForIPC(await typeVm(vmId, text)));
ipcMain.handle("vm-press", async (_event, vmId: string, key: string) => safeForIPC(await pressVm(vmId, key)));
ipcMain.handle(
  "vm-click",
  async (_event, vmId: string, x?: number, y?: number, element?: string) => {
    if (element?.trim() && (x == null || y == null)) {
      const baseUrl = getLocalizationUrl();
      if (!baseUrl) {
        return safeForIPC({ ok: false, error: "Localization model not ready. Start app and wait for Holo1.5-3B." });
      }
      const shot = await screenshotVm(vmId);
      if (!shot.ok || !shot.pngBase64) {
        return safeForIPC({ ok: false, error: shot.error ?? "Screenshot failed" });
      }
      const path = join(tmpdir(), `mcp_test_click_${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(shot.pngBase64, "base64"));
      try {
        const coords = await localizeElement(path, element.trim(), { baseUrl });
        if (!coords) {
          return safeForIPC({ ok: false, error: `Could not localize element: "${element}"` });
        }
        return safeForIPC(await clickVm(vmId, coords.x, coords.y));
      } finally {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
    return safeForIPC(await clickVm(vmId, x, y));
  }
);

ipcMain.handle(
  "vm-drag-drop",
  async (
    _event,
    vmId: string,
    opts: {
      from_element?: string;
      to_element?: string;
      from_x?: number;
      from_y?: number;
      to_x?: number;
      to_y?: number;
      drop_time_ms?: number;
    }
  ) => {
    const { from_element, to_element, from_x, from_y, to_x, to_y, drop_time_ms = 300 } = opts ?? {};
    let srcX = from_x;
    let srcY = from_y;
    let dstX = to_x;
    let dstY = to_y;
    const baseUrl = getLocalizationUrl();
    if ((srcX == null || srcY == null || dstX == null || dstY == null) && baseUrl) {
      const shot = await screenshotVm(vmId);
      if (!shot.ok || !shot.pngBase64) {
        return safeForIPC({ ok: false, error: shot.error ?? "Screenshot failed" });
      }
      const path = join(tmpdir(), `mcp_test_drag_${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(shot.pngBase64, "base64"));
      try {
        if ((srcX == null || srcY == null) && from_element?.trim()) {
          const coords = await localizeElement(path, from_element.trim(), { baseUrl });
          if (!coords) {
            return safeForIPC({ ok: false, error: `Could not localize from_element: "${from_element}"` });
          }
          srcX = coords.x;
          srcY = coords.y;
        }
        if ((dstX == null || dstY == null) && to_element?.trim()) {
          const coords = await localizeElement(path, to_element.trim(), { baseUrl });
          if (!coords) {
            return safeForIPC({ ok: false, error: `Could not localize to_element: "${to_element}"` });
          }
          dstX = coords.x;
          dstY = coords.y;
        }
      } finally {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
    if (srcX == null || srcY == null || dstX == null || dstY == null) {
      return safeForIPC({
        ok: false,
        error: "Need (from_x, from_y) and (to_x, to_y), or from_element and to_element with localization",
      });
    }
    const steps = Math.max(2, Math.ceil(drop_time_ms / 20));
    const stepMs = drop_time_ms / steps;
    let r = await moveVm(vmId, srcX, srcY);
    if (!r.ok) return safeForIPC(r);
    r = await mouseDownVm(vmId, srcX, srcY);
    if (!r.ok) return safeForIPC(r);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(srcX + (dstX - srcX) * t);
      const y = Math.round(srcY + (dstY - srcY) * t);
      r = await moveVmDragging(vmId, x, y);
      if (!r.ok) return safeForIPC(r);
      if (stepMs > 0) await new Promise((res) => setTimeout(res, stepMs));
    }
    r = await moveVmDragging(vmId, dstX, dstY);
    if (!r.ok) return safeForIPC(r);
    r = await mouseUpVm(vmId, dstX, dstY);
    return safeForIPC(r);
  }
);

ipcMain.handle(
  "vm-scroll",
  async (
    _event,
    vmId: string,
    opts: { scrollY: number; scrollX?: number; element?: string; x?: number; y?: number }
  ) => {
    const { scrollY, scrollX = 0, element, x, y } = opts ?? {};
    let targetX = x;
    let targetY = y;
    if (element?.trim() && (targetX == null || targetY == null)) {
      const baseUrl = getLocalizationUrl();
      if (!baseUrl) {
        return safeForIPC({ ok: false, error: "Localization model not ready. Start app and wait for Holo1.5-3B." });
      }
      const shot = await screenshotVm(vmId);
      if (!shot.ok || !shot.pngBase64) {
        return safeForIPC({ ok: false, error: shot.error ?? "Screenshot failed" });
      }
      const path = join(tmpdir(), `mcp_test_scroll_${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(shot.pngBase64, "base64"));
      try {
        const coords = await localizeElement(path, element.trim(), { baseUrl });
        if (!coords) {
          return safeForIPC({ ok: false, error: `Could not localize element: "${element}"` });
        }
        targetX = coords.x;
        targetY = coords.y;
      } finally {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
    return safeForIPC(await scrollVm(vmId, scrollY, scrollX, targetX, targetY));
  }
);

let sayProcess: ReturnType<typeof spawn> | null = null;

ipcMain.handle("say", async (_event, text: string, rate?: number) => {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return;
  if (sayProcess) {
    sayProcess.kill("SIGKILL");
    sayProcess = null;
  }
  const r = typeof rate === "number" && rate > 0 ? Math.round(rate) : 195;
  sayProcess = spawn("say", ["-r", String(r), t], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      sayProcess!.on("error", reject);
      sayProcess!.on("exit", (code) => {
        sayProcess = null;
        code === 0 ? resolve() : reject(new Error(`say exited ${code}`));
      });
    });
  } finally {
    sayProcess = null;
  }
});

