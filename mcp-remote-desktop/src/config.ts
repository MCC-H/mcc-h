export interface Config {
  host: string;
  username: string;
  password: string;
  ocrEndpoint: string;
  display: string;
  mcpPort: number;
}

const DEFAULTS: Partial<Config> = {
  ocrEndpoint: "http://localhost:8000",
  display: ":0",
  mcpPort: 3100,
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    host: env.MCP_REMOTE_HOST ?? "",
    username: env.MCP_REMOTE_USER ?? "",
    password: env.MCP_REMOTE_PASSWORD ?? "",
    ocrEndpoint: env.MCP_OCR_ENDPOINT ?? DEFAULTS.ocrEndpoint!,
    display: env.MCP_DISPLAY ?? DEFAULTS.display!,
    mcpPort: parseInt(env.MCP_PORT ?? String(DEFAULTS.mcpPort), 10),
  };
}
