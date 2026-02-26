/**
 * After electron-builder signs the app, sign bundled binaries with Developer ID.
 * HoustonVM must have com.apple.security.virtualization to use Apple's Virtualization framework.
 * HoustonAI and llama-server also need signing for distribution.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IDENTITY = "F44ZS9HT2P";

function signBinary(binaryPath, entitlementsPath = null) {
  if (!fs.existsSync(binaryPath)) {
    console.warn("[afterSign] Binary not found:", binaryPath);
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
  const resourcesDir = context.packager.getMacOsResourcesDir(context.appOutDir);
  const projectDir = context.packager.projectDir;

  // HoustonVM: needs virtualization entitlement
  const houstonVmPath = path.join(resourcesDir, "HoustonVM");
  const houstonVmEntitlements = path.join(projectDir, "houston-vm", "HoustonVM.entitlements");
  if (fs.existsSync(houstonVmPath)) {
    console.log("[afterSign] Signing HoustonVM with virtualization entitlement...");
    signBinary(houstonVmPath, houstonVmEntitlements);
    console.log("[afterSign] HoustonVM signed");
  }

  // HoustonAI
  const houstonAiPath = path.join(resourcesDir, "HoustonAI");
  if (fs.existsSync(houstonAiPath)) {
    console.log("[afterSign] Signing HoustonAI...");
    signBinary(houstonAiPath);
    console.log("[afterSign] HoustonAI signed");
  }

  // llama-server (inside llama-b8149)
  const llamaDir = path.join(resourcesDir, "llama-b8149");
  const llamaServerPath = path.join(llamaDir, "llama-server");
  if (fs.existsSync(llamaServerPath)) {
    console.log("[afterSign] Signing llama-server...");
    signBinary(llamaServerPath);
    console.log("[afterSign] llama-server signed");
  }
};
