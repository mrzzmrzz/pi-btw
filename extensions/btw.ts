import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const BTW_NOTE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
  "You are having a side conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are context only - that work is being handled by another agent.",
  "Answer the user's side questions and help them think through ideas or next steps.",
  "Do not continue the main session's work unless the user asks you to prepare something for handoff.",
].join(" ");

type Theme = ExtensionContext["ui"]["theme"];

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  timestamp: number;
};

type BtwTranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string; error?: string }
  | { kind: "error"; text: string };

type TranscriptState = {
  entries: BtwTranscriptEntry[];
  userIndex: number;
  thinkingIndex: number;
  textIndex: number;
  toolIndexById: Map<string, number>;
};

type SessionRuntime = {
  session: AgentSession;
  subscriptions: Set<() => void>;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function createEmptyTranscript(): TranscriptState {
  return { entries: [], userIndex: -1, thinkingIndex: -1, textIndex: -1, toolIndexById: new Map() };
}

function createBtwResourceLoader(): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [BTW_SYSTEM_PROMPT],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// pi does not expose the host ModelRuntime to extensions; ctx.modelRegistry is a facade over it.
// Reusing it keeps extension-registered providers, virtual models, and --api-key overrides
// available to the sub-session. Without it, createAgentSession() builds a fresh runtime from
// auth.json/models.json that knows none of those.
function getHostModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: Partial<ModelRuntime> }).runtime;
  return runtime && typeof runtime.streamSimple === "function" && typeof runtime.getModel === "function"
    ? (runtime as ModelRuntime)
    : undefined;
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }
  return chunks.join("\n").trim();
}

function extractMessageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function formatToolDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
    const command = (value as { command?: unknown }).command;
    if (typeof command === "string") {
      return command;
    }
  }
  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
  } catch {
    return "";
  }
}

function extractToolError(result: unknown): string {
  if (result && typeof result === "object") {
    const value = result as { content?: Array<{ type?: string; text?: string }>; error?: unknown };
    if (typeof value.error === "string" && value.error) {
      return value.error;
    }
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (text) {
        return text.split("\n")[0];
      }
    }
  }
  return typeof result === "string" && result ? result.split("\n")[0] : "failed";
}

function applyTranscriptEvent(state: TranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      state.userIndex = -1;
      state.thinkingIndex = -1;
      state.textIndex = -1;
      return;
    }
    case "message_start":
    case "message_update":
    case "message_end": {
      if (event.message.role === "user") {
        const text = extractMessageText(event.message);
        if (!text) {
          return;
        }
        if (state.userIndex >= 0 && state.entries[state.userIndex]?.kind === "user") {
          (state.entries[state.userIndex] as { text: string }).text = text;
        } else {
          state.userIndex = state.entries.push({ kind: "user", text }) - 1;
        }
        return;
      }

      if (event.message.role !== "assistant") {
        return;
      }
      const assistant = event.message as AssistantMessage;
      const thinking = extractText(assistant.content, "thinking");
      const answer = extractText(assistant.content, "text");
      if (thinking) {
        if (state.thinkingIndex >= 0) {
          (state.entries[state.thinkingIndex] as { text: string }).text = thinking;
        } else {
          state.thinkingIndex = state.entries.push({ kind: "thinking", text: thinking }) - 1;
        }
      }
      if (answer) {
        if (state.textIndex >= 0) {
          (state.entries[state.textIndex] as { text: string }).text = answer;
        } else {
          state.textIndex = state.entries.push({ kind: "text", text: answer }) - 1;
        }
      }
      return;
    }
    case "tool_execution_start": {
      const index = state.entries.push({
        kind: "tool",
        name: event.toolName,
        detail: formatToolDetail(event.args),
      }) - 1;
      state.toolIndexById.set(event.toolCallId, index);
      return;
    }
    case "tool_execution_end": {
      if (!event.isError) {
        return;
      }
      const index = state.toolIndexById.get(event.toolCallId);
      const entry = index !== undefined ? state.entries[index] : undefined;
      if (entry?.kind === "tool") {
        entry.error = extractToolError(event.result);
      }
      return;
    }
    case "turn_end": {
      state.userIndex = -1;
      state.thinkingIndex = -1;
      state.textIndex = -1;
      return;
    }
    default:
      return;
  }
}

function appendCompletedExchange(state: TranscriptState, details: BtwDetails): void {
  state.entries.push({ kind: "user", text: details.question });
  if (details.thinking) {
    state.entries.push({ kind: "thinking", text: details.thinking });
  }
  state.entries.push({ kind: "text", text: details.answer });
}

function renderTranscriptLines(entries: BtwTranscriptEntry[], theme: Theme): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No side thread yet. Type a question below.")];
  }

  const lines: string[] = [];
  const pushBlock = (text: string, style: (line: string) => string, indent = "") => {
    if (lines.length > 0) {
      lines.push("");
    }
    for (const line of text.split("\n")) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  for (const entry of entries) {
    if (entry.kind === "user") {
      const [first, ...rest] = entry.text.split("\n");
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`${theme.fg("accent", "> ")}${first}`);
      for (const line of rest) {
        lines.push(`  ${line}`);
      }
      continue;
    }
    if (entry.kind === "thinking") {
      pushBlock(entry.text, (line) => theme.fg("dim", theme.italic(line)));
      continue;
    }
    if (entry.kind === "tool") {
      const detail = entry.detail ? ` ${entry.detail}` : "";
      const suffix = entry.error ? theme.fg("error", ` (error: ${entry.error})`) : "";
      pushBlock(`${entry.name}${detail}`, (line) => `${theme.fg("dim", line)}${suffix}`);
      continue;
    }
    if (entry.kind === "error") {
      pushBlock(`error: ${entry.text}`, (line) => theme.fg("error", line));
      continue;
    }
    pushBlock(entry.text, (line) => line);
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return null;
}

function formatThread(thread: BtwDetails[]): string {
  return thread
    .map((entry) => `User: ${entry.question.trim()}\nAssistant: ${entry.answer.trim()}`)
    .join("\n\n---\n\n");
}

function isVisibleBtwNote(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_NOTE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return (
    !!entry &&
    typeof entry === "object" &&
    (entry as { type?: string }).type === "custom" &&
    (entry as { customType?: string }).customType === customType
  );
}

class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly readEntries: () => BtwTranscriptEntry[];
  private readonly getStatus: () => string | null;
  private readonly isStreaming: () => boolean;
  private scrollOffset = 0;
  private viewportHeight = 8;
  private followTail = true;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    readEntries: () => BtwTranscriptEntry[],
    getStatus: () => string | null,
    isStreaming: () => boolean,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readEntries = readEntries;
    this.getStatus = getStatus;
    this.isStreaming = isStreaming;

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTail = true;
      onSubmit(value);
    };
    this.input.onEscape = () => {
      onDismiss();
    };

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
          this.tui.requestRender();
          return;
        }
        onDismiss();
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        onDismiss();
        return;
      }
      originalHandleInput(data);
    };
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.followTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - step);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.scrollOffset += step;
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  refresh(): void {
    this.tui.requestRender();
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private inputFrameLine(innerWidth: number): string {
    const previousFocused = this.input.focused;
    // Input.render() emits a cursor marker when focused, which skews width math for
    // this framed row. Render it unfocused; the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const rendered = this.input.render(innerWidth)[0] ?? "";
      return this.frameLine(rendered, innerWidth);
    } finally {
      this.input.focused = previousFocused;
    }
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(22, width - 2);
    const theme = this.theme;
    const border = (edge: "top" | "bottom") =>
      theme.fg("border", edge === "top" ? `┌${"─".repeat(innerWidth)}┐` : `└${"─".repeat(innerWidth)}┘`);
    const rule = theme.fg("border", `├${"─".repeat(innerWidth)}┤`);

    const entries = this.readEntries();
    const exchanges = entries.filter((entry) => entry.kind === "user").length;
    const state = this.isStreaming() ? "streaming" : "idle";
    const title = `${theme.fg("accent", "btw")}${theme.fg("dim", ` · ${exchanges} exchange${exchanges === 1 ? "" : "s"} · ${state}`)}`;

    const status = this.getStatus();
    const hint = status ?? "enter send · esc close · /btw:inject hands off · /btw:clear";

    const wrapped: string[] = [];
    for (const line of renderTranscriptLines(entries, theme)) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth - 2)).map((part) => ` ${part}`));
    }

    const header = [border("top"), this.frameLine(` ${title}`, innerWidth), rule];
    const footer = [rule, this.inputFrameLine(innerWidth), this.frameLine(` ${theme.fg("dim", hint)}`, innerWidth), border("bottom")];

    const terminalRows = process.stdout.rows ?? 30;
    const dialogHeight = Math.max(14, Math.min(28, Math.floor(terminalRows * 0.7)));
    const viewportHeight = Math.max(4, dialogHeight - header.length - footer.length);
    this.viewportHeight = viewportHeight;

    const maxScroll = Math.max(0, wrapped.length - viewportHeight);
    if (this.followTail) {
      this.scrollOffset = maxScroll;
    } else {
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      if (this.scrollOffset >= maxScroll) {
        this.followTail = true;
      }
    }

    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    while (visible.length < viewportHeight) {
      visible.push("");
    }

    const lines = [...header, ...visible.map((line) => this.frameLine(line, innerWidth)), ...footer];
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let transcriptState = createEmptyTranscript();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayRuntime: OverlayRuntime | null = null;
  let activeSession: SessionRuntime | null = null;

  function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    }
  }

  function setOverlayStatus(status: string | null): void {
    overlayStatus = status;
    overlayRuntime?.refresh?.();
  }

  function rebuildTranscript(): void {
    transcriptState = createEmptyTranscript();
    for (const details of pendingThread) {
      appendCompletedExchange(transcriptState, details);
    }
  }

  function clearSessionSubscriptions(runtime: SessionRuntime): void {
    for (const unsubscribe of runtime.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // Ignore unsubscribe errors during shutdown.
      }
    }
    runtime.subscriptions.clear();
  }

  async function disposeSession(): Promise<void> {
    const current = activeSession;
    activeSession = null;
    if (!current) {
      return;
    }
    clearSessionSubscriptions(current);
    try {
      await current.session.abort();
    } catch {
      // Ignore abort errors during shutdown.
    }
    current.session.dispose();
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  async function dismissOverlaySession(): Promise<void> {
    dismissOverlay();
    await disposeSession();
    rebuildTranscript();
    overlayStatus = null;
  }

  function buildSeedMessages(ctx: ExtensionCommandContext): Message[] {
    const messages: Message[] = [];
    try {
      messages.push(
        ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
          (message) => !isVisibleBtwNote(message),
        ),
      );
    } catch {
      // Seed without main-session context when it cannot be built.
    }

    for (const entry of pendingThread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: ctx.model?.provider ?? "unknown",
          model: ctx.model?.id ?? "unknown",
          api: ctx.model?.api ?? "openai-responses",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }

    return messages;
  }

  function subscribeOverlayToSession(): void {
    const runtime = activeSession;
    if (!runtime || !overlayRuntime || runtime.subscriptions.size > 0) {
      return;
    }
    const unsubscribe = runtime.session.subscribe((event: AgentSessionEvent) => {
      if (activeSession?.session !== runtime.session || !overlayRuntime) {
        return;
      }
      applyTranscriptEvent(transcriptState, event);
      overlayRuntime.refresh?.();
    });
    runtime.subscriptions.add(unsubscribe);
  }

  async function ensureSession(ctx: ExtensionCommandContext): Promise<SessionRuntime | null> {
    if (!ctx.model) {
      return null;
    }

    if (activeSession) {
      const model = activeSession.session.model;
      if (model && model.provider === ctx.model.provider && model.id === ctx.model.id) {
        return activeSession;
      }
      await disposeSession();
    }

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: ctx.model,
      modelRuntime: getHostModelRuntime(ctx),
      thinkingLevel: pi.getThinkingLevel(),
      // Match pi's default coding-agent toolset.
      tools: ["read", "bash", "edit", "write"],
      resourceLoader: createBtwResourceLoader(),
    });

    const seed = buildSeedMessages(ctx);
    if (seed.length > 0) {
      session.agent.state.messages = seed as typeof session.state.messages;
    }

    activeSession = { session, subscriptions: new Set() };
    subscribeOverlayToSession();
    return activeSession;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    if (overlayRuntime?.handle) {
      subscribeOverlayToSession();
      overlayRuntime.handle.setHidden(false);
      overlayRuntime.handle.focus();
      overlayRuntime.refresh?.();
      return;
    }

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeSession) {
        clearSessionSubscriptions(activeSession);
      }
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          runtime.finish = () => {
            done();
          };

          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => overlayStatus,
            () => activeSession?.session.isStreaming ?? false,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void dismissOverlaySession();
            },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            closeRuntime();
          };

          subscribeOverlayToSession();

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 60,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext, value: string): Promise<void> {
    const text = value.trim();
    if (!text) {
      setOverlayStatus("Enter a question first.");
      return;
    }

    const match = text.match(/^\/btw(?::(\w+))?(?:\s+(.*))?$/);
    if (match) {
      const name = match[1] ? `btw:${match[1]}` : "btw";
      if (name === "btw" || name === "btw:clear" || name === "btw:inject") {
        overlayRuntime?.setDraft?.("");
        overlayDraft = "";
        await dispatchCommand(name, match[2]?.trim() ?? "", ctx);
        return;
      }
      setOverlayStatus(`Unknown command: /${name}. BTW has /btw, /btw:inject, /btw:clear.`);
      return;
    }

    overlayRuntime?.setDraft?.("");
    overlayDraft = "";
    await runBtw(ctx, text);
  }

  async function resetThread(persist = true): Promise<void> {
    await disposeSession();
    pendingThread = [];
    transcriptState = createEmptyTranscript();
    overlayStatus = null;
    overlayDraft = "";
    overlayRuntime?.setDraft?.("");
    if (persist) {
      pi.appendEntry(BTW_RESET_TYPE, { timestamp: Date.now() });
    }
    overlayRuntime?.refresh?.();
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    await disposeSession();
    pendingThread = [];
    overlayStatus = null;
    overlayDraft = "";

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }
      const details = (entry as { data?: Partial<BtwDetails> }).data;
      if (!details?.question || !details.answer) {
        continue;
      }
      pendingThread.push({
        question: details.question,
        thinking: details.thinking ?? "",
        answer: details.answer,
        timestamp: details.timestamp ?? Date.now(),
      });
    }

    rebuildTranscript();
    overlayRuntime?.refresh?.();
  }

  async function runBtw(ctx: ExtensionCommandContext, question: string): Promise<void> {
    if (!ctx.model) {
      notify(ctx, "No active model selected.", "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    // Keyless providers (llama.cpp, local models.json entries) resolve ok without an apiKey.
    if (!auth.ok) {
      const message = auth.error || `No credentials available for ${ctx.model.provider}/${ctx.model.id}.`;
      setOverlayStatus(message);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const runtime = await ensureSession(ctx);
    if (!runtime) {
      notify(ctx, "No active model selected.", "error");
      return;
    }

    setOverlayStatus("streaming...");
    await ensureOverlay(ctx);

    try {
      await runtime.session.prompt(question, { source: "extension" });

      const response = getLastAssistantMessage(runtime.session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        rebuildTranscript();
        setOverlayStatus("Request aborted.");
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const details: BtwDetails = {
        question,
        thinking: extractText(response.content, "thinking"),
        answer: extractText(response.content, "text") || "(No text response)",
        timestamp: Date.now(),
      };
      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);
      if (!overlayRuntime) {
        // Headless: no overlay subscription streamed this turn into the transcript.
        rebuildTranscript();
      }
      setOverlayStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcriptState.entries.push({ kind: "error", text: message });
      setOverlayStatus("Request failed. Thread kept; retry or /btw:inject.");
      notify(ctx, message, "error");
      await disposeSession();
    } finally {
      overlayRuntime?.refresh?.();
    }
  }

  async function dispatchCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmed = args.trim();

    if (name === "btw") {
      if (!trimmed) {
        await ensureSession(ctx);
        await ensureOverlay(ctx);
        return;
      }
      await runBtw(ctx, trimmed);
      return;
    }

    if (name === "btw:clear") {
      await resetThread();
      dismissOverlay();
      notify(ctx, "Cleared BTW thread.", "info");
      return;
    }

    if (name === "btw:inject") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return;
      }

      const content = trimmed
        ? `Here is a side conversation I had. ${trimmed}\n\n${formatThread(pendingThread)}`
        : `Here is a side conversation I had for additional context:\n\n${formatThread(pendingThread)}`;
      const count = pendingThread.length;

      if (ctx.isIdle()) {
        pi.sendUserMessage(content);
      } else {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      }

      await resetThread();
      dismissOverlay();
      notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      return;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    await disposeSession();
    dismissOverlay();
  });

  pi.registerCommand("btw", {
    description: "Ask a side question in a parallel BTW thread without touching the main context.",
    handler: async (args, ctx) => {
      await dispatchCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Send the BTW thread to the main agent as a user message, then clear it.",
    handler: async (args, ctx) => {
      await dispatchCommand("btw:inject", args, ctx);
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Clear the BTW thread and close the overlay.",
    handler: async (args, ctx) => {
      await dispatchCommand("btw:clear", args, ctx);
    },
  });
}
