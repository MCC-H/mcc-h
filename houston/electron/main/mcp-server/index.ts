import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { startSession, sendToSession, closeSession } from "./remote.js";
import { runOCR, parseOcrToOverlay } from "./ocr.js";
import { localizeElement, primeHoloCache, getCachedHoloImage } from "./localization.js";
import type { McpServerConfig, AskUserPopupInfo } from "./config.js";
import { screenshotVm, typeVm, pressVm, clickVm, moveVm, moveVmDragging, mouseDownVm, mouseUpVm, scrollVm, startVm, stopVm, setOverlayVm, VM_POWERED_OFF_MSG } from "../vm-manager.js";
import { waitForUserReply } from "../ask-user-bridge.js";
import {
  secretsList,
  secretsGet,
  secretsSet,
  secretsDelete,
} from "../secrets-store.js";
import {
  agentConfigList,
  agentConfigSet,
  agentConfigDelete,
} from "../agent-config-store.js";
import * as recipeStore from "../recipe-store.js";
import { renderScreenshotWithOcrBoxes, renderTerminalToImage } from "../recipe-render.js";
import { timed, logSummary } from "./timing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "../../../skills");

const CLARIFICATION_PARAM = z
  .string()
  .optional()
  .describe("Why you are using this tool and what outcome you expect. Always provide this.");

const ASSESSMENT_PARAM = z
  .string()
  .describe("Assessment of previous tool call result or user instructions. Mandatory: on first call assess user request; on subsequent calls assess last tool result.");

const WAIT_SECONDS_PARAM = z
  .number()
  .optional()
  .describe("Seconds to wait after the action for results to appear (optional, max 30).");

const WAIT_SECONDS_MANDATORY_PARAM = z
  .number()
  .default(1)
  .describe("Seconds to wait after the action before taking the snapshot. Default 1, max 30. Prefer this over using wait tool separately.");

function toolResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function logClarification(toolName: string, args: unknown) {
  const a = args as Record<string, unknown> | undefined;
  const c = a?.clarification;
  if (typeof c === "string" && c.trim()) {
    console.log(`[Houston MCP] Tool ${toolName} clarification:`, c.trim());
  }
}

function logAssessment(toolName: string, args: unknown) {
  const a = args as Record<string, unknown> | undefined;
  const v = a?.assessment;
  if (typeof v === "string" && v.trim()) {
    console.log(`[Houston MCP] Tool ${toolName} assessment:`, v.trim());
  }
}

/**
 * Validates that only documented parameters were passed. Returns an error message if unknown params
 * are present. Use suggestedHint when params suggest a different tool (e.g. x,y on take_snapshot -> mouse_click).
 */
function validateUnknownParams(
  toolName: string,
  args: unknown,
  allowedKeys: Set<string>,
  suggestedHint?: string
): string | null {
  const a = args as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  const unknown = Object.keys(a).filter((k) => !allowedKeys.has(k));
  if (unknown.length === 0) return null;
  return `${toolName} does not accept: ${unknown.join(", ")}.${suggestedHint ? ` ${suggestedHint}` : ""}`;
}

/** Unescape \\n, \\t, \\r, \\\\ in text for keyboard_type. */
function unescapeKeyboardText(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

/** Map escape sequences and single chars to key names for keyboard_type. Handles "ctrl+\\n" etc. */
function resolveKey(key: string): string {
  const parts = key.split("+").map((p) => p.trim());
  const last = parts[parts.length - 1] ?? "";
  const resolve = (k: string): string => {
    if (k === "\n" || k === "\\n") return "Return";
    if (k === "\t" || k === "\\t") return "Tab";
    if (k === "\r" || k === "\\r") return "Return";
    if (k === "\b" || k === "\\b") return "Backspace";
    if (k === "\\") return "backslash";
    return k;
  };
  const resolved = resolve(last);
  if (parts.length > 1) {
    return [...parts.slice(0, -1), resolved].join("+");
  }
  return resolved;
}

const ESCAPE_KEY_STRINGS = new Set(["\n", "\t", "\r", "\b", "\\n", "\\t", "\\r", "\\b"]);

/** Known key names (VM accepts these). Case-insensitive. */
const KNOWN_KEY_NAMES = new Set([
  "return", "enter", "tab", "escape", "esc", "space", "spacebar",
  "backspace", "backspace2", "delete", "del",
  "up", "down", "left", "right", "home", "end",
  "page_up", "pageup", "page_down", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "minus", "equal", "bracketleft", "bracketright", "backslash",
  "semicolon", "apostrophe", "comma", "period", "slash", "grave",
]);

/** True if item should be sent as key press (pressVm), false if as literal text (typeVm). */
function isKeyPress(item: string): boolean {
  const t = item.trim();
  if (ESCAPE_KEY_STRINGS.has(t)) return true;
  if (t.includes("+")) return true; // key combo: ctrl+a, alt+Tab
  if (KNOWN_KEY_NAMES.has(t.toLowerCase())) return true;
  return false;
}

/** Trim only spaces; preserve \\t, \\n, \\r, \\b (they are valid keys — trimming \\t would drop Tab). */
function trimKeyItem(s: string): string {
  return s.replace(/^ +| +$/g, "");
}

/** Parse sequence array into items. Each element: literal text, escape sequence, or key name. */
function parseSequence(seq: unknown): string[] {
  if (!Array.isArray(seq)) return [];
  return seq.map((k) => trimKeyItem(String(k ?? ""))).filter((s) => s.length > 0);
}

const MAX_WAIT_SECONDS = 30;

async function applyWaitSeconds(args: unknown): Promise<void> {
  const a = args as Record<string, unknown> | undefined;
  const s = a?.wait_seconds;
  if (typeof s === "number" && s > 0) {
    const capped = Math.min(s, MAX_WAIT_SECONDS);
    await new Promise((r) => setTimeout(r, capped * 1000));
  }
}

function getLocalScreenshotPath(): string {
  return join(tmpdir(), `mcp_screenshot_${randomUUID()}.png`);
}

/** Mutex to serialize screenshot requests; prevents concurrent HoustonVM /screenshot/ calls. */
let screenshotMutex = Promise.resolve<void>(undefined);

function isVmPoweredOffError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("powered off") || msg.includes("not running");
}

function createMcpServer(config: McpServerConfig) {
  async function takeScreenshotImpl(): Promise<{ localPath: string; base64: string }> {
    if (!config.vmId) {
      throw new Error("Computer is not powered on. Select a Houston VM in config.");
    }
    const prev = screenshotMutex;
    let resolve: () => void = () => {};
    screenshotMutex = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await timed("screenshot", async () => {
        const result = await screenshotVm(config.vmId);
        if (!result.ok || !result.pngBase64) {
          throw new Error(result.error ?? "Screenshot failed");
        }
        const localPath = getLocalScreenshotPath();
        const buf = Buffer.from(result.pngBase64, "base64");
        writeFileSync(localPath, buf);
        return { localPath, base64: result.pngBase64 };
      });
    } finally {
      resolve();
    }
  }
  const server = new McpServer(
    { name: "mcp-remote-desktop", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  let lastScreenshotBase64: string | null = null;

  type SnapshotResult = { content: { type: "text"; text: string }[]; recipeExtra?: { screenshotBase64: string; vision?: string; click?: { x: number; y: number; element?: string } } };

  function withClickPrefix(text: string, x: number, y: number, element?: string): string {
    const clickLine = element ? `click: [${x}, ${y}] (element: "${element}")\n\n` : `click: [${x}, ${y}]\n\n`;
    return clickLine + text;
  }

  function withScrollPrefix(text: string, x: number, y: number, element?: string): string {
    const line = element ? `scroll: [${x}, ${y}] (element: "${element}")\n\n` : `scroll: [${x}, ${y}]\n\n`;
    return line + text;
  }

  /** Take a fresh snapshot after an action and return OCR result. Used by mouse/keyboard tools. */
  async function takeSnapshotAfterAction(args: unknown, clickAt?: { x: number; y: number }): Promise<SnapshotResult> {
    if (!config.vmId) {
      return toolResult("Computer is not powered on. Select a Houston VM in config.");
    }
    const a = args as Record<string, unknown> | undefined;
    const s = a?.wait_seconds;
    const waitSec = Math.min(typeof s === "number" ? s : 1, MAX_WAIT_SECONDS);
    if (waitSec > 0) await new Promise((r) => setTimeout(r, waitSec * 1000));
    let localPath: string;
    try {
      const shot = await takeScreenshotImpl();
      localPath = shot.localPath;
    } catch (err) {
      if (isVmPoweredOffError(err)) return toolResult(VM_POWERED_OFF_MSG);
      throw err;
    }
    lastScreenshotBase64 = readFileSync(localPath).toString("base64");
    if (config.localizationApiUrl) {
      primeHoloCache(localPath, { baseUrl: config.localizationApiUrl });
    }
    const ocrText = await timed("ocr", () => runOCR(config, localPath));
    const overlay = parseOcrToOverlay(ocrText);
    if (overlay) await timed("overlay", () => setOverlayVm(config.vmId, overlay));
    let base64: string;
    try {
      const rendered = await timed("render", () =>
        renderScreenshotWithOcrBoxes(localPath, ocrText, { clickAt })
      );
      base64 = rendered.base64;
    } catch {
      base64 = readFileSync(localPath).toString("base64");
    }
    let vision: string | undefined;
    try {
      const ocrJson = JSON.parse(ocrText) as { vision_description?: string };
      vision = ocrJson.vision_description;
    } catch {
      /* ignore */
    }
    return { ...toolResult(ocrText), recipeExtra: { screenshotBase64: base64, vision } };
  }

  const TAKE_SNAPSHOT_KEYS = new Set(["assessment", "clarification", "wait_seconds", "fresh_view"]);

  server.registerTool(
    "take_snapshot",
    {
      description: "Capture screen and return OCR layout (image size, checkboxes, radio_buttons, ui_elements, texts, vision_description). Use first to understand the current state. fresh_view=true returns full annotation; false/default returns changes vs previous screenshot.",
      inputSchema: {
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_PARAM,
        fresh_view: z.boolean().optional().describe("When true, return full annotation (fresh view). When false/default, return changes vs previous screenshot."),
      },
    },
    async (args) => {
      const a = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "take_snapshot",
        args,
        TAKE_SNAPSHOT_KEYS,
        a?.x != null || a?.y != null || a?.element != null
          ? "Did you mean mouse_click? take_snapshot only captures the screen; it does not click. Use mouse_click(element=\"...\") or mouse_click(x=..., y=..., wait_seconds=...) to interact."
          : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("take_snapshot", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { fresh_view: freshView } = args as { fresh_view?: boolean };
      console.log("[Houston MCP] Tool take_snapshot called", config.vmId ? `(VM ${config.vmId})` : "(no VM)", "fresh_view:", freshView);
      logClarification("take_snapshot", args);
      logAssessment("take_snapshot", args);
      let localPath: string;
      try {
        const shot = await takeScreenshotImpl();
        localPath = shot.localPath;
      } catch (err) {
        if (isVmPoweredOffError(err)) {
          recipeStore.appendToolCall("take_snapshot", args, VM_POWERED_OFF_MSG);
          return toolResult(VM_POWERED_OFF_MSG);
        }
        throw err;
      }
      lastScreenshotBase64 = readFileSync(localPath).toString("base64");
      if (config.localizationApiUrl) {
        primeHoloCache(localPath, { baseUrl: config.localizationApiUrl });
      }
      const ocrText = await timed("ocr", () => runOCR(config, localPath, { freshView: freshView === true }));
      const overlay = parseOcrToOverlay(ocrText);
      if (overlay) await timed("overlay", () => setOverlayVm(config.vmId, overlay));
      await applyWaitSeconds(args);
      const resultText = ocrText + "\n\nIf you see checkboxes, click on them, not on labels. If the click on any element didn't work, try clicking around it.";
      let base64: string;
      try {
        const rendered = await timed("render", () => renderScreenshotWithOcrBoxes(localPath, ocrText));
        base64 = rendered.base64;
      } catch (renderErr) {
        console.warn("[Houston MCP] Recipe render failed, using raw screenshot:", renderErr instanceof Error ? renderErr.message : renderErr);
        base64 = readFileSync(localPath).toString("base64");
      }
      let vision: string | undefined;
      try {
        const ocrJson = JSON.parse(ocrText) as { vision_description?: string };
        vision = ocrJson.vision_description;
      } catch {
        /* ignore */
      }
      recipeStore.appendToolCall("take_snapshot", args, resultText, { screenshotBase64: base64, vision });
      console.log("[Houston MCP] Tool take_snapshot done");
      logSummary();
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "power_on",
    {
      description: "Power on the selected Houston VM. Waits for boot, then returns snapshot (OCR layout) like take_snapshot. Use wait_seconds to allow OS to boot (default 10, max 30).",
      inputSchema: {
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: z.number().optional().default(10).describe("Seconds to wait for VM to boot before taking snapshot (default 10, max 30)."),
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "power_on",
        args,
        new Set(["assessment", "clarification", "wait_seconds"]),
        pa?.x != null || pa?.y != null || pa?.element != null
          ? "Did you mean mouse_click? power_on only boots the VM and returns a snapshot. Use mouse_click(element=\"...\") or mouse_click(x=..., y=...) to interact."
          : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("power_on", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      console.log("[Houston MCP] Tool power_on called", config.vmId ? `(VM ${config.vmId})` : "(no VM)");
      logClarification("power_on", args);
      logAssessment("power_on", args);
      if (!config.vmId) {
        return toolResult("Computer is not powered on. Select a Houston VM in config.");
      }
      const r = await startVm(config.vmId);
      if (!r.ok) throw new Error(r.error ?? "Failed to power on VM");
      const a = args as Record<string, unknown> | undefined;
      const waitSec = Math.min(typeof a?.wait_seconds === "number" ? a.wait_seconds : 10, MAX_WAIT_SECONDS);
      if (waitSec > 0) await new Promise((res) => setTimeout(res, waitSec * 1000));
      let localPath: string;
      try {
        const shot = await takeScreenshotImpl();
        localPath = shot.localPath;
      } catch (err) {
        if (isVmPoweredOffError(err)) {
          recipeStore.appendToolCall("power_on", args, VM_POWERED_OFF_MSG);
          return toolResult(VM_POWERED_OFF_MSG);
        }
        throw err;
      }
      lastScreenshotBase64 = readFileSync(localPath).toString("base64");
      const ocrText = await timed("ocr", () => runOCR(config, localPath, { freshView: true }));
      const overlay = parseOcrToOverlay(ocrText);
      if (overlay) await timed("overlay", () => setOverlayVm(config.vmId, overlay));
      let base64: string;
      try {
        const rendered = await timed("render", () => renderScreenshotWithOcrBoxes(localPath, ocrText));
        base64 = rendered.base64;
      } catch {
        base64 = readFileSync(localPath).toString("base64");
      }
      let vision: string | undefined;
      try {
        const ocrJson = JSON.parse(ocrText) as { vision_description?: string };
        vision = ocrJson.vision_description;
      } catch {
        /* ignore */
      }
      recipeStore.appendToolCall("power_on", args, ocrText, { screenshotBase64: base64, vision });
      console.log("[Houston MCP] Tool power_on done");
      logSummary();
      return toolResult(ocrText);
    }
  );

  server.registerTool(
    "power_off",
    {
      description: "Power off the selected Houston VM. force=false (default): graceful ACPI shutdown. force=true: immediate stop.",
      inputSchema: {
        force: z.boolean().optional().default(false).describe("If true, force stop immediately. If false, graceful ACPI shutdown (default)."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      },
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("power_off", args, new Set(["assessment", "clarification", "force"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("power_off", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { force } = args as { force?: boolean };
      console.log("[Houston MCP] Tool power_off called", config.vmId ? `(VM ${config.vmId}, force=${force})` : "(no VM)");
      logClarification("power_off", args);
      logAssessment("power_off", args);
      if (!config.vmId) {
        return toolResult("No VM selected. Select a Houston VM in config.");
      }
      const r = await stopVm(config.vmId, force);
      if (!r.ok) throw new Error(r.error ?? "Failed to power off VM");
      const resultText = "VM powered off.";
      recipeStore.appendToolCall("power_off", args, resultText);
      console.log("[Houston MCP] Tool power_off done");
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "mouse_move",
    {
      description: "Move mouse to coordinates. Returns new snapshot after wait. wait_seconds mandatory, default 1.",
      inputSchema: {
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "mouse_move",
        args,
        new Set(["x", "y", "assessment", "clarification", "wait_seconds"]),
        pa?.element != null ? "mouse_move requires x,y coordinates. Did you mean mouse_click(element=\"...\") for element-based targeting?" : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("mouse_move", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { x, y } = args as { x: number; y: number };
      console.log("[Houston MCP] Tool mouse_move called", { x, y });
      logClarification("mouse_move", args);
      logAssessment("mouse_move", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("mouse_move", args, t);
        return toolResult(t);
      }
      const r = await moveVm(config.vmId, x, y);
      if (!r.ok) throw new Error(r.error);
      const result = await takeSnapshotAfterAction(args, { x, y });
      const resultText = result.content?.[0]?.text ?? "";
      recipeStore.appendToolCall("mouse_move", args, resultText, result.recipeExtra);
      console.log("[Houston MCP] Tool mouse_move done");
      return result;
    }
  );

  server.registerTool(
    "mouse_click",
    {
      description:
        "Single click. Prefer element (human-like): e.g. 'Submit button', 'search input field', 'OK button'. Falls back to x,y when element-based fails. Returns new snapshot after wait. When element is used, result includes 'click: [x, y] (element: \"...\")' before the OCR layout so you know where it clicked. wait_seconds mandatory, default 1.",
      inputSchema: {
        element: z
          .string()
          .optional()
          .describe(
            "Human-like description of element to click, e.g. 'Submit button', 'search input field', 'checkbox next to Remember me'. Preferred over x,y when localization is available."
          ),
        x: z.number().optional().describe("X coordinate (optional; use element instead when possible)"),
        y: z.number().optional().describe("Y coordinate (optional; use element instead when possible)"),
        button: z.number().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "mouse_click",
        args,
        new Set(["element", "x", "y", "button", "assessment", "clarification", "wait_seconds"]),
        pa?.sequence != null
          ? "For typing keys use keyboard_type(sequence=[\"\\n\"], ...). mouse_click is for clicking."
          : pa?.fresh_view != null
            ? "fresh_view is for take_snapshot. mouse_click returns a snapshot after the click."
            : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("mouse_click", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { element, x, y, button = 1 } = args as { element?: string; x?: number; y?: number; button?: number };
      console.log("[Houston MCP] Tool mouse_click called", { element, x, y, button });
      logClarification("mouse_click", args);
      logAssessment("mouse_click", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("mouse_click", args, t);
        return toolResult(t);
      }
      let clickX = x;
      let clickY = y;
      if (element && (clickX == null || clickY == null) && config.localizationApiUrl) {
        const hasCache = !!getCachedHoloImage();
        let localPath: string | null = null;
        if (!hasCache) {
          try {
            localPath = (await takeScreenshotImpl()).localPath;
          } catch (err) {
            if (isVmPoweredOffError(err)) {
              recipeStore.appendToolCall("mouse_click", args, VM_POWERED_OFF_MSG);
              return toolResult(VM_POWERED_OFF_MSG);
            }
            throw err;
          }
        }
        const coords = await timed("localize", () =>
          localizeElement(localPath, element, { baseUrl: config.localizationApiUrl! })
        );
        if (coords) {
          clickX = coords.x;
          clickY = coords.y;
          console.log("[Houston MCP] Localized", element, "->", clickX, clickY);
        } else {
          recipeStore.appendToolCall("mouse_click", args, `Could not localize element: "${element}". Use x,y coordinates.`);
          return toolResult(`Could not localize element: "${element}". Use x,y coordinates from take_snapshot.`);
        }
      }
      if (clickX == null || clickY == null) {
        const hasSequence = (args as Record<string, unknown>).sequence != null;
        const t = hasSequence
          ? "Wrong tool. For key sequences (Enter, Tab, etc.) use keyboard_type. Correct: keyboard_type(sequence=[\"\\n\"], assessment=\"...\", clarification=\"...\", wait_seconds=1). For clicking use mouse_click(element=\"Submit button\") or mouse_click(x=100, y=200)."
          : "mouse_click requires element or x,y. Correct: mouse_click(element=\"Submit button\", assessment=\"...\", clarification=\"...\", wait_seconds=1) or mouse_click(x=100, y=200, assessment=\"...\", clarification=\"...\", wait_seconds=1). For typing keys use keyboard_type(sequence=[\"\\n\"], ...).";
        recipeStore.appendToolCall("mouse_click", args, t);
        return toolResult(t);
      }
      const r = await timed("click", () => clickVm(config.vmId, clickX, clickY));
      if (!r.ok) throw new Error(r.error);
      const clickAt = { x: clickX, y: clickY };
      const result = await takeSnapshotAfterAction(args, clickAt);
      let resultText = result.content?.[0]?.text ?? "";
      const usedElement = element && (x == null || y == null);
      if (usedElement) {
        resultText = withClickPrefix(resultText, clickX, clickY, element);
      }
      const recipeExtra = result.recipeExtra ? { ...result.recipeExtra, click: usedElement ? { x: clickX, y: clickY, element } : undefined } : undefined;
      recipeStore.appendToolCall("mouse_click", args, resultText, recipeExtra);
      console.log("[Houston MCP] Tool mouse_click done");
      logSummary();
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "mouse_double_click",
    {
      description:
        "Double-click. Prefer element (e.g. 'File Explorer icon') or use x,y. Returns new snapshot after wait. When element is used, result includes 'click: [x, y] (element: \"...\")' before the OCR layout. wait_seconds mandatory, default 1.",
      inputSchema: {
        element: z
          .string()
          .optional()
          .describe("Human-like description of element to double-click, e.g. 'File Explorer icon', 'document icon'"),
        x: z.number().optional(),
        y: z.number().optional(),
        delay_ms: z.number().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "mouse_double_click",
        args,
        new Set(["element", "x", "y", "delay_ms", "assessment", "clarification", "wait_seconds"]),
        pa?.sequence != null ? "For typing keys use keyboard_type(sequence=[\"\\n\"], ...). mouse_double_click is for double-clicking." : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("mouse_double_click", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { element, x, y } = args as { element?: string; x?: number; y?: number };
      console.log("[Houston MCP] Tool mouse_double_click called", { element, x, y });
      logClarification("mouse_double_click", args);
      logAssessment("mouse_double_click", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("mouse_double_click", args, t);
        return toolResult(t);
      }
      let clickX = x;
      let clickY = y;
      if (element && (clickX == null || clickY == null) && config.localizationApiUrl) {
        const hasCache = !!getCachedHoloImage();
        let localPath: string | null = null;
        if (!hasCache) {
          try {
            localPath = (await takeScreenshotImpl()).localPath;
          } catch (err) {
            if (isVmPoweredOffError(err)) {
              recipeStore.appendToolCall("mouse_double_click", args, VM_POWERED_OFF_MSG);
              return toolResult(VM_POWERED_OFF_MSG);
            }
            throw err;
          }
        }
        const coords = await timed("localize", () =>
          localizeElement(localPath, element, { baseUrl: config.localizationApiUrl! })
        );
        if (coords) {
          clickX = coords.x;
          clickY = coords.y;
        } else {
          recipeStore.appendToolCall("mouse_double_click", args, `Could not localize element: "${element}". Use x,y.`);
          return toolResult(`Could not localize element: "${element}". Use x,y coordinates.`);
        }
      }
      if (clickX == null || clickY == null) {
        const hasSequence = (args as Record<string, unknown>).sequence != null;
        const t = hasSequence
          ? "Wrong tool. For key sequences use keyboard_type(sequence=[\"\\n\"], ...). For double-click use mouse_double_click(element=\"File Explorer icon\") or mouse_double_click(x=100, y=200)."
          : "mouse_double_click requires element or x,y. Correct: mouse_double_click(element=\"File Explorer icon\", ...) or mouse_double_click(x=100, y=200, ...).";
        recipeStore.appendToolCall("mouse_double_click", args, t);
        return toolResult(t);
      }
      const r = await timed("click", () => clickVm(config.vmId, clickX, clickY, true));
      if (!r.ok) throw new Error(r.error);
      const result = await takeSnapshotAfterAction(args, { x: clickX, y: clickY });
      let resultText = result.content?.[0]?.text ?? "";
      const usedElement = element && (x == null || y == null);
      if (usedElement) {
        resultText = withClickPrefix(resultText, clickX, clickY, element);
      }
      const recipeExtra = result.recipeExtra ? { ...result.recipeExtra, click: usedElement ? { x: clickX, y: clickY, element } : undefined } : undefined;
      recipeStore.appendToolCall("mouse_double_click", args, resultText, recipeExtra);
      console.log("[Houston MCP] Tool mouse_double_click done");
      logSummary();
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "mouse_scroll",
    {
      description:
        "Scroll. scrollY/scrollX in wheel clicks: + = up/left, - = down/right. Use ~50 clicks for bigger scroll; up to 10 for precision. Use element (e.g. 'main content') or x,y to target scrollable area. Returns new snapshot with scroll center [x,y] where scrolling started. wait_seconds mandatory, default 1. Note: On some systems (e.g. macOS Natural scroll) scrolling may be reversed.",
      inputSchema: {
        scrollY: z.number().describe("Vertical scroll in wheel clicks: + = up, - = down. Use ~50 for bigger scroll, up to 10 for precision."),
        scrollX: z.number().optional().describe("Horizontal scroll in wheel clicks: + = left, - = right. Use ~50 for bigger scroll, up to 10 for precision."),
        element: z
          .string()
          .optional()
          .describe("Human-like description of scrollable area, e.g. 'main content', 'sidebar'"),
        x: z.number().optional(),
        y: z.number().optional(),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "mouse_scroll",
        args,
        new Set(["scrollY", "scrollX", "element", "x", "y", "assessment", "clarification", "wait_seconds"]),
        pa?.sequence != null ? "For typing keys use keyboard_type(sequence=[\"\\n\"], ...). mouse_scroll is for scrolling." : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("mouse_scroll", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { scrollY, scrollX, element, x, y } = args as {
        scrollY: number;
        scrollX?: number;
        element?: string;
        x?: number;
        y?: number;
      };
      console.log("[Houston MCP] Tool mouse_scroll called", { scrollY, scrollX, element, x, y });
      logClarification("mouse_scroll", args);
      logAssessment("mouse_scroll", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("mouse_scroll", args, t);
        return toolResult(t);
      }
      let targetX = x;
      let targetY = y;
      if (element && (targetX == null || targetY == null) && config.localizationApiUrl) {
        const hasCache = !!getCachedHoloImage();
        let localPath: string | null = null;
        if (!hasCache) {
          try {
            localPath = (await takeScreenshotImpl()).localPath;
          } catch (err) {
            if (isVmPoweredOffError(err)) {
              recipeStore.appendToolCall("mouse_scroll", args, VM_POWERED_OFF_MSG);
              return toolResult(VM_POWERED_OFF_MSG);
            }
            throw err;
          }
        }
        const coords = await timed("localize", () =>
          localizeElement(localPath, element, { baseUrl: config.localizationApiUrl! })
        );
        if (coords) {
          targetX = coords.x;
          targetY = coords.y;
        }
      }
      const r = await timed("scroll", () => scrollVm(config.vmId, scrollY, scrollX, targetX, targetY));
      if (!r.ok) throw new Error(r.error);
      const scrollAt = targetX != null && targetY != null ? { x: targetX, y: targetY } : undefined;
      const result = await takeSnapshotAfterAction(args, scrollAt);
      let resultText = result.content?.[0]?.text ?? "";
      if (scrollAt) {
        resultText = withScrollPrefix(resultText, scrollAt.x, scrollAt.y, element && (x == null || y == null) ? element : undefined);
      }
      const recipeExtra = result.recipeExtra ? { ...result.recipeExtra, click: scrollAt ? { x: scrollAt.x, y: scrollAt.y, element: element && (x == null || y == null) ? element : undefined } : undefined } : undefined;
      recipeStore.appendToolCall("mouse_scroll", args, resultText, recipeExtra);
      console.log("[Houston MCP] Tool mouse_scroll done");
      logSummary();
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "drag_n_drop",
    {
      description:
        "Drag from one point to another. Use from_element/to_element (human-like) or from_x,from_y,to_x,to_y. Coordinates take precedence over elements. Uses cached screenshot for localization when available. Returns new snapshot after wait. wait_seconds mandatory, default 1.",
      inputSchema: {
        from_element: z
          .string()
          .optional()
          .describe("Human-like description of drag source, e.g. 'file icon', 'list item'"),
        to_element: z
          .string()
          .optional()
          .describe("Human-like description of drop target, e.g. 'trash icon', 'folder'"),
        from_x: z.number().optional().describe("Source X (takes precedence over from_element)"),
        from_y: z.number().optional().describe("Source Y (takes precedence over from_element)"),
        to_x: z.number().optional().describe("Target X (takes precedence over to_element)"),
        to_y: z.number().optional().describe("Target Y (takes precedence over to_element)"),
        drop_time_ms: z
          .number()
          .optional()
          .default(300)
          .describe("Duration of drag in ms (default 300). Controls path interpolation speed."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "drag_n_drop",
        args,
        new Set(["from_element", "to_element", "from_x", "from_y", "to_x", "to_y", "drop_time_ms", "assessment", "clarification", "wait_seconds"]),
        pa?.x != null || pa?.y != null
          ? "Use from_x, from_y, to_x, to_y (or from_element, to_element). drag_n_drop needs source and target coordinates."
          : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("drag_n_drop", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const {
        from_element: fromElement,
        to_element: toElement,
        from_x: fromX,
        from_y: fromY,
        to_x: toX,
        to_y: toY,
        drop_time_ms: dropTimeMs = 300,
      } = args as {
        from_element?: string;
        to_element?: string;
        from_x?: number;
        from_y?: number;
        to_x?: number;
        to_y?: number;
        drop_time_ms?: number;
      };
      console.log("[Houston MCP] Tool drag_n_drop called", {
        fromElement,
        toElement,
        fromX,
        fromY,
        toX,
        toY,
        dropTimeMs,
      });
      logClarification("drag_n_drop", args);
      logAssessment("drag_n_drop", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("drag_n_drop", args, t);
        return toolResult(t);
      }
      let srcX = fromX;
      let srcY = fromY;
      let dstX = toX;
      let dstY = toY;
      if (config.localizationApiUrl) {
        const hasCache = !!getCachedHoloImage();
        let localPath: string | null = null;
        if (!hasCache) {
          try {
            localPath = (await takeScreenshotImpl()).localPath;
          } catch (err) {
            if (isVmPoweredOffError(err)) {
              recipeStore.appendToolCall("drag_n_drop", args, VM_POWERED_OFF_MSG);
              return toolResult(VM_POWERED_OFF_MSG);
            }
            throw err;
          }
        }
        if ((srcX == null || srcY == null) && fromElement) {
          const coords = await timed("localize", () =>
            localizeElement(localPath, fromElement, { baseUrl: config.localizationApiUrl! })
          );
          if (coords) {
            srcX = coords.x;
            srcY = coords.y;
            console.log("[Houston MCP] Localized from", fromElement, "->", srcX, srcY);
          }
        }
        if ((dstX == null || dstY == null) && toElement) {
          const coords = await timed("localize", () =>
            localizeElement(localPath, toElement, { baseUrl: config.localizationApiUrl! })
          );
          if (coords) {
            dstX = coords.x;
            dstY = coords.y;
            console.log("[Houston MCP] Localized to", toElement, "->", dstX, dstY);
          }
        }
      }
      if (srcX == null || srcY == null || dstX == null || dstY == null) {
        const t =
          "drag_n_drop requires (from_x, from_y) and (to_x, to_y), or from_element and to_element with localization. Prefer coordinates when both provided.";
        recipeStore.appendToolCall("drag_n_drop", args, t);
        return toolResult(t);
      }
      const steps = Math.max(2, Math.ceil(dropTimeMs / 20));
      const stepMs = dropTimeMs / steps;
      let r = await moveVm(config.vmId, srcX, srcY);
      if (!r.ok) throw new Error(r.error);
      r = await timed("mousedown", () => mouseDownVm(config.vmId, srcX, srcY));
      if (!r.ok) throw new Error(r.error);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = Math.round(srcX + (dstX - srcX) * t);
        const y = Math.round(srcY + (dstY - srcY) * t);
        r = await moveVmDragging(config.vmId, x, y);
        if (!r.ok) throw new Error(r.error);
        if (stepMs > 0) await new Promise((res) => setTimeout(res, stepMs));
      }
      r = await moveVmDragging(config.vmId, dstX, dstY);
      if (!r.ok) throw new Error(r.error);
      r = await timed("mouseup", () => mouseUpVm(config.vmId, dstX, dstY));
      if (!r.ok) throw new Error(r.error);
      const clickAt = { x: dstX, y: dstY };
      const result = await takeSnapshotAfterAction(args, clickAt);
      let resultText = result.content?.[0]?.text ?? "";
      const usedElements = fromElement && toElement && (fromX == null || fromY == null || toX == null || toY == null);
      if (usedElements) {
        resultText = `drag: [${srcX}, ${srcY}] -> [${dstX}, ${dstY}] (from: "${fromElement}", to: "${toElement}")\n\n` + resultText;
      }
      recipeStore.appendToolCall("drag_n_drop", args, resultText, result.recipeExtra);
      console.log("[Houston MCP] Tool drag_n_drop done");
      logSummary();
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "keyboard_type",
    {
      description:
        "Type text and/or press keys. sequence is a JSON array: literal text, escape sequences (\\n, \\t, \\r, \\b), or key combos (Return, Tab, Backspace, Down, ctrl+c, alt+Tab). Examples: [\"user\", \"\\t\", \"root\", \"\\n\"], [\"ctrl+a\", \"\\b\", \"hello\"]. Literal commas OK: [\"hello, world\"]. Returns new snapshot. wait_seconds mandatory, default 1.",
      inputSchema: {
        sequence: z
          .array(z.string())
          .describe(
            "Array of items. Each: literal text, escape sequence (\\n, \\t, \\r, \\b), or key (Return, Tab, Backspace, Down, ctrl+c, alt+Tab). Example: [\"user\", \"\\t\", \"root\", \"\\n\"] or [\"ctrl+a\", \"hello, world\"] — commas in literals are fine."
          ),
        delay: z.number().optional().default(100).describe("Delay in ms between items (default 100)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        wait_seconds: WAIT_SECONDS_MANDATORY_PARAM,
      },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "keyboard_type",
        args,
        new Set(["sequence", "delay", "assessment", "clarification", "wait_seconds"]),
        pa?.element != null || pa?.x != null || pa?.y != null
          ? "For clicking use mouse_click(element=\"...\") or mouse_click(x=..., y=...). keyboard_type is for typing."
          : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("keyboard_type", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { sequence: seq, delay: delayMs = 100 } = args as {
        sequence?: unknown;
        delay?: number;
      };
      const items = parseSequence(seq);
      console.log("[Houston MCP] Tool keyboard_type called, items:", JSON.stringify(items), "delay:", delayMs, "ms");
      logClarification("keyboard_type", args);
      logAssessment("keyboard_type", args);
      if (!config.vmId) {
        const t = "Computer is not powered on. Select a Houston VM in config.";
        recipeStore.appendToolCall("keyboard_type", args, t);
        return toolResult(t);
      }
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < items.length; i++) {
        const item = items[i] ?? "";
        const isEnterLike = item === "\r" || item === "\n" || item === "\\r" || item === "\\n";
        if (isEnterLike) {
          const char = "\n";
          const r = await typeVm(config.vmId, char);
          if (!r.ok) throw new Error(r.error);
        } else if (isKeyPress(item)) {
          const key = resolveKey(item);
          const r = await pressVm(config.vmId, key);
          if (!r.ok) throw new Error(r.error);
        } else {
          const text = unescapeKeyboardText(item);
          if (text) {
            const r = await typeVm(config.vmId, text);
            if (!r.ok) throw new Error(r.error);
          }
        }
        if (i < items.length - 1) await sleep(delayMs);
      }
      const result = await takeSnapshotAfterAction(args);
      const resultText = result.content?.[0]?.text ?? "";
      recipeStore.appendToolCall("keyboard_type", args, resultText, result.recipeExtra);
      console.log("[Houston MCP] Tool keyboard_type done, items:", JSON.stringify(items));
      logSummary();
      return result;
    }
  );

  server.registerTool(
    "start_ssh_session",
    {
      description: "Start an interactive SSH session (virtual terminal 80x24). Returns session_id and initial output. Prefer key if provided; at least one of key or password required. Use for: editing files, running scripts, installing packages, reading logs, file operations, wmctrl.",
      inputSchema: {
        host: z.string().describe("SSH host"),
        port: z.number().optional().default(22).describe("SSH port, default 22"),
        username: z.string().describe("SSH username"),
        privateKey: z.string().optional().describe("Private key (PEM) for auth. Prefer over password if provided."),
        password: z.string().optional().describe("Password for auth. Used if privateKey not provided."),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      },
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("start_ssh_session", args, new Set(["host", "port", "username", "privateKey", "password", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("start_ssh_session", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { host, port, username, privateKey, password } = args as {
        host?: string;
        port?: number;
        username?: string;
        privateKey?: string;
        password?: string;
      };
      console.log("[Houston MCP] Tool start_ssh_session called", { host, username });
      logClarification("start_ssh_session", args);
      logAssessment("start_ssh_session", args);
      const result = await startSession({
        host: host ?? "",
        port,
        username: username ?? "",
        privateKey,
        password,
      });
      const resultText = JSON.stringify(result);
      recipeStore.appendToolCall("start_ssh_session", args, resultText);
      console.log("[Houston MCP] Tool start_ssh_session done, session_id:", result.session_id);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "send_to_ssh_session",
    {
      description: "Send command to an SSH session. Returns last N lines (default 24) after waiting. Session is a virtual terminal 80x24. Use for wmctrl: maximize wmctrl -r 'TITLE' -b add,maximized_vert,maximized_horz; close wmctrl -c 'TITLE'.",
      inputSchema: {
        session_id: z.string().describe("Session ID from start_ssh_session"),
        command: z.string().describe("Command to send (e.g. ls, vim, wmctrl -r 'Title' -b add,maximized_vert,maximized_horz)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        history_limit: z.number().optional().default(24).describe("Number of output lines to return (default 24)"),
        wait_seconds: z.number().optional().default(1).describe("Seconds to wait after sending command (default 1, max 30)"),
      },
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("send_to_ssh_session", args, new Set(["session_id", "command", "assessment", "clarification", "history_limit", "wait_seconds"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("send_to_ssh_session", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { session_id, command, history_limit, wait_seconds } = args as {
        session_id?: string;
        command?: string;
        history_limit?: number;
        wait_seconds?: number;
      };
      console.log("[Houston MCP] Tool send_to_ssh_session called", { session_id, command });
      logClarification("send_to_ssh_session", args);
      logAssessment("send_to_ssh_session", args);
      const waitSec = Math.min(typeof wait_seconds === "number" ? wait_seconds : 1, MAX_WAIT_SECONDS);
      const output = await sendToSession(session_id ?? "", command ?? "", {
        history_limit: history_limit ?? 24,
        wait_seconds: waitSec,
      });
      const resultText = output || "(no output)";
      let terminalBase64: string | undefined;
      try {
        const { base64 } = await renderTerminalToImage(resultText);
        terminalBase64 = base64;
      } catch (err) {
        console.warn("[Houston MCP] Recipe terminal render failed:", err instanceof Error ? err.message : err);
      }
      recipeStore.appendToolCall("send_to_ssh_session", args, resultText, terminalBase64 ? { terminalBase64 } : undefined);
      console.log("[Houston MCP] Tool send_to_ssh_session done, output length:", output?.length ?? 0);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "close_ssh_session",
    {
      description: "Close an SSH session. Must be called by agent when done.",
      inputSchema: {
        session_id: z.string().describe("Session ID from start_ssh_session"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      },
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("close_ssh_session", args, new Set(["session_id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("close_ssh_session", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { session_id } = args as { session_id?: string };
      console.log("[Houston MCP] Tool close_ssh_session called", { session_id });
      logClarification("close_ssh_session", args);
      logAssessment("close_ssh_session", args);
      closeSession(session_id ?? "");
      const resultText = "Session closed.";
      recipeStore.appendToolCall("close_ssh_session", args, resultText);
      console.log("[Houston MCP] Tool close_ssh_session done");
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "wait",
    {
      description: "Pause between actions. Max 30 seconds. Prefer wait_seconds on action tools instead.",
      inputSchema: { seconds: z.number(), assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM },
    },
    async (args) => {
      const pa = args as Record<string, unknown>;
      const unknownMsg = validateUnknownParams(
        "wait",
        args,
        new Set(["seconds", "assessment", "clarification"]),
        pa?.wait_seconds != null
          ? "wait uses 'seconds' (not wait_seconds). Or prefer wait_seconds on action tools (mouse_click, keyboard_type, etc.) instead of separate wait."
          : undefined
      );
      if (unknownMsg) {
        recipeStore.appendToolCall("wait", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { seconds } = args as { seconds: number };
      const capped = Math.min(seconds, MAX_WAIT_SECONDS);
      console.log("[Houston MCP] Tool wait called, seconds:", seconds, capped !== seconds ? `(capped to ${capped})` : "");
      logClarification("wait", args);
      logAssessment("wait", args);
      await new Promise((r) => setTimeout(r, capped * 1000));
      const resultText = `Waited ${capped} seconds`;
      recipeStore.appendToolCall("wait", args, resultText);
      console.log("[Houston MCP] Tool wait done, waited", capped, "seconds");
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_list",
    {
      description: "List all secrets (agent-only storage). Returns JSON array of {id, detailed_description, first_factor, first_factor_type}.",
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("secrets_list", args, new Set(["assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      console.log("[Houston MCP] Tool secrets_list called");
      logClarification("secrets_list", args);
      logAssessment("secrets_list", args);
      const list = secretsList();
      const resultText = JSON.stringify(list);
      recipeStore.appendToolCall("secrets_list", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_get",
    {
      description: "Get a secret value by id (UUID). Returns plaintext.",
      inputSchema: z.object({
        id: z.string().describe("Secret id (UUID from secrets_list)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("secrets_get", args, new Set(["id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_get", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      console.log("[Houston MCP] Tool secrets_get called", { id });
      logClarification("secrets_get", args);
      logAssessment("secrets_get", args);
      const value = secretsGet(id);
      const resultText = value === null ? `Secret with id "${id}" not found.` : value;
      recipeStore.appendToolCall("secrets_get", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_set",
    {
      description: "Set a secret. Rejects if (detailed_description, first_factor) exists unless force=true.",
      inputSchema: z.object({
        detailed_description: z.string().describe("Detailed description of the secret"),
        first_factor: z.string().describe("First factor, e.g. 'user' or 'user@domain.tld'"),
        first_factor_type: z.string().describe("First factor type, e.g. 'username', 'email', 'API Key'"),
        value: z.string().describe("Secret value"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false).describe("If true, overwrite existing. Default false."),
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("secrets_set", args, new Set(["detailed_description", "first_factor", "first_factor_type", "value", "assessment", "clarification", "force"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { detailed_description, first_factor, first_factor_type, value, force = false } = args as {
        detailed_description: string;
        first_factor: string;
        first_factor_type: string;
        value: string;
        force?: boolean;
      };
      console.log("[Houston MCP] Tool secrets_set called", { detailed_description, first_factor, force });
      logClarification("secrets_set", args);
      logAssessment("secrets_set", args);
      const id = secretsSet(detailed_description, first_factor, first_factor_type, value, force);
      const resultText = `Secret set. id="${id}"`;
      recipeStore.appendToolCall("secrets_set", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "secrets_delete",
    {
      description: "Delete a secret by id (UUID from secrets_list).",
      inputSchema: z.object({
        id: z.string().describe("Secret id (UUID)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("secrets_delete", args, new Set(["id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("secrets_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      console.log("[Houston MCP] Tool secrets_delete called", { id });
      logClarification("secrets_delete", args);
      logAssessment("secrets_delete", args);
      secretsDelete(id);
      const resultText = `Secret "${id}" deleted.`;
      recipeStore.appendToolCall("secrets_delete", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "config_list",
    {
      description: "List all agent config entries. Returns JSON array of {id, detailed_description, value}. Agent-only storage.",
      inputSchema: z.object({ assessment: ASSESSMENT_PARAM, clarification: CLARIFICATION_PARAM }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("config_list", args, new Set(["assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("config_list", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      console.log("[Houston MCP] Tool config_list called");
      logClarification("config_list", args);
      logAssessment("config_list", args);
      const list = agentConfigList();
      const resultText = JSON.stringify(list);
      recipeStore.appendToolCall("config_list", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "config_set",
    {
      description: "Set an agent config entry. Rejects if detailed_description exists unless force=true.",
      inputSchema: z.object({
        detailed_description: z.string().describe("Detailed description of the config"),
        value: z.string().describe("Config value"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        force: z.boolean().optional().default(false).describe("If true, overwrite existing. Default false."),
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("config_set", args, new Set(["detailed_description", "value", "assessment", "clarification", "force"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("config_set", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { detailed_description, value, force = false } = args as {
        detailed_description: string;
        value: string;
        force?: boolean;
      };
      console.log("[Houston MCP] Tool config_set called", { detailed_description, force });
      logClarification("config_set", args);
      logAssessment("config_set", args);
      const id = agentConfigSet(detailed_description, value, force);
      const resultText = `Config set. id="${id}"`;
      recipeStore.appendToolCall("config_set", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "config_delete",
    {
      description: "Delete an agent config entry by id (UUID from config_list).",
      inputSchema: z.object({
        id: z.string().describe("Config id (UUID)"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("config_delete", args, new Set(["id", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("config_delete", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { id } = args as { id: string };
      console.log("[Houston MCP] Tool config_delete called", { id });
      logClarification("config_delete", args);
      logAssessment("config_delete", args);
      agentConfigDelete(id);
      const resultText = `Config "${id}" deleted.`;
      recipeStore.appendToolCall("config_delete", args, resultText);
      return toolResult(resultText);
    }
  );

  server.registerTool(
    "start_task",
    {
      description: "Start a task. Call at the beginning of a new task. Records task name and start time.",
      inputSchema: z.object({
        summary: z.string().describe("Short task summary/name (e.g. 'Install nginx', 'Configure SSH')"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("start_task", args, new Set(["summary", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("start_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const summary = typeof (args as { summary?: string }).summary === "string" ? (args as { summary: string }).summary : "";
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      console.log("[Houston MCP] Tool start_task called —", summary);
      logClarification("start_task", args);
      logAssessment("start_task", args);
      recipeStore.initFromStartTask(summary, assessment);
      console.log("[Houston MCP] Recipe: initialized from start_task, summary:", summary);
      config.onStartTask?.({ summary });
      return toolResult("Task started.");
    }
  );

  server.registerTool(
    "finalize_task",
    {
      description: "Mandatory when task is complete. Call before ending. is_successful (true/false) is mandatory. Do not produce a final text response without calling finalize_task first.",
      inputSchema: z.object({
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        is_successful: z.boolean().describe("Whether the task completed successfully (true) or failed (false). Mandatory."),
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("finalize_task", args, new Set(["assessment", "clarification", "is_successful"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("finalize_task", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      const clarification = typeof (args as { clarification?: string }).clarification === "string" ? (args as { clarification: string }).clarification : "";
      const rawSuccess = (args as { is_successful?: boolean | string }).is_successful;
      const is_successful =
        typeof rawSuccess === "boolean"
          ? rawSuccess
          : typeof rawSuccess === "string"
            ? rawSuccess.toLowerCase() !== "false" && rawSuccess.toLowerCase() !== "0"
            : true;
      console.log("[Houston MCP] Tool finalize_task called — task completed, success:", is_successful);
      logClarification("finalize_task", args);
      logAssessment("finalize_task", args);
      recipeStore.finalize(is_successful, assessment, clarification);
      config.onFinalizeTask?.({ assessment, clarification, is_successful });
      return toolResult("Task finalized. You don't need to write anything else.");
    }
  );

  server.registerTool(
    "ask_user",
    {
      description: "Ask the user for input. Opens popup with textarea and 60-second countdown. Use when you need clarification or when a tool result contained [User message during reply]. Pass attempt (0–2) when retrying after timeout; you can ask up to 3 times total.",
      inputSchema: z.object({
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
        attempt: z.number().optional().default(0).describe("Retry attempt (0=first, 1=second, 2=third). Default 0."),
      }),
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("ask_user", args, new Set(["assessment", "clarification", "attempt"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("ask_user", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { attempt = 0 } = args as { attempt?: number };
      const assessment = typeof (args as { assessment?: string }).assessment === "string" ? (args as { assessment: string }).assessment : "";
      const clarification = typeof (args as { clarification?: string }).clarification === "string" ? (args as { clarification: string }).clarification : "";
      console.log("[Houston MCP] Tool ask_user called — waiting for user reply, attempt:", attempt);
      logClarification("ask_user", args);
      logAssessment("ask_user", args);
      config.onAskUserRequest?.({ clarification, assessment, attempt });
      const reply = await waitForUserReply({
        timeoutMs: 60_000,
        onTimeout: config.onAskUserTimeout,
      });
      recipeStore.appendToolCall("ask_user", args, reply);
      console.log("[Houston MCP] Tool ask_user got reply, length:", reply.length);
      return toolResult(reply);
    }
  );

  server.registerTool(
    "get_skill",
    {
      description: "Get skill docs by name.",
      inputSchema: {
        name: z.string().describe("Skill name"),
        assessment: ASSESSMENT_PARAM,
        clarification: CLARIFICATION_PARAM,
      },
    },
    async (args) => {
      const unknownMsg = validateUnknownParams("get_skill", args, new Set(["name", "assessment", "clarification"]));
      if (unknownMsg) {
        recipeStore.appendToolCall("get_skill", args, unknownMsg);
        return toolResult(unknownMsg);
      }
      const { name } = args as { name: string };
      console.log("[Houston MCP] Tool get_skill called", { name });
      logClarification("get_skill", args);
      logAssessment("get_skill", args);
      const path = join(SKILLS_DIR, `${name}.md`);
      const resultText = !existsSync(path) ? `Skill "${name}" not found.` : readFileSync(path, "utf-8");
      recipeStore.appendToolCall("get_skill", args, resultText);
      console.log("[Houston MCP] Tool get_skill done, length:", resultText.length);
      return toolResult(resultText);
    }
  );

  return server;
}

export async function startMcpServer(config: McpServerConfig): Promise<Server> {
  if (!config.vmId) {
    throw new Error("Select a Houston VM to control (screenshot, mouse, keyboard)");
  }

  const transports: Record<string, SSEServerTransport> = {};
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/sse", async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    console.log("[Houston MCP] SSE client connected, sessionId:", transport.sessionId);
    res.on("close", () => {
      delete transports[transport.sessionId];
      console.log("[Houston MCP] SSE client disconnected, sessionId:", transport.sessionId);
    });
    const mcpServer = createMcpServer(config);
    await mcpServer.connect(transport);
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      console.warn("[Houston MCP] POST /messages missing sessionId");
      res.status(400).send("Missing sessionId");
      return;
    }
    const transport = transports[sessionId];
    if (!transport) {
      console.warn("[Houston MCP] POST /messages session not found:", sessionId);
      res.status(404).send("Session not found");
      return;
    }
    const method = (req.body as { method?: string })?.method;
    if (method) console.log("[Houston MCP] Message:", method);
    await transport.handlePostMessage(req, res, req.body);
  });

  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr?.port ? addr.port : 0;
      console.log(`[Houston MCP] Listening on port ${port}`);
      console.log(`[Houston MCP] SSE: http://localhost:${port}/sse`);
      resolve(server);
    });

    server.on("error", reject);
  });
}

export function getMcpServerPort(server: Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr?.port ? addr.port : 0;
}
