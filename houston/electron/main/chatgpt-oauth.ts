/**
 * ChatGPT OAuth flow for Houston.
 * Based on opencode-openai-codex-auth - uses OpenAI's official OAuth (same as Codex CLI).
 * For personal development with ChatGPT Plus/Pro subscription.
 */

import { randomBytes, createHash } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const HOUSTON_DIR = join(homedir(), "houston");
const CHATGPT_OAUTH_PATH = join(HOUSTON_DIR, "chatgpt-oauth.json");

export interface ChatGPTOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE(): { challenge: string; verifier: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64UrlEncode(hash);
  return { challenge, verifier };
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getChatGPTOAuthTokens(): ChatGPTOAuthTokens | null {
  try {
    if (existsSync(CHATGPT_OAUTH_PATH)) {
      const data = JSON.parse(readFileSync(CHATGPT_OAUTH_PATH, "utf-8"));
      if (data?.access && data?.refresh && data?.accountId) {
        return data as ChatGPTOAuthTokens;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveChatGPTOAuthTokens(tokens: ChatGPTOAuthTokens): void {
  mkdirSync(HOUSTON_DIR, { recursive: true });
  writeFileSync(CHATGPT_OAUTH_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function clearChatGPTOAuthTokens(): void {
  try {
    if (existsSync(CHATGPT_OAUTH_PATH)) {
      unlinkSync(CHATGPT_OAUTH_PATH);
    }
  } catch {
    /* ignore */
  }
}

export function isChatGPTAuthorized(): boolean {
  const tokens = getChatGPTOAuthTokens();
  if (!tokens) return false;
  // Consider expired if within 5 min of expiry (refresh will be needed)
  return tokens.expires > Date.now() + 5 * 60 * 1000 || !!tokens.refresh;
}

export async function refreshChatGPTToken(): Promise<ChatGPTOAuthTokens | null> {
  const current = getChatGPTOAuthTokens();
  if (!current?.refresh) return null;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    console.error("[Houston] ChatGPT token refresh failed:", res.status, await res.text());
    return null;
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    return null;
  }

  const decoded = decodeJWT(json.access_token);
  const auth = decoded?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
  const accountId = auth?.chatgpt_account_id ?? current.accountId;

  const tokens: ChatGPTOAuthTokens = {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
  saveChatGPTOAuthTokens(tokens);
  return tokens;
}

export async function getValidChatGPTTokens(): Promise<ChatGPTOAuthTokens | null> {
  let tokens = getChatGPTOAuthTokens();
  if (!tokens) return null;

  if (tokens.expires < Date.now() + 5 * 60 * 1000 && tokens.refresh) {
    tokens = await refreshChatGPTToken();
  }
  return tokens;
}

function openBrowserUrl(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", shell: process.platform === "win32" });
  } catch {
    /* user can copy URL manually */
  }
}

export interface ChatGPTAuthorizeResult {
  ok: boolean;
  error?: string;
}

export function authorizeChatGPT(): Promise<ChatGPTAuthorizeResult> {
  return new Promise((resolve) => {
    const { challenge, verifier } = generatePKCE();
    const state = createState();

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "codex_cli_rs");

    const authUrl = url.toString();

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "", "http://localhost");
        if (reqUrl.pathname !== "/auth/callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        if (reqUrl.searchParams.get("state") !== state) {
          res.statusCode = 400;
          res.end("State mismatch");
          server.close();
          resolve({ ok: false, error: "State mismatch" });
          return;
        }
        const code = reqUrl.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.end("Missing authorization code");
          server.close();
          resolve({ ok: false, error: "Missing authorization code" });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!DOCTYPE html><html><head><title>Houston - ChatGPT Authorized</title></head><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>✓ Authorized</h1><p>You can close this window and return to Houston.</p></body></html>`
        );

        server.close();

        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
          }),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error("[Houston] ChatGPT token exchange failed:", tokenRes.status, errText);
          resolve({ ok: false, error: `Token exchange failed: ${tokenRes.status}` });
          return;
        }

        const json = (await tokenRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };

        if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
          resolve({ ok: false, error: "Invalid token response" });
          return;
        }

        const decoded = decodeJWT(json.access_token);
        const auth = decoded?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
        const accountId = auth?.chatgpt_account_id ?? "";

        if (!accountId) {
          resolve({ ok: false, error: "Could not extract account ID from token" });
          return;
        }

        saveChatGPTOAuthTokens({
          access: json.access_token,
          refresh: json.refresh_token,
          expires: Date.now() + json.expires_in * 1000,
          accountId,
        });

        resolve({ ok: true });
      } catch (err) {
        server.close();
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    server.listen(1455, "127.0.0.1", () => {
      openBrowserUrl(authUrl);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error("[Houston] OAuth server failed:", err?.code, err);
      resolve({
        ok: false,
        error: `Could not start callback server (port 1455): ${err?.message}. Try closing other apps using this port.`,
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (server.listening) {
        server.close();
        resolve({ ok: false, error: "Authorization timed out. Please try again." });
      }
    }, 5 * 60 * 1000);
  });
}
