import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig } from "./config.js";
import { runSsh, runSshSilent, runSshTypeText, scpFromRemote } from "./remote.js";
import { runOCR } from "./ocr.js";
import type { Config } from "./config.js";

const config = loadConfig(process.env);

function validateConfig(): void {
  if (!config.host || !config.username || !config.password) {
    console.error("Missing required config: MCP_REMOTE_HOST, MCP_REMOTE_USER, MCP_REMOTE_PASSWORD");
    process.exit(1);
  }
}

const SCREENSHOT_PATH = "/tmp/mcp_screenshot.png";

/** Unescape \\n, \\t, \\r, \\\\ in text for keyboard_type. */
function unescapeKeyboardText(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

/** Map escape sequences to xdotool key names. */
function resolveKeyboardKey(key: string): string {
  const parts = key.split("+").map((p) => p.trim());
  const last = parts[parts.length - 1] ?? "";
  const resolve = (k: string): string => {
    if (k === "\n" || k === "\\n") return "Return";
    if (k === "\t" || k === "\\t") return "Tab";
    if (k === "\r" || k === "\\r") return "Return";
    if (k === "\b" || k === "\\b") return "BackSpace";
    if (k === "\\") return "backslash";
    if (k.toLowerCase() === "backspace") return "BackSpace";
    return k;
  };
  const resolved = resolve(last);
  if (parts.length > 1) {
    return [...parts.slice(0, -1), resolved].join("+");
  }
  return resolved;
}

const ESCAPE_KEY_STRINGS = new Set(["\n", "\t", "\r", "\b", "\\n", "\\t", "\\r", "\\b"]);
const KNOWN_KEY_NAMES = new Set([
  "return", "enter", "tab", "escape", "esc", "space", "spacebar",
  "backspace", "backspace2", "delete", "del",
  "up", "down", "left", "right", "home", "end",
  "page_up", "pageup", "page_down", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "minus", "equal", "bracketleft", "bracketright", "backslash",
  "semicolon", "apostrophe", "comma", "period", "slash", "grave",
]);

function isKeyboardKeyPress(item: string): boolean {
  const t = item.trim();
  if (ESCAPE_KEY_STRINGS.has(t)) return true;
  if (t.includes("+")) return true;
  if (KNOWN_KEY_NAMES.has(t.toLowerCase())) return true;
  return false;
}

function parseKeyboardSequence(seq: unknown): string[] {
  if (!Array.isArray(seq)) return [];
  return seq
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.replace(/^ +| +$/g, ""));
}

function getLocalScreenshotPath(): string {
  return join(tmpdir(), `mcp_screenshot_${randomUUID()}.png`);
}

function takeScreenshotImpl(cfg: Config): { localPath: string; base64: string } {
  runSshSilent(cfg, `maim ${SCREENSHOT_PATH}`);
  const localPath = getLocalScreenshotPath();
  scpFromRemote(cfg, SCREENSHOT_PATH, localPath);
  const base64 = readFileSync(localPath).toString("base64");
  return { localPath, base64 };
}

function getServer() {
  const server = new McpServer(
    {
      name: "mcp-remote-desktop",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } }
  );

  let lastScreenshotBase64: string | null = null;

  server.registerTool(
    "take_screenshot",
    { description: "Capture screen and return OCR layout" },
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { localPath } = takeScreenshotImpl(config);
      lastScreenshotBase64 = readFileSync(localPath).toString("base64");
      const ocrResult = await runOCR(config, localPath);
      const layout = ocrResult.layout.map((obj) => {
        const [text] = Object.keys(obj);
        const coords = obj[text] as [number, number];
        return { [text]: coords };
      });
      const result = JSON.stringify({
        image: ocrResult.image,
        layout,
      });
      return { content: [{ type: "text", text: result }] };
    }
  );

  server.registerTool(
    "get_screenshot_image",
    { description: "Get last screenshot as base64 image" },
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      if (!lastScreenshotBase64) {
        const { base64 } = takeScreenshotImpl(config);
        lastScreenshotBase64 = base64;
      }
      return { content: [{ type: "text", text: lastScreenshotBase64 }] };
    }
  );

  server.registerTool(
    "mouse_move",
    {
      description: "Move mouse to coordinates",
      inputSchema: {
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
      },
    },
    async ({ x, y }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      runSshSilent(config, `xdotool mousemove ${x} ${y}`);
      return { content: [{ type: "text", text: `Moved mouse to (${x}, ${y})` }] };
    }
  );

  server.registerTool(
    "mouse_click",
    {
      description: "Single click; use x,y for move+click",
      inputSchema: {
        x: z.number().optional().describe("X coordinate (optional)"),
        y: z.number().optional().describe("Y coordinate (optional)"),
        button: z.number().optional().describe("Button: 1=left, 2=middle, 3=right"),
      },
    },
    async ({ x, y, button = 1 }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      if (x !== undefined && y !== undefined) {
        runSshSilent(config, `xdotool mousemove ${x} ${y} click ${button}`);
      } else {
        runSshSilent(config, `xdotool click ${button}`);
      }
      return { content: [{ type: "text", text: "Click performed" }] };
    }
  );

  server.registerTool(
    "mouse_double_click",
    {
      description: "Double-click at coordinates",
      inputSchema: {
        x: z.number().describe("X coordinate in pixels"),
        y: z.number().describe("Y coordinate in pixels"),
        delay_ms: z.number().optional().describe("Delay between clicks in ms (default 300)"),
      },
    },
    async ({ x, y, delay_ms = 300 }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      runSshSilent(config, `xdotool mousemove ${x} ${y} click 1 click 1`);
      return { content: [{ type: "text", text: `Double-click at (${x}, ${y})` }] };
    }
  );

  server.registerTool(
    "keyboard_type",
    {
      description:
        "Type text and/or press keys. JSON array of items: literal text, escape sequences (\\n, \\t, \\r, \\b), or key combos (Return, Tab, ctrl+c, alt+Tab, etc.). Example: [\"user\", \"\\t\", \"root\", \"\\n\"] or [\"ctrl+a\", \"hello\"].",
      inputSchema: {
        sequence: z
          .array(z.string())
          .describe(
            "Array of items. Each: literal text, escape sequence (\\n, \\t, \\r, \\b), or key (Return, Tab, Backspace, Down, ctrl+c, alt+Tab). Example: [\"user\", \"\\t\", \"root\", \"\\n\"]"
          ),
        delay: z.number().optional().default(100).describe("Delay in ms between items (default 100)"),
      },
    },
    async ({ sequence: seq, delay = 100 }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const items = parseKeyboardSequence(seq);
      for (let i = 0; i < items.length; i++) {
        const item = items[i] ?? "";
        if (isKeyboardKeyPress(item)) {
          const key = resolveKeyboardKey(item);
          const escaped = key.replace(/"/g, '\\"');
          runSshSilent(config, `xdotool key ${escaped}`);
        } else {
          const text = unescapeKeyboardText(item);
          if (text) runSshTypeText(config, text);
        }
        if (i < items.length - 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      return { content: [{ type: "text", text: "Typed sequence" }] };
    }
  );

  server.registerTool(
    "run_ssh_command",
    {
      description: "Run arbitrary command on remote",
      inputSchema: {
        command: z.string().describe("Command to run on remote machine"),
      },
    },
    async ({ command }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const output = runSsh(config, command);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    }
  );

  server.registerTool(
    "wait",
    {
      description: "Pause between actions",
      inputSchema: {
        seconds: z.number().describe("Seconds to wait"),
      },
    },
    async ({ seconds }): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { content: [{ type: "text", text: `Waited ${seconds} seconds` }] };
    }
  );

  return server;
};

const transports: Record<string, SSEServerTransport> = {};
const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/sse", async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  const server = getServer();
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).send("Missing sessionId");
    return;
  }
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

validateConfig();

app.listen(config.mcpPort, () => {
  console.log(`MCP Remote Desktop server listening on port ${config.mcpPort}`);
  console.log(`  SSE endpoint: http://localhost:${config.mcpPort}/sse`);
  console.log(`  Messages: POST http://localhost:${config.mcpPort}/messages?sessionId=<id>`);
  console.log(`  Remote: ${config.username}@${config.host} DISPLAY=${config.display}`);
  console.log(`  OCR: ${config.ocrEndpoint}`);
});
