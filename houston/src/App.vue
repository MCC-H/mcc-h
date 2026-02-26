<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, provide } from "vue";
import MCPServerConfig from "./components/MCPServerConfig.vue";
import VMManager from "./components/VMManager.vue";
import Launchpad from "./components/Launchpad.vue";

const serverRunning = ref(false);
const showTestButtons = ref(false);
provide("showTestButtons", showTestButtons);
const vmListRefreshTrigger = ref(0);
provide("vmListRefreshTrigger", vmListRefreshTrigger);
provide("refreshVmList", () => {
  vmListRefreshTrigger.value++;
});

export interface LaunchpadStatus {
  hypervisor: "loading" | "ready" | "not running";
  models: Record<string, string> | null;
  isComplete: boolean;
}

const launchpadStatus = ref<LaunchpadStatus>({
  hypervisor: "loading",
  models: null,
  isComplete: false,
});
provide("launchpadStatus", launchpadStatus);

let launchpadPoll: ReturnType<typeof setInterval> | null = null;

async function pollLaunchpad() {
  if (!window.electronAPI?.vmModelsStatus) return;
  if (launchpadStatus.value.hypervisor === "ready" && launchpadStatus.value.isComplete) return;
  try {
    const r = await window.electronAPI.vmModelsStatus();
    if (r.ok && r.models) {
      const wasNull = launchpadStatus.value.models === null;
      launchpadStatus.value = {
        hypervisor: "ready",
        models: r.models,
        isComplete: r.isComplete ?? false,
      };
      if (wasNull) vmListRefreshTrigger.value++;
      if (r.isComplete) {
        if (launchpadPoll) clearInterval(launchpadPoll);
        launchpadPoll = null;
      }
    } else {
      launchpadStatus.value = {
        hypervisor: "not running",
        models: null,
        isComplete: false,
      };
    }
  } catch {
    launchpadStatus.value = {
      hypervisor: "not running",
      models: null,
      isComplete: false,
    };
  }
}

onMounted(() => {
  pollLaunchpad();
  launchpadPoll = setInterval(pollLaunchpad, 1500);
});

onUnmounted(() => {
  if (launchpadPoll) clearInterval(launchpadPoll);
});

watch(serverRunning, (running) => {
  document.body.style.overflow = running ? "hidden" : "";
}, { immediate: true });
const config = ref<{
  vmId: string;
  mcpPort: number;
  aiProvider: "claude" | "openrouter" | "chatgpt" | "custom";
  claudeApiKey: string;
  claudeModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  chatgptModel: string;
  customControlApiUrl?: string;
  customControlApiKey?: string;
  customControlModel?: string;
  vlModel?: string;
  vlApiUrl?: string;
  vlApiKey?: string;
}>({
  vmId: "",
  mcpPort: 10000,
  aiProvider: "claude",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  chatgptModel: "gpt-5.1-codex",
});

onMounted(async () => {
  console.log("[Houston App] onMounted");
  if (window.electronAPI?.getConfig) {
    const loaded = await window.electronAPI.getConfig();
    const provider: "claude" | "openrouter" | "chatgpt" | "custom" =
      loaded.aiProvider === "openrouter" ? "openrouter"
        : loaded.aiProvider === "chatgpt" ? "chatgpt"
        : loaded.aiProvider === "custom" ? "custom"
        : "claude";
    config.value = { ...config.value, ...loaded, aiProvider: provider };
    console.log("[Houston App] Config loaded");
  }
});
</script>

<template>
  <div class="app" :class="{ 'app-running': serverRunning }">
    <h1>MCC-H</h1>
    <p class="subtitle">Let AI work like a human</p>
    <label class="show-test-checkbox">
      <input v-model="showTestButtons" type="checkbox" />
      Show test buttons
    </label>
    <Launchpad />
    <VMManager />
    <MCPServerConfig v-model="config" @status-change="(s) => (serverRunning = s === 'running')" />
  </div>
</template>

<style scoped>
.app {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: calc(100vh - 3rem);
}

.app.app-running {
  overflow: hidden;
  height: calc(100vh - 3rem);
  max-height: calc(100vh - 3rem);
}

.app-running {
  max-width: 100%;
  width: 100%;
}

h1 {
  flex-shrink: 0;
  margin: 0 0 0.25rem 0;
  font-size: 1.5rem;
}

.subtitle {
  flex-shrink: 0;
  margin: 0 0 1.5rem 0;
  color: #888;
  font-size: 0.9rem;
}

.show-test-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.9rem;
  color: #888;
  cursor: pointer;
}
</style>
