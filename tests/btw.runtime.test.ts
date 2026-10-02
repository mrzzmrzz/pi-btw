import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import btwExtension from "../extensions/btw";

const { promptStreamMock, createAgentSessionMock, sessionManagerInMemoryMock, subSessionRecords } = vi.hoisted(() => ({
  promptStreamMock: vi.fn(),
  createAgentSessionMock: vi.fn(),
  sessionManagerInMemoryMock: vi.fn(() => ({ type: "in-memory-session" })),
  subSessionRecords: [] as Array<{
    options: any;
    session: any;
    seedMessages: any[];
    promptCalls: Array<{ text: string; context: StreamContext }>;
    emit: (event: any) => void;
    getListenerCount: () => number;
    getIsStreaming: () => boolean;
  }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
    SessionManager: {
      ...actual.SessionManager,
      inMemory: sessionManagerInMemoryMock,
    },
  };
});

type CustomEntry = { type: "custom"; customType: string; data?: unknown };
type SessionEntry = CustomEntry | { type: string; role?: string; customType?: string; content?: unknown; [key: string]: unknown };

type StreamContext = {
  systemPrompt: string;
  messages: Array<{ role: string; content: Array<{ type: string; text?: string; thinking?: string }> }>;
};

type PromptStreamEvent =
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_execution_start"; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolName: string; result?: unknown; isError?: boolean }
  | { type: "done"; message: ReturnType<typeof makeAssistantMessage> }
  | { type: "error"; error: ReturnType<typeof makeAssistantMessage> };

class FakeOverlayHandle {
  hidden = false;
  focused = false;
  hideCalls = 0;
  setHidden(hidden: boolean) {
    this.hidden = hidden;
  }
  isHidden() {
    return this.hidden;
  }
  focus() {
    this.focused = true;
  }
  unfocus() {
    this.focused = false;
  }
  isFocused() {
    return this.focused;
  }
  hide() {
    this.hideCalls += 1;
    this.hidden = true;
    this.focused = false;
  }
}

const tuiMocks = vi.hoisted(() => {
  class FakeInput {
    value = "";
    focused = false;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(value: string) {
      this.value = value;
    }
    getValue() {
      return this.value;
    }
    render(_width: number) {
      return [`> ${this.value}`];
    }
    handleInput(_data: string) {}
  }

  class FakeContainer {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
    clear() {
      this.children = [];
    }
  }

  return { FakeInput, FakeContainer };
});

vi.mock("@earendil-works/pi-tui", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui");
  return {
    ...actual,
    Container: tuiMocks.FakeContainer,
    Input: tuiMocks.FakeInput,
  };
});

function makeAssistantMessage(answer: string) {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text: answer }],
    provider: "test-provider",
    model: "test-model",
    api: "openai-responses" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function buildAssistantContent(thinking: string, answer: string) {
  const content: Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }> = [];
  if (thinking) {
    content.push({ type: "thinking", thinking });
  }
  if (answer) {
    content.push({ type: "text", text: answer });
  }
  return content;
}

async function* streamAnswer(answer: string) {
  yield { type: "text_delta" as const, delta: answer.slice(0, Math.max(1, Math.floor(answer.length / 2))) };
  yield { type: "text_delta" as const, delta: answer.slice(Math.max(1, Math.floor(answer.length / 2))) };
  yield { type: "done" as const, message: makeAssistantMessage(answer) };
}

function createBlockingAnswerStream(answer: string) {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstChunkLength = Math.max(1, Math.floor(answer.length / 2));

  return {
    release,
    stream: async function* () {
      yield { type: "text_delta" as const, delta: answer.slice(0, firstChunkLength) };
      await blocked;
      yield { type: "text_delta" as const, delta: answer.slice(firstChunkLength) };
      yield { type: "done" as const, message: makeAssistantMessage(answer) };
    },
  };
}

function createBlockingToolStream() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    stream: async function* () {
      yield { type: "tool_execution_start" as const, toolName: "read", args: { path: "package.json" } };
      await blocked;
      yield {
        type: "error" as const,
        error: {
          ...makeAssistantMessage(""),
          stopReason: "aborted" as const,
        },
      };
    },
  };
}

function createStreamingFailureStream() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    stream: async function* () {
      yield { type: "thinking_delta" as const, delta: "Inspecting package.json" };
      yield { type: "tool_execution_start" as const, toolName: "read", args: { path: "package.json" } };
      await blocked;
      yield {
        type: "tool_execution_end" as const,
        toolName: "read",
        result: { content: [{ type: "text", text: '{"name":"pi-btw"}' }] },
      };
      yield {
        type: "error" as const,
        error: {
          ...makeAssistantMessage(""),
          stopReason: "error" as const,
          errorMessage: "Sub-session prompt exploded",
        },
      };
    },
  };
}

function buildMockSystemPrompt(options: any): string {
  const systemPrompt = options.resourceLoader?.getSystemPrompt?.();
  const appendSystemPrompt = options.resourceLoader?.getAppendSystemPrompt?.() ?? [];
  return [systemPrompt, ...appendSystemPrompt].filter(Boolean).join("\n\n");
}

function createMockAgentSession(options: any) {
  const listeners = new Set<(event: any) => void>();
  let seedMessages: any[] = [];
  let stateMessages: any[] = [];
  let isStreaming = false;

  const emit = (event: any) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const record = {
    options,
    seedMessages,
    promptCalls: [] as Array<{ text: string; context: StreamContext }>,
    emit,
    getListenerCount: () => listeners.size,
    getIsStreaming: () => isStreaming,
    session: null as any,
  };

  const session = {
    agent: {
      state: {
        get messages() {
          return stateMessages;
        },
        set messages(messages: any[]) {
          seedMessages = messages.map((message) => structuredClone(message));
          stateMessages = seedMessages.map((message) => structuredClone(message));
          record.seedMessages = seedMessages;
        },
      },
    },
    state: {
      get messages() {
        return stateMessages;
      },
      model: options.model,
      tools: (options.tools ?? []).map((name: string) => ({ name })),
    },
    get model() {
      return options.model;
    },
    get isStreaming() {
      return isStreaming;
    },
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    prompt: vi.fn(async (text: string) => {
      const userMessage = {
        role: "user",
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
      };
      const context: StreamContext = {
        systemPrompt: buildMockSystemPrompt(options),
        messages: [...stateMessages.map((message) => structuredClone(message)), userMessage],
      };
      record.promptCalls.push({ text, context });

      emit({ type: "turn_start" });
      emit({ type: "message_start", message: userMessage });
      emit({ type: "message_end", message: userMessage });

      const stream = promptStreamMock(record, text, context) as AsyncIterable<PromptStreamEvent>;
      let assistantStarted = false;
      let thinking = "";
      let answer = "";
      let finalMessage: ReturnType<typeof makeAssistantMessage> | null = null;

      const emitAssistantUpdate = () => {
        const assistantMessage = {
          ...makeAssistantMessage(answer),
          content: buildAssistantContent(thinking, answer),
        };
        if (!assistantStarted) {
          assistantStarted = true;
          emit({ type: "message_start", message: assistantMessage });
        }
        emit({ type: "message_update", message: assistantMessage });
      };

      isStreaming = true;
      for await (const event of stream) {
        if (event.type === "thinking_delta") {
          thinking += event.delta;
          emitAssistantUpdate();
          continue;
        }
        if (event.type === "text_delta") {
          answer += event.delta;
          emitAssistantUpdate();
          continue;
        }
        if (event.type === "tool_execution_start") {
          emit({
            type: "tool_execution_start",
            toolCallId: `call-${record.promptCalls.length}`,
            toolName: event.toolName,
            args: event.args ?? {},
          });
          continue;
        }
        if (event.type === "tool_execution_end") {
          emit({
            type: "tool_execution_end",
            toolCallId: `call-${record.promptCalls.length}`,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError ?? false,
          });
          continue;
        }
        finalMessage = event.type === "done" ? event.message : event.error;
      }
      isStreaming = false;

      if (!finalMessage) {
        finalMessage = makeAssistantMessage(answer);
      }

      if (!assistantStarted) {
        emit({ type: "message_start", message: finalMessage });
      }
      emit({ type: "message_end", message: finalMessage });
      emit({ type: "turn_end", message: finalMessage });
      stateMessages = [...context.messages.map((message) => structuredClone(message)), structuredClone(finalMessage)];
    }),
    abort: vi.fn(async () => {
      isStreaming = false;
    }),
    dispose: vi.fn(() => {
      listeners.clear();
    }),
  };

  record.session = session;
  subSessionRecords.push(record);
  return { session, extensionsResult: { extensions: [], errors: [], runtime: {} } };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function getCustomEntries(entries: SessionEntry[], customType: string): CustomEntry[] {
  return entries.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === customType);
}

function createHarness(
  initialEntries: SessionEntry[] = [],
  options: {
    keybindingMatches?: (data: string, id: string) => boolean;
  } = {},
) {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Function[]>();
  const entries: SessionEntry[] = [...initialEntries];
  const notifications: Array<{ message: string; type?: string }> = [];
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
  const overlayHandles: FakeOverlayHandle[] = [];
  const overlays: Array<{ factoryOptions?: unknown; done?: (result: unknown) => void; component?: any }> = [];
  const tui = { requestRender: vi.fn() };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    italic: (text: string) => text,
    bold: (text: string) => text,
  };
  const keybindings = {
    matches: options.keybindingMatches ?? ((_data: string, _id: string) => false),
  };

  const sessionManager = {
    getEntries: () => entries,
    getLeafId: () => "leaf",
    getBranch: () => entries,
  };

  let model: { provider: string; id: string; api: string } | null = {
    provider: "test-provider",
    id: "test-model",
    api: "openai-responses",
  };
  let idle = true;
  let hasCredentials = true;
  let authApiKey: string | undefined = "test-key";
  const hostModelRuntime = { streamSimple: vi.fn(), getModel: vi.fn() };

  const ui = {
    theme,
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifications.push({ message, type });
    },
    setWidget: () => {},
    custom: async (factory: any, customOptions?: any) => {
      let done!: (result: unknown) => void;
      const resultPromise = new Promise((resolve) => {
        done = (result: unknown) => resolve(result);
      });
      const handle = new FakeOverlayHandle();
      overlayHandles.push(handle);
      customOptions?.onHandle?.(handle);
      const component = await factory(tui as any, theme as any, keybindings as any, done);
      overlays.push({ factoryOptions: customOptions, done, component });
      return resultPromise;
    },
  };

  const api: ExtensionAPI = {
    on: ((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as any,
    registerTool: vi.fn() as any,
    registerCommand: ((name: string, commandOptions: any) => {
      commands.set(name, { name, ...commandOptions } as RegisteredCommand);
    }) as any,
    registerShortcut: vi.fn() as any,
    registerFlag: vi.fn() as any,
    getFlag: vi.fn() as any,
    registerMessageRenderer: vi.fn() as any,
    sendMessage: vi.fn() as any,
    sendUserMessage: ((content: unknown, sendOptions?: unknown) => sentUserMessages.push({ content, options: sendOptions })) as any,
    appendEntry: ((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })) as any,
    getThinkingLevel: vi.fn(() => "off") as any,
    setThinkingLevel: vi.fn() as any,
  } as unknown as ExtensionAPI;

  btwExtension(api);

  const baseCtx = {
    hasUI: true,
    ui: ui as any,
    sessionManager: sessionManager as any,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () =>
        hasCredentials ? { ok: true, apiKey: authApiKey, headers: undefined } : { ok: false, error: 'No API key found for "test"' },
      ),
      runtime: hostModelRuntime,
    },
    get model() {
      return model;
    },
    getSystemPrompt: () => "system",
    isIdle: () => idle,
  };

  async function runEvent(name: string, event: unknown = {}, ctx: ExtensionContext | ExtensionCommandContext = baseCtx as any) {
    const list = handlers.get(name) ?? [];
    for (const handler of list) {
      await handler(event, ctx);
    }
  }

  async function runSessionStart() {
    await runEvent("session_start");
  }

  async function command(name: string, args = "") {
    const cmd = commands.get(name);
    if (!cmd) throw new Error(`Missing command: ${name}`);
    await cmd.handler(args, baseCtx as unknown as ExtensionCommandContext);
  }

  function latestOverlayComponent() {
    const overlay = overlays.at(-1)?.component;
    if (!overlay) throw new Error("Overlay not created");
    return overlay;
  }

  function overlayText() {
    return latestOverlayComponent().render(100).join("\n");
  }

  return {
    api,
    commands,
    entries,
    notifications,
    sentUserMessages,
    overlayHandles,
    overlays,
    baseCtx,
    runSessionStart,
    runEvent,
    command,
    latestOverlayComponent,
    overlayText,
    setIdle(value: boolean) {
      idle = value;
    },
    hostModelRuntime,
    setCredentials(value: boolean) {
      hasCredentials = value;
    },
    setAuthApiKey(value: string | undefined) {
      authApiKey = value;
    },
    setModel(value: { provider: string; id: string; api: string } | null) {
      model = value;
    },
  };
}

describe("btw runtime behavior", () => {
  beforeEach(() => {
    promptStreamMock.mockReset();
    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockImplementation(async (options: any) => createMockAgentSession(options));
    sessionManagerInMemoryMock.mockClear();
    subSessionRecords.length = 0;
    promptStreamMock.mockImplementation((_record: any, text: string) => streamAnswer(`answer to: ${text}`));
  });

  it("registers exactly the three btw commands", () => {
    const harness = createHarness();
    expect([...harness.commands.keys()].sort()).toEqual(["btw", "btw:clear", "btw:inject"]);
  });

  it("creates a BTW sub-session with an in-memory session manager, coding tools, and the BTW aside prompt appended to pi's default prompt", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "what file defines this route?");

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const record = subSessionRecords[0];
    expect(sessionManagerInMemoryMock).toHaveBeenCalledTimes(1);
    expect(record.options.sessionManager).toEqual({ type: "in-memory-session" });
    expect(record.options.tools).toEqual(["read", "bash", "edit", "write"]);
    // Base system prompt stays pi's default; the BTW aside prompt rides in appendSystemPrompt.
    expect(record.options.resourceLoader.getSystemPrompt()).toBeUndefined();
    expect(record.options.resourceLoader.getAppendSystemPrompt()).toEqual([
      expect.stringContaining("side conversation"),
    ]);
    expect(record.promptCalls[0].text).toBe("what file defines this route?");

    const threadEntries = getCustomEntries(harness.entries, "btw-thread-entry");
    expect(threadEntries).toHaveLength(1);
    expect(threadEntries[0].data).toMatchObject({
      question: "what file defines this route?",
      answer: "answer to: what file defines this route?",
    });
  });

  it("seeds the sub-session with main-session messages but excludes visible btw notes", async () => {
    const harness = createHarness([
      {
        type: "message",
        id: "1",
        message: { role: "user", content: [{ type: "text", text: "main session task" }], timestamp: Date.now() },
      } as SessionEntry,
      {
        type: "message",
        id: "2",
        parentId: "1",
        message: makeAssistantMessage("main session answer"),
      } as SessionEntry,
      {
        type: "custom_message",
        id: "leaf",
        parentId: "2",
        customType: "btw-note",
        content: "saved btw note",
        display: true,
        timestamp: Date.now(),
      } as SessionEntry,
    ]);

    await harness.runSessionStart();
    await harness.command("btw", "contextual start");

    const seedTexts = subSessionRecords[0].seedMessages.map((message) => (message.content[0] as any)?.text ?? "");
    expect(seedTexts).toContain("main session task");
    expect(seedTexts).toContain("main session answer");
    expect(seedTexts).not.toContain("saved btw note");
  });

  it("keeps one continuous sub-session across follow-up questions", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "first question");
    await harness.command("btw", "second question");

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(subSessionRecords[0].promptCalls.map((call) => call.text)).toEqual(["first question", "second question"]);
  });

  it("recreates the sub-session when the main model changes, reseeding the completed thread", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "first question");

    harness.setModel({ provider: "other-provider", id: "other-model", api: "openai-responses" });
    await harness.command("btw", "second question");

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(subSessionRecords[0].session.dispose).toHaveBeenCalledTimes(1);
    const seedTexts = subSessionRecords[1].seedMessages.map((message) => (message.content[0] as any)?.text ?? "");
    expect(seedTexts).toContain("first question");
    expect(seedTexts).toContain("answer to: first question");
  });

  it("renders the streamed exchange in the overlay transcript without icons or emoji", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "say cheese");

    const text = harness.overlayText();
    expect(text).toContain("> say cheese");
    expect(text).toContain("answer to: say cheese");
    expect(text).toContain("1 exchange");
    // Restrained, text-only UI: no emoji, pictographs, or arrow glyphs in the rendered
    // overlay (box-drawing borders and the "·" separator are layout, not icons).
    expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2190}-\u{21FF}]|[⏳❌▍↳]/u);
  });

  it("shows partial streamed output and a streaming state while the sub-session is mid-turn", async () => {
    const harness = createHarness();
    const blocking = createBlockingAnswerStream("full answer text");
    promptStreamMock.mockImplementationOnce(() => blocking.stream());

    await harness.runSessionStart();
    const running = harness.command("btw", "long question");
    await flushAsyncWork();

    const midStream = harness.overlayText();
    expect(midStream).toContain("> long question");
    expect(midStream).toContain("full ans");
    expect(midStream).toContain("streaming");

    blocking.release();
    await running;
    expect(harness.overlayText()).toContain("full answer text");
    expect(harness.overlayText()).toContain("idle");
  });

  it("shows tool activity as plain dim lines", async () => {
    const harness = createHarness();
    promptStreamMock.mockImplementationOnce(async function* () {
      yield { type: "tool_execution_start" as const, toolName: "read", args: { path: "package.json" } };
      yield {
        type: "tool_execution_end" as const,
        toolName: "read",
        result: { content: [{ type: "text", text: "{}" }] },
      };
      yield { type: "text_delta" as const, delta: "done reading" };
      yield { type: "done" as const, message: makeAssistantMessage("done reading") };
    });

    await harness.runSessionStart();
    await harness.command("btw", "read the manifest");

    const text = harness.overlayText();
    expect(text).toContain("read package.json");
    expect(text).toContain("done reading");
  });

  it("keeps the overlay recoverable after a prompt failure and disposes the failed sub-session", async () => {
    const harness = createHarness();
    const failing = createStreamingFailureStream();
    promptStreamMock.mockImplementationOnce(() => failing.stream());

    await harness.runSessionStart();
    const running = harness.command("btw", "doomed question");
    await flushAsyncWork();
    failing.release();
    await running;

    expect(harness.overlayText()).toContain("error: Sub-session prompt exploded");
    expect(subSessionRecords[0].session.dispose).toHaveBeenCalledTimes(1);
    expect(harness.notifications.some((note) => note.type === "error")).toBe(true);

    // The failed exchange is not persisted; a retry starts a fresh sub-session.
    expect(getCustomEntries(harness.entries, "btw-thread-entry")).toHaveLength(0);
    await harness.command("btw", "retry question");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(getCustomEntries(harness.entries, "btw-thread-entry")).toHaveLength(1);
  });

  it("aborts and disposes the sub-session when Escape dismisses mid-stream, dropping the partial turn", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "finished question");

    const blocking = createBlockingToolStream();
    promptStreamMock.mockImplementationOnce(() => blocking.stream());
    const running = harness.command("btw", "aborted question");
    await flushAsyncWork();

    const overlay = harness.latestOverlayComponent();
    (overlay as any).input.onEscape?.();
    await flushAsyncWork();
    blocking.release();
    await running;

    const record = subSessionRecords[0];
    expect(record.session.abort).toHaveBeenCalled();
    expect(record.session.dispose).toHaveBeenCalledTimes(1);
    expect(record.getListenerCount()).toBe(0);
    expect(harness.overlayHandles[0].hideCalls).toBeGreaterThan(0);

    // Reopening rebuilds the transcript from completed exchanges only.
    await harness.command("btw", "");
    const text = harness.overlayText();
    expect(text).toContain("> finished question");
    expect(text).not.toContain("aborted question");
  });

  it("reopens the overlay with the persisted thread after dismissal", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "remember me");

    const overlay = harness.latestOverlayComponent();
    (overlay as any).input.onEscape?.();
    await flushAsyncWork();

    await harness.command("btw", "");
    expect(harness.overlays.length).toBe(2);
    expect(harness.overlayText()).toContain("> remember me");
    expect(harness.overlayText()).toContain("answer to: remember me");
  });

  it("restores the hidden thread from session entries after the last reset marker", async () => {
    const harness = createHarness([
      { type: "custom", customType: "btw-thread-entry", data: { question: "old q", answer: "old a", timestamp: 1 } },
      { type: "custom", customType: "btw-thread-reset", data: { timestamp: 2 } },
      { type: "custom", customType: "btw-thread-entry", data: { question: "new q", answer: "new a", timestamp: 3 } },
    ]);

    await harness.runSessionStart();
    await harness.command("btw", "");

    const text = harness.overlayText();
    expect(text).toContain("> new q");
    expect(text).toContain("new a");
    expect(text).not.toContain("old q");

    // The restored thread also seeds the next sub-session.
    const seedTexts = subSessionRecords[0].seedMessages.map((message) => (message.content[0] as any)?.text ?? "");
    expect(seedTexts).toContain("new q");
    expect(seedTexts).toContain("new a");
  });

  it("injects the full thread as a user message when idle and clears the thread", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "side question");
    await harness.command("btw:inject", "implement what we discussed");

    expect(harness.sentUserMessages).toHaveLength(1);
    const { content, options } = harness.sentUserMessages[0];
    expect(String(content)).toContain("implement what we discussed");
    expect(String(content)).toContain("User: side question");
    expect(String(content)).toContain("Assistant: answer to: side question");
    expect(options).toBeUndefined();

    expect(getCustomEntries(harness.entries, "btw-thread-reset")).toHaveLength(1);
    expect(harness.overlayHandles[0].hideCalls).toBeGreaterThan(0);

    // Thread is gone: a second inject has nothing to send.
    await harness.command("btw:inject", "");
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.notifications.at(-1)).toMatchObject({ type: "warning" });
  });

  it("queues the injection as a follow-up while the main session is busy", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "side question");

    harness.setIdle(false);
    await harness.command("btw:inject", "");

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("clears the thread and dismisses the overlay on /btw:clear", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "throwaway");
    await harness.command("btw:clear");

    expect(getCustomEntries(harness.entries, "btw-thread-reset")).toHaveLength(1);
    expect(subSessionRecords[0].session.dispose).toHaveBeenCalledTimes(1);
    expect(harness.overlayHandles[0].hideCalls).toBeGreaterThan(0);

    await harness.command("btw", "");
    expect(harness.overlayText()).toContain("No side thread yet");
  });

  it("routes overlay-composed /btw commands to the command handlers and other input to the sub-session", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "first question");

    const overlay = harness.latestOverlayComponent();
    (overlay as any).input.onSubmit?.("follow-up question");
    await flushAsyncWork();
    expect(subSessionRecords[0].promptCalls.map((call) => call.text)).toEqual(["first question", "follow-up question"]);

    (overlay as any).input.onSubmit?.("/btw:clear");
    await flushAsyncWork();
    expect(getCustomEntries(harness.entries, "btw-thread-reset")).toHaveLength(1);
  });

  it("clears a non-empty composer on app.clear without dismissing, and dismisses when empty", async () => {
    const harness = createHarness([], {
      keybindingMatches: (data, id) => id === "app.clear" && data === "",
    });
    await harness.runSessionStart();
    await harness.command("btw", "");

    const overlay = harness.latestOverlayComponent();
    const input = (overlay as any).input;
    input.setValue("draft text");
    input.handleInput("");
    expect(input.getValue()).toBe("");
    expect(harness.overlayHandles[0].hideCalls).toBe(0);

    input.handleInput("");
    await flushAsyncWork();
    expect(harness.overlayHandles[0].hideCalls).toBeGreaterThan(0);
  });

  it("reports a missing model instead of creating a sub-session", async () => {
    const harness = createHarness();
    harness.setModel(null);
    await harness.runSessionStart();
    await harness.command("btw", "anyone there?");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(harness.notifications.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports missing credentials instead of prompting", async () => {
    const harness = createHarness();
    harness.setCredentials(false);
    await harness.runSessionStart();
    await harness.command("btw", "anyone there?");

    expect(subSessionRecords).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain("No API key found");
  });

  it("runs keyless providers that resolve auth without an API key", async () => {
    const harness = createHarness();
    harness.setAuthApiKey(undefined);
    await harness.runSessionStart();
    await harness.command("btw", "local model?");

    expect(subSessionRecords).toHaveLength(1);
    expect(subSessionRecords[0].promptCalls[0].text).toBe("local model?");
  });

  it("reuses the host model runtime so extension-registered providers work in the sub-session", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "which runtime?");

    expect(subSessionRecords[0].options.modelRuntime).toBe(harness.hostModelRuntime);
    expect(subSessionRecords[0].options).not.toHaveProperty("modelRegistry");
  });

  it("does not leak btw thread entries into visible messages or the main context", async () => {
    const harness = createHarness();
    await harness.runSessionStart();
    await harness.command("btw", "quiet question");

    // Thread state persists only as hidden custom entries; nothing is sent to the main session.
    expect(harness.sentUserMessages).toHaveLength(0);
    const entryTypes = harness.entries.map((entry) => (entry as CustomEntry).customType);
    expect(entryTypes).toEqual(["btw-thread-entry"]);
  });
});
