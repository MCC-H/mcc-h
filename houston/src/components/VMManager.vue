<script setup lang="ts">
import { ref, inject, onMounted, onUnmounted, watch, computed } from "vue";

const refreshVmList = inject<() => void>("refreshVmList");
const showTestButtonsRef = inject<{ value: boolean }>("showTestButtons");
const showTestButtons = computed(() => showTestButtonsRef?.value ?? false);
const vms = ref<VmInfo[]>([]);
const creating = ref(false);
const message = ref("");
const screenshotData = ref<string | null>(null);
const ocrResult = ref<string | null>(null);
const ocrLoading = ref(false);
const overlayData = ref<{
  image: string;
  centers: { x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number; label: string; text: string; kind: "icon" | "text" }[];
  imgW: number;
  imgH: number;
  visionDescription?: string;
  visionVmId?: string;
  overlayVmId?: string;  // vmId for drawing overlay on VM screen
  rawJson?: string;
} | null>(null);
const showRawOcr = ref(false);
const overlayHovered = ref<{ label: string; text: string } | null>(null);
const overlayLoading = ref(false);
const visionLoading = ref(false);
const omniParserLoading = ref(false);
const enableOverlayLoading = ref(false);
const customScreenshotBase64 = ref<string | null>(null);
const keystrokeInput = ref("");
const showKeystrokeModal = ref(false);
const keystrokeVmId = ref("");
const showCreateVmModal = ref(false);
const createVmGuestType = ref<"linux" | "macos">("linux");
const createVmRamGb = ref(4);
const createVmDiskGb = ref(20);
const createVmIsoPath = ref("");
const createVmIpswPath = ref("");
const installProgressPoll = ref<ReturnType<typeof setInterval> | null>(null);
const installProgressByVm = ref<Record<string, string>>({});
const showIconTestModal = ref(false);
const iconTestImages = ref<string[]>([]);
const iconTestCaptions = ref<{ label: string; description: string }[]>([]);
const iconTestLoading = ref(false);
const iconTestResult = ref("");
const iconTestDropDragover = ref(false);
const iconTestFileInput = ref<HTMLInputElement | null>(null);
const vmListRefreshTrigger = inject<{ value: number }>("vmListRefreshTrigger");

function openIconTestModal() {
  iconTestImages.value = [];
  iconTestCaptions.value = [];
  iconTestResult.value = "";
  showIconTestModal.value = true;
}

function addIconTestFiles(files: FileList | File[]) {
  const arr = Array.from(files);
  for (const f of arr) {
    if (!f.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      if (b64) {
        iconTestImages.value = [...iconTestImages.value, b64];
      }
    };
    reader.readAsDataURL(f);
  }
}

async function getIconLabels() {
  if (iconTestImages.value.length === 0) return;
  iconTestLoading.value = true;
  iconTestResult.value = "Loading…";
  try {
    const images = JSON.parse(JSON.stringify(iconTestImages.value)) as string[];
    const r = await window.electronAPI?.vmIconCaptions?.(images);
    if (r?.ok && r.captions) {
      iconTestCaptions.value = r.captions;
      iconTestResult.value = `Done. ${r.captions.length} labels.`;
    } else {
      iconTestResult.value = r?.error ?? "Icon caption failed";
    }
  } catch (e) {
    iconTestResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    iconTestLoading.value = false;
  }
}

async function getIconLabelsHolo() {
  if (iconTestImages.value.length === 0) return;
  iconTestLoading.value = true;
  iconTestResult.value = "Loading (Holo)…";
  try {
    const images = JSON.parse(JSON.stringify(iconTestImages.value)) as string[];
    const r = await window.electronAPI?.vmIconCaptionsHolo?.(images);
    if (r?.ok && r.captions) {
      iconTestCaptions.value = r.captions;
      iconTestResult.value = `Done (Holo). ${r.captions.length} labels.`;
    } else {
      iconTestResult.value = r?.error ?? "Holo icon caption failed";
    }
  } catch (e) {
    iconTestResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    iconTestLoading.value = false;
  }
}

function onIconTestPaste(e: ClipboardEvent) {
  if (!showIconTestModal.value) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    e.preventDefault();
    addIconTestFiles(files);
  }
}

async function load() {
  if (!window.electronAPI?.vmList) return;
  vms.value = await window.electronAPI.vmList();
}

function openCreateVmModal() {
  createVmGuestType.value = "linux";
  createVmRamGb.value = 4;
  createVmDiskGb.value = 20;
  createVmIsoPath.value = "";
  createVmIpswPath.value = "";
  showCreateVmModal.value = true;
}

watch(createVmGuestType, (t) => {
  if (t === "macos") {
    createVmRamGb.value = 4;
    createVmDiskGb.value = 32;
  } else {
    createVmRamGb.value = 4;
    createVmDiskGb.value = 20;
  }
});

watch(
  () => vmListRefreshTrigger?.value ?? 0,
  async (val) => {
    if (val > 0) await load();
  }
);

onMounted(() => {
  load();
});

onUnmounted(() => {
  if (installProgressPoll.value) clearInterval(installProgressPoll.value);
  document.removeEventListener("paste", onIconTestPaste);
});

watch(showIconTestModal, (open) => {
  if (open) {
    document.addEventListener("paste", onIconTestPaste);
  } else {
    document.removeEventListener("paste", onIconTestPaste);
  }
});

watch(overlayData, async (data) => {
  if (!window.electronAPI?.vmSetOverlay) return;
  const vmId = data?.overlayVmId ?? data?.visionVmId;
  if (!vmId) return;
  if (data && data.centers.length > 0) {
    await window.electronAPI.vmSetOverlay(vmId, {
      centers: data.centers,
      imgW: data.imgW,
      imgH: data.imgH,
    });
  } else {
    await window.electronAPI.vmSetOverlay(vmId, null);
  }
}, { immediate: true });

function startInstallProgressPoll(vmId: string) {
  installProgressByVm.value = {};
  if (installProgressPoll.value) clearInterval(installProgressPoll.value);
  installProgressPoll.value = setInterval(async () => {
    const r = await window.electronAPI?.vmInstallProgress?.(vmId);
    if (r?.ok && r.phase && r.fractionCompleted != null) {
      const pct = Math.round((r.fractionCompleted ?? 0) * 100);
      const msg = `${r.phase}: ${pct}%`;
      message.value = msg;
      installProgressByVm.value = { ...installProgressByVm.value, [vmId]: msg };
    } else if (r?.ok && r.phase) {
      message.value = r.phase;
      installProgressByVm.value = { ...installProgressByVm.value, [vmId]: r.phase };
    }
    const vms = await window.electronAPI?.vmList?.() ?? [];
    const vm = vms.find((v) => v.id === vmId);
    if (vm && vm.status !== "installing") {
      if (installProgressPoll.value) clearInterval(installProgressPoll.value);
      installProgressPoll.value = null;
      message.value = "";
      installProgressByVm.value = {};
      await load();
      refreshVmList?.();
    }
  }, 1000);
}

async function browseIso() {
  if (!window.electronAPI?.showOpenDialog) return;
  const path = await window.electronAPI.showOpenDialog({
    title: "Select Debian ISO",
    filters: [{ name: "ISO images", extensions: ["iso"] }],
  });
  if (path) createVmIsoPath.value = path;
}

async function browseIpsw() {
  if (!window.electronAPI?.showOpenDialog) return;
  const path = await window.electronAPI.showOpenDialog({
    title: "Select macOS restore image (IPSW)",
    filters: [{ name: "IPSW images", extensions: ["ipsw"] }],
  });
  if (path) createVmIpswPath.value = path;
}

async function createVm() {
  if (!window.electronAPI?.vmCreate) return;
  creating.value = true;
  message.value = "";
  try {
    const ramMb = Math.max(4096, Math.min(65536, Math.round((createVmRamGb.value || 4) * 1024)));
    const diskGb = Math.max(8, Math.min(512, createVmDiskGb.value)) || 20;
    const options: { guestType: "linux" | "macos"; isoPath?: string; ipswPath?: string; ramMb?: number; diskGb?: number } = {
      guestType: createVmGuestType.value,
      ramMb,
      diskGb,
    };
    if (createVmGuestType.value === "linux") {
      const p = createVmIsoPath.value.trim();
      if (p) options.isoPath = p;
    } else if (createVmGuestType.value === "macos") {
      const p = createVmIpswPath.value.trim();
      if (p) {
        if (window.electronAPI?.vmCheckIpsw) {
          const check = await window.electronAPI.vmCheckIpsw(p);
          if (check.ok && check.supported === false) {
            const download = window.confirm(
              "Your selected IPSW is not supported on this host.\n\nWould you like to download the latest supported IPSW instead?"
            );
            if (download) {
              options.ipswPath = undefined;
            } else {
              creating.value = false;
              return;
            }
          } else {
            options.ipswPath = p;
          }
        } else {
          options.ipswPath = p;
        }
      }
    }
    const r = await window.electronAPI.vmCreate(options);
    if (r.ok && r.vm) {
      showCreateVmModal.value = false;
      await load();
      refreshVmList?.();
      if (r.vm.status === "installing") {
        startInstallProgressPoll(r.vm.id);
      }
    } else {
      message.value = r.error ?? "Failed to create VM";
    }
  } finally {
    creating.value = false;
  }
}

async function startVm(vmId: string) {
  if (!window.electronAPI?.vmStart) return;
  message.value = "";
  const r = await window.electronAPI.vmStart(vmId);
  if (r.ok) {
    await load();
    refreshVmList?.();
  } else {
    message.value = r.error ?? "Failed to start VM";
  }
}

async function stopVm(vmId: string) {
  if (!window.electronAPI?.vmStop) return;
  message.value = "";
  const r = await window.electronAPI.vmStop(vmId);
  if (r.ok) {
    await load();
    refreshVmList?.();
  } else {
    message.value = r.error ?? "Failed to stop VM";
  }
}

async function deleteVm(vmId: string) {
  if (!window.confirm(`Delete VM Houston-${vmId}? This cannot be undone.`)) return;
  if (!window.electronAPI?.vmDelete) return;
  message.value = "";
  const r = await window.electronAPI.vmDelete(vmId);
  if (r.ok) {
    await load();
    refreshVmList?.();
  } else {
    message.value = r.error ?? "Failed to delete VM";
  }
}

async function showConsole(vmId: string) {
  if (!window.electronAPI?.vmShowConsole) return;
  message.value = "";
  const r = await window.electronAPI.vmShowConsole(vmId);
  if (!r.ok) message.value = r.error ?? "Failed to show console";
}

async function takeScreenshot(vmId: string) {
  if (!window.electronAPI?.vmScreenshot) return;
  message.value = "";
  const r = await window.electronAPI.vmScreenshot(vmId);
  if (r.ok && r.pngBase64) {
    screenshotData.value = `data:image/png;base64,${r.pngBase64}`;
  } else {
    message.value = r.error ?? "Failed to take screenshot";
  }
}

function downloadScreenshot() {
  if (!screenshotData.value) return;
  const link = document.createElement("a");
  link.href = screenshotData.value;
  link.download = `houston-screenshot-${Date.now()}.png`;
  link.click();
}

async function selectCustomScreenshot() {
  if (!window.electronAPI?.selectCustomScreenshot) return;
  const r = await window.electronAPI.selectCustomScreenshot();
  if (r.ok && r.pngBase64) {
    customScreenshotBase64.value = r.pngBase64;
    message.value = "Custom screenshot selected";
  } else {
    if (r.error && !r.error.includes("No file selected")) {
      message.value = r.error;
    }
  }
}

async function testOcr(vmId: string) {
  if (!window.electronAPI?.vmTestOcr) return;
  message.value = "";
  ocrLoading.value = true;
  ocrResult.value = null;
  try {
    const r = await window.electronAPI.vmTestOcr(vmId, customScreenshotBase64.value ?? undefined);
    if (r.ok && r.text) {
      ocrResult.value = r.text;
    } else {
      message.value = r.error ?? "OCR failed";
    }
  } finally {
    ocrLoading.value = false;
  }
}

type OcrCenter = {
  x: number;
  y: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  label: string;
  text: string;
  kind: "icon" | "text";
};

function parseOcrCenters(text: string): { centers: OcrCenter[]; imgW: number; imgH: number } | null {
  let data: { image?: number[]; checkboxes?: unknown[]; ui_elements?: unknown[]; texts?: unknown[] };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return null;
  }
  const img = Array.isArray(data.image) && data.image.length >= 2 ? data.image : [1920, 1200];
  const imgW = Number(img[0]) || 1920;
  const imgH = Number(img[1]) || 1200;
  const centers: OcrCenter[] = [];

  function parseCenter(c: Record<string, unknown>): { x: number; y: number; x1?: number; y1?: number; x2?: number; y2?: number } {
    const center = c.center as number[] | undefined;
    const bbox = c.bbox2d as number[] | undefined;
    const x = center?.[0] ?? Number(c.x) ?? 0;
    const y = center?.[1] ?? Number(c.y) ?? 0;
    const x1 = bbox?.[0] ?? (c.x1 != null ? Number(c.x1) : undefined);
    const y1 = bbox?.[1] ?? (c.y1 != null ? Number(c.y1) : undefined);
    const x2 = bbox?.[2] ?? (c.x2 != null ? Number(c.x2) : undefined);
    const y2 = bbox?.[3] ?? (c.y2 != null ? Number(c.y2) : undefined);
    return { x, y, x1, y1, x2, y2 };
  }

  for (const cb of data.checkboxes ?? []) {
    const c = cb as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(c);
    const state = String(c.state ?? "");
    const label = state === "checked" ? "checkbox✓" : "checkbox";
    centers.push({ x, y, x1, y1, x2, y2, label, text: String(c.text ?? ""), kind: "icon" });
  }

  for (const rb of data.radio_buttons ?? []) {
    const r = rb as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(r);
    const state = String(r.state ?? "");
    const label = state === "checked" ? "radio✓" : "radio";
    centers.push({ x, y, x1, y1, x2, y2, label, text: String(r.text ?? ""), kind: "icon" });
  }

  for (const el of data.ui_elements ?? []) {
    const e = el as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(e);
    centers.push({
      x, y, x1, y1, x2, y2,
      label: String(e.label ?? "element"),
      text: String(e.caption ?? ""),
      kind: "icon",
    });
  }

  for (const t of data.texts ?? []) {
    const item = t as Record<string, unknown>;
    const { x, y, x1, y1, x2, y2 } = parseCenter(item);
    const color = String(item.color ?? "default");
    centers.push({ x, y, x1, y1, x2, y2, label: `text (${color})`, text: String(item.text ?? ""), kind: "text" });
  }

  return { centers, imgW, imgH };
}

async function enableOverlayOnVm(vmId: string) {
  if (!window.electronAPI?.vmTestOcrOverlay || !window.electronAPI?.vmSetOverlay) return;
  message.value = "";
  enableOverlayLoading.value = true;
  try {
    const r = await window.electronAPI.vmTestOcrOverlay(vmId, customScreenshotBase64.value ?? undefined);
    if (r.ok && r.text) {
      const parsed = parseOcrCenters(r.text);
      if (parsed && parsed.centers.length > 0) {
        await window.electronAPI.vmSetOverlay(vmId, {
          centers: parsed.centers,
          imgW: parsed.imgW,
          imgH: parsed.imgH,
        });
        message.value = `Overlay enabled (${parsed.centers.length} elements)`;
      } else {
        message.value = parsed ? "No elements to overlay" : "OCR response is not valid JSON";
      }
    } else {
      message.value = r.error ?? "OCR overlay failed";
    }
  } finally {
    enableOverlayLoading.value = false;
  }
}

async function testOcrOverlay(vmId: string) {
  if (!window.electronAPI?.vmTestOcrOverlay) return;
  message.value = "";
  overlayLoading.value = true;
  overlayData.value = null;
  try {
    const r = await window.electronAPI.vmTestOcrOverlay(vmId, customScreenshotBase64.value ?? undefined);
    if (r.ok && r.text && r.pngBase64) {
      const parsed = parseOcrCenters(r.text);
      if (!parsed) {
        message.value = "OCR response is not valid JSON";
        return;
      }
      overlayData.value = {
        image: `data:image/png;base64,${r.pngBase64}`,
        centers: parsed.centers,
        imgW: parsed.imgW,
        imgH: parsed.imgH,
        overlayVmId: vmId,
        rawJson: r.text,
      };
      showRawOcr.value = false;
    } else {
      message.value = r.error ?? "OCR overlay failed";
    }
  } finally {
    overlayLoading.value = false;
  }
}

async function testOcrVision(vmId: string) {
  if (!window.electronAPI?.vmTestOcrVision) return;
  message.value = "";
  visionLoading.value = true;
  overlayData.value = null;
  try {
    const r = await window.electronAPI.vmTestOcrVision(vmId, {
      imageBase64: customScreenshotBase64.value ?? undefined,
    });
    if (r.ok && r.text && r.pngBase64) {
      const parsed = parseOcrCenters(r.text);
      if (!parsed) {
        message.value = "OCR+Vision response is not valid JSON";
        return;
      }
      let visionDescription: string | undefined;
      try {
        const data = JSON.parse(r.text) as { vision_description?: string };
        visionDescription = data.vision_description?.trim() || undefined;
      } catch {
        /* ignore */
      }
      overlayData.value = {
        image: `data:image/png;base64,${r.pngBase64}`,
        centers: parsed.centers,
        imgW: parsed.imgW,
        imgH: parsed.imgH,
        visionDescription,
        visionVmId: vmId,
        overlayVmId: vmId,
        rawJson: r.text,
      };
      showRawOcr.value = false;
    } else {
      message.value = r.error ?? "OCR+Vision failed";
    }
  } finally {
    visionLoading.value = false;
  }
}

async function detectChanges() {
  const vmId = overlayData.value?.visionVmId;
  if (!vmId || !window.electronAPI?.vmTestOcrVision) return;
  visionLoading.value = true;
  message.value = "";
  try {
    const r = await window.electronAPI.vmTestOcrVision(vmId, { freshView: false });
    if (r.ok && r.text && r.pngBase64) {
      const parsed = parseOcrCenters(r.text);
      if (!parsed) {
        message.value = "OCR+Vision response is not valid JSON";
        return;
      }
      let visionDescription: string | undefined;
      try {
        const data = JSON.parse(r.text) as { vision_description?: string };
        visionDescription = data.vision_description?.trim() || undefined;
      } catch {
        /* ignore */
      }
      overlayData.value = {
        image: `data:image/png;base64,${r.pngBase64}`,
        centers: parsed.centers,
        imgW: parsed.imgW,
        imgH: parsed.imgH,
        visionDescription,
        visionVmId: vmId,
      };
    } else {
      message.value = r.error ?? "OCR+Vision changes failed";
    }
  } finally {
    visionLoading.value = false;
  }
}

async function testOcrOmniParser(vmId: string) {
  if (!window.electronAPI?.vmTestOcrOmniParser) return;
  message.value = "";
  omniParserLoading.value = true;
  overlayData.value = null;
  try {
    const r = await window.electronAPI.vmTestOcrOmniParser(vmId, {
      confidenceThreshold: 0.15,
      imageBase64: customScreenshotBase64.value ?? undefined,
    });
    if (r.ok && r.text && r.pngBase64) {
      const parsed = parseOcrCenters(r.text);
      if (!parsed) {
        message.value = "OCR response is not valid JSON";
        return;
      }
      overlayData.value = {
        image: `data:image/png;base64,${r.pngBase64}`,
        centers: parsed.centers,
        imgW: parsed.imgW,
        imgH: parsed.imgH,
        overlayVmId: vmId,
        rawJson: r.text,
      };
      showRawOcr.value = false;
    } else {
      message.value = r.error ?? "OmniParser failed";
    }
  } finally {
    omniParserLoading.value = false;
  }
}

async function sendClick(vmId: string) {
  if (!window.electronAPI?.vmClick) return;
  message.value = "";
  const r = await window.electronAPI.vmClick(vmId);
  if (!r.ok) message.value = r.error ?? "Failed to send click";
}

function openKeystrokeModal(vmId: string) {
  keystrokeVmId.value = vmId;
  keystrokeInput.value = "";
  showKeystrokeModal.value = true;
}

async function sendKeystroke() {
  if (!window.electronAPI?.vmPress || !keystrokeInput.value.trim()) return;
  message.value = "";
  const r = await window.electronAPI.vmPress(keystrokeVmId.value, keystrokeInput.value.trim());
  showKeystrokeModal.value = false;
  if (!r.ok) message.value = r.error ?? "Failed to send keystroke";
}

</script>

<template>
  <div class="vm-manager">
    <div class="vm-header">
      <h2>VMs</h2>
      <div class="vm-header-buttons">
        <template v-if="showTestButtons">
          <button
            class="btn secondary"
            @click="openIconTestModal"
            title="Test icon caption: drop, paste (Ctrl+V), or select images"
          >
            Test icon caption
          </button>
          <button
            class="btn secondary"
            @click="openIconTestModal"
            title="Test icon caption with Holo model"
          >
            Test icon caption (Holo)
          </button>
          <button
            class="btn secondary"
            @click="selectCustomScreenshot"
            title="Use a local image instead of VM screenshot for OCR"
          >
            {{ customScreenshotBase64 ? "Custom screenshot ✓" : "Select custom screenshot" }}
          </button>
          <button
            v-if="customScreenshotBase64"
            class="btn small"
            @click="customScreenshotBase64 = null"
            title="Clear custom screenshot"
          >
            Clear
          </button>
        </template>
        <button class="btn primary" :disabled="creating" @click="openCreateVmModal">
          {{ creating ? "Creating…" : "Create VM" }}
        </button>
      </div>
    </div>

    <div v-if="message" :class="['message', message.includes('%') ? 'progress' : 'error']">{{ message }}</div>

    <div v-if="screenshotData" class="screenshot-modal" @click.self="screenshotData = null">
      <div class="screenshot-content">
        <img :src="screenshotData" alt="VM screenshot" />
        <div class="modal-buttons">
          <button class="btn small" @click="downloadScreenshot">Download</button>
          <button class="btn small" @click="screenshotData = null">Close</button>
        </div>
      </div>
    </div>

    <div v-if="ocrResult !== null" class="screenshot-modal" @click.self="ocrResult = null">
      <div class="screenshot-content ocr-result">
        <label>OCR result (image size, checkboxes, ui_elements, texts):</label>
        <pre class="ocr-text">{{ ocrResult }}</pre>
        <div class="modal-buttons">
          <button class="btn small" @click="ocrResult = null">Close</button>
        </div>
      </div>
    </div>

    <div v-if="overlayData" class="screenshot-modal" @click.self="overlayData = null">
      <div class="screenshot-content overlay-content">
        <label>Screenshot + OCR overlay ({{ overlayData.centers.length }} points)</label>
        <div
          class="overlay-wrapper"
          @mouseleave="overlayHovered = null"
        >
          <div
            v-if="overlayHovered"
            class="overlay-tooltip"
          >
            {{ overlayHovered.text ? `${overlayHovered.label}: ${overlayHovered.text}` : overlayHovered.label }}
          </div>
          <img :src="overlayData.image" alt="VM screenshot with overlay" />
          <div class="overlay-boxes">
            <div
              v-for="(c, i) in overlayData.centers"
              v-show="c.x1 != null && c.y1 != null && c.x2 != null && c.y2 != null"
              :key="'box-' + i"
              :class="['overlay-box', c.kind === 'text' ? 'overlay-box-text' : 'overlay-box-icon']"
              :style="{
                left: ((c.x1 ?? 0) / overlayData.imgW) * 100 + '%',
                top: ((c.y1 ?? 0) / overlayData.imgH) * 100 + '%',
                width: (((c.x2 ?? 0) - (c.x1 ?? 0)) / overlayData.imgW) * 100 + '%',
                height: (((c.y2 ?? 0) - (c.y1 ?? 0)) / overlayData.imgH) * 100 + '%',
              }"
              @mouseenter="overlayHovered = { label: c.label, text: c.text }"
            />
          </div>
          <div class="overlay-dots">
            <span
              v-for="(c, i) in overlayData.centers"
              :key="i"
              :class="['overlay-dot', c.kind === 'text' ? 'overlay-dot-text' : 'overlay-dot-icon']"
              :style="{
                left: (c.x / overlayData.imgW) * 100 + '%',
                top: (c.y / overlayData.imgH) * 100 + '%',
              }"
              @mouseenter="overlayHovered = { label: c.label, text: c.text }"
            />
          </div>
        </div>
        <div v-if="overlayData.visionDescription" class="vision-description">
          <label>Vision</label>
          <pre class="vision-text">{{ overlayData.visionDescription }}</pre>
        </div>
        <div v-if="overlayData.rawJson" class="raw-ocr-section">
          <button
            class="btn small"
            @click="showRawOcr = !showRawOcr"
          >
            {{ showRawOcr ? "Hide raw OCR" : "Show raw OCR" }}
          </button>
          <pre v-show="showRawOcr" class="ocr-text raw-ocr-text">{{ overlayData.rawJson }}</pre>
        </div>
        <div class="modal-buttons">
          <button
            v-if="overlayData.visionVmId"
            class="btn small"
            :disabled="visionLoading"
            @click="detectChanges"
          >
            {{ visionLoading ? "Detecting…" : "Detect changes" }}
          </button>
          <button class="btn small" @click="overlayData = null">Close</button>
        </div>
      </div>
    </div>

    <div v-if="showCreateVmModal" class="screenshot-modal" @click.self="showCreateVmModal = false">
      <div class="screenshot-content create-vm-modal">
        <h3 class="create-vm-title">Create VM</h3>
        <div class="create-vm-section">
          <label>Guest OS</label>
          <table class="create-vm-guest-type">
            <tbody>
              <tr>
                <td class="guest-radio-cell">
                  <input id="guest-linux" v-model="createVmGuestType" type="radio" value="linux" />
                </td>
                <td>
                  <label for="guest-linux">Linux</label>
                </td>
              </tr>
              <tr>
                <td class="guest-radio-cell">
                  <input id="guest-macos" v-model="createVmGuestType" type="radio" value="macos" />
                </td>
                <td>
                  <label for="guest-macos">macOS (select ipsw or auto-download)</label>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="create-vm-section">
          <label>Resources</label>
          <div class="create-vm-resources">
            <div class="create-vm-resource-row">
              <label class="create-vm-resource-label">RAM (GB)</label>
              <input
                v-model.number="createVmRamGb"
                type="number"
                min="4"
                max="64"
                step="1"
              />
            </div>
            <div class="create-vm-resource-row">
              <label class="create-vm-resource-label">Disk (GB)</label>
              <input
                v-model.number="createVmDiskGb"
                type="number"
                min="8"
                max="512"
                step="1"
              />
            </div>
          </div>
        </div>
        <div class="create-vm-section">
          <template v-if="createVmGuestType === 'linux'">
            <label>Linux ISO (optional — Debian will be downloaded if empty)</label>
            <div class="create-vm-iso-row">
              <input
                v-model="createVmIsoPath"
                type="text"
                placeholder="Leave empty to download Debian"
              />
              <button class="btn small" @click="browseIso">Browse…</button>
            </div>
          </template>
          <template v-else-if="createVmGuestType === 'macos'">
            <label>macOS restore image (optional — checks ~/houston/ISOs/*.ipsw or downloads latest)</label>
            <div class="create-vm-iso-row">
              <input
                v-model="createVmIpswPath"
                type="text"
                placeholder="/path/to/UniversalMac_15.0_24A335_Restore.ipsw"
              />
              <button class="btn small" @click="browseIpsw">Browse…</button>
            </div>
          </template>
        </div>
        <div class="modal-buttons">
          <button class="btn primary" :disabled="creating" @click="createVm">Create VM</button>
          <button class="btn small" @click="showCreateVmModal = false">Cancel</button>
        </div>
      </div>
    </div>

    <div v-if="showKeystrokeModal" class="screenshot-modal" @click.self="showKeystrokeModal = false">
      <div class="screenshot-content">
        <label>Key (e.g. Enter, Tab, Escape, Space):</label>
        <input v-model="keystrokeInput" type="text" placeholder="Enter" @keydown.enter="sendKeystroke" />
        <div class="modal-buttons">
          <button class="btn small" @click="sendKeystroke">Send</button>
          <button class="btn small" @click="showKeystrokeModal = false">Cancel</button>
        </div>
      </div>
    </div>

    <div v-if="showIconTestModal" class="screenshot-modal" @click.self="showIconTestModal = false">
      <div class="screenshot-content icon-test-content">
        <h3>Test icon caption</h3>
        <p class="icon-test-hint">Drop, paste (Ctrl+V), or click to select icon images. Try Qwen (Icon Classification) or Holo for captions.</p>
        <div
          class="icon-test-drop"
          :class="{ dragover: iconTestDropDragover }"
          @click="iconTestFileInput?.click()"
          @dragover.prevent="iconTestDropDragover = true"
          @dragleave="iconTestDropDragover = false"
          @drop.prevent="addIconTestFiles($event.dataTransfer?.files ?? []); iconTestDropDragover = false"
        >
          Drop images here or click to select
        </div>
        <input
          ref="iconTestFileInput"
          type="file"
          accept="image/*"
          multiple
          style="display: none"
          @change="addIconTestFiles(($event.target as HTMLInputElement)?.files ?? [])"
        />
        <div class="icon-test-preview">
          <div
            v-for="(b64, i) in iconTestImages"
            :key="i"
            class="icon-test-item"
          >
            <img :src="'data:image/png;base64,' + b64" alt="" />
            <div class="icon-test-cap">
              <span v-if="iconTestCaptions[i]" class="icon-test-label">{{ iconTestCaptions[i].label }}</span>
              <span v-if="iconTestCaptions[i]?.description" class="icon-test-desc">{{ iconTestCaptions[i].description }}</span>
              <span v-else-if="!iconTestLoading && iconTestCaptions.length === 0">—</span>
            </div>
          </div>
        </div>
        <div class="icon-test-buttons">
          <button
            class="btn primary"
            :disabled="iconTestImages.length === 0 || iconTestLoading"
            @click="getIconLabels"
          >
            {{ iconTestLoading ? "Loading…" : "Get labels (Qwen)" }}
          </button>
          <button
            class="btn secondary"
            :disabled="iconTestImages.length === 0 || iconTestLoading"
            @click="getIconLabelsHolo"
          >
            {{ iconTestLoading ? "Loading…" : "Get labels (Holo)" }}
          </button>
        </div>
        <div v-if="iconTestResult" class="icon-test-result">{{ iconTestResult }}</div>
        <div class="modal-buttons">
          <button class="btn small" @click="showIconTestModal = false">Close</button>
        </div>
      </div>
    </div>

    <div class="vm-list">
      <table v-if="vms.length > 0">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>RAM</th>
            <th>Disk</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="vm in vms" :key="vm.id">
            <td>{{ vm.name }}</td>
            <td>{{ vm.guestType === 'macos' ? 'macOS' : 'Linux' }}</td>
            <td>
              <span :class="['status', vm.status]">{{ vm.status }}</span>
              <span v-if="vm.status === 'installing' && installProgressByVm[vm.id]" class="status-hint"> — {{ installProgressByVm[vm.id] }}</span>
              <span v-else-if="vm.status === 'installing'" class="status-hint"> (see HoustonVM window)</span>
            </td>
            <td>{{ vm.ramMb }} MB</td>
            <td>{{ vm.diskGb }} GB</td>
            <td class="actions">
              <button
                v-if="vm.status === 'stopped'"
                class="btn small"
                @click="startVm(vm.id)"
              >
                Start
              </button>
              <span v-else-if="vm.status === 'installing'" class="status-hint">Installing…</span>
              <template v-else>
                <button class="btn small" @click="stopVm(vm.id)">Stop</button>
                <button class="btn small" @click="showConsole(vm.id)" title="Reopen VM console">Console</button>
                <button class="btn small" @click="takeScreenshot(vm.id)" title="Capture VM screen">Screenshot</button>
                <button
                  class="btn small"
                  :disabled="ocrLoading"
                  @click="testOcr(vm.id)"
                  title="Screenshot + run OCR (text, checkboxes, ui elements)"
                >
                  {{ ocrLoading ? "OCR…" : "Test OCR" }}
                </button>
                <button
                  class="btn small"
                  :disabled="overlayLoading || visionLoading || omniParserLoading"
                  @click="testOcrOverlay(vm.id)"
                  title="Screenshot + OCR with dots at icon centers"
                >
                  {{ overlayLoading ? "Overlay…" : "Screenshot + OCR" }}
                </button>
                <button
                  class="btn small"
                  :disabled="overlayLoading || visionLoading || omniParserLoading"
                  @click="testOcrVision(vm.id)"
                  title="Screenshot + OCR + Vision (Qwen VL)"
                >
                  {{ visionLoading ? "Vision…" : "Screenshot + OCR + Vision" }}
                </button>
                <button
                  class="btn small"
                  :disabled="overlayLoading || visionLoading || omniParserLoading"
                  @click="testOcrOmniParser(vm.id)"
                  title="Screenshot + OmniParser only (icon detection, no captions)"
                >
                  {{ omniParserLoading ? "OmniParser…" : "Screenshot + OmniParser" }}
                </button>
              </template>
              <button class="btn small danger" @click="deleteVm(vm.id)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">No VMs. Click "Create VM" to add one.</p>
    </div>
  </div>
</template>

<style scoped>
.vm-manager {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.vm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.vm-header-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.vm-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.vm-list table {
  width: 100%;
  border-collapse: collapse;
}

.vm-list th,
.vm-list td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid #333;
}

.vm-list th {
  color: #888;
  font-weight: 500;
}

.status.running {
  color: #6f6;
}

.status.stopped {
  color: #888;
}

.status.installing {
  color: #fa0;
}

.status-hint {
  color: #888;
  font-size: 0.85em;
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn {
  padding: 0.4rem 0.8rem;
  border: none;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
}

.btn.small {
  padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
}

.btn.primary {
  background: #4a9eff;
  color: #fff;
}

.btn.primary:hover:not(:disabled) {
  background: #3a8eef;
}

.btn.secondary {
  background: #444;
  color: #fff;
}

.btn.secondary:hover:not(:disabled) {
  background: #555;
}

.btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.danger {
  background: #c44;
  color: #fff;
}

.btn.danger:hover {
  background: #b33;
}

.message.error {
  padding: 0.5rem 0.75rem;
  background: #3a1a1a;
  color: #f66;
  border-radius: 4px;
}

.message.progress {
  padding: 0.5rem 0.75rem;
  background: #1a2a3a;
  color: #6af;
  border-radius: 4px;
}

.empty {
  color: #888;
  margin: 0;
}

.icon-test-content h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}

.icon-test-hint {
  color: #888;
  font-size: 0.85rem;
  margin: 0 0 1rem 0;
}

.icon-test-drop {
  border: 2px dashed #666;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
  cursor: pointer;
  margin-bottom: 1rem;
}

.icon-test-drop:hover,
.icon-test-drop.dragover {
  border-color: #4a9eff;
  background: #1a2a3a;
}

.icon-test-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1rem 0;
}

.icon-test-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.icon-test-item img {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border: 1px solid #444;
  border-radius: 4px;
}

.icon-test-cap {
  font-size: 11px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
  margin-top: 0.25rem;
  text-align: center;
  color: #ccc;
}

.icon-test-label {
  font-weight: 600;
  color: #fff;
}

.icon-test-desc {
  display: block;
  color: #888;
}

.icon-test-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.icon-test-result {
  margin-top: 0.5rem;
  padding: 0.5rem;
  background: #1a2a3a;
  border-radius: 4px;
  font-size: 0.9rem;
  color: #6af;
}

.screenshot-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.screenshot-content {
  background: #222;
  padding: 1rem;
  border-radius: 8px;
  max-width: 90vw;
  max-height: 90vh;
  overflow: auto;
}

.screenshot-content img {
  max-width: 100%;
  display: block;
  margin-bottom: 0.5rem;
}

.screenshot-content label {
  display: block;
  margin-bottom: 0.5rem;
  color: #ccc;
}

.screenshot-content.ocr-result .ocr-text {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 60vh;
  overflow: auto;
  background: #111;
  padding: 0.75rem;
  border-radius: 4px;
  margin: 0.5rem 0;
  color: #ccc;
}

.vision-description {
  margin-top: 1rem;
}

.raw-ocr-section {
  margin-top: 1rem;
}

.raw-ocr-section .raw-ocr-text {
  margin-top: 0.5rem;
}

.vision-description label {
  margin-bottom: 0.25rem;
}

.vision-description .vision-text {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 30vh;
  overflow: auto;
  background: #111;
  padding: 0.75rem;
  border-radius: 4px;
  margin: 0.25rem 0 0;
  color: #ccc;
}

.screenshot-content input {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-bottom: 0.5rem;
  background: #333;
  border: 1px solid #555;
  color: #fff;
  border-radius: 4px;
}

.create-vm-modal {
  min-width: 520px;
}

.create-vm-title {
  margin: 0 0 1rem;
  font-size: 1.1rem;
  color: #fff;
}

.create-vm-section {
  margin-bottom: 1rem;
}

.create-vm-section:last-of-type {
  margin-bottom: 1.25rem;
}

.create-vm-section > label:first-child {
  margin-bottom: 0.5rem;
}

.create-vm-resources {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem 1rem;
}

.create-vm-resource-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.create-vm-resource-label {
  font-size: 0.9rem;
  color: #aaa;
  margin-bottom: 0;
}

.create-vm-resource-row input {
  width: 100%;
  margin-bottom: 0;
}

.create-vm-iso-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.create-vm-iso-row input {
  flex: 1;
  margin-bottom: 0;
}

.create-vm-guest-type {
  border-collapse: collapse;
}

.create-vm-guest-type td {
  padding: 0.25rem 0.5rem 0.25rem 0;
  vertical-align: middle;
  color: #ccc;
}

.create-vm-guest-type .guest-radio-cell {
  width: 1%;
  white-space: nowrap;
}

.create-vm-guest-type label {
  cursor: pointer;
}

.modal-buttons {
  display: flex;
  gap: 0.5rem;
}

.overlay-wrapper {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.overlay-wrapper img {
  max-width: 100%;
  display: block;
  vertical-align: top;
}

.overlay-boxes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.overlay-box {
  position: absolute;
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
  cursor: default;
}

.overlay-box-icon {
  border-color: rgba(255, 68, 68, 0.7);
}

.overlay-box-text {
  border-color: rgba(68, 136, 255, 0.7);
}

.overlay-dots {
  position: absolute;
  inset: 0;
}

.overlay-dot {
  position: absolute;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  margin-top: -5px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
  pointer-events: auto;
  cursor: default;
}

.overlay-dot-icon {
  background: #f44;
}

.overlay-dot-text {
  background: #48f;
}

.overlay-tooltip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 0.5rem;
  padding: 0.35rem 0.6rem;
  background: #111;
  color: #eee;
  font-size: 0.85rem;
  border-radius: 4px;
  max-width: 90%;
  word-break: break-word;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  z-index: 10;
}
</style>
