/**
 * A controlled stand-in for the parts of Pi the extension actually uses.
 *
 * It records commands, tools, messages, and bus events, and it models the one
 * ordering rule the extension depends on: Pi persists a custom message to the
 * session branch when the agent receives it, not when it is queued.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
  delivered: boolean;
}

export interface Notification {
  message: string;
  level: string;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface PiHarness {
  api: ExtensionAPI;
  ctx: ExtensionCommandContext;
  sent: SentMessage[];
  emitted: Array<{ name: string; payload: unknown }>;
  notifications: Notification[];
  activeTools: string[];
  /** Run a registered command the way Pi dispatches one. */
  run(name: string, args?: string): Promise<void>;
  /** Call a registered tool the way the model would, with Pi's tool signal. */
  call(
    name: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  /** Deliver a queued custom message: the agent has now received it. */
  deliver(customType?: string): SentMessage;
  /** Append an assistant message, optionally one that also calls a tool. */
  assistant(text: string, tool?: string): void;
  /** Append a tool result, the way a real tool-calling turn records one. */
  toolResult(text: string): void;
  /** Append a plain user message, which ends a response segment. */
  user(text: string): void;
  /** Fire one lifecycle event at every subscriber. */
  fire(event: "agent_settled" | "session_shutdown"): Promise<void>;
}

export function createPi(options: {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
}): PiHarness {
  const mode = options.mode ?? "tui";
  const hasUI = options.hasUI ?? (mode === "tui" || mode === "rpc");
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >();
  const tools = new Map<string, { execute: Function }>();
  const handlers = new Map<string, Handler[]>();
  const entries: Entry[] = [];
  const sent: SentMessage[] = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const notifications: Notification[] = [];
  let activeTools: string[] = ["read", "bash"];
  let counter = 0;

  const append = (entry: Partial<Entry> & { type: string }) => {
    counter += 1;
    entries.push({
      ...entry,
      id: `entry-${counter}`,
      parentId: counter === 1 ? null : `entry-${counter - 1}`,
      timestamp: new Date(counter * 1000).toISOString(),
    });
  };

  const ctx = {
    mode,
    hasUI,
    cwd: options.cwd,
    ui: {
      notify: (message: string, level: string) => {
        if (!hasUI) throw new Error("notify is unavailable without UI");
        notifications.push({ message, level });
      },
    },
    sessionManager: { getBranch: () => [...entries] },
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;

  const api = {
    registerCommand: (name: string, definition: { handler: Function }) =>
      void commands.set(
        name,
        definition.handler as (
          args: string,
          ctx: ExtensionCommandContext,
        ) => Promise<void>,
      ),
    registerTool: (tool: { name: string; execute: Function }) =>
      void tools.set(tool.name, tool),
    on: (event: string, handler: Handler) =>
      void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: (
      message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
      },
      _options?: unknown,
    ) => void sent.push({ ...message, delivered: false }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => void (activeTools = [...names]),
    events: {
      emit: (name: string, payload: unknown) =>
        void emitted.push({ name, payload }),
      on: () => undefined,
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    ctx,
    sent,
    emitted,
    notifications,
    get activeTools() {
      return [...activeTools];
    },
    run: async (name, args = "") => {
      const handler = commands.get(name);
      if (!handler) throw new Error(`no command named ${name}`);
      await handler(args, ctx);
    },
    call: async (name, params, signal) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool named ${name}`);
      return (await tool.execute(
        "call-1",
        params,
        signal,
        undefined,
        ctx,
      )) as ToolResult;
    },
    deliver: (customType) => {
      const message = sent.find(
        (item) =>
          !item.delivered && (!customType || item.customType === customType),
      );
      if (!message) throw new Error(`no queued ${customType ?? "message"}`);
      message.delivered = true;
      append({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
        display: message.display,
      });
      return message;
    },
    assistant: (text, tool) =>
      append({
        type: "message",
        message: {
          role: "assistant",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...(tool
              ? [{ type: "toolCall", id: `tool-${counter}`, name: tool }]
              : []),
          ],
        },
      }),
    toolResult: (text) =>
      append({
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text }],
        },
      }),
    user: (text) =>
      append({
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    fire: async (event) => {
      for (const handler of handlers.get(event) ?? [])
        await handler({ type: event }, ctx);
    },
  };
}
