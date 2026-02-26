<script setup lang="ts">
import { computed, inject, ref, onMounted, onUnmounted } from "vue";

export interface LaunchpadStatus {
  hypervisor: "loading" | "ready" | "not running";
  models: Record<string, string> | null;
  isComplete: boolean;
}

const status = inject<{ value: LaunchpadStatus }>("launchpadStatus");

const isReady = computed(
  () => status?.value.hypervisor === "ready" && status?.value.isComplete
);

const hypervisorLabel = computed(() => {
  const h = status?.value?.hypervisor ?? "loading";
  if (h === "ready") return "ready";
  if (h === "not running") return "pending";
  return "pending";
});

const hypervisorClass = computed(() => {
  const h = status?.value?.hypervisor ?? "loading";
  return "hypervisor-" + String(h).replace(/\s+/g, "-");
});

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  web_form: "Forms parser",
  ocr: "OCR",
  omni_parser: "Icon detection",
  ui_elements: "UI classification",
  checkbox: "Checkbox detection",
  icon_classification: "Icon Classification",
};

function modelDisplayName(key: string): string {
  return MODEL_DISPLAY_NAMES[key] ?? key.replace(/_/g, " ");
}

const iconModelProgress = ref<string | null>(null);
const localizationModelProgress = ref<string | null>(null);
const hypervisorStartStatus = ref<{ phase: "starting" | "ready" | "failed"; message?: string } | null>(null);
const aiStartStatus = ref<{ phase: "starting" | "ready" | "failed"; message?: string } | null>(null);
let iconModelProgressCleanup: (() => void) | undefined;
let localizationModelProgressCleanup: (() => void) | undefined;
let hypervisorStartCleanup: (() => void) | undefined;
let aiStartCleanup: (() => void) | undefined;

function formatProgress(p: {
  phase: string;
  fractionCompleted?: number;
  bytesReceived?: number;
  bytesTotal?: number;
  speedMBps?: number;
}): string {
  if (p.fractionCompleted == null) return p.phase;
  const pct = `${Math.round(p.fractionCompleted * 100)}%`;
  if (p.bytesReceived != null && p.bytesTotal != null) {
    const mbR = (p.bytesReceived / (1024 * 1024)).toFixed(1);
    const mbT = (p.bytesTotal / (1024 * 1024)).toFixed(1);
    const speed = p.speedMBps != null ? ` ${p.speedMBps.toFixed(1)} MB/s` : "";
    return `${p.phase} ${pct} (${mbR} / ${mbT} MB${speed})`;
  }
  return `${p.phase} ${pct}`;
}

onMounted(() => {
  iconModelProgressCleanup = window.electronAPI?.onIconModelProgress?.((p) => {
    if (p.fractionCompleted === 1) {
      iconModelProgress.value = null;
    } else {
      iconModelProgress.value = formatProgress(p);
    }
  });
  localizationModelProgressCleanup = window.electronAPI?.onLocalizationModelProgress?.((p) => {
    if (p.fractionCompleted === 1) {
      localizationModelProgress.value = null;
    } else {
      localizationModelProgress.value = formatProgress(p);
    }
  });
  hypervisorStartCleanup = window.electronAPI?.onHypervisorStartProgress?.((p) => {
    hypervisorStartStatus.value = p;
  });
  aiStartCleanup = window.electronAPI?.onAiStartProgress?.((p) => {
    aiStartStatus.value = p;
  });
});

onUnmounted(() => {
  iconModelProgressCleanup?.();
  localizationModelProgressCleanup?.();
  hypervisorStartCleanup?.();
  aiStartCleanup?.();
  iconModelProgress.value = null;
  localizationModelProgress.value = null;
  hypervisorStartStatus.value = null;
  aiStartStatus.value = null;
});
</script>

<template>
  <section class="launchpad">
    <h2 class="launchpad-title">Launchpad</h2>
    <div v-if="isReady" class="launchpad-ready">
      Ready to launch
    </div>
    <template v-else>
      <div class="launchpad-not-ready">
        Not ready to launch
      </div>
      <div v-if="iconModelProgress" class="launchpad-message">
        Icon: {{ iconModelProgress }}
      </div>
      <div v-if="localizationModelProgress" class="launchpad-message">
        Localization: {{ localizationModelProgress }}
      </div>
      <div v-if="hypervisorStartStatus" class="launchpad-message" :class="'start-' + hypervisorStartStatus.phase">
        Hypervisor: {{ hypervisorStartStatus.message ?? hypervisorStartStatus.phase }}
      </div>
      <div v-if="aiStartStatus" class="launchpad-message" :class="'start-' + aiStartStatus.phase">
        AI service: {{ aiStartStatus.message ?? aiStartStatus.phase }}
      </div>
      <div class="launchpad-details">
        <div class="launchpad-row">
          <span class="launchpad-label">Hypervisor:</span>
          <span :class="['launchpad-value', hypervisorClass]">
            {{ hypervisorLabel }}
          </span>
        </div>
        <div v-if="status?.value?.models" class="launchpad-row">
          <span class="launchpad-label">Models:</span>
          <span class="launchpad-models">
            <span
              v-for="(s, name) in (status?.value?.models ?? {})"
              :key="name"
              :class="['model-chip', 'model-' + s]"
            >
              {{ modelDisplayName(name) }}: {{ s }}
            </span>
          </span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.launchpad {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
}

.launchpad-title {
  margin: 0 0 0.75rem 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.launchpad-ready {
  font-size: 1.5rem;
  font-weight: 700;
  color: #6f6;
  letter-spacing: 0.02em;
}

.launchpad-not-ready {
  font-size: 1.5rem;
  font-weight: 700;
  color: #fa0;
  letter-spacing: 0.02em;
  margin-bottom: 0.75rem;
}

.launchpad-message {
  font-size: 0.9rem;
  color: #fa0;
  margin-bottom: 0.5rem;
}

.launchpad-details {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.launchpad-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.launchpad-label {
  color: #888;
  min-width: 5.5rem;
}

.launchpad-value {
  font-weight: 500;
}

.hypervisor-ready {
  color: #6f6;
}

.hypervisor-loading,
.hypervisor-pending {
  color: #fa0;
}

.hypervisor-not-running {
  color: #f66;
}

.start-starting {
  color: #fa0;
}

.start-ready {
  color: #6f6;
}

.start-failed {
  color: #f66;
}

.launchpad-models {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.model-chip {
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  font-size: 0.75rem;
}

.model-chip.model-ready {
  background: rgba(111, 255, 111, 0.15);
  color: #6f6;
}

.model-chip.model-loading {
  background: rgba(250, 200, 0, 0.15);
  color: #fa0;
}

.model-chip.model-pending {
  background: rgba(136, 136, 136, 0.2);
  color: #888;
}

.model-chip.model-unavailable {
  background: rgba(255, 68, 68, 0.15);
  color: #f66;
}
</style>
