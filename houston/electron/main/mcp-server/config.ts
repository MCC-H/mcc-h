export interface AskUserPopupInfo {
  clarification: string;
  assessment: string;
  attempt: number;
}

export interface FinalizeTaskPopupInfo {
  assessment: string;
  clarification: string;
  is_successful: boolean;
}

export interface McpServerConfig {
  vmId: string;
  mcpPort: number;
  guestType?: string;
  openrouterApiKey?: string;
  /** VL observation model ID (e.g. qwen/qwen3-vl-8b-instruct). Used when vlApiUrl is empty (OpenRouter) or with custom server. */
  vlModel?: string;
  /** Custom OpenAI-compatible API URL for VL. When set, uses this instead of OpenRouter. */
  vlApiUrl?: string;
  /** API key for VL. Required when vlApiUrl is set; when using OpenRouter, falls back to openrouterApiKey. */
  vlApiKey?: string;
  /** URL of bundled vision model (Qwen3-VL-2B) for element localization. When set, mouse_click(element) uses it to resolve coordinates. */
  localizationApiUrl?: string;
  onAskUserRequest?: (info: AskUserPopupInfo) => void;
  onAskUserTimeout?: () => void;
  onStartTask?: (info: { summary: string }) => void;
  onFinalizeTask?: (info: FinalizeTaskPopupInfo) => void;
}
