<script setup lang="ts">
import { ref, watch, inject, onMounted, computed } from "vue";
import AgentChat from "./AgentChat.vue";

const configOpen = ref(false);
const showTestButtonsRef = inject<{ value: boolean }>("showTestButtons");
const showTestButtons = computed({
  get: () => showTestButtonsRef?.value ?? false,
  set: (v) => { if (showTestButtonsRef) showTestButtonsRef.value = v; },
});
const vms = ref<{ id: string; name: string; status: string }[]>([]);
const vmListRefreshTrigger = inject<{ value: number }>("vmListRefreshTrigger");

export type AiProvider = "claude" | "openrouter" | "chatgpt" | "custom";

const CLAUDE_PRESETS = [
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];
const OPENROUTER_PRESETS = [
  { value: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
  { value: "google/gemini-3-flash-preview", label: "Google Gemini 3 Flash Preview" },
  { value: "moonshotai/kimi-k2.5", label: "Moonshot Kimi K2.5" },
  { value: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
];
const CHATGPT_PRESETS = [
  { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
];

const VL_PRESETS = [
  { value: "qwen/qwen3-vl-8b-instruct", label: "Qwen VL 8B" },
  { value: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
  { value: "google/gemini-2.0-flash", label: "Google Gemini 2.0 Flash" },
];

function isPreset(value: string, presets: { value: string }[]): boolean {
  return presets.some((p) => p.value === value);
}

export interface McpConfig {
  vmId: string;
  mcpPort: number;
  aiProvider: AiProvider;
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
}

async function loadVms() {
  try {
    const list = (await window.electronAPI?.vmList?.()) ?? [];
    vms.value = list;
  } catch {
    vms.value = [];
  }
}

watch(
  () => vmListRefreshTrigger?.value ?? 0,
  (val) => {
    if (val > 0) loadVms();
  }
);

watch(
  () => config.value.aiProvider,
  (p) => {
    if (p === "chatgpt") refreshChatGPTAuthStatus();
  }
);

const props = defineProps<{
  modelValue: McpConfig;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: McpConfig): void;
  (e: "statusChange", status: "idle" | "starting" | "running" | "error"): void;
}>();

const config = ref<McpConfig>({
  ...props.modelValue,
  chatgptModel: props.modelValue.chatgptModel ?? "gpt-5.1-codex",
  vlModel: props.modelValue.vlModel ?? "qwen/qwen3-vl-8b-instruct",
});

watch(
  () => props.modelValue,
  (v) => {
    config.value = { ...v };
  },
  { deep: true }
);

const status = ref<"idle" | "starting" | "running" | "error">("idle");
const message = ref("");
const agentReady = ref(false);
const chatgptAuthorizing = ref(false);
const chatgptAuthorized = ref(false);

async function refreshChatGPTAuthStatus() {
  if (window.electronAPI?.chatgptAuthStatus) {
    const r = await window.electronAPI.chatgptAuthStatus();
    chatgptAuthorized.value = r?.authorized === true;
  }
}

async function authorizeChatGPT() {
  if (!window.electronAPI?.chatgptAuthorize) return;
  chatgptAuthorizing.value = true;
  message.value = "";
  try {
    const result = await window.electronAPI.chatgptAuthorize();
    if (result?.ok) {
      chatgptAuthorized.value = true;
      message.value = "ChatGPT authorized successfully.";
    } else {
      message.value = result?.error ?? "Authorization failed.";
      status.value = "error";
    }
  } catch (err) {
    message.value = err instanceof Error ? err.message : "Authorization failed.";
    status.value = "error";
  } finally {
    chatgptAuthorizing.value = false;
  }
}

onMounted(() => refreshChatGPTAuthStatus());

function update(field: keyof McpConfig, value: string | number | AiProvider) {
  config.value[field] = value as never;
  const updated = { ...config.value };
  emit("update:modelValue", updated);
  window.electronAPI?.saveConfig?.(updated);
}

async function startServer() {
  console.log("[Houston Config] startServer clicked");
  if (!window.electronAPI?.startMcpServer) {
    const inElectron = /Electron/i.test(navigator.userAgent);
    let msg = "Run with Electron: npm run electron:dev or ./launch.sh";
    if (!inElectron) {
      msg += " — You ran npm run dev (browser). MCC-H must run inside Electron.";
    } else {
      msg += " — Preload failed; check DevTools Console (Ctrl+Shift+I) for errors.";
    }
    message.value = msg;
    status.value = "error";
    console.debug("[Houston] electronAPI:", window.electronAPI ? "ok" : "undefined", "userAgent:", navigator.userAgent);
    return;
  }
  if (!config.value.vmId) {
    message.value = "Please select an MCC-H VM to control";
    status.value = "error";
    return;
  }

  status.value = "starting";
  message.value = "";
  emit("statusChange", status.value);

  try {
    const result = await window.electronAPI.startMcpServer({
      vmId: config.value.vmId,
      mcpPort: config.value.mcpPort,
      aiProvider: config.value.aiProvider,
      claudeApiKey: config.value.claudeApiKey,
      claudeModel: config.value.claudeModel,
      openrouterApiKey: config.value.openrouterApiKey,
      openrouterModel: config.value.openrouterModel,
      chatgptModel: config.value.chatgptModel ?? "gpt-5.1-codex",
      customControlApiUrl: config.value.customControlApiUrl,
      customControlApiKey: config.value.customControlApiKey,
      customControlModel: config.value.customControlModel,
      vlModel: config.value.vlModel,
      vlApiUrl: config.value.vlApiUrl,
      vlApiKey: config.value.vlApiKey,
    });

    if (result.ok) {
      status.value = "running";
      message.value = result.message;
      agentReady.value = result.agentReady === true;
    } else {
      status.value = "error";
      message.value = result.message;
      agentReady.value = false;
    }
  } catch (err) {
    status.value = "error";
    message.value = err instanceof Error ? err.message : String(err);
  }
  emit("statusChange", status.value);
}

function stopServer() {
  console.log("[Houston Config] stopServer clicked");
  window.electronAPI?.stopMcpServer?.();
  status.value = "idle";
  message.value = "";
  agentReady.value = false;
  emit("statusChange", status.value);
}

function wipeSecrets() {
  if (confirm("Delete all agent secrets? This cannot be undone.")) {
    window.electronAPI?.wipeSecrets?.();
    message.value = "Secrets wiped.";
  }
}

function wipeConfigs() {
  if (confirm("Delete all agent configs? This cannot be undone.")) {
    window.electronAPI?.wipeConfigs?.();
    message.value = "Configs wiped.";
  }
}

// Secrets Editor
const showSecretsEditor = ref(false);
const secretsItems = ref<Array<{ id: string; detailed_description: string; first_factor: string; first_factor_type: string; value: string }>>([]);
const secretsError = ref("");
const secretsEditingId = ref<string | null>(null);
const secretsForm = ref({
  detailed_description: "",
  first_factor: "",
  first_factor_type: "",
  value: "",
});

async function openSecretsEditor() {
  showSecretsEditor.value = true;
  secretsError.value = "";
  await refreshSecretsList();
}

async function refreshSecretsList() {
  try {
    const list = (await window.electronAPI?.secretsListFull?.()) ?? [];
    secretsItems.value = list;
  } catch (err) {
    secretsItems.value = [];
    secretsError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddSecret() {
  secretsEditingId.value = null;
  secretsForm.value = { detailed_description: "", first_factor: "", first_factor_type: "", value: "" };
}

function startEditSecret(entry: (typeof secretsItems.value)[0]) {
  secretsEditingId.value = entry.id;
  secretsForm.value = {
    detailed_description: entry.detailed_description,
    first_factor: entry.first_factor,
    first_factor_type: entry.first_factor_type,
    value: entry.value,
  };
}

async function saveSecret() {
  secretsError.value = "";
  try {
    if (secretsEditingId.value) {
      await window.electronAPI?.secretsDelete?.(secretsEditingId.value);
    }
    await window.electronAPI?.secretsSet?.({
      ...secretsForm.value,
      force: false,
    });
    await refreshSecretsList();
    secretsEditingId.value = null;
    secretsForm.value = { detailed_description: "", first_factor: "", first_factor_type: "", value: "" };
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deleteSecret(id: string) {
  if (!confirm("Delete this secret?")) return;
  secretsError.value = "";
  try {
    await window.electronAPI?.secretsDelete?.(id);
    await refreshSecretsList();
    if (secretsEditingId.value === id) {
      secretsEditingId.value = null;
      secretsForm.value = { detailed_description: "", first_factor: "", first_factor_type: "", value: "" };
    }
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

// Configs Editor
const showConfigsEditor = ref(false);
const configsItems = ref<Array<{ id: string; detailed_description: string; value: string }>>([]);
const configsError = ref("");
const configsEditingId = ref<string | null>(null);
const configsForm = ref({ detailed_description: "", value: "" });

async function openConfigsEditor() {
  showConfigsEditor.value = true;
  configsError.value = "";
  await refreshConfigsList();
}

async function refreshConfigsList() {
  try {
    const list = (await window.electronAPI?.agentConfigList?.()) ?? [];
    configsItems.value = list;
  } catch (err) {
    configsItems.value = [];
    configsError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddConfig() {
  configsEditingId.value = null;
  configsForm.value = { detailed_description: "", value: "" };
}

function startEditConfig(entry: (typeof configsItems.value)[0]) {
  configsEditingId.value = entry.id;
  configsForm.value = { detailed_description: entry.detailed_description, value: entry.value };
}

async function saveConfigEntry() {
  configsError.value = "";
  try {
    if (configsEditingId.value) {
      await window.electronAPI?.agentConfigDelete?.(configsEditingId.value);
    }
    await window.electronAPI?.agentConfigSet?.({
      ...configsForm.value,
      force: false,
    });
    await refreshConfigsList();
    configsEditingId.value = null;
    configsForm.value = { detailed_description: "", value: "" };
  } catch (err) {
    configsError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deleteConfigEntry(id: string) {
  if (!confirm("Delete this config?")) return;
  configsError.value = "";
  try {
    await window.electronAPI?.agentConfigDelete?.(id);
    await refreshConfigsList();
    if (configsEditingId.value === id) {
      configsEditingId.value = null;
      configsForm.value = { detailed_description: "", value: "" };
    }
  } catch (err) {
    configsError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

const showTestPopup = ref(false);
const testClickX = ref("");
const testClickY = ref("");
const testClickElement = ref("");
const testDragFromElement = ref("");
const testDragToElement = ref("");
const testDragFromX = ref("");
const testDragFromY = ref("");
const testDragToX = ref("");
const testDragToY = ref("");
const testKeyInput = ref("");
const testScrollElement = ref("");
const testScrollX = ref("");
const testScrollY = ref("");
const testScrollScrollX = ref("");
const testScrollScrollY = ref("");

function openTestPopup() {
  showTestPopup.value = true;
}

async function testClick() {
  if (!config.value.vmId) {
    message.value = "Select a VM first";
    return;
  }
  const element = testClickElement.value.trim();
  const x = parseFloat(testClickX.value);
  const y = parseFloat(testClickY.value);
  if (element) {
    message.value = "";
    const r = await window.electronAPI?.vmClick?.(config.value.vmId, undefined, undefined, element);
    if (r?.ok) message.value = `Click sent at element: "${element}"`;
    else message.value = r?.error ?? "Failed to send click";
    return;
  }
  if (Number.isNaN(x) || Number.isNaN(y)) {
    message.value = "Enter element description or valid x and y numbers";
    return;
  }
  message.value = "";
  const r = await window.electronAPI?.vmClick?.(config.value.vmId, x, y);
  if (r?.ok) message.value = `Click sent at (${x}, ${y})`;
  else message.value = r?.error ?? "Failed to send click";
}

async function testKey() {
  if (!config.value.vmId) {
    message.value = "Select a VM first";
    return;
  }
  const key = testKeyInput.value.trim();
  if (!key) {
    message.value = "Enter a key (e.g. Enter, Tab, ctrl+a)";
    return;
  }
  message.value = "";
  const r = await window.electronAPI?.vmPress?.(config.value.vmId, key);
  if (r?.ok) message.value = `Key sent: ${key}`;
  else message.value = r?.error ?? "Failed to send key";
}

async function testDragDrop() {
  if (!config.value.vmId) {
    message.value = "Select a VM first";
    return;
  }
  const fromEl = testDragFromElement.value.trim();
  const toEl = testDragToElement.value.trim();
  const fromX = testDragFromX.value ? parseFloat(testDragFromX.value) : undefined;
  const fromY = testDragFromY.value ? parseFloat(testDragFromY.value) : undefined;
  const toX = testDragToX.value ? parseFloat(testDragToX.value) : undefined;
  const toY = testDragToY.value ? parseFloat(testDragToY.value) : undefined;
  if (!fromEl && !toEl && (fromX == null || fromY == null || toX == null || toY == null)) {
    message.value = "Enter from_element and to_element, or from_x, from_y, to_x, to_y";
    return;
  }
  message.value = "";
  const r = await window.electronAPI?.vmDragDrop?.(config.value.vmId, {
    from_element: fromEl || undefined,
    to_element: toEl || undefined,
    from_x: fromX,
    from_y: fromY,
    to_x: toX,
    to_y: toY,
    drop_time_ms: 300,
  });
  if (r?.ok) message.value = "Drag & drop sent";
  else message.value = r?.error ?? "Failed to send drag & drop";
}

async function testScroll() {
  if (!config.value.vmId) {
    message.value = "Select a VM first";
    return;
  }
  const scrollYVal = testScrollScrollY.value ? parseFloat(testScrollScrollY.value) : 0;
  const scrollXVal = testScrollScrollX.value ? parseFloat(testScrollScrollX.value) : 0;
  if (scrollYVal === 0 && scrollXVal === 0) {
    message.value = "Enter scrollY and/or scrollX (e.g. -3 to scroll down, 3 to scroll up)";
    return;
  }
  const element = testScrollElement.value.trim();
  const x = testScrollX.value ? parseFloat(testScrollX.value) : undefined;
  const y = testScrollY.value ? parseFloat(testScrollY.value) : undefined;
  if (element || (x != null && y != null)) {
    message.value = "";
    const r = await window.electronAPI?.vmScroll?.(config.value.vmId, {
      scrollY: scrollYVal,
      scrollX: scrollXVal,
      element: element || undefined,
      x,
      y,
    });
    if (r?.ok) message.value = `Scroll sent: scrollY=${scrollYVal}, scrollX=${scrollXVal}`;
    else message.value = r?.error ?? "Failed to send scroll";
  } else {
    message.value = "";
    const r = await window.electronAPI?.vmScroll?.(config.value.vmId, {
      scrollY: scrollYVal,
      scrollX: scrollXVal,
    });
    if (r?.ok) message.value = `Scroll sent: scrollY=${scrollYVal}, scrollX=${scrollXVal}`;
    else message.value = r?.error ?? "Failed to send scroll";
  }
}

async function viewRecipe() {
  try {
    await window.electronAPI?.recipeView?.();
  } catch (err) {
    message.value = err instanceof Error ? err.message : "Failed to open recipe";
  }
}

async function saveRecipe() {
  try {
    const path = await window.electronAPI?.recipeSave?.();
    if (path) message.value = `Recipe saved to ${path}`;
  } catch (err) {
    message.value = err instanceof Error ? err.message : "Failed to save recipe";
  }
}

const agentChatRef = ref<InstanceType<typeof AgentChat> | null>(null);
const showLoadRecipePopup = ref(false);
const loadRecipeInstructions = ref("");
const loadRecipeMarkdown = ref("");

async function loadRecipe() {
  try {
    const r = await window.electronAPI?.recipeLoad?.();
    if (!r?.ok || !r.markdown) {
      message.value = r?.error ?? "Failed to load recipe";
      return;
    }
    loadRecipeMarkdown.value = r.markdown;
    loadRecipeInstructions.value = "";
    showLoadRecipePopup.value = true;
  } catch (err) {
    message.value = err instanceof Error ? err.message : "Failed to load recipe";
  }
}

function followRecipe() {
  const instructions = loadRecipeInstructions.value.trim();
  const displayInstructions = instructions || "none";
  const actualMessage = `I want you to follow this recipe, but with my own mandatory adjustments:

${instructions}

**RECIPE**
${loadRecipeMarkdown.value}`;
  const displayMessage = `Asked model to follow recipe with custom instructions: ${displayInstructions}`;
  showLoadRecipePopup.value = false;
  loadRecipeMarkdown.value = "";
  loadRecipeInstructions.value = "";
  agentChatRef.value?.sendRecipePrompt?.(actualMessage, displayMessage);
}
</script>

<template>
  <div class="config" :class="{ running: status === 'running' }">
    <template v-if="status !== 'running'">
      <div class="field">
        <label for="vmId">VM to control</label>
        <select
          id="vmId"
          :value="config.vmId"
          @change="update('vmId', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">— Select VM —</option>
          <option v-for="vm in vms" :key="vm.id" :value="vm.id">
            {{ vm.name }} ({{ vm.status }})
          </option>
        </select>
      </div>
      <div class="field">
        <label for="aiProvider">AI Provider</label>
        <select
          id="aiProvider"
          :value="config.aiProvider"
          @change="update('aiProvider', ($event.target as HTMLSelectElement).value as AiProvider)"
        >
          <option value="claude">Claude</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
          <option value="chatgpt">ChatGPT (OAuth)</option>
        </select>
      </div>
      <div class="field" v-if="config.aiProvider === 'custom'">
        <label for="customControlApiUrl">Custom API URL</label>
        <input
          id="customControlApiUrl"
          type="url"
          placeholder="https://api.example.com/v1"
          :value="config.customControlApiUrl"
          @input="update('customControlApiUrl', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="field" v-if="config.aiProvider === 'custom'">
        <label for="customControlApiKey">Custom API Key</label>
        <input
          id="customControlApiKey"
          type="password"
          placeholder="sk-..."
          :value="config.customControlApiKey"
          @input="update('customControlApiKey', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="field" v-if="config.aiProvider === 'custom'">
        <label for="customControlModel">Custom Model</label>
        <input
          id="customControlModel"
          type="text"
          placeholder="e.g. gpt-4o or local/model-name"
          :value="config.customControlModel"
          @input="update('customControlModel', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="field" v-if="config.aiProvider === 'claude'">
        <label>Claude Model</label>
        <div class="model-radio-group">
          <label v-for="p in CLAUDE_PRESETS" :key="p.value" class="model-radio">
            <input
              type="radio"
              name="claudeModel"
              :value="p.value"
              :checked="config.claudeModel === p.value"
              @change="update('claudeModel', p.value)"
            />
            {{ p.label }}
          </label>
          <label class="model-radio model-radio-custom">
            <input
              type="radio"
              name="claudeModel"
              value="__custom__"
              :checked="!isPreset(config.claudeModel, CLAUDE_PRESETS)"
              @change="update('claudeModel', isPreset(config.claudeModel, CLAUDE_PRESETS) ? '' : config.claudeModel)"
            />
            Custom:
            <input
              type="text"
              class="model-custom-input"
              placeholder="e.g. claude-3-5-sonnet-20241022"
              :value="!isPreset(config.claudeModel, CLAUDE_PRESETS) ? config.claudeModel : ''"
              @input="update('claudeModel', ($event.target as HTMLInputElement).value)"
              @focus="isPreset(config.claudeModel, CLAUDE_PRESETS) && update('claudeModel', '')"
            />
          </label>
        </div>
      </div>
      <div class="field" v-if="config.aiProvider === 'claude'">
        <label for="claudeApiKey">Claude API Key</label>
        <input
          id="claudeApiKey"
          type="password"
          placeholder="sk-ant-..."
          :value="config.claudeApiKey"
          @input="update('claudeApiKey', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="field" v-if="config.aiProvider === 'openrouter'">
        <label>OpenRouter Model</label>
        <div class="model-radio-group">
          <label v-for="p in OPENROUTER_PRESETS" :key="p.value" class="model-radio">
            <input
              type="radio"
              name="openrouterModel"
              :value="p.value"
              :checked="config.openrouterModel === p.value"
              @change="update('openrouterModel', p.value)"
            />
            {{ p.label }}
          </label>
          <label class="model-radio model-radio-custom">
            <input
              type="radio"
              name="openrouterModel"
              value="__custom__"
              :checked="!isPreset(config.openrouterModel, OPENROUTER_PRESETS)"
              @change="update('openrouterModel', isPreset(config.openrouterModel, OPENROUTER_PRESETS) ? '' : config.openrouterModel)"
            />
            Custom:
            <input
              type="text"
              class="model-custom-input"
              placeholder="e.g. anthropic/claude-3.5-sonnet"
              :value="!isPreset(config.openrouterModel, OPENROUTER_PRESETS) ? config.openrouterModel : ''"
              @input="update('openrouterModel', ($event.target as HTMLInputElement).value)"
              @focus="isPreset(config.openrouterModel, OPENROUTER_PRESETS) && update('openrouterModel', '')"
            />
          </label>
        </div>
      </div>
      <div class="field" v-if="config.aiProvider === 'openrouter'">
        <label for="openrouterApiKey">OpenRouter API Key</label>
        <input
          id="openrouterApiKey"
          type="password"
          placeholder="sk-or-..."
          :value="config.openrouterApiKey"
          @input="update('openrouterApiKey', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="field" v-if="config.aiProvider === 'chatgpt'">
        <label>ChatGPT Model</label>
        <div class="model-radio-group">
          <label v-for="p in CHATGPT_PRESETS" :key="p.value" class="model-radio">
            <input
              type="radio"
              name="chatgptModel"
              :value="p.value"
              :checked="config.chatgptModel === p.value"
              @change="update('chatgptModel', p.value)"
            />
            {{ p.label }}
          </label>
          <label class="model-radio model-radio-custom">
            <input
              type="radio"
              name="chatgptModel"
              value="__custom__"
              :checked="!isPreset(config.chatgptModel, CHATGPT_PRESETS)"
              @change="update('chatgptModel', isPreset(config.chatgptModel, CHATGPT_PRESETS) ? '' : config.chatgptModel)"
            />
            Custom:
            <input
              type="text"
              class="model-custom-input"
              placeholder="e.g. gpt-4o"
              :value="!isPreset(config.chatgptModel, CHATGPT_PRESETS) ? config.chatgptModel : ''"
              @input="update('chatgptModel', ($event.target as HTMLInputElement).value)"
              @focus="isPreset(config.chatgptModel, CHATGPT_PRESETS) && update('chatgptModel', '')"
            />
          </label>
        </div>
      </div>
      <div class="field" v-if="config.aiProvider === 'chatgpt'">
        <label>ChatGPT Authorization</label>
        <div class="chatgpt-auth-row">
          <button
            type="button"
            class="btn primary"
            :disabled="chatgptAuthorizing"
            @click="authorizeChatGPT"
          >
            {{ chatgptAuthorizing ? "Authorizing…" : "Authorize with ChatGPT" }}
          </button>
          <span v-if="chatgptAuthorized" class="authorized-badge">✓ Authorized</span>
          <span v-else-if="config.aiProvider === 'chatgpt'" class="auth-hint">Requires ChatGPT Plus/Pro</span>
        </div>
      </div>
      <div class="field vl-section">
        <label>VL observation model</label>
        <p class="field-hint">Vision-language model for screenshot annotation. Uses OpenRouter by default; set custom URL to use your own server.</p>
        <div class="model-radio-group">
          <label v-for="p in VL_PRESETS" :key="p.value" class="model-radio">
            <input
              type="radio"
              name="vlModel"
              :value="p.value"
              :checked="config.vlModel === p.value"
              @change="update('vlModel', p.value)"
            />
            {{ p.label }}
          </label>
          <label class="model-radio model-radio-custom">
            <input
              type="radio"
              name="vlModel"
              value="__custom__"
              :checked="!isPreset(config.vlModel ?? '', VL_PRESETS)"
              @change="update('vlModel', isPreset(config.vlModel ?? '', VL_PRESETS) ? '' : config.vlModel ?? '')"
            />
            Custom:
            <input
              type="text"
              class="model-custom-input"
              placeholder="e.g. qwen/qwen3-vl-8b-instruct"
              :value="!isPreset(config.vlModel ?? '', VL_PRESETS) ? config.vlModel : ''"
              @input="update('vlModel', ($event.target as HTMLInputElement).value)"
              @focus="isPreset(config.vlModel ?? '', VL_PRESETS) && update('vlModel', '')"
            />
          </label>
        </div>
        <div class="field vl-custom-server">
          <label for="vlApiUrl">Custom VL API URL (optional)</label>
          <input
            id="vlApiUrl"
            type="url"
            placeholder="Leave empty for OpenRouter. Or https://your-server.com/v1"
            :value="config.vlApiUrl"
            @input="update('vlApiUrl', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="field" v-if="config.vlApiUrl?.trim()">
          <label for="vlApiKey">VL API Key (required for custom server)</label>
          <input
            id="vlApiKey"
            type="password"
            placeholder="sk-... or OpenRouter key"
            :value="config.vlApiKey"
            @input="update('vlApiKey', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </template>

    <div class="actions">
      <div class="actions-main">
        <button
          v-if="status !== 'running'"
          class="btn primary"
          :disabled="status === 'starting'"
          @click="startServer"
        >
          {{ status === "starting" ? "Entering…" : "Enter control room" }}
        </button>
        <button v-else class="btn secondary" @click="stopServer">Exit control room</button>
      </div>
      <div class="actions-secondary">
      <button class="btn secondary" @click="openSecretsEditor">Secrets Editor</button>
      <button class="btn secondary" @click="openConfigsEditor">Configs Editor</button>
      <template v-if="showTestButtons">
        <button class="btn secondary" @click="wipeSecrets" title="Test: delete all secrets">Wipe secrets</button>
        <button class="btn secondary" @click="wipeConfigs" title="Test: delete all configs">Wipe configs</button>
      </template>
      <button
        v-if="status === 'running' && showTestButtons"
        class="btn secondary"
        @click="openTestPopup"
      >
        Test
      </button>
      <button class="btn secondary" @click="viewRecipe">View recipe</button>
      <button class="btn secondary" @click="saveRecipe">Save recipe</button>
      <button class="btn secondary" @click="loadRecipe">Load recipe</button>
      </div>
    </div>

    <div v-if="message" :class="['message', status]">
      {{ message }}
    </div>

    <div v-if="showSecretsEditor" class="load-recipe-overlay" @click.self="showSecretsEditor = false">
      <div class="load-recipe-modal editor-modal">
        <h3>Secrets Editor</h3>
        <p v-if="secretsError" class="editor-error">{{ secretsError }}</p>
        <div class="editor-form">
          <input v-model="secretsForm.detailed_description" type="text" placeholder="Description" class="editor-input" />
          <input v-model="secretsForm.first_factor" type="text" placeholder="First factor (e.g. user)" class="editor-input" />
          <input v-model="secretsForm.first_factor_type" type="text" placeholder="First factor type (e.g. username)" class="editor-input" />
          <input v-model="secretsForm.value" type="text" placeholder="Value (plaintext)" class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="saveSecret">{{ secretsEditingId ? "Update" : "Add" }}</button>
            <button v-if="secretsEditingId" class="btn secondary" @click="startAddSecret">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in secretsItems" :key="item.id" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.detailed_description }}</span>
              <span class="editor-row-factor">{{ item.first_factor }}</span>
              <span class="editor-row-type">{{ item.first_factor_type }}</span>
              <span class="editor-row-value">{{ item.value }}</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditSecret(item)">Edit</button>
              <button class="btn secondary small" @click="deleteSecret(item.id)">Delete</button>
            </div>
          </div>
        </div>
        <div class="load-recipe-actions">
          <button class="btn secondary" @click="startAddSecret">Add new</button>
          <button class="btn secondary" @click="showSecretsEditor = false">Close</button>
        </div>
      </div>
    </div>

    <div v-if="showConfigsEditor" class="load-recipe-overlay" @click.self="showConfigsEditor = false">
      <div class="load-recipe-modal editor-modal">
        <h3>Configs Editor</h3>
        <p v-if="configsError" class="editor-error">{{ configsError }}</p>
        <div class="editor-form">
          <input v-model="configsForm.detailed_description" type="text" placeholder="Description" class="editor-input" />
          <input v-model="configsForm.value" type="text" placeholder="Value (plaintext)" class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="saveConfigEntry">{{ configsEditingId ? "Update" : "Add" }}</button>
            <button v-if="configsEditingId" class="btn secondary" @click="startAddConfig">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in configsItems" :key="item.id" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.detailed_description }}</span>
              <span class="editor-row-value">{{ item.value }}</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditConfig(item)">Edit</button>
              <button class="btn secondary small" @click="deleteConfigEntry(item.id)">Delete</button>
            </div>
          </div>
        </div>
        <div class="load-recipe-actions">
          <button class="btn secondary" @click="startAddConfig">Add new</button>
          <button class="btn secondary" @click="showConfigsEditor = false">Close</button>
        </div>
      </div>
    </div>

    <div v-if="showTestPopup" class="load-recipe-overlay" @click.self="showTestPopup = false">
      <div class="load-recipe-modal editor-modal">
        <h3>Test VM Actions</h3>
        <div class="test-popup-section">
          <h4>Test click</h4>
          <div class="test-popup-row">
            <input
              v-model="testClickElement"
              type="text"
              placeholder="element (e.g. Submit button)"
              class="editor-input test-popup-input"
              title="Element description for localization"
            />
            <input
              v-model="testClickX"
              type="number"
              placeholder="x"
              class="editor-input test-popup-coord"
              title="X coordinate"
            />
            <input
              v-model="testClickY"
              type="number"
              placeholder="y"
              class="editor-input test-popup-coord"
              title="Y coordinate"
            />
            <button class="btn secondary" @click="testClick">Test click</button>
          </div>
        </div>
        <div class="test-popup-section">
          <h4>Test drag & drop</h4>
          <div class="test-popup-row">
            <input
              v-model="testDragFromElement"
              type="text"
              placeholder="from element"
              class="editor-input test-popup-element"
              title="Source element for localization"
            />
            <input
              v-model="testDragToElement"
              type="text"
              placeholder="to element"
              class="editor-input test-popup-element"
              title="Target element for localization"
            />
          </div>
          <div class="test-popup-row">
            <input
              v-model="testDragFromX"
              type="number"
              placeholder="from x"
              class="editor-input test-popup-coord"
            />
            <input
              v-model="testDragFromY"
              type="number"
              placeholder="from y"
              class="editor-input test-popup-coord"
            />
            <input
              v-model="testDragToX"
              type="number"
              placeholder="to x"
              class="editor-input test-popup-coord"
            />
            <input
              v-model="testDragToY"
              type="number"
              placeholder="to y"
              class="editor-input test-popup-coord"
            />
            <button class="btn secondary" @click="testDragDrop">Test drag & drop</button>
          </div>
        </div>
        <div class="test-popup-section">
          <h4>Test scroll</h4>
          <div class="test-popup-row">
            <input
              v-model="testScrollElement"
              type="text"
              placeholder="element (e.g. main content)"
              class="editor-input test-popup-element"
              title="Scrollable area for localization"
            />
            <input
              v-model="testScrollScrollY"
              type="number"
              placeholder="scrollY (+ up, - down)"
              class="editor-input test-popup-coord"
              title="Vertical scroll in wheel clicks"
            />
            <input
              v-model="testScrollScrollX"
              type="number"
              placeholder="scrollX (+ left, - right)"
              class="editor-input test-popup-coord"
              title="Horizontal scroll in wheel clicks"
            />
            <button class="btn secondary" @click="testScroll">Test scroll</button>
          </div>
          <div class="test-popup-row">
            <input
              v-model="testScrollX"
              type="number"
              placeholder="x"
              class="editor-input test-popup-coord"
              title="X coordinate (optional)"
            />
            <input
              v-model="testScrollY"
              type="number"
              placeholder="y"
              class="editor-input test-popup-coord"
              title="Y coordinate (optional)"
            />
          </div>
        </div>
        <div class="test-popup-section">
          <h4>Test key</h4>
          <div class="test-popup-row">
            <input
              v-model="testKeyInput"
              type="text"
              placeholder="Enter, Tab, ctrl+a"
              class="editor-input test-popup-key"
              title="Key to press"
            />
            <button class="btn secondary" @click="testKey">Test key</button>
          </div>
        </div>
        <div class="load-recipe-actions">
          <button class="btn secondary" @click="showTestPopup = false">Close</button>
        </div>
      </div>
    </div>

    <template v-if="status === 'running'">
      <div class="accordion">
        <button
          type="button"
          class="accordion-header"
          :aria-expanded="configOpen"
          @click="configOpen = !configOpen"
        >
          <span>Configuration</span>
          <span class="accordion-chevron">{{ configOpen ? "▼" : "▶" }}</span>
        </button>
        <div v-show="configOpen" class="accordion-body">
          <div class="field">
            <label for="vmIdAcc">VM to control</label>
            <select
              id="vmIdAcc"
              :value="config.vmId"
              @change="update('vmId', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">— Select VM —</option>
              <option v-for="vm in vms" :key="vm.id" :value="vm.id">
                {{ vm.name }} ({{ vm.status }})
              </option>
            </select>
          </div>
          <div class="field">
            <label for="aiProviderAcc">AI Provider</label>
            <select
              id="aiProviderAcc"
              :value="config.aiProvider"
              @change="update('aiProvider', ($event.target as HTMLSelectElement).value as AiProvider)"
            >
              <option value="claude">Claude</option>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
              <option value="chatgpt">ChatGPT (OAuth)</option>
            </select>
          </div>
          <div class="field" v-if="config.aiProvider === 'custom'">
            <label for="customControlApiUrlAcc">Custom API URL</label>
            <input
              id="customControlApiUrlAcc"
              type="url"
              placeholder="https://api.example.com/v1"
              :value="config.customControlApiUrl"
              @input="update('customControlApiUrl', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="field" v-if="config.aiProvider === 'custom'">
            <label for="customControlApiKeyAcc">Custom API Key</label>
            <input
              id="customControlApiKeyAcc"
              type="password"
              placeholder="sk-..."
              :value="config.customControlApiKey"
              @input="update('customControlApiKey', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="field" v-if="config.aiProvider === 'custom'">
            <label for="customControlModelAcc">Custom Model</label>
            <input
              id="customControlModelAcc"
              type="text"
              placeholder="e.g. gpt-4o"
              :value="config.customControlModel"
              @input="update('customControlModel', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="field" v-if="config.aiProvider === 'claude'">
            <label>Claude Model</label>
            <div class="model-radio-group">
              <label v-for="p in CLAUDE_PRESETS" :key="p.value" class="model-radio">
                <input
                  type="radio"
                  name="claudeModelAcc"
                  :value="p.value"
                  :checked="config.claudeModel === p.value"
                  @change="update('claudeModel', p.value)"
                />
                {{ p.label }}
              </label>
              <label class="model-radio model-radio-custom">
                <input
                  type="radio"
                  name="claudeModelAcc"
                  value="__custom__"
                  :checked="!isPreset(config.claudeModel, CLAUDE_PRESETS)"
                  @change="update('claudeModel', isPreset(config.claudeModel, CLAUDE_PRESETS) ? '' : config.claudeModel)"
                />
                Custom:
                <input
                  type="text"
                  class="model-custom-input"
                  placeholder="e.g. claude-3-5-sonnet-20241022"
                  :value="!isPreset(config.claudeModel, CLAUDE_PRESETS) ? config.claudeModel : ''"
                  @input="update('claudeModel', ($event.target as HTMLInputElement).value)"
                  @focus="isPreset(config.claudeModel, CLAUDE_PRESETS) && update('claudeModel', '')"
                />
              </label>
            </div>
          </div>
          <div class="field" v-if="config.aiProvider === 'claude'">
            <label for="claudeApiKeyAcc">Claude API Key</label>
            <input
              id="claudeApiKeyAcc"
              type="password"
              placeholder="sk-ant-..."
              :value="config.claudeApiKey"
              @input="update('claudeApiKey', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="field" v-if="config.aiProvider === 'openrouter'">
            <label>OpenRouter Model</label>
            <div class="model-radio-group">
              <label v-for="p in OPENROUTER_PRESETS" :key="p.value" class="model-radio">
                <input
                  type="radio"
                  name="openrouterModelAcc"
                  :value="p.value"
                  :checked="config.openrouterModel === p.value"
                  @change="update('openrouterModel', p.value)"
                />
                {{ p.label }}
              </label>
              <label class="model-radio model-radio-custom">
                <input
                  type="radio"
                  name="openrouterModelAcc"
                  value="__custom__"
                  :checked="!isPreset(config.openrouterModel, OPENROUTER_PRESETS)"
                  @change="update('openrouterModel', isPreset(config.openrouterModel, OPENROUTER_PRESETS) ? '' : config.openrouterModel)"
                />
                Custom:
                <input
                  type="text"
                  class="model-custom-input"
                  placeholder="e.g. anthropic/claude-3.5-sonnet"
                  :value="!isPreset(config.openrouterModel, OPENROUTER_PRESETS) ? config.openrouterModel : ''"
                  @input="update('openrouterModel', ($event.target as HTMLInputElement).value)"
                  @focus="isPreset(config.openrouterModel, OPENROUTER_PRESETS) && update('openrouterModel', '')"
                />
              </label>
            </div>
          </div>
          <div class="field" v-if="config.aiProvider === 'openrouter'">
            <label for="openrouterApiKeyAcc">OpenRouter API Key</label>
            <input
              id="openrouterApiKeyAcc"
              type="password"
              placeholder="sk-or-..."
              :value="config.openrouterApiKey"
              @input="update('openrouterApiKey', ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div class="field" v-if="config.aiProvider === 'chatgpt'">
            <label>ChatGPT Model</label>
            <div class="model-radio-group">
              <label v-for="p in CHATGPT_PRESETS" :key="p.value" class="model-radio">
                <input
                  type="radio"
                  name="chatgptModelAcc"
                  :value="p.value"
                  :checked="config.chatgptModel === p.value"
                  @change="update('chatgptModel', p.value)"
                />
                {{ p.label }}
              </label>
              <label class="model-radio model-radio-custom">
                <input
                  type="radio"
                  name="chatgptModelAcc"
                  value="__custom__"
                  :checked="!isPreset(config.chatgptModel, CHATGPT_PRESETS)"
                  @change="update('chatgptModel', isPreset(config.chatgptModel, CHATGPT_PRESETS) ? '' : config.chatgptModel)"
                />
                Custom:
                <input
                  type="text"
                  class="model-custom-input"
                  placeholder="e.g. gpt-4o"
                  :value="!isPreset(config.chatgptModel, CHATGPT_PRESETS) ? config.chatgptModel : ''"
                  @input="update('chatgptModel', ($event.target as HTMLInputElement).value)"
                  @focus="isPreset(config.chatgptModel, CHATGPT_PRESETS) && update('chatgptModel', '')"
                />
              </label>
            </div>
          </div>
          <div class="field" v-if="config.aiProvider === 'chatgpt'">
            <label>ChatGPT Authorization</label>
            <div class="chatgpt-auth-row">
              <button
                type="button"
                class="btn primary"
                :disabled="chatgptAuthorizing"
                @click="authorizeChatGPT"
              >
                {{ chatgptAuthorizing ? "Authorizing…" : "Authorize with ChatGPT" }}
              </button>
              <span v-if="chatgptAuthorized" class="authorized-badge">✓ Authorized</span>
            </div>
          </div>
          <div class="field vl-section">
            <label>VL observation model</label>
            <div class="model-radio-group">
              <label v-for="p in VL_PRESETS" :key="p.value" class="model-radio">
                <input
                  type="radio"
                  name="vlModelAcc"
                  :value="p.value"
                  :checked="config.vlModel === p.value"
                  @change="update('vlModel', p.value)"
                />
                {{ p.label }}
              </label>
              <label class="model-radio model-radio-custom">
                <input
                  type="radio"
                  name="vlModelAcc"
                  value="__custom__"
                  :checked="!isPreset(config.vlModel ?? '', VL_PRESETS)"
                  @change="update('vlModel', isPreset(config.vlModel ?? '', VL_PRESETS) ? '' : config.vlModel ?? '')"
                />
                Custom:
                <input
                  type="text"
                  class="model-custom-input"
                  placeholder="e.g. qwen/qwen3-vl-8b-instruct"
                  :value="!isPreset(config.vlModel ?? '', VL_PRESETS) ? config.vlModel : ''"
                  @input="update('vlModel', ($event.target as HTMLInputElement).value)"
                  @focus="isPreset(config.vlModel ?? '', VL_PRESETS) && update('vlModel', '')"
                />
              </label>
            </div>
            <div class="field vl-custom-server">
              <label for="vlApiUrlAcc">Custom VL API URL (optional)</label>
              <input
                id="vlApiUrlAcc"
                type="url"
                placeholder="Leave empty for OpenRouter"
                :value="config.vlApiUrl"
                @input="update('vlApiUrl', ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="field" v-if="config.vlApiUrl?.trim()">
              <label for="vlApiKeyAcc">VL API Key</label>
              <input
                id="vlApiKeyAcc"
                type="password"
                :value="config.vlApiKey"
                @input="update('vlApiKey', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="agentReady" class="chat-wrapper">
        <AgentChat ref="agentChatRef" :auto-send-first-message="config.aiProvider === 'chatgpt' ? 'hi!' : undefined" />
      </div>

    <div v-if="showLoadRecipePopup" class="load-recipe-overlay" @click.self="showLoadRecipePopup = false">
      <div class="load-recipe-modal">
        <h3>Load recipe</h3>
        <p>Please enter custom instructions to this recipe if you want to</p>
        <textarea v-model="loadRecipeInstructions" placeholder="Optional custom instructions..." rows="4" class="load-recipe-textarea" />
        <div class="load-recipe-actions">
          <button class="btn primary" @click="followRecipe">Follow</button>
          <button class="btn secondary" @click="showLoadRecipePopup = false">Cancel</button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.config {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.model-radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.model-radio {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.model-radio-custom {
  flex-wrap: wrap;
}

.model-custom-input {
  flex: 1;
  min-width: 12rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid #333;
  border-radius: 4px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.9rem;
}

.model-custom-input:focus {
  outline: none;
  border-color: #4a9eff;
}

.field-hint {
  font-size: 0.8rem;
  color: #888;
  margin: 0 0 0.5rem 0;
}

.vl-section {
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid #333;
}

.vl-custom-server {
  margin-top: 0.5rem;
}

.field label {
  font-size: 0.85rem;
  color: #aaa;
}

.field input {
  padding: 0.5rem 0.75rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.95rem;
}

.field input:focus,
.field select:focus {
  outline: none;
  border-color: #4a9eff;
}

.field select {
  padding: 0.5rem 0.75rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.95rem;
  cursor: pointer;
}

.actions {
  flex-shrink: 0;
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.actions-main {
  display: flex;
  justify-content: center;
}

.actions-secondary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.show-test-checkbox-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.9rem;
  color: #888;
  cursor: pointer;
}

.test-click-row {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.test-click-input {
  width: 4.5rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.9rem;
}

.test-click-input:focus {
  outline: none;
  border-color: #4a9eff;
}

.test-click-element {
  width: 12rem;
}

.test-key-input {
  width: 9rem;
}

.btn {
  padding: 0.6rem 1.2rem;
  border: none;
  border-radius: 6px;
  font-size: 0.95rem;
  cursor: pointer;
}

.btn.primary {
  background: #4a9eff;
  color: #fff;
}

.btn.primary:hover:not(:disabled) {
  background: #3a8eef;
}

.btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.secondary {
  background: #444;
  color: #e0e0e0;
}

.btn.secondary:hover {
  background: #555;
}

.message {
  flex-shrink: 0;
  padding: 0.75rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.message.running {
  background: #1a3a1a;
  color: #6f6;
}

.message.error {
  background: #3a1a1a;
  color: #f66;
}

.config.running {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.accordion {
  flex-shrink: 0;
  border: 1px solid #333;
  border-radius: 6px;
  overflow: hidden;
  margin-top: 0.5rem;
}

.accordion-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: #252525;
  border: none;
  color: #e0e0e0;
  font-size: 0.9rem;
  cursor: pointer;
  text-align: left;
}

.accordion-header:hover {
  background: #2a2a2a;
}

.accordion-chevron {
  color: #888;
  font-size: 0.75rem;
}

.accordion-body {
  padding: 0.75rem 1rem;
  background: #1e1e1e;
  border-top: 1px solid #333;
}

.chat-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  margin-top: 1rem;
  width: 100%;
}

.chatgpt-auth-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.authorized-badge {
  color: #6f6;
  font-size: 0.9rem;
}

.auth-hint {
  color: #888;
  font-size: 0.85rem;
}

.load-recipe-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.load-recipe-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 480px;
  width: 90%;
}

.load-recipe-modal h3 {
  margin: 0 0 0.75rem;
  font-size: 1.1rem;
}

.load-recipe-modal p {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  color: #ccc;
}

.load-recipe-textarea {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #1e1e1e;
  color: #e0e0e0;
  font-size: 0.95rem;
  font-family: inherit;
  resize: vertical;
  margin-bottom: 1rem;
}

.load-recipe-textarea:focus {
  outline: none;
  border-color: #4a9eff;
}

.load-recipe-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.editor-modal {
  max-width: 640px;
  max-height: 85vh;
  overflow: auto;
}

.editor-error {
  color: #f66;
  font-size: 0.9rem;
  margin: 0 0 0.75rem;
}

.editor-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.editor-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #1e1e1e;
  color: #e0e0e0;
  font-size: 0.95rem;
}

.editor-input:focus {
  outline: none;
  border-color: #4a9eff;
}

.editor-form-actions {
  display: flex;
  gap: 0.5rem;
}

.editor-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid #333;
  border-radius: 6px;
  background: #1e1e1e;
  margin-bottom: 1rem;
}

.editor-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #333;
  gap: 0.75rem;
}

.editor-row:last-child {
  border-bottom: none;
}

.editor-row-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.editor-row-desc {
  font-weight: 600;
  color: #8ab4e0;
}

.editor-row-factor,
.editor-row-type {
  color: #888;
}

.editor-row-value {
  word-break: break-all;
  color: #e0e0e0;
}

.editor-row-actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.35rem;
}

.btn.small {
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
}

.test-popup-section {
  margin-bottom: 1.25rem;
}

.test-popup-section h4 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  color: #aaa;
}

.test-popup-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.test-popup-input,
.test-popup-element,
.test-popup-key {
  flex: 1;
  min-width: 8rem;
}

.test-popup-coord {
  width: 4rem;
}
</style>
