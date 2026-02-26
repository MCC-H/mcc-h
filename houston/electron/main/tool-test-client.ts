import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

let toolTestClient: Client | null = null;
let toolTestTransport: SSEClientTransport | null = null;

export async function connectToolTestClient(mcpPort: number): Promise<void> {
  console.log("[Houston ToolTest] Connecting to MCP server on port", mcpPort);
  const sseUrl = new URL(`http://localhost:${mcpPort}/sse`);
  toolTestTransport = new SSEClientTransport(sseUrl);
  toolTestClient = new Client({ name: "houston-tool-test", version: "1.0.0" });
  await toolTestClient.connect(toolTestTransport);
  console.log("[Houston ToolTest] Connected");
}

export function disconnectToolTestClient(): void {
  if (toolTestTransport) {
    toolTestTransport.close();
    toolTestTransport = null;
  }
  toolTestClient = null;
  console.log("[Houston ToolTest] Disconnected");
}

export interface McpToolParam {
  key: string;
  type: "string" | "number";
  default: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  params: McpToolParam[];
}

export async function listMcpTools(): Promise<McpToolInfo[]> {
  if (!toolTestClient) {
    return [];
  }
  const { tools } = await toolTestClient.listTools();
  return tools.map((t) => {
    const schema = (t.inputSchema as { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] }) ?? {};
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const params: McpToolParam[] = Object.entries(props).map(([key, p]) => ({
      key,
      type: (p?.type === "number" ? "number" : "string") as "string" | "number",
      default: "",
    }));
    if (params.length === 0 && Object.keys(props).length === 0) {
      const needsArgs = t.name.startsWith("browser__");
      if (needsArgs) {
        params.push({ key: "args", type: "string", default: "{}" });
      }
    }
    return { name: t.name, description: t.description, params };
  });
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!toolTestClient) {
    throw new Error("Tool test client not connected. Start MCP server first.");
  }
  console.log("[Houston ToolTest] Calling tool:", name, "args:", JSON.stringify(args));
  const result = await toolTestClient.callTool({ name, arguments: args });
  const content = "content" in result ? result.content : [];
  const arr = Array.isArray(content) ? content : [];
  const text =
    arr
      .filter((c): c is { type: "text"; text: string } => c && typeof c === "object" && "type" in c && c.type === "text")
      .map((c) => c.text)
      .join("\n") || ("toolResult" in result ? String(result.toolResult) : "(no output)");
  console.log("[Houston ToolTest] Tool", name, "result length:", text.length);
  return text;
}
