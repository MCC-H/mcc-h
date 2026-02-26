/**
 * Before electron-builder signs the app, sign nested binaries with Developer ID.
 * Nested binaries must be signed first; signing them in afterSign invalidates the main app signature.
 * HoustonVM must have com.apple.security.virtualization to use Apple's Virtualization framework.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IDENTITY = "F44ZS9HT2P";

function signBinary(binaryPath, entitlementsPath = null) {
  if (!fs.existsSync(binaryPath)) {
    console.warn("[afterPack] Binary not found:", binaryPath);
    return;
  }
  const args = ["-f", "-s", IDENTITY, "--options", "runtime"];
  if (entitlementsPath && fs.existsSync(entitlementsPath)) {
    args.push("--entitlements", entitlementsPath);
  }
  args.push(binaryPath);
  execFileSync("codesign", args, { stdio: "inherit" });
}

module.exports = async function (context) {
  if (context.electronPlatformName !== "darwin") return;

  const resourcesDir = context.packager.getMacOsResourcesDir(context.appOutDir);
  const projectDir = context.packager.projectDir;

  // HoustonVM: needs virtualization entitlement
  const houstonVmPath = path.join(resourcesDir, "HoustonVM");
  const houstonVmEntitlements = path.join(projectDir, "houston-vm", "HoustonVM.entitlements");
  if (fs.existsSync(houstonVmPath)) {
    console.log("[afterPack] Signing HoustonVM with virtualization entitlement...");
    signBinary(houstonVmPath, houstonVmEntitlements);
    console.log("[afterPack] HoustonVM signed");
  }

  // HoustonAI
  const houstonAiPath = path.join(resourcesDir, "HoustonAI");
  if (fs.existsSync(houstonAiPath)) {
    console.log("[afterPack] Signing HoustonAI...");
    signBinary(houstonAiPath);
    console.log("[afterPack] HoustonAI signed");
  }

  // llama-server (inside llama-b8149)
  const llamaDir = path.join(resourcesDir, "llama-b8149");
  const llamaServerPath = path.join(llamaDir, "llama-server");
  if (fs.existsSync(llamaServerPath)) {
    console.log("[afterPack] Signing llama-server...");
    signBinary(llamaServerPath);
    console.log("[afterPack] llama-server signed");
  }
};
