import { execSync } from "node:child_process";
import type { Config } from "./config.js";

const SSH_OPTS = "-o StrictHostKeyChecking=no -o ConnectTimeout=5";

function sshCommand(config: Config, cmd: string): string {
  const escaped = cmd.replace(/'/g, "'\\''");
  return `sshpass -p '${config.password.replace(/'/g, "'\\''")}' ssh ${SSH_OPTS} ${config.username}@${config.host} '${escaped}'`;
}

export function runSsh(config: Config, command: string): string {
  const full = sshCommand(config, `DISPLAY=${config.display} ${command}`);
  return execSync(full, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
}

/** Run xdotool type with arbitrary text via base64 to avoid shell escaping */
export function runSshTypeText(config: Config, text: string): void {
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  const fullCmd = `sh -c 'echo "${b64}" | base64 -d | xdotool type --clearmodifiers --file -'`;
  runSshSilent(config, fullCmd);
}

export function runSshSilent(config: Config, command: string): void {
  const full = sshCommand(config, `DISPLAY=${config.display} ${command}`);
  execSync(full, { encoding: "utf-8", stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
}

export function scpFromRemote(config: Config, remotePath: string, localPath: string): void {
  const cmd = `sshpass -p '${config.password.replace(/'/g, "'\\''")}' scp ${SSH_OPTS} ${config.username}@${config.host}:${remotePath} ${localPath}`;
  execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}
