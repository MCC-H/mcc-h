import { contextBridge, ipcRenderer } from "electron";

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
  customControlApiUrl?: string;
  customControlApiKey?: string;
  customControlModel?: string;
  vlModel?: string;
  vlApiUrl?: string;
  vlApiKey?: string;
}

try {
  contextBridge.exposeInMainWorld("electronAPI", {
    getConfig: () => ipcRenderer.invoke("get-config"),
    saveConfig: (config: McpConfig) => ipcRenderer.invoke("save-config", config),
    startMcpServer: (config: McpConfig) => ipcRenderer.invoke("start-mcp-server", config),
    stopMcpServer: () => ipcRenderer.invoke("stop-mcp-server"),
    wipeSecrets: () => ipcRenderer.invoke("wipe-secrets"),
    wipeConfigs: () => ipcRenderer.invoke("wipe-configs"),
    secretsListFull: () => ipcRenderer.invoke("secrets-list-full"),
    secretsSet: (args: {
      detailed_description: string;
      first_factor: string;
      first_factor_type: string;
      value: string;
      force?: boolean;
    }) => ipcRenderer.invoke("secrets-set", args),
    secretsDelete: (id: string) => ipcRenderer.invoke("secrets-delete", id),
    agentConfigList: () => ipcRenderer.invoke("agent-config-list"),
    agentConfigSet: (args: { detailed_description: string; value: string; force?: boolean }) =>
      ipcRenderer.invoke("agent-config-set", args),
    agentConfigDelete: (id: string) => ipcRenderer.invoke("agent-config-delete", id),
    recipeView: () => ipcRenderer.invoke("recipe-view"),
    recipeSave: () => ipcRenderer.invoke("recipe-save"),
    recipeLoad: () => ipcRenderer.invoke("recipe-load"),
    agentSendMessage: (message: string, history?: { role: "user" | "assistant"; content: string }[]) =>
      ipcRenderer.invoke("agent-send-message", message, history ?? []),
    agentAbort: () => ipcRenderer.invoke("agent-abort"),
    agentInjectMessage: (message: string) => ipcRenderer.invoke("agent-inject-message", message),
    onAgentStreamChunk: (callback: (chunk: string) => void) => {
      const fn = (_: unknown, chunk: string) => callback(chunk);
      ipcRenderer.on("agent-stream-chunk", fn);
      return () => ipcRenderer.removeListener("agent-stream-chunk", fn);
    },
    vmList: () => ipcRenderer.invoke("vm-list"),
    vmCreate: (options?: { guestType?: string; isoPath?: string; ipswPath?: string }) =>
      ipcRenderer.invoke("vm-create", options),
    vmCheckIpsw: (ipswPath: string) => ipcRenderer.invoke("vm-check-ipsw", ipswPath),
    vmInstallProgress: (vmId: string) => ipcRenderer.invoke("vm-install-progress", vmId),
    showOpenDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke("dialog-show-open", options),
    selectCustomScreenshot: () => ipcRenderer.invoke("select-custom-screenshot"),
    vmStart: (vmId: string) => ipcRenderer.invoke("vm-start", vmId),
    vmStop: (vmId: string) => ipcRenderer.invoke("vm-stop", vmId),
    vmDelete: (vmId: string) => ipcRenderer.invoke("vm-delete", vmId),
    vmShowConsole: (vmId: string) => ipcRenderer.invoke("vm-show-console", vmId),
    vmScreenshot: (vmId: string) => ipcRenderer.invoke("vm-screenshot", vmId),
    vmTestOcr: (vmId: string, imageBase64?: string) =>
      ipcRenderer.invoke("vm-test-ocr", vmId, imageBase64),
    vmTestOcrOverlay: (vmId: string, imageBase64?: string) =>
      ipcRenderer.invoke("vm-test-ocr-overlay", vmId, imageBase64),
    vmSetOverlay: (
      vmId: string,
      overlay: { centers: Array<{ x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number; kind?: string }>; imgW: number; imgH: number } | null
    ) => ipcRenderer.invoke("vm-set-overlay", vmId, overlay),
    vmTestOcrVision: (vmId: string, options?: { freshView?: boolean; imageBase64?: string }) =>
      ipcRenderer.invoke("vm-test-ocr-vision", vmId, options),
    vmTestOcrOmniParser: (
      vmId: string,
      options?: { confidenceThreshold?: number; iouThreshold?: number; imageBase64?: string }
    ) => ipcRenderer.invoke("vm-test-ocr-omni-parser", vmId, options),
    vmIconCaptions: (images: string[]) => ipcRenderer.invoke("vm-icon-captions", images),
    vmIconCaptionsHolo: (images: string[]) => ipcRenderer.invoke("vm-icon-captions-holo", images),
    vmModelsStatus: () => ipcRenderer.invoke("vm-models-status"),
    vmType: (vmId: string, text: string) => ipcRenderer.invoke("vm-type", vmId, text),
    vmPress: (vmId: string, key: string) => ipcRenderer.invoke("vm-press", vmId, key),
    vmClick: (vmId: string, x?: number, y?: number, element?: string) =>
      ipcRenderer.invoke("vm-click", vmId, x, y, element),
    vmDragDrop: (
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
    ) => ipcRenderer.invoke("vm-drag-drop", vmId, opts),
    vmScroll: (
      vmId: string,
      opts: { scrollY: number; scrollX?: number; element?: string; x?: number; y?: number }
    ) => ipcRenderer.invoke("vm-scroll", vmId, opts),
    say: (text: string, rate?: number) => ipcRenderer.invoke("say", text, rate ?? 195),
    chatgptAuthorize: () => ipcRenderer.invoke("chatgpt-authorize"),
    chatgptAuthStatus: () => ipcRenderer.invoke("chatgpt-auth-status"),
    onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => {
      const fn = (_: unknown, info: { clarification: string; assessment: string; attempt: number }) => callback(info);
      ipcRenderer.on("ask-user-popup", fn);
      return () => ipcRenderer.removeListener("ask-user-popup", fn);
    },
    onAskUserPopupClose: (callback: () => void) => {
      const fn = () => callback();
      ipcRenderer.on("ask-user-popup-close", fn);
      return () => ipcRenderer.removeListener("ask-user-popup-close", fn);
    },
    onTaskStart: (callback: (info: { summary: string }) => void) => {
      const fn = (_: unknown, info: { summary: string }) => callback(info);
      ipcRenderer.on("task-start", fn);
      return () => ipcRenderer.removeListener("task-start", fn);
    },
    onFinalizeTaskPopup: (callback: (info: { assessment: string; clarification: string; is_successful: boolean }) => void) => {
      const fn = (_: unknown, info: { assessment: string; clarification: string; is_successful: boolean }) => callback(info);
      ipcRenderer.on("finalize-task-popup", fn);
      return () => ipcRenderer.removeListener("finalize-task-popup", fn);
    },
    onIconModelProgress: (callback: (p: { phase: string; fractionCompleted?: number }) => void) => {
      const fn = (_: unknown, p: { phase: string; fractionCompleted?: number }) => callback(p);
      ipcRenderer.on("icon-model-progress", fn);
      return () => ipcRenderer.removeListener("icon-model-progress", fn);
    },
    onLocalizationModelProgress: (callback: (p: { phase: string; fractionCompleted?: number }) => void) => {
      const fn = (_: unknown, p: { phase: string; fractionCompleted?: number }) => callback(p);
      ipcRenderer.on("localization-model-progress", fn);
      return () => ipcRenderer.removeListener("localization-model-progress", fn);
    },
    onHypervisorStartProgress: (callback: (p: { phase: "starting" | "ready" | "failed"; message?: string }) => void) => {
      const fn = (_: unknown, p: { phase: "starting" | "ready" | "failed"; message?: string }) => callback(p);
      ipcRenderer.on("hypervisor-start-progress", fn);
      return () => ipcRenderer.removeListener("hypervisor-start-progress", fn);
    },
    onAiStartProgress: (callback: (p: { phase: "starting" | "ready" | "failed"; message?: string }) => void) => {
      const fn = (_: unknown, p: { phase: "starting" | "ready" | "failed"; message?: string }) => callback(p);
      ipcRenderer.on("ai-start-progress", fn);
      return () => ipcRenderer.removeListener("ai-start-progress", fn);
    },
  });
  console.log("[Houston preload] electronAPI exposed");
} catch (err) {
  console.error("[Houston preload] Failed to expose electronAPI:", err);
}
