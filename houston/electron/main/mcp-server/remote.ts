import { Client, type ClientChannel } from "ssh2";
import { randomUUID } from "node:crypto";
import stripAnsi from "strip-ansi";

const CONNECT_TIMEOUT_MS = 5000;
const TERM_COLS = 80;
const TERM_ROWS = 24;
const MAX_LINES = 500;

export interface SessionConnectParams {
  host: string;
  port?: number;
  username: string;
  privateKey?: string;
  password?: string;
}

interface Session {
  conn: Client;
  stream: ClientChannel;
  lines: string[];
  lineBuffer: string;
}

const sessions = new Map<string, Session>();

function appendToLines(session: Session, data: string): void {
  const cleaned = stripAnsi(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  session.lineBuffer += cleaned;
  const parts = session.lineBuffer.split("\n");
  session.lineBuffer = parts.pop() ?? "";
  for (const line of parts) {
    session.lines.push(line);
    if (session.lines.length > MAX_LINES) session.lines.shift();
  }
}

function getLastLines(session: Session, limit: number): string {
  const n = Math.min(limit, session.lines.length);
  return session.lines.slice(-n).join("\n") || "(no output)";
}

export async function startSession(params: SessionConnectParams): Promise<{ session_id: string; output: string }> {
  if (!params.privateKey && !params.password) {
    throw new Error("Either privateKey or password is required");
  }
  const port = params.port ?? 22;

  const conn = new Client();
  await new Promise<void>((resolve, reject) => {
    conn
      .on("ready", () => resolve())
      .on("error", (err: Error) => reject(err))
      .connect({
        host: params.host,
        port,
        username: params.username,
        privateKey: params.privateKey,
        password: params.password,
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: () => true,
      });
  });

  const sessionId = randomUUID();
  const lines: string[] = [];

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    conn.shell(
      {
        cols: TERM_COLS,
        rows: TERM_ROWS,
      },
      (err: Error | undefined, s: ClientChannel | undefined) => {
        if (err) reject(err);
        else if (s) resolve(s);
        else reject(new Error("Shell failed"));
      }
    );
  });

  const session: Session = { conn, stream, lines, lineBuffer: "" };
  sessions.set(sessionId, session);

  stream.on("data", (chunk: Buffer) => {
    appendToLines(session, chunk.toString("utf-8"));
  });
  stream.on("close", () => {
    sessions.delete(sessionId);
    conn.end();
  });
  conn.on("error", () => {
    sessions.delete(sessionId);
  });

  await new Promise((r) => setTimeout(r, 500));
  const output = getLastLines(session, TERM_ROWS);
  return { session_id: sessionId, output };
}

export async function sendToSession(
  sessionId: string,
  command: string,
  options?: { history_limit?: number; wait_seconds?: number }
): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const historyLimit = options?.history_limit ?? 24;
  const waitSeconds = options?.wait_seconds ?? 1;

  session.stream.write(command + "\n");

  const waitMs = Math.min(Math.max(waitSeconds, 0), 30) * 1000;
  await new Promise((r) => setTimeout(r, waitMs));

  return getLastLines(session, historyLimit);
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    session.stream.end();
    session.conn.end();
  }
}
