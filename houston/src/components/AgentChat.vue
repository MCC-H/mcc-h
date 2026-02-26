<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onBeforeUnmount, computed } from "vue";
import { marked } from "marked";

const props = defineProps<{
  /** When set, automatically send this message as the first user message on mount (e.g. "hi!" for Codex) */
  autoSendFirstMessage?: string;
}>();

const showAskUserPopup = ref(false);
const askUserInfo = ref<{ clarification: string; assessment: string; attempt: number } | null>(null);
const showFinalizePopup = ref(false);
const finalizeInfo = ref<{ assessment: string; clarification: string; is_successful: boolean } | null>(null);

const taskSummary = ref("");
const taskStartTime = ref<number | null>(null);
const taskFinalized = ref(false);
const taskSuccess = ref(true);
const taskElapsedSeconds = ref(0);
let taskTimerInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsed(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function startTaskTimer() {
  if (taskTimerInterval) clearInterval(taskTimerInterval);
  taskTimerInterval = setInterval(() => {
    if (taskStartTime.value == null || taskFinalized.value) return;
    taskElapsedSeconds.value = Math.floor((Date.now() - taskStartTime.value) / 1000);
  }, 1000);
}

function stopTaskTimer() {
  if (taskTimerInterval) {
    clearInterval(taskTimerInterval);
    taskTimerInterval = null;
  }
}
const askUserReplyText = ref("");
const askUserCountdown = ref(60);
let askUserCountdownTimer: ReturnType<typeof setInterval> | null = null;

function startAskUserCountdown() {
  askUserCountdown.value = 60;
  if (askUserCountdownTimer) clearInterval(askUserCountdownTimer);
  askUserCountdownTimer = setInterval(() => {
    askUserCountdown.value--;
    if (askUserCountdown.value <= 0 && askUserCountdownTimer) {
      clearInterval(askUserCountdownTimer);
      askUserCountdownTimer = null;
    }
  }, 1000);
}

function stopAskUserCountdown() {
  if (askUserCountdownTimer) {
    clearInterval(askUserCountdownTimer);
    askUserCountdownTimer = null;
  }
}

function playNotificationSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    /* ignore */
  }
}

function submitAskUserReply() {
  const text = askUserReplyText.value.trim();
  window.electronAPI?.agentInjectMessage?.(text || "(no message)");
  showAskUserPopup.value = false;
  askUserInfo.value = null;
  askUserReplyText.value = "";
  stopAskUserCountdown();
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  injected?: boolean;
  isError?: boolean;
  type?: "assessment" | "clarification" | "tool_running" | "tool_call" | "content";
  name?: string;
  accordion?: string;
  wait_seconds?: number;
};

const MSG_START = "<<<MSG>>>";
const MSG_END = "<<<END>>>";

function parseStream(raw: string): { parts: ChatMessage[]; tail: string } {
  const parts: ChatMessage[] = [];
  let remaining = raw;
  let contentBuffer = "";

  while (true) {
    const idx = remaining.indexOf(MSG_START);
    if (idx === -1) {
      contentBuffer += remaining;
      break;
    }
    contentBuffer += remaining.slice(0, idx);
    const after = remaining.slice(idx + MSG_START.length);
    const endIdx = after.indexOf(MSG_END);
    if (endIdx === -1) {
      contentBuffer += MSG_START + after;
      break;
    }
    const jsonStr = after.slice(0, endIdx);
    remaining = after.slice(endIdx + MSG_END.length);
    try {
      const msg = JSON.parse(jsonStr) as { type?: string; content?: string; name?: string; accordion?: string; wait_seconds?: number };
      if (contentBuffer.trim()) {
        parts.push({ role: "assistant", content: contentBuffer.trim(), type: "content" });
        contentBuffer = "";
      }
      if (msg.type === "content_end") {
        /* flush handled above */
      } else if (msg.type === "assessment" && typeof msg.content === "string") {
        parts.push({ role: "assistant", content: msg.content, type: "assessment" });
      } else if (msg.type === "clarification" && typeof msg.content === "string") {
        parts.push({ role: "assistant", content: msg.content, type: "clarification" });
      } else if (msg.type === "tool_running" && msg.name) {
        parts.push({ role: "assistant", type: "tool_running", name: msg.name, content: "", wait_seconds: msg.wait_seconds });
      } else if (msg.type === "tool_call" && msg.name && msg.accordion) {
        const last = parts[parts.length - 1];
        if (last?.type === "tool_running" && last.name === msg.name) {
          parts.pop();
        }
        parts.push({ role: "assistant", type: "tool_call", name: msg.name, accordion: msg.accordion, content: "", wait_seconds: msg.wait_seconds });
      } else if (msg.type === "user_injected" && typeof msg.content === "string") {
        parts.push({ role: "user", content: msg.content, injected: true });
      }
    } catch {
      contentBuffer += MSG_START + jsonStr + MSG_END;
    }
  }

  return { parts, tail: contentBuffer };
}

function messageToHistoryContent(m: ChatMessage): string {
  if (m.role === "user") return m.content;
  if (m.type === "assessment") return `**Assessment:** ${m.content}\n\n`;
  if (m.type === "clarification") return `**Clarification:** ${m.content}\n\n`;
  if (m.type === "tool_running") {
    const sec = ` (${m.wait_seconds ?? 1} seconds)`;
    return `**Tool: ${m.name}${sec}** — Running…\n\n`;
  }
  if (m.type === "tool_call" && m.accordion) return m.accordion + "\n\n";
  return m.content + (m.content ? "\n\n" : "");
}

const COMPLETED_TASK_MARKER = "\n\n========== COMPLETED STEPS ==========\n\n";
const YOU_ARE_HERE_MARKER = "\n\n========== YOU ARE HERE ==========\n\n";

function buildHistory(msgs: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  const includeInHistory = (x: ChatMessage) => {
    if (x.role === "user") return true;
    if (x.role === "assistant" && (x.type === "assessment" || x.type === "clarification")) return true;
    return false;
  };
  const filtered = msgs.filter(includeInHistory);
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const content = messageToHistoryContent(m);
    if (m.role === "user") {
      if (i > 0 && filtered[i - 1].role === "assistant") {
        out[out.length - 1].content += COMPLETED_TASK_MARKER;
      }
      out.push({ role: "user", content });
    } else {
      if (out.length > 0 && out[out.length - 1].role === "assistant") {
        out[out.length - 1].content += content;
      } else {
        out.push({ role: "assistant", content });
      }
    }
  }
  if (out.length > 0) {
    out[out.length - 1].content += YOU_ARE_HERE_MARKER;
  }
  return out;
}

const messagesRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref("");
const loading = ref(false);
const streamingContent = ref("");
const ttsEnabled = ref(false);
const ttsRate = ref(195);
const lastTtsToolRunningIndex = ref(-1);

let askUserPopupUnsub: (() => void) | undefined;
let askUserCloseUnsub: (() => void) | undefined;
let finalizePopupUnsub: (() => void) | undefined;
let taskStartUnsub: (() => void) | undefined;

onMounted(() => {
  nextTick(resizeInput);
  askUserPopupUnsub = window.electronAPI?.onAskUserPopup?.((info) => {
    playNotificationSound();
    showAskUserPopup.value = true;
    askUserInfo.value = info;
    askUserReplyText.value = "";
    startAskUserCountdown();
  });
  askUserCloseUnsub = window.electronAPI?.onAskUserPopupClose?.(() => {
    showAskUserPopup.value = false;
    askUserInfo.value = null;
    askUserReplyText.value = "";
    stopAskUserCountdown();
  });
  finalizePopupUnsub = window.electronAPI?.onFinalizeTaskPopup?.((info) => {
    playNotificationSound();
    taskFinalized.value = true;
    taskSuccess.value = info.is_successful;
    stopTaskTimer();
    if (taskStartTime.value != null) {
      taskElapsedSeconds.value = Math.floor((Date.now() - taskStartTime.value) / 1000);
    }
    showFinalizePopup.value = true;
    finalizeInfo.value = info;
    if (ttsEnabled.value && window.electronAPI?.say) {
      const text = [info.assessment, info.clarification].filter(Boolean).join(". ");
      if (text) window.electronAPI.say(text, ttsRate.value).catch(() => { });
    }
  });
  taskStartUnsub = window.electronAPI?.onTaskStart?.((info) => {
    taskSummary.value = info.summary || "";
    taskStartTime.value = Date.now();
    taskFinalized.value = false;
    taskElapsedSeconds.value = 0;
    startTaskTimer();
  });

  if (props.autoSendFirstMessage?.trim()) {
    nextTick(() => {
      input.value = props.autoSendFirstMessage!.trim();
      send();
    });
  }
});

function dismissFloatingTask() {
  taskSummary.value = "";
  taskStartTime.value = null;
  taskFinalized.value = false;
  taskSuccess.value = true;
  taskElapsedSeconds.value = 0;
  stopTaskTimer();
}

const CHAT_INPUT_MIN_ROWS = 1;
const CHAT_INPUT_MAX_HEIGHT = 200;

function resizeInput() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = "auto";
  const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
  const padding = parseInt(getComputedStyle(el).paddingTop, 10) + parseInt(getComputedStyle(el).paddingBottom, 10) || 24;
  const minHeight = CHAT_INPUT_MIN_ROWS * lineHeight + padding;
  const newHeight = Math.min(Math.max(el.scrollHeight, minHeight), CHAT_INPUT_MAX_HEIGHT);
  el.style.height = `${newHeight}px`;
  el.style.overflowY = newHeight >= CHAT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
}

async function send() {
  const text = input.value.trim();
  if (!text) return;

  if (loading.value) {
    window.electronAPI?.agentInjectMessage?.(text);
    messages.value.push({ role: "user", content: text, injected: true });
    input.value = "";
    nextTick(resizeInput);
    scrollToBottomAlways();
    return;
  }

  if (!window.electronAPI?.agentSendMessage) return;

  const history = buildHistory(messages.value);
  messages.value.push({ role: "user", content: text });
  input.value = "";
  nextTick(resizeInput);
  loading.value = true;
  streamingContent.value = "";

  const unsubscribe = window.electronAPI?.onAgentStreamChunk?.((chunk: string) => {
    streamingContent.value += chunk;
  });

  try {
    const reply = await window.electronAPI.agentSendMessage(text, JSON.parse(JSON.stringify(history)));
    const { parts, tail } = parseStream(streamingContent.value);
    for (const p of parts) messages.value.push(p);
    let finalContent = tail.trim();
    if (reply === "Stopped by user.") {
      finalContent += (finalContent ? "\n\n" : "") + "_Stopped by user._";
    } else if (reply && reply !== tail.trim()) {
      finalContent += (finalContent ? "\n\n" : "") + reply;
    }
    if (finalContent || reply) messages.value.push({ role: "assistant", content: finalContent || reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[AgentChat] agentSendMessage error:", msg);
    const { parts, tail } = parseStream(streamingContent.value);
    for (const p of parts) messages.value.push(p);
    const content = tail.trim() ? `${tail.trim()}\n\n**Error:** ${msg}` : `Error: ${msg}`;
    messages.value.push({ role: "assistant", content, isError: true });
  } finally {
    unsubscribe?.();
    streamingContent.value = "";
    loading.value = false;
    scrollToBottomAlways();
  }
}

/** Send recipe prompt with custom instructions. Display short message in chat, send full prompt to model. */
async function sendRecipePrompt(actualMessage: string, displayMessage: string) {
  if (!window.electronAPI?.agentSendMessage || loading.value) return;
  const history = buildHistory(messages.value);
  messages.value.push({ role: "user", content: displayMessage });
  loading.value = true;
  streamingContent.value = "";

  const unsubscribe = window.electronAPI?.onAgentStreamChunk?.((chunk: string) => {
    streamingContent.value += chunk;
  });

  try {
    const reply = await window.electronAPI.agentSendMessage(actualMessage, JSON.parse(JSON.stringify(history)));
    const { parts, tail } = parseStream(streamingContent.value);
    for (const p of parts) messages.value.push(p);
    let finalContent = tail.trim();
    if (reply === "Stopped by user.") {
      finalContent += (finalContent ? "\n\n" : "") + "_Stopped by user._";
    } else if (reply && reply !== tail.trim()) {
      finalContent += (finalContent ? "\n\n" : "") + reply;
    }
    if (finalContent || reply) messages.value.push({ role: "assistant", content: finalContent || reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { parts, tail } = parseStream(streamingContent.value);
    for (const p of parts) messages.value.push(p);
    const content = tail.trim() ? `${tail.trim()}\n\n**Error:** ${msg}` : `Error: ${msg}`;
    messages.value.push({ role: "assistant", content, isError: true });
  } finally {
    unsubscribe?.();
    streamingContent.value = "";
    loading.value = false;
    scrollToBottomAlways();
  }
}

defineExpose({ sendRecipePrompt });

const SCROLL_THRESHOLD = 80;

/** True when user is at/near bottom; false when they've scrolled up. Updated on scroll. */
const userIsAtBottom = ref(true);

function scrollToBottom() {
  nextTick(() => {
    const el = messagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** Only scroll if user was at bottom (hasn't scrolled up to read old content). */
function scrollToBottomIfFollowing() {
  if (!userIsAtBottom.value) return;
  nextTick(() => {
    const el = messagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** Always scroll to bottom (e.g. when loading or after send). */
function scrollToBottomAlways() {
  userIsAtBottom.value = true;
  nextTick(() => {
    nextTick(() => {
      const el = messagesRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
}

let scrollCleanup: (() => void) | null = null;

function setupScrollTracking() {
  const el = messagesRef.value;
  if (!el) return;
  const check = () => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    userIsAtBottom.value = atBottom;
  };
  el.addEventListener("scroll", check, { passive: true });
  check();
  scrollCleanup = () => el.removeEventListener("scroll", check);
}

onMounted(() => {
  nextTick(setupScrollTracking);
});
onBeforeUnmount(() => {
  scrollCleanup?.();
  askUserPopupUnsub?.();
  askUserCloseUnsub?.();
  finalizePopupUnsub?.();
  taskStartUnsub?.();
  stopAskUserCountdown();
  stopTaskTimer();
  if (toolRunningTimer) {
    clearInterval(toolRunningTimer);
    toolRunningTimer = null;
  }
});

watch(streamingContent, () => {
  scrollToBottomIfFollowing();
});
watch(messages, () => {
  scrollToBottomIfFollowing();
}, { deep: true });

const streamingParsed = computed(() => parseStream(streamingContent.value));

/** Index of the last tool_running part (the one currently running). -1 if none. */
const lastToolRunningIndex = computed(() => {
  const parts = streamingParsed.value.parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "tool_running") return i;
  }
  return -1;
});

/** Countdown in seconds (decimal, e.g. 2.5). Updated every 200ms. */
const toolRunningCountdown = ref<number | null>(null);

function formatToolCountdown(v: number): string {
  return v.toFixed(1);
}
let toolRunningTimer: ReturnType<typeof setInterval> | null = null;

watch(
  [loading, streamingParsed],
  () => {
    if (toolRunningTimer) {
      clearInterval(toolRunningTimer);
      toolRunningTimer = null;
    }
    toolRunningCountdown.value = null;
    if (!loading.value || lastToolRunningIndex.value < 0) return;
    const parts = streamingParsed.value.parts;
    const idx = lastToolRunningIndex.value;
    const part = parts[idx];
    const waitSec = part?.type === "tool_running" ? part.wait_seconds : undefined;
    const startSec = typeof waitSec === "number" && waitSec > 0 ? waitSec : 1;
    toolRunningCountdown.value = startSec;
    toolRunningTimer = setInterval(() => {
      if (toolRunningCountdown.value != null && toolRunningCountdown.value > 0) {
        toolRunningCountdown.value = Math.max(0, toolRunningCountdown.value - 0.2);
      }
      if (toolRunningCountdown.value != null && toolRunningCountdown.value <= 0 && toolRunningTimer) {
        clearInterval(toolRunningTimer);
        toolRunningTimer = null;
      }
    }, 200);
  },
  { deep: true }
);

watch(loading, (now) => {
  if (!now) lastTtsToolRunningIndex.value = -1;
});

/** Speak regular AI messages when reply completes. */
watch(
  loading,
  async (now, prev) => {
    if (prev !== true || now !== false || !ttsEnabled.value || !window.electronAPI?.say) return;
    const last = messages.value[messages.value.length - 1];
    if (last?.role !== "assistant" || !last.content || last.isError) return;
    const isRegular = !last.type || last.type === "content";
    if (!isRegular) return;
    const text = stripMarkdownForTts(last.content);
    if (!text) return;
    try {
      await window.electronAPI.say(text, ttsRate.value);
    } catch {
      /* say skipped or failed */
    }
  }
);

/** Speak assessment+clarification when tool_running appears. Skip if previous say still running. */
watch(
  [loading, ttsEnabled, streamingParsed],
  async () => {
    if (!ttsEnabled.value || !loading.value || !window.electronAPI?.say) return;
    const parts = streamingParsed.value.parts;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type !== "tool_running" || i <= lastTtsToolRunningIndex.value) continue;
      lastTtsToolRunningIndex.value = i;
      let assessment = "";
      let clarification = "";
      if (i >= 1 && parts[i - 1].type === "clarification") clarification = (parts[i - 1].content ?? "").trim();
      if (i >= 2 && parts[i - 2].type === "assessment") assessment = (parts[i - 2].content ?? "").trim();
      else if (i >= 1 && parts[i - 1].type === "assessment") assessment = (parts[i - 1].content ?? "").trim();
      const text = [assessment, clarification].filter(Boolean).join(". ");
      if (text) {
        try {
          await window.electronAPI.say(text, ttsRate.value);
        } catch {
          /* say skipped (busy) or failed */
        }
      }
      break;
    }
  },
  { deep: true }
);

function renderMarkdown(text: string): string {
  if (!text?.trim()) return "";
  return marked.parse(text) as string;
}

/** Strip markdown for TTS: remove syntax, keep readable text. */
function stripMarkdownForTts(text: string): string {
  if (!text?.trim()) return "";
  let s = text
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) -> label
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // images
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/_([^_]+)_/g, "$1") // _italic_
    .replace(/^#{1,6}\s+/gm, "") // headers
    .replace(/^>\s*/gm, "") // blockquote
    .replace(/^[-*]\s+/gm, "") // unordered list
    .replace(/^\d+\.\s+/gm, "") // ordered list
    .replace(/^---+$/gm, "") // horizontal rules
    .replace(/\n{2,}/g, " ") // collapse newlines
    .trim();
  return s;
}

function stop() {
  if (loading.value) window.electronAPI?.agentAbort?.();
}
</script>

<template>
  <div class="chat">
    <div ref="messagesRef" class="chat-messages">
      <div v-if="messages.length === 0" class="chat-placeholder">
        Agent is ready. Type your message below — I'll ask what you'd like me to do.
      </div>
      <div v-for="(msg, i) in messages" :key="i"
        :class="['chat-bubble', msg.role, { error: msg.isError, injected: msg.injected }, msg.type]">
        <template v-if="msg.role === 'user'">
          <span v-if="msg.injected" class="injected-label">Injected:</span>
          <span class="chat-bubble-text">{{ msg.content }}</span>
        </template>
        <template v-else>
          <div v-if="msg.isError" class="chat-error-text">{{ msg.content }}</div>
          <template v-else-if="msg.type === 'assessment'">
            <span class="msg-type-label">Assessment</span>
            <div class="chat-markdown" v-html="renderMarkdown(msg.content)"></div>
          </template>
          <template v-else-if="msg.type === 'clarification'">
            <span class="msg-type-label">Clarification</span>
            <div class="chat-markdown" v-html="renderMarkdown(msg.content)"></div>
          </template>
          <template v-else-if="msg.type === 'tool_running'">
            <span class="msg-type-label">Tool: {{ msg.name }} ({{ msg.wait_seconds ?? 1 }} seconds)</span>
            <span class="tool-running">Running…</span>
          </template>
          <template v-else-if="msg.type === 'tool_call' && msg.accordion">
            <span class="msg-type-label">Tool: {{ msg.name }} ({{ msg.wait_seconds ?? 1 }} seconds)</span>
            <div class="chat-markdown" v-html="msg.accordion"></div>
          </template>
          <div v-else class="chat-markdown" v-html="renderMarkdown(msg.content)"></div>
        </template>
      </div>
      <template v-if="loading">
        <div v-for="(p, pi) in streamingParsed.parts" :key="'stream-' + pi" :class="['chat-bubble', p.role, p.type]">
          <template v-if="p.role === 'user'">
            <span v-if="p.injected" class="injected-label">Injected:</span>
            <span class="chat-bubble-text">{{ p.content }}</span>
          </template>
          <template v-else-if="p.type === 'assessment'">
            <span class="msg-type-label">Assessment</span>
            <div class="chat-markdown" v-html="renderMarkdown(p.content)"></div>
          </template>
          <template v-else-if="p.type === 'clarification'">
            <span class="msg-type-label">Clarification</span>
            <div class="chat-markdown" v-html="renderMarkdown(p.content)"></div>
          </template>
          <template v-else-if="p.type === 'tool_running'">
            <span class="msg-type-label">Tool: {{ p.name }} ({{ p.wait_seconds ?? 1 }} seconds)</span>
            <span class="tool-running">Running {{ pi === lastToolRunningIndex && toolRunningCountdown != null ?
              formatToolCountdown(toolRunningCountdown) : "…" }}....</span>
          </template>
          <template v-else-if="p.type === 'tool_call' && p.accordion">
            <span class="msg-type-label">Tool: {{ p.name }} ({{ p.wait_seconds ?? 1 }} seconds)</span>
            <div class="chat-markdown" v-html="p.accordion"></div>
          </template>
          <div v-else-if="p.content" class="chat-markdown" v-html="renderMarkdown(p.content)"></div>
        </div>
        <div class="chat-bubble assistant">
          <div v-if="streamingParsed.tail" class="chat-markdown" v-html="renderMarkdown(streamingParsed.tail)"></div>
          <span v-else>Thinking…</span>
        </div>
      </template>
    </div>
    <div class="chat-tts">
      <label class="chat-tts-toggle">
        <input v-model="ttsEnabled" type="checkbox" />
        Speak assessment & clarification
      </label>
      <label class="chat-tts-rate" v-if="ttsEnabled">
        Speed (wpm)
        <input v-model.number="ttsRate" type="number" min="80" max="400" step="10" />
      </label>
    </div>
    <div class="chat-input">
      <textarea ref="inputRef" v-model="input" rows="1"
        :placeholder="loading ? 'Type to inject message into next tool result…' : 'What would you like me to do?'"
        class="chat-input-field" @keydown.enter="(e) => { if (!e.shiftKey) { e.preventDefault(); send(); } }"
        @input="resizeInput" />
      <button v-if="loading" class="btn secondary" @click="stop">Stop</button>
      <button class="btn primary" :disabled="!input.trim()" @click="send">
        Send
      </button>
    </div>

    <div v-if="showAskUserPopup" class="ask-user-overlay">
      <div class="ask-user-modal">
        <h3>Agent is asking for your input</h3>
        <p v-if="askUserInfo?.clarification" class="ask-user-clarification">{{ askUserInfo.clarification }}</p>
        <p v-if="askUserInfo?.assessment" class="ask-user-assessment">{{ askUserInfo.assessment }}</p>
        <p class="ask-user-countdown">Reply within {{ askUserCountdown }} seconds</p>
        <textarea v-model="askUserReplyText" placeholder="Type your reply..." rows="4" class="ask-user-textarea"
          @keydown.enter.ctrl="submitAskUserReply()" />
        <div class="ask-user-actions">
          <button class="btn primary" @click="submitAskUserReply">Submit</button>
        </div>
      </div>
    </div>

    <div v-if="showFinalizePopup" class="ask-user-overlay"
      @click.self="showFinalizePopup = false; finalizeInfo = null; dismissFloatingTask()">
      <div class="ask-user-modal finalize-modal"
        :class="{ 'finalize-failed': finalizeInfo && !finalizeInfo.is_successful }">
        <h3>Task {{ finalizeInfo?.is_successful ? 'completed' : 'failed' }}</h3>
        <p v-if="finalizeInfo?.assessment" class="ask-user-assessment"><strong>Assessment:</strong> {{
          finalizeInfo.assessment }}</p>
        <p v-if="finalizeInfo?.clarification" class="ask-user-clarification"><strong>Clarification:</strong> {{
          finalizeInfo.clarification }}</p>
        <div class="ask-user-actions">
          <button class="btn primary"
            @click="showFinalizePopup = false; finalizeInfo = null; dismissFloatingTask()">Close</button>
        </div>
      </div>
    </div>

    <div v-if="taskSummary" class="floating-task"
      :class="{ finalized: taskFinalized, failed: taskFinalized && !taskSuccess }">
      <span class="floating-task-name">{{ taskSummary }}</span>
      <span class="floating-task-timer">{{ formatElapsed(taskElapsedSeconds) }}</span>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  border-top: 1px solid #333;
  padding-top: 1rem;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.5rem 0;
  overscroll-behavior: contain;
}

.chat-placeholder {
  color: #888;
  font-size: 0.9rem;
  padding: 0.5rem 0;
}

.chat-bubble {
  padding: 0.6rem 0.9rem;
  border-radius: 8px;
  font-size: 0.9rem;
  max-width: 85%;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.chat-bubble-text {
  display: block;
  min-width: 0;
  overflow-wrap: break-word;
  word-break: break-word;
}

.chat-bubble.user {
  align-self: flex-end;
  background: #2a4a6a;
  color: #e0e0e0;
}

.chat-bubble.user.injected {
  border: 1px dashed #5a8aba;
}

.injected-label {
  display: block;
  font-size: 0.75rem;
  color: #8ab4e0;
  margin-bottom: 0.25rem;
}

.msg-type-label {
  display: block;
  font-size: 0.75rem;
  margin-bottom: 0.25rem;
  font-weight: 600;
}

.chat-bubble.assessment .msg-type-label {
  color: #6ab7ff;
}

.chat-bubble.assessment {
  border-left: 3px solid #4a9eff;
  margin-left: 0.25rem;
}

.chat-bubble.clarification .msg-type-label {
  color: #e8c97a;
}

.chat-bubble.clarification {
  border-left: 3px solid #d4a84b;
  margin-left: 0.25rem;
}

.chat-bubble.tool_call .msg-type-label {
  color: #6ab88a;
}

.chat-bubble.tool_call {
  border-left: 3px solid #4a9d6e;
  margin-left: 0.25rem;
}

.chat-bubble.tool_running .msg-type-label {
  color: #6ab88a;
}

.chat-bubble.tool_running {
  border-left: 3px solid #4a9d6e;
  margin-left: 0.25rem;
}

.chat-bubble.tool_running .tool-running {
  font-style: italic;
  color: #888;
  font-size: 0.9em;
}

.chat-bubble.assistant {
  align-self: flex-start;
  background: #252525;
  border: 1px solid #333;
  color: #e0e0e0;
}

.chat-bubble.error {
  background: #3a1a1a;
  border-color: #a44;
  color: #f88;
}

.chat-error-text {
  white-space: pre-wrap;
}

.chat-markdown :deep(p) {
  margin: 0 0 0.5em;
}

.chat-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.chat-markdown :deep(code) {
  background: #1a1a1a;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}

.chat-markdown :deep(pre) {
  background: #1a1a1a;
  padding: 0.75rem;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.5em 0;
}

.chat-markdown :deep(pre code) {
  background: none;
  padding: 0;
}

.chat-markdown :deep(ul),
.chat-markdown :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.chat-markdown {
  overflow: hidden;
  min-width: 0;
}

.chat-markdown :deep(img) {
  max-width: 100%;
  height: auto;
  object-fit: contain;
}
.chat-markdown :deep(a) {
  color: #6ab7ff;
}

.chat-markdown :deep(strong) {
  font-weight: 600;
}

.chat-markdown :deep(em) {
  font-style: italic;
}

.chat-markdown :deep(details.tool-result-debug) {
  margin: 0.5em 0;
  border: 1px solid #444;
  border-radius: 6px;
  background: #1a1a1a;
}

.chat-markdown :deep(details.tool-result-debug summary) {
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  font-size: 0.85rem;
  color: #8ab4e0;
}

.chat-markdown :deep(details.tool-result-debug pre) {
  margin: 0;
  padding: 0.6rem;
  max-height: 20rem;
  overflow: auto;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-tts {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.85rem;
  color: #888;
}

.chat-tts-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.chat-tts-toggle input {
  cursor: pointer;
}

.chat-tts-rate {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.chat-tts-rate input {
  width: 4rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid #333;
  border-radius: 4px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.9rem;
}

.chat-input {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

.chat-input .chat-input-field {
  flex: 1;
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #252525;
  color: #e0e0e0;
  font-size: 0.95rem;
  font-family: inherit;
  resize: none;
  overflow-y: hidden;
  box-sizing: border-box;
}

.chat-input .chat-input-field:focus {
  outline: none;
  border-color: #4a9eff;
}

.chat-input .btn {
  padding: 0.5rem 1rem;
}

.chat-input .btn.secondary {
  background: #444;
  color: #e0e0e0;
}

.chat-input .btn.secondary:hover {
  background: #555;
}

.ask-user-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.ask-user-modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 480px;
  width: 90%;
}

.ask-user-modal.finalize-modal.finalize-failed {
  border-color: #6a4a4a;
  background: #2a1e1e;
}

.ask-user-modal h3 {
  margin: 0 0 0.75rem;
  font-size: 1.1rem;
}

.ask-user-clarification,
.ask-user-assessment {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: #ccc;
}

.ask-user-countdown {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  color: #8ab4e0;
  font-weight: 600;
}

.ask-user-textarea {
  width: 100%;
  padding: 0.75rem;
  margin-bottom: 1rem;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 0.95rem;
  resize: vertical;
  box-sizing: border-box;
}

.ask-user-textarea:focus {
  outline: none;
  border-color: #4a9eff;
}

.ask-user-actions {
  display: flex;
  justify-content: flex-end;
}

.floating-task {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: #1e2a3a;
  border: 1px solid #3a5a7a;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 500;
  font-size: 0.9rem;
}

.floating-task-name {
  color: #e0e0e0;
  font-weight: 500;
}

.floating-task-timer {
  color: #6ab7ff;
  font-variant-numeric: tabular-nums;
}

.floating-task.finalized {
  border-color: #4a6a4a;
  background: #1e2a1e;
}

.floating-task.finalized .floating-task-timer {
  color: #6ab86a;
}

.floating-task.finalized.failed {
  border-color: #6a4a4a;
  background: #2a1e1e;
}

.floating-task.finalized.failed .floating-task-timer {
  color: #b86a6a;
}
</style>
