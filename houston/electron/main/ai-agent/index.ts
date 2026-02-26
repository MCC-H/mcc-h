import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, "../../SYSTEM_PROMPT.md");

function loadSystemPrompt(): string {
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trim();
  } catch (err) {
    console.error("[Houston Agent] Failed to load SYSTEM_PROMPT.md:", err);
    return "You control a remote Debian computer via MCP tools. Ask the user what they would like you to do.";
  }
}

function mcpToolToAnthropic(tool: { name: string; description?: string; inputSchema?: unknown }) {
  const schema = (tool.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] }) ?? {
    type: "object",
    properties: {},
    required: [],
  };
  const properties = schema.properties ?? {};
  const propKeys = new Set(Object.keys(properties));
  const required = (schema.required ?? []).filter((k) => propKeys.has(k));
  return {
    name: tool.name,
    description: tool.description ?? `Tool: ${tool.name}`,
    input_schema: {
      type: "object" as const,
      properties,
      required,
    },
  } as const;
}

function formatToolCallDisplay(name: string, args: Record<string, unknown>, excludeClarification = false, excludeAssessment = false): string {
  if (!args || Object.keys(args).length === 0) return `${name}()`;
  const clarification = excludeClarification ? null : args.clarification;
  const rest = Object.fromEntries(
    Object.entries(args).filter(([k]) => k !== "clarification" && (!excludeAssessment || k !== "assessment"))
  );
  const restParts = Object.entries(rest).map(([k, v]) => {
    const s = typeof v === "string" ? (v.length > 40 ? `"${v.slice(0, 37)}..."` : JSON.stringify(v)) : String(v);
    return `${k}=${s}`;
  });
  const main = restParts.length > 0 ? `${name}(${restParts.join(", ")})` : `${name}()`;
  if (typeof clarification === "string" && clarification.trim()) {
    return `${main}\n\n**Clarification:** ${clarification.trim()}`;
  }
  return main;
}

function formatToolResultPreview(result: string, maxLen = 80): string {
  const t = result?.trim() || "(no output)";
  return t.length <= maxLen ? t : t.slice(0, maxLen - 3) + "...";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MSG_START = "<<<MSG>>>";
const MSG_END = "<<<END>>>";

function emitStructured(emitChunk: (chunk: string) => void, payload: Record<string, unknown>): void {
  emitChunk(MSG_START + JSON.stringify(payload) + MSG_END);
}

/** Emit assessment and clarification before tool runs; show "tool running" indicator. */
function emitToolBlockStart(toolName: string, args: Record<string, unknown>, emitChunk: (chunk: string) => void): void {
  const assessment = typeof args?.assessment === "string" ? args.assessment.trim() : "";
  const clarification = typeof args?.clarification === "string" ? args.clarification.trim() : "";
  if (assessment) emitStructured(emitChunk, { type: "assessment", content: assessment });
  if (clarification) emitStructured(emitChunk, { type: "clarification", content: clarification });
  const waitSec = typeof args?.wait_seconds === "number" ? args.wait_seconds : undefined;
  emitStructured(emitChunk, { type: "tool_running", name: toolName, wait_seconds: waitSec });
}

/** Pretty-print JSON for display if content contains JSON. */
function prettyPrintForDisplay(text: string): string {
  const trimmed = text?.trim() || "";
  if (!trimmed) return "(no output)";
  // Try to extract and pretty-print JSON (content may have trailing text, e.g. take_snapshot hint)
  const open = trimmed.indexOf("{");
  const openArr = trimmed.indexOf("[");
  const useObject = open >= 0 && (openArr < 0 || open < openArr);
  const start = useObject ? open : openArr;
  if (start >= 0) {
    const closeChar = useObject ? "}" : "]";
    let depth = 0;
    let end = -1;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === (useObject ? "{" : "[")) depth++;
      else if (c === closeChar) {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) {
      try {
        const jsonStr = trimmed.slice(start, end + 1);
        const parsed = JSON.parse(jsonStr);
        const pretty = JSON.stringify(parsed, null, 2);
        const after = trimmed.slice(end + 1).trim();
        return after ? pretty + "\n\n" + after : pretty;
      } catch {
        /* not valid JSON */
      }
    }
  }
  return trimmed;
}

/** Emit tool result after tool completes. */
function emitToolBlockResult(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  emitChunk: (chunk: string) => void
): void {
  const callDisplay = formatToolCallDisplay(toolName, args, true, true);
  const displayText = prettyPrintForDisplay(resultText);
  const escaped = escapeHtml(displayText);
  const accordionHtml = `<details class="tool-result-debug"><summary>Full result: ${escapeHtml(callDisplay)}</summary><pre>${escaped}</pre></details>`;
  const waitSec = typeof args?.wait_seconds === "number" ? args.wait_seconds : undefined;
  emitStructured(emitChunk, { type: "tool_call", name: toolName, accordion: accordionHtml, wait_seconds: waitSec });
}

function isScreenshotTool(name: string): boolean {
  return name === "take_snapshot";
}

let pendingInjectMessage: string | null = null;

export function setPendingInjectMessage(msg: string): void {
  pendingInjectMessage = msg?.trim() || null;
}

function getAndClearPendingInjectMessage(): string | null {
  const msg = pendingInjectMessage;
  pendingInjectMessage = null;
  return msg;
}

function maybeInjectUserMessage(
  resultText: string,
  toolName: string,
  emitChunk?: (chunk: string) => void
): string {
  const injected = getAndClearPendingInjectMessage();
  if (!injected) return resultText;
  if (emitChunk) emitStructured(emitChunk, { type: "user_injected", content: injected });
  return resultText + "\n\n[User message during reply]: " + injected;
}

function mcpToolResultToText(callResult: unknown): string {
  const r = callResult as { content?: unknown; toolResult?: unknown };
  const content = r?.content ?? r?.toolResult ?? [];
  return (Array.isArray(content) ? content : [])
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n") || "(no output)";
}

type JsonSchema = Record<string, unknown>;

/** Resolve $ref (e.g. #/definitions/Root) to actual schema from root. */
function resolveRef(ref: string, root: JsonSchema): unknown {
  const path = ref.replace(/^#\//, "").split("/").filter(Boolean);
  let cur: unknown = root;
  for (const seg of path) {
    cur = (cur as Record<string, unknown>)?.[seg];
  }
  return cur;
}

/** Recursively sanitize schema for Gemini: filter required to match properties, strip properties/required from non-objects, inline $ref. */
function sanitizeSchemaForGemini(obj: unknown, root?: JsonSchema): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeSchemaForGemini(v, root));

  const o = obj as JsonSchema;
  const defsKey = o.$defs ? "$defs" : "definitions";
  const schemaRoot = root ?? o;

  if (o.$ref && typeof o.$ref === "string") {
    const resolved = resolveRef(o.$ref, schemaRoot);
    if (resolved && typeof resolved === "object") {
      return sanitizeSchemaForGemini(resolved, schemaRoot);
    }
  }

  const result: JsonSchema = {};
  const type = o.type as string | string[] | undefined;
  const isObject = type === "object" || (Array.isArray(type) && type.includes("object"));

  for (const [key, value] of Object.entries(o)) {
    if (key === "$ref") continue;
    if (key === "$defs" || key === "definitions") {
      result[key] = Object.fromEntries(
        Object.entries((value as Record<string, unknown>) ?? {}).map(([k, v]) => [
          k,
          sanitizeSchemaForGemini(v, schemaRoot),
        ])
      );
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          sanitizeSchemaForGemini(v, schemaRoot),
        ])
      );
      continue;
    }
    if (key === "required") {
      result[key] = value;
      continue;
    }
    if (key === "items") {
      result[key] = sanitizeSchemaForGemini(value, schemaRoot);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGemini(value, schemaRoot);
      continue;
    }
    result[key] = value;
  }

  if (isObject && result.properties && Array.isArray(result.required)) {
    const props = result.properties as Record<string, unknown>;
    const propKeys = new Set(Object.keys(props));
    result.required = (result.required as unknown[]).filter((k): k is string =>
      typeof k === "string" && propKeys.has(k)
    );
  }

  if (!isObject) {
    delete result.properties;
    delete result.required;
  }

  return result;
}

function mcpToolToOpenAI(tool: { name: string; description?: string; inputSchema?: unknown }) {
  const raw = (tool.inputSchema as JsonSchema) ?? {};
  const schema = sanitizeSchemaForGemini(raw) as JsonSchema;
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description ?? `Tool: ${tool.name}`,
      parameters: {
        type: schema.type ?? "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    },
  };
}

export type AiProvider = "claude" | "openrouter" | "chatgpt" | "custom";

export interface AgentConfig {
  mcpPort: number;
  aiProvider: AiProvider;
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  chatgptModel?: string;
  customControlApiUrl?: string;
  customControlApiKey?: string;
  customControlModel?: string;
}

let mcpClient: Client | null = null;
let mcpTransport: SSEClientTransport | null = null;
let agentConfig: AgentConfig | null = null;

let agentAbortRequested = false;

export function requestAgentAbort(): void {
  agentAbortRequested = true;
}

export async function startAgent(config: AgentConfig): Promise<void> {
  if (config.aiProvider === "claude" && !config.claudeApiKey?.trim()) {
    throw new Error("Claude API key is required");
  }
  if (config.aiProvider === "openrouter" && !config.openrouterApiKey?.trim()) {
    throw new Error("OpenRouter API key is required");
  }
  if (config.aiProvider === "custom") {
    if (!config.customControlApiUrl?.trim()) throw new Error("Custom API URL is required");
    if (!config.customControlApiKey?.trim()) throw new Error("Custom API key is required");
    if (!config.customControlModel?.trim()) throw new Error("Custom model is required");
  }
  if (config.aiProvider === "chatgpt") {
    const { getValidChatGPTTokens } = await import("../chatgpt-oauth.js");
    const tokens = await getValidChatGPTTokens();
    if (!tokens) {
      throw new Error("ChatGPT not authorized. Click 'Authorize with ChatGPT' first.");
    }
  }

  agentConfig = config;
  if (config.aiProvider === "claude") {
    setClaudeApiKey(config.claudeApiKey);
  }

  const sseUrl = new URL(`http://localhost:${config.mcpPort}/sse`);
  mcpTransport = new SSEClientTransport(sseUrl);
  mcpClient = new Client({ name: "houston-agent", version: "1.0.0" });
  await mcpClient.connect(mcpTransport);

  console.log("[Houston Agent] Connected to MCP server");
}

export function stopAgent(): void {
  if (mcpTransport) {
    mcpTransport.close();
    mcpTransport = null;
  }
  mcpClient = null;
  agentConfig = null;
}

export type StreamChunkCallback = (chunk: string) => void;

export type HistoryMessage = { role: "user" | "assistant"; content: string };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

type OpenAIMessage =
  | { role: "user" | "assistant" | "system"; content: string }
  | { role: "assistant"; content: null; tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string };

async function runOpenRouterSendMessage(
  mcpTools: { name: string; description?: string; inputSchema?: unknown }[],
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = []
): Promise<{ text: string }> {
  const apiKey = agentConfig!.openrouterApiKey.trim();
  const openAITools = mcpTools.map(mcpToolToOpenAI);
  if (agentConfig!.openrouterModel?.includes("gemini")) {
    openAITools.forEach((t, i) => {
      const params = t.function.parameters as JsonSchema;
      const propKeys = new Set(Object.keys(params.properties ?? {}));
      const required = (params.required ?? []) as string[];
      const invalid = required.filter((k) => !propKeys.has(k));
      if (invalid.length > 0) {
        console.warn(`[Houston Agent] Tool ${i} ${t.function.name}: required has keys not in properties:`, invalid);
      }
    });
  }

  const messages: OpenAIMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content } as OpenAIMessage)),
    { role: "user" as const, content: userMessage },
  ];

  const streaming = onChunk != null;
  const emitChunk = (chunk: string) => {
    if (chunk && onChunk) onChunk(chunk);
  };

  const RETRYABLE_FINISH_REASONS = new Set(["error", "length", "content_filter", "unknown"]);
  let errorRetries = 0;
  const MAX_ERROR_RETRIES = 2;
  let finalizeTaskCalled = false;
  let hasExecutedActionTool = false;

  while (true) {
    if (agentAbortRequested) {
      return { text: "Stopped by user." };
    }

    const body = {
      model: agentConfig!.openrouterModel || "google/gemini-2.5-flash",
      messages: [{ role: "system", content: loadSystemPrompt() }, ...messages],
      tools: openAITools,
      tool_choice: "auto",
      max_tokens: 8192,
      stream: streaming,
      reasoning: { enabled: true, max_tokens: 8192 },
      provider: { sort: "throughput" },
    };

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Houston Agent] OpenRouter error:", res.status, errText);
      throw new Error(errText || `OpenRouter API error ${res.status}`);
    }

    if (onChunk && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      const toolCallsAcc: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
      let finishReason: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (delta.content) {
              fullContent += delta.content;
              emitChunk(delta.content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAcc[idx]) {
                  toolCallsAcc[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          } catch {
            /* skip */
          }
        }
      }

      if (finishReason !== "tool_calls" || toolCallsAcc.length === 0) {
        const reason = finishReason ?? "unknown";
        const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && errorRetries < MAX_ERROR_RETRIES;
        const canRetry = (RETRYABLE_FINISH_REASONS.has(reason) || missingFinalize) && errorRetries < MAX_ERROR_RETRIES;
        if (canRetry) {
          errorRetries++;
          if (missingFinalize && !RETRYABLE_FINISH_REASONS.has(reason)) {
            console.warn(`[Houston Agent] finalize_task not called, prompting model (${errorRetries}/${MAX_ERROR_RETRIES})...`);
            messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
          } else {
            console.warn(`[Houston Agent] OpenRouter finish_reason=${reason}, retrying (${errorRetries}/${MAX_ERROR_RETRIES})...`);
            if (missingFinalize) {
              messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
            } else if (RETRYABLE_FINISH_REASONS.has(reason) || !fullContent.trim()) {
              messages.push({ role: "user" as const, content: "[System: Please continue.]" });
            }
          }
          continue;
        }
        const text = fullContent.trim() || `I'm not sure how to respond. [finishReason: ${reason}]`;
        return { text };
      }

      const choice = {
        content: fullContent,
        tool_calls: toolCallsAcc.filter((tc) => tc?.id).map((tc) => ({ id: tc.id, type: "function" as const, function: tc.function })),
      };
      if (streaming) emitStructured(emitChunk, { type: "content_end" });
      console.log("[Houston Agent] OpenRouter tool calls:", choice.tool_calls.map((t: { function: { name: string } }) => t.function.name).join(", "));
      const toolResults: OpenAIMessage[] = [];
      for (const tc of choice.tool_calls) {
        if (tc.function.name === "finalize_task") finalizeTaskCalled = true;
        else hasExecutedActionTool = true;
        const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        if (streaming) emitToolBlockStart(tc.function.name, args, emitChunk);
        let resultText: string;
        try {
          const callResult = await mcpClient!.callTool({ name: tc.function.name, arguments: args });
          resultText = mcpToolResultToText(callResult);
        } catch (err) {
          resultText = err instanceof Error ? err.message : String(err);
        }
        resultText = maybeInjectUserMessage(resultText, tc.function.name, streaming ? emitChunk : undefined);
        if (streaming) emitToolBlockResult(tc.function.name, args, resultText, emitChunk);
        toolResults.push({ role: "tool", content: resultText, tool_call_id: tc.id });
      }
      messages.push({ role: "assistant", content: null, tool_calls: choice.tool_calls });
      messages.push(...toolResults);
      errorRetries = 0;
      continue;
    }

    const data = await res.json();

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      throw new Error("OpenRouter returned no choices");
    }

    if (!choice.tool_calls?.length) {
      const finishReason = data.choices?.[0]?.finish_reason ?? "unknown";
      const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && errorRetries < MAX_ERROR_RETRIES;
      const canRetry = (RETRYABLE_FINISH_REASONS.has(finishReason) || missingFinalize) && errorRetries < MAX_ERROR_RETRIES;
      if (canRetry) {
        errorRetries++;
        if (missingFinalize && !RETRYABLE_FINISH_REASONS.has(finishReason)) {
          console.warn(`[Houston Agent] finalize_task not called, prompting model (${errorRetries}/${MAX_ERROR_RETRIES})...`);
          messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
        } else {
          console.warn(`[Houston Agent] OpenRouter finish_reason=${finishReason}, retrying (${errorRetries}/${MAX_ERROR_RETRIES})...`);
          const contentStr = typeof choice.content === "string" ? choice.content : "";
          if (missingFinalize) {
            messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
          } else if (RETRYABLE_FINISH_REASONS.has(finishReason) || !contentStr.trim()) {
            messages.push({ role: "user" as const, content: "[System: Please continue.]" });
          }
        }
        continue;
      }
      const injected = getAndClearPendingInjectMessage();
      if (injected) {
        const text = choice.content ?? "";
        messages.push({ role: "assistant" as const, content: typeof text === "string" ? text : String(text ?? "") });
        messages.push({ role: "user" as const, content: "[User message during reply]: " + injected });
        if (onChunk) emitStructured(emitChunk, { type: "user_injected", content: injected });
        continue;
      }
      const text = choice.content ?? `I'm not sure how to respond. [finishReason: ${finishReason}]`;
      if (onChunk) emitChunk(text);
      return { text };
    }

    if (streaming) emitStructured(emitChunk, { type: "content_end" });
    console.log("[Houston Agent] OpenRouter tool calls:", choice.tool_calls.map((t: { function: { name: string } }) => t.function.name).join(", "));
    const toolResults: OpenAIMessage[] = [];
    for (const tc of choice.tool_calls) {
      if (tc.function.name === "finalize_task") finalizeTaskCalled = true;
      else hasExecutedActionTool = true;
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      if (streaming) emitToolBlockStart(tc.function.name, args, emitChunk);
      let resultText: string;
      try {
        const callResult = await mcpClient!.callTool({ name: tc.function.name, arguments: args });
        resultText = mcpToolResultToText(callResult);
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
      }
      resultText = maybeInjectUserMessage(resultText, tc.function.name, streaming ? emitChunk : undefined);
      if (streaming) emitToolBlockResult(tc.function.name, args, resultText, emitChunk);
      toolResults.push({ role: "tool", content: resultText, tool_call_id: tc.id });
    }
    messages.push({ role: "assistant", content: null, tool_calls: choice.tool_calls });
    messages.push(...toolResults);
    errorRetries = 0;
  }
}

/** Resolve custom API URL: append /v1/chat/completions if not present. */
function resolveCustomApiUrl(base: string): string {
  const u = base.trim().replace(/\/$/, "");
  return u.includes("/v1/chat") ? u : `${u}/v1/chat/completions`;
}

async function runCustomOpenAISendMessage(
  mcpTools: { name: string; description?: string; inputSchema?: unknown }[],
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = []
): Promise<{ text: string }> {
  const apiUrl = resolveCustomApiUrl(agentConfig!.customControlApiUrl!);
  const apiKey = agentConfig!.customControlApiKey!.trim();
  const model = agentConfig!.customControlModel!.trim();
  const openAITools = mcpTools.map(mcpToolToOpenAI);

  const messages: OpenAIMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content } as OpenAIMessage)),
    { role: "user" as const, content: userMessage },
  ];

  const streaming = onChunk != null;
  const emitChunk = (chunk: string) => {
    if (chunk && onChunk) onChunk(chunk);
  };

  const RETRYABLE_FINISH_REASONS = new Set(["error", "length", "content_filter", "unknown"]);
  let errorRetries = 0;
  const MAX_ERROR_RETRIES = 2;
  let finalizeTaskCalled = false;
  let hasExecutedActionTool = false;

  while (true) {
    if (agentAbortRequested) {
      return { text: "Stopped by user." };
    }

    const body = {
      model,
      messages: [{ role: "system", content: loadSystemPrompt() }, ...messages],
      tools: openAITools,
      tool_choice: "auto",
      max_tokens: 8192,
      stream: streaming,
    };

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Houston Agent] Custom API error:", res.status, errText);
      throw new Error(errText || `Custom API error ${res.status}`);
    }

    if (onChunk && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      const toolCallsAcc: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
      let finishReason: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (delta.content) {
              fullContent += delta.content;
              emitChunk(delta.content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAcc[idx]) {
                  toolCallsAcc[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          } catch {
            /* skip */
          }
        }
      }

      if (finishReason !== "tool_calls" || toolCallsAcc.length === 0) {
        const reason = finishReason ?? "unknown";
        const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && errorRetries < MAX_ERROR_RETRIES;
        const canRetry = (RETRYABLE_FINISH_REASONS.has(reason) || missingFinalize) && errorRetries < MAX_ERROR_RETRIES;
        if (canRetry) {
          errorRetries++;
          if (missingFinalize && !RETRYABLE_FINISH_REASONS.has(reason)) {
            messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
          } else if (RETRYABLE_FINISH_REASONS.has(reason) || !fullContent.trim()) {
            messages.push({ role: "user" as const, content: "[System: Please continue.]" });
          }
          continue;
        }
        return { text: fullContent.trim() || `I'm not sure how to respond. [finishReason: ${reason}]` };
      }

      const choice = {
        content: fullContent,
        tool_calls: toolCallsAcc.filter((tc) => tc?.id).map((tc) => ({ id: tc.id, type: "function" as const, function: tc.function })),
      };
      if (streaming) emitStructured(emitChunk, { type: "content_end" });
      const toolResults: OpenAIMessage[] = [];
      for (const tc of choice.tool_calls) {
        if (tc.function.name === "finalize_task") finalizeTaskCalled = true;
        else hasExecutedActionTool = true;
        const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        if (streaming) emitToolBlockStart(tc.function.name, args, emitChunk);
        let resultText: string;
        try {
          const callResult = await mcpClient!.callTool({ name: tc.function.name, arguments: args });
          resultText = mcpToolResultToText(callResult);
        } catch (err) {
          resultText = err instanceof Error ? err.message : String(err);
        }
        resultText = maybeInjectUserMessage(resultText, tc.function.name, streaming ? emitChunk : undefined);
        if (streaming) emitToolBlockResult(tc.function.name, args, resultText, emitChunk);
        toolResults.push({ role: "tool", content: resultText, tool_call_id: tc.id });
      }
      messages.push({ role: "assistant", content: null, tool_calls: choice.tool_calls });
      messages.push(...toolResults);
      errorRetries = 0;
      continue;
    }

    const data = await res.json();
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error("Custom API returned no choices");

    if (!choice.tool_calls?.length) {
      const finishReason = data.choices?.[0]?.finish_reason ?? "unknown";
      const contentStr = typeof choice.content === "string" ? choice.content : "";
      const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && errorRetries < MAX_ERROR_RETRIES;
      const canRetry = (RETRYABLE_FINISH_REASONS.has(finishReason) || missingFinalize) && errorRetries < MAX_ERROR_RETRIES;
      if (canRetry) {
        errorRetries++;
        if (missingFinalize) {
          messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
        } else if (RETRYABLE_FINISH_REASONS.has(finishReason) || !contentStr.trim()) {
          messages.push({ role: "user" as const, content: "[System: Please continue.]" });
        }
        continue;
      }
      return { text: contentStr || `I'm not sure how to respond. [finishReason: ${finishReason}]` };
    }

    if (streaming) emitStructured(emitChunk, { type: "content_end" });
    const toolResults: OpenAIMessage[] = [];
    for (const tc of choice.tool_calls) {
      if (tc.function.name === "finalize_task") finalizeTaskCalled = true;
      else hasExecutedActionTool = true;
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      if (streaming) emitToolBlockStart(tc.function.name, args, emitChunk);
      let resultText: string;
      try {
        const callResult = await mcpClient!.callTool({ name: tc.function.name, arguments: args });
        resultText = mcpToolResultToText(callResult);
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
      }
      resultText = maybeInjectUserMessage(resultText, tc.function.name, streaming ? emitChunk : undefined);
      if (streaming) emitToolBlockResult(tc.function.name, args, resultText, emitChunk);
      toolResults.push({ role: "tool", content: resultText, tool_call_id: tc.id });
    }
    messages.push({ role: "assistant", content: null, tool_calls: choice.tool_calls });
    messages.push(...toolResults);
    errorRetries = 0;
  }
}

function mcpToolToCodexFunction(tool: { name: string; description?: string; inputSchema?: unknown }) {
  const raw = (tool.inputSchema as JsonSchema) ?? {};
  const schema = sanitizeSchemaForGemini(raw) as JsonSchema;
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description ?? `Tool: ${tool.name}`,
    parameters: {
      type: schema.type ?? "object",
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    },
  };
}

async function runChatGPTSendMessage(
  mcpTools: { name: string; description?: string; inputSchema?: unknown }[],
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = []
): Promise<{ text: string }> {
  const { getValidChatGPTTokens } = await import("../chatgpt-oauth.js");
  let tokens = await getValidChatGPTTokens();
  if (!tokens) {
    throw new Error("ChatGPT not authorized. Click 'Authorize with ChatGPT' and restart.");
  }

  const codexTools = mcpTools.map(mcpToolToCodexFunction);
  const model = agentConfig!.chatgptModel ?? "gpt-5.1-codex";

  const inputItems: Array<{ type: string; role: string; content: unknown }> = [];
  for (const h of history) {
    inputItems.push({
      type: "message",
      role: h.role,
      content: [{ type: "input_text", text: h.content }],
    });
  }
  inputItems.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: userMessage }],
  });

  const streaming = onChunk != null;
  const emitChunk = (chunk: string) => {
    if (chunk && onChunk) onChunk(chunk);
  };

  let finalizeTaskCalled = false;
  let hasExecutedActionTool = false;
  let errorRetries = 0;
  const MAX_ERROR_RETRIES = 2;

  type CodexMessage = { role: "user" | "assistant"; content: string } | { role: "assistant"; content: null; tool_calls: { id: string; name: string; arguments: string }[] } | { role: "user"; content: string };
  const messages: CodexMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content } as CodexMessage)),
    { role: "user" as const, content: userMessage },
  ];

  while (true) {
    if (agentAbortRequested) {
      return { text: "Stopped by user." };
    }

    tokens = await getValidChatGPTTokens();
    if (!tokens) throw new Error("ChatGPT token expired. Re-authorize and restart.");

    const currentInput: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < messages.length; idx++) {
      const m = messages[idx];
      if (m.role === "user" && "content" in m && typeof m.content === "string") {
        const prev = messages[idx - 1];
        if (prev?.role === "assistant" && "tool_calls" in prev && prev.tool_calls?.length) {
          for (let j = 0; j < prev.tool_calls.length; j++) {
            const resultMsg = messages[idx + j] as { role: string; content?: string } | undefined;
            const output = resultMsg?.role === "user" && typeof resultMsg?.content === "string" ? resultMsg.content : "";
            currentInput.push({
              type: "function_call_output",
              call_id: prev.tool_calls[j].id,
              output,
            });
          }
          idx += prev.tool_calls.length - 1;
          continue;
        }
        currentInput.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
      } else if (m.role === "assistant" && "content" in m && m.content !== null) {
        currentInput.push({ type: "message", role: "assistant", content: [{ type: "input_text", text: m.content }] });
      } else if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
        for (const tc of m.tool_calls) {
          currentInput.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments });
        }
      }
    }

    const inputToUse = currentInput.length > 0 ? currentInput : inputItems;

    const body = {
      model,
      store: false,
      stream: true,
      instructions: loadSystemPrompt(),
      input: inputToUse,
      tools: codexTools,
      tool_choice: "auto",
      reasoning: { effort: "medium" as const, summary: "auto" as const },
      text: { verbosity: "medium" as const },
      include: ["reasoning.encrypted_content"],
    };

    const res = await fetch(CHATGPT_CODEX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access}`,
        "chatgpt-account-id": tokens.accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Houston Agent] ChatGPT Codex error:", res.status, errText);
      if (res.status === 401 && tokens.refresh) {
        const refreshed = await import("../chatgpt-oauth.js").then((m) => m.refreshChatGPTToken());
        if (refreshed) continue;
      }
      throw new Error(errText || `ChatGPT API error ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    const toolCallsAcc: { id: string; name: string; arguments: string }[] = [];
    let doneResponse: {
      output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
      output_items?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
    } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            fullContent += parsed.delta;
            emitChunk(parsed.delta);
          }
          if (parsed.type === "response.done" || parsed.type === "response.completed") {
            doneResponse = parsed.response ?? null;
          }
        } catch {
          /* skip */
        }
      }
    }

    const outputItems = (doneResponse?.output ?? doneResponse?.output_items ?? []) as Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    const functionCalls = outputItems.filter((o) => o.type === "function_call");
    const hasToolCalls = functionCalls.length > 0;

    if (!hasToolCalls) {
      const injected = getAndClearPendingInjectMessage();
      if (injected) {
        messages.push({ role: "assistant", content: fullContent });
        messages.push({ role: "user", content: "[User message during reply]: " + injected });
        if (onChunk) emitStructured(emitChunk, { type: "user_injected", content: injected });
        continue;
      }
      const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && errorRetries < MAX_ERROR_RETRIES;
      if (missingFinalize) {
        errorRetries++;
        messages.push({ role: "user", content: "[System: You must call finalize_task to complete the task. Call it now.]" });
        continue;
      }
      const text = fullContent.trim() || "I'm not sure how to respond.";
      return { text };
    }

    if (streaming) emitStructured(emitChunk, { type: "content_end" });

    const toolCalls = functionCalls.map((fc) => ({
      id: fc.call_id ?? `fc_${Math.random().toString(36).slice(2)}`,
      name: fc.name ?? "",
      arguments: fc.arguments ?? "{}",
    }));

    console.log("[Houston Agent] ChatGPT tool calls:", toolCalls.map((t) => t.name).join(", "));

    const toolResults: CodexMessage[] = [];
    for (const tc of toolCalls) {
      if (tc.name === "finalize_task") finalizeTaskCalled = true;
      else hasExecutedActionTool = true;
      const args = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
      if (streaming) emitToolBlockStart(tc.name, args, emitChunk);
      let resultText: string;
      try {
        const callResult = await mcpClient!.callTool({ name: tc.name, arguments: args });
        resultText = mcpToolResultToText(callResult);
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
      }
      resultText = maybeInjectUserMessage(resultText, tc.name, streaming ? emitChunk : undefined);
      if (streaming) emitToolBlockResult(tc.name, args, resultText, emitChunk);
      toolResults.push({ role: "user", content: resultText });
    }

    messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
    messages.push(...toolResults);
    errorRetries = 0;
  }
}

export async function sendMessage(
  userMessage: string,
  onChunk?: StreamChunkCallback,
  history: HistoryMessage[] = []
): Promise<{ text: string }> {
  console.log("[Houston Agent] sendMessage called, length:", userMessage.length, "history:", history.length, "streaming:", !!onChunk);
  pendingInjectMessage = null;
  agentAbortRequested = false;

  if (!mcpClient || !mcpTransport || !agentConfig) {
    const msg = "Agent not started. Add API key and restart to enable.";
    console.error("[Houston Agent]", msg);
    throw new Error(msg);
  }

  console.log("[Houston Agent] Listing MCP tools...");
  const { tools: mcpTools } = await mcpClient.listTools();
  console.log("[Houston Agent] Got", mcpTools.length, "tools:", mcpTools.map((t) => t.name).join(", "));

  if (agentConfig.aiProvider === "openrouter") {
    return runOpenRouterSendMessage(mcpTools, userMessage, onChunk, history);
  }
  if (agentConfig.aiProvider === "custom") {
    return runCustomOpenAISendMessage(mcpTools, userMessage, onChunk, history);
  }
  if (agentConfig.aiProvider === "chatgpt") {
    return runChatGPTSendMessage(mcpTools, userMessage, onChunk, history);
  }

  const anthropicTools = mcpTools.map(mcpToolToAnthropic);
  const apiKey = (globalThis as { __houstonClaudeApiKey?: string }).__houstonClaudeApiKey;
  if (!apiKey) {
    const msg = "Claude API key not set. Restart with a valid API key.";
    console.error("[Houston Agent]", msg);
    throw new Error(msg);
  }

  const client = new Anthropic({ apiKey });

  type Message = Anthropic.MessageParam;
  const messages: Message[] = [
    ...history.map((h) => ({ role: h.role, content: h.content } as Message)),
    { role: "user", content: userMessage },
  ];

  const emitChunk = (chunk: string) => {
    if (chunk && onChunk) onChunk(chunk);
  };

  let finalizeTaskCalled = false;
  let hasExecutedActionTool = false;
  let finalizeRetries = 0;
  const MAX_FINALIZE_RETRIES = 2;

  while (true) {
    if (agentAbortRequested) {
      console.log("[Houston Agent] Abort requested by user");
      return { text: "Stopped by user." };
    }
    console.log("[Houston Agent] Claude API call, messages:", messages.length);

    if (onChunk) {
      const stream = client.messages.stream({
        model: agentConfig!.claudeModel || "claude-sonnet-4-6",
        max_tokens: 8192,
        system: loadSystemPrompt(),
        messages,
        tools: anthropicTools,
        tool_choice: { type: "auto" },
      });

      let fullText = "";
      try {
        stream.on("text", (delta: string, snapshot: string) => {
          fullText = snapshot;
          emitChunk(delta);
        });
        const response = await stream.finalMessage();
        console.log("[Houston Agent] Stream done, stop_reason:", response.stop_reason);
        if (response.stop_reason === "end_turn") {
          const injected = getAndClearPendingInjectMessage();
          if (injected) {
            messages.push({ role: "assistant" as const, content: response.content });
            messages.push({ role: "user" as const, content: "[User message during reply]: " + injected });
            emitStructured(emitChunk, { type: "user_injected", content: injected });
            continue;
          }
          const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && finalizeRetries < MAX_FINALIZE_RETRIES;
          if (missingFinalize) {
            finalizeRetries++;
            console.warn(`[Houston Agent] finalize_task not called, prompting model (${finalizeRetries}/${MAX_FINALIZE_RETRIES})...`);
            messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
            continue;
          }
          const textBlock = response.content.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
          const fallback = `I'm not sure how to respond. [finishReason: ${response.stop_reason}]`;
          return { text: textBlock?.text ?? fullText ?? fallback };
        }

        const toolUseBlocks = response.content.filter((b) => (b as { type?: string }).type === "tool_use") as { type: "tool_use"; id: string; name: string; input: unknown }[];
        if (toolUseBlocks.length === 0) {
          const injected = getAndClearPendingInjectMessage();
          if (injected) {
            messages.push({ role: "assistant" as const, content: response.content });
            messages.push({ role: "user" as const, content: "[User message during reply]: " + injected });
            emitStructured(emitChunk, { type: "user_injected", content: injected });
            continue;
          }
          const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && finalizeRetries < MAX_FINALIZE_RETRIES;
          if (missingFinalize) {
            finalizeRetries++;
            console.warn(`[Houston Agent] finalize_task not called (no tool_use), prompting model (${finalizeRetries}/${MAX_FINALIZE_RETRIES})...`);
            messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
            continue;
          }
          return { text: fullText || `I'm not sure how to respond. Please try again. [finishReason: ${response.stop_reason}]` };
        }

        emitStructured(emitChunk, { type: "content_end" });
        const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
        for (const toolUse of toolUseBlocks) {
          if (toolUse.name === "finalize_task") finalizeTaskCalled = true;
          else hasExecutedActionTool = true;
          const args = (toolUse.input as Record<string, unknown>) ?? {};
          emitToolBlockStart(toolUse.name, args, emitChunk);
          let resultText: string;
          try {
            const callResult = await mcpClient!.callTool({
              name: toolUse.name,
              arguments: args,
            });
            resultText = mcpToolResultToText(callResult);
          } catch (err) {
            resultText = err instanceof Error ? err.message : String(err);
            console.error("[Houston Agent] Tool", toolUse.name, "error:", resultText);
          }
          resultText = maybeInjectUserMessage(resultText, toolUse.name, emitChunk);
          emitToolBlockResult(toolUse.name, args, resultText, emitChunk);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
        }

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        finalizeRetries = 0;
        continue;
      } catch (apiErr) {
        const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        const status = typeof apiErr === "object" && apiErr !== null && "status" in apiErr ? (apiErr as { status?: number }).status : undefined;
        console.error("[Houston Agent] Claude API error:", msg, "status:", status);
        if (status === 529 || msg.includes("529")) {
          throw new Error("Claude API overloaded (529). Please try again in a moment.");
        }
        throw apiErr;
      }
    }

    let response;
    try {
      response = await client.messages.create({
        model: agentConfig!.claudeModel || "claude-sonnet-4-6",
        max_tokens: 8192,
        system: loadSystemPrompt(),
        messages,
        tools: anthropicTools,
        tool_choice: { type: "auto" },
      });
    } catch (apiErr) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      const status = typeof apiErr === "object" && apiErr !== null && "status" in apiErr ? (apiErr as { status?: number }).status : undefined;
      console.error("[Houston Agent] Claude API error:", msg, "status:", status);
      if (status === 529 || msg.includes("529")) {
        throw new Error("Claude API overloaded (529). Please try again in a moment.");
      }
      throw apiErr;
    }

    console.log("[Houston Agent] Claude response, stop_reason:", response.stop_reason, "content blocks:", response.content.length);

    if (response.stop_reason === "end_turn") {
      const injected = getAndClearPendingInjectMessage();
      if (injected) {
        messages.push({ role: "assistant" as const, content: response.content });
        messages.push({ role: "user" as const, content: "[User message during reply]: " + injected });
        emitStructured(emitChunk, { type: "user_injected", content: injected });
        continue;
      }
      const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && finalizeRetries < MAX_FINALIZE_RETRIES;
      if (missingFinalize) {
        finalizeRetries++;
        console.warn(`[Houston Agent] finalize_task not called, prompting model (${finalizeRetries}/${MAX_FINALIZE_RETRIES})...`);
        messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
        continue;
      }
      const textBlock = response.content.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
      const fallback = `I'm not sure how to respond. [finishReason: ${response.stop_reason}]`;
      return { text: textBlock?.text ?? fallback };
    }

    const toolUseBlocks = response.content.filter((b) => (b as { type?: string }).type === "tool_use") as { type: "tool_use"; id: string; name: string; input: unknown }[];
    if (toolUseBlocks.length === 0) {
      const injected = getAndClearPendingInjectMessage();
      if (injected) {
        messages.push({ role: "assistant" as const, content: response.content });
        messages.push({ role: "user" as const, content: "[User message during reply]: " + injected });
        emitStructured(emitChunk, { type: "user_injected", content: injected });
        continue;
      }
      const missingFinalize = hasExecutedActionTool && !finalizeTaskCalled && finalizeRetries < MAX_FINALIZE_RETRIES;
      if (missingFinalize) {
        finalizeRetries++;
        console.warn(`[Houston Agent] finalize_task not called (no tool_use), prompting model (${finalizeRetries}/${MAX_FINALIZE_RETRIES})...`);
        messages.push({ role: "user" as const, content: "[System: You must call finalize_task to complete the task. Call it now.]" });
        continue;
      }
      console.warn("[Houston Agent] No tool_use blocks in response");
      return { text: `I'm not sure how to respond. Please try again. [finishReason: ${response.stop_reason}]` };
    }

    console.log("[Houston Agent] Executing", toolUseBlocks.length, "tool(s):", toolUseBlocks.map((t) => t.name).join(", "));

    if (onChunk) emitStructured(emitChunk, { type: "content_end" });
    const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === "finalize_task") finalizeTaskCalled = true;
      else hasExecutedActionTool = true;
      const args = (toolUse.input as Record<string, unknown>) ?? {};
      if (onChunk) emitToolBlockStart(toolUse.name, args, emitChunk);
      let resultText: string;
      try {
        console.log("[Houston Agent] Calling MCP tool:", toolUse.name);
        const callResult = await mcpClient!.callTool({
          name: toolUse.name,
          arguments: args,
        });
        resultText = mcpToolResultToText(callResult);
        console.log("[Houston Agent] Tool", toolUse.name, "result length:", resultText.length);
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err);
        console.error("[Houston Agent] Tool", toolUse.name, "error:", resultText);
      }
      resultText = maybeInjectUserMessage(resultText, toolUse.name, onChunk ? emitChunk : undefined);
      if (onChunk) emitToolBlockResult(toolUse.name, args, resultText, emitChunk);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
    }

    finalizeRetries = 0;
    messages.push({
      role: "assistant",
      content: response.content,
    });
    messages.push({
      role: "user",
      content: toolResults,
    });
  }
}

export function setClaudeApiKey(key: string): void {
  (globalThis as { __houstonClaudeApiKey?: string }).__houstonClaudeApiKey = key;
}
