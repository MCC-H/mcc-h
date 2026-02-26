/// <reference types="vite/client" />

type AiProvider = "claude" | "openrouter" | "chatgpt" | "custom";

interface McpConfig {
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

interface ElectronAPI {
  getConfig: () => Promise<McpConfig>;
  saveConfig: (config: McpConfig) => Promise<void>;
  startMcpServer: (config: McpConfig) => Promise<{ ok: boolean; agentReady?: boolean; message: string }>;
  stopMcpServer: () => Promise<{ ok: boolean }>;
  wipeSecrets: () => Promise<void>;
  wipeConfigs: () => Promise<void>;
  secretsListFull: () => Promise<Array<{ id: string; detailed_description: string; first_factor: string; first_factor_type: string; value: string }>>;
  secretsSet: (args: {
    detailed_description: string;
    first_factor: string;
    first_factor_type: string;
    value: string;
    force?: boolean;
  }) => Promise<string>;
  secretsDelete: (id: string) => Promise<void>;
  agentConfigList: () => Promise<Array<{ id: string; detailed_description: string; value: string }>>;
  agentConfigSet: (args: { detailed_description: string; value: string; force?: boolean }) => Promise<string>;
  agentConfigDelete: (id: string) => Promise<void>;
  recipeView: () => Promise<void>;
  recipeSave: () => Promise<string | null>;
  recipeLoad: () => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  agentSendMessage: (message: string, history?: { role: "user" | "assistant"; content: string }[]) => Promise<string>;
  agentAbort: () => Promise<void>;
  agentInjectMessage: (message: string) => Promise<void>;
  onAgentStreamChunk: (callback: (chunk: string) => void) => () => void;
  vmList: () => Promise<VmInfo[]>;
  vmCreate: (options?: { guestType?: string; isoPath?: string; ipswPath?: string }) => Promise<{ ok: boolean; vm?: VmInfo; error?: string }>;
  vmCheckIpsw: (ipswPath: string) => Promise<{ ok: boolean; supported?: boolean; error?: string }>;
  vmInstallProgress: (vmId: string) => Promise<{ ok: boolean; fractionCompleted?: number; phase?: string }>;
  showOpenDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  selectCustomScreenshot: () => Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
  vmStart: (vmId: string) => Promise<{ ok: boolean; error?: string }>;
  vmStop: (vmId: string) => Promise<{ ok: boolean; error?: string }>;
  vmDelete: (vmId: string) => Promise<{ ok: boolean; error?: string }>;
  vmShowConsole: (vmId: string) => Promise<{ ok: boolean; error?: string }>;
  vmScreenshot: (vmId: string) => Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
  vmTestOcr: (vmId: string, imageBase64?: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  vmTestOcrOverlay: (vmId: string, imageBase64?: string) => Promise<{ ok: boolean; text?: string; pngBase64?: string; error?: string }>;
  vmSetOverlay: (
    vmId: string,
    overlay: { centers: Array<{ x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number; kind?: string }>; imgW: number; imgH: number } | null
  ) => Promise<{ ok: boolean; error?: string }>;
  vmTestOcrVision: (vmId: string, options?: { freshView?: boolean; imageBase64?: string }) => Promise<{ ok: boolean; text?: string; pngBase64?: string; error?: string }>;
  vmTestOcrOmniParser: (vmId: string, options?: { confidenceThreshold?: number; iouThreshold?: number; imageBase64?: string }) => Promise<{ ok: boolean; text?: string; pngBase64?: string; error?: string }>;
  vmIconCaptions: (images: string[]) => Promise<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }>;
  vmIconCaptionsHolo: (images: string[]) => Promise<{ ok: boolean; captions?: { label: string; description: string }[]; error?: string }>;
  vmModelsStatus: () => Promise<{ ok: boolean; models?: Record<string, string>; isComplete?: boolean }>;
  vmType: (vmId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  vmPress: (vmId: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  vmClick: (vmId: string, x?: number, y?: number, element?: string) => Promise<{ ok: boolean; error?: string }>;
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
  ) => Promise<{ ok: boolean; error?: string }>;
  vmScroll: (
    vmId: string,
    opts: { scrollY: number; scrollX?: number; element?: string; x?: number; y?: number }
  ) => Promise<{ ok: boolean; error?: string }>;
  say: (text: string, rate?: number) => Promise<void>;
  onAskUserPopup: (callback: (info: { clarification: string; assessment: string; attempt: number }) => void) => () => void;
  onAskUserPopupClose: (callback: () => void) => () => void;
  onTaskStart: (callback: (info: { summary: string }) => void) => () => void;
  onFinalizeTaskPopup: (callback: (info: { assessment: string; clarification: string; is_successful: boolean }) => void) => () => void;
  onIconModelProgress: (
    callback: (p: {
      phase: string;
      fractionCompleted?: number;
      bytesReceived?: number;
      bytesTotal?: number;
      speedMBps?: number;
    }) => void
  ) => () => void;
  onLocalizationModelProgress: (
    callback: (p: {
      phase: string;
      fractionCompleted?: number;
      bytesReceived?: number;
      bytesTotal?: number;
      speedMBps?: number;
    }) => void
  ) => () => void;
  onHypervisorStartProgress: (
    callback: (p: { phase: "starting" | "ready" | "failed"; message?: string }) => void
  ) => () => void;
  onAiStartProgress: (
    callback: (p: { phase: "starting" | "ready" | "failed"; message?: string }) => void
  ) => () => void;
  chatgptAuthorize: () => Promise<{ ok: boolean; error?: string }>;
  chatgptAuthStatus: () => Promise<{ authorized: boolean }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
  interface VmInfo {
    id: string;
    name: string;
    path: string;
    status: "running" | "stopped" | "installing";
    ramMb: number;
    diskGb: number;
    guestType?: string;
  }
}

export { };
