/**
 * Newline-delimited JSON-RPC 2.0 over a byte stream.
 *
 * This is the whole MCP stdio transport: one JSON message per line, in and out.
 * It knows nothing about Quick Review, so it can be driven over a pipe in a
 * test exactly as a host drives it over stdio.
 *
 * Requests are dispatched without waiting for each other. A review host blocks
 * one request on the reviewer for minutes at a time, and everything else on the
 * connection has to keep working while it does.
 */

import type { Readable, Writable } from "node:stream";

/** Refuse a line long before a malformed stream can exhaust memory. */
export const MAX_MESSAGE = 8 * 1024 * 1024;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export function methodNotFound(method: string): RpcError {
  return new RpcError(METHOD_NOT_FOUND, `unknown method: ${method}`);
}

export function invalidParams(detail: string): RpcError {
  return new RpcError(INVALID_PARAMS, detail);
}

type Id = string | number;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export type Dispatch = (
  method: string,
  params: unknown,
  signal: AbortSignal,
) => unknown;

export interface Connection {
  /** Stop reading and abort every request still in flight. */
  close(): void;
}

export interface ServeOptions {
  input: Readable;
  output: Writable;
  dispatch: Dispatch;
  /** Called once the peer closes the stream. */
  onClose?: () => void;
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || typeof value === "number";
}

export function serve(options: ServeOptions): Connection {
  const { input, output, dispatch } = options;
  const inFlight = new Map<Id, AbortController>();
  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;

  const send = (message: unknown) => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };

  const fail = (id: Id, error: unknown) => {
    const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
    const message = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const run = async (id: Id | undefined, method: string, params: unknown) => {
    const controller = new AbortController();
    if (id !== undefined) inFlight.set(id, controller);
    try {
      const result = await dispatch(method, params, controller.signal);
      // A notification draws no reply, however it went.
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      if (id !== undefined) fail(id, error);
    } finally {
      if (id !== undefined) inFlight.delete(id);
    }
  };

  const receive = (line: string) => {
    let message: Message;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("message is not an object");
      message = value as Message;
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: PARSE_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    const id = isId(message.id) ? message.id : undefined;
    // A response to something we sent: this server issues no requests, so
    // there is nothing to route it to and nothing to complain about.
    if (message.method === undefined) return;
    if (typeof message.method !== "string") {
      if (id !== undefined)
        fail(id, new RpcError(INVALID_REQUEST, "method must be a string"));
      return;
    }
    // Cancellation has to be handled here, not in dispatch: the request it
    // names is still running and only this layer holds its controller.
    if (message.method === "notifications/cancelled") {
      const params = message.params as { requestId?: unknown } | undefined;
      if (isId(params?.requestId)) inFlight.get(params.requestId)?.abort();
      return;
    }
    void run(id, message.method, message.params);
  };

  const onData = (chunk: Buffer) => {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    if (buffer.length > MAX_MESSAGE) {
      buffer = Buffer.alloc(0);
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: PARSE_ERROR,
          message: "message exceeded the size limit",
        },
      });
      return;
    }
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.toString("utf8", 0, end).replace(/\r$/, "");
      buffer = buffer.subarray(end + 1);
      if (line.trim()) receive(line);
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  };

  input.on("data", onData);
  input.once("end", () => {
    close();
    options.onClose?.();
  });

  return { close };
}
