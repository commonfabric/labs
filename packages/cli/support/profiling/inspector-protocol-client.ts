import { isObjectNotArray } from "@commonfabric/utils/types";
type ProtocolResponse = {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
};

type ProtocolEvent = {
  method: string;
  params?: unknown;
};

function isProtocolMessage(
  message: unknown,
): message is ProtocolResponse | ProtocolEvent {
  if (!isObjectNotArray(message)) {
    return false;
  }

  if ("id" in message) return typeof message.id === "number";
  return "method" in message && typeof message.method === "string";
}

type PendingCommand = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

export class InspectorProtocolClient extends EventTarget {
  readonly Console = {
    enable: () => this.#command("Console.enable"),
  };

  readonly Debugger = {
    enable: (params: Record<string, unknown>) =>
      this.#command("Debugger.enable", params),
  };

  readonly Profiler = {
    enable: () => this.#command("Profiler.enable"),
    setSamplingInterval: (params: { interval: number }) =>
      this.#command("Profiler.setSamplingInterval", params),
    start: () => this.#command<void>("Profiler.start"),
    stop: () => this.#command<{ profile: unknown }>("Profiler.stop"),
  };

  readonly Runtime = {
    enable: () => this.#command("Runtime.enable"),
  };

  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCommand>();
  #nextId = 1;
  #closed = false;

  constructor(socket: WebSocket) {
    super();
    this.#socket = socket;
    socket.addEventListener("message", this.#handleMessage);
    socket.addEventListener("close", this.#handleClose);
    socket.addEventListener("error", this.#handleError);
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) {
      this.#handleClose();
      return;
    }

    const closed = Promise.withResolvers<void>();
    const handleClose = () => {
      cleanup();
      closed.resolve();
    };
    const handleError = (event: Event) => {
      cleanup();
      closed.reject(event);
    };
    const cleanup = () => {
      this.#socket.removeEventListener("close", handleClose);
      this.#socket.removeEventListener("error", handleError);
    };

    this.#socket.addEventListener("close", handleClose);
    this.#socket.addEventListener("error", handleError);
    this.#socket.close();
    await closed.promise;
  }

  #command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Inspector WebSocket is not open"));
    }

    const id = this.#nextId++;
    const result = Promise.withResolvers<T>();
    this.#pending.set(id, {
      resolve: (value) => result.resolve(value as T),
      reject: result.reject,
    });
    try {
      this.#socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.#pending.delete(id);
      result.reject(error);
    }
    return result.promise;
  }

  #handleMessage = (event: MessageEvent): void => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      this.#rejectPending(
        new Error("Inspector sent an invalid protocol message", {
          cause: error,
        }),
      );
      return;
    }

    if (!isProtocolMessage(message)) {
      this.#rejectPending(
        new Error("Inspector sent an invalid protocol message"),
      );
      return;
    }

    if ("id" in message) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const details = message.error.data ? `: ${message.error.data}` : "";
        pending.reject(
          new Error(
            `${message.error.message} (${message.error.code})${details}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.dispatchEvent(
      new CustomEvent(message.method, { detail: message.params }),
    );
  };

  #handleClose = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("Inspector WebSocket closed"));
    this.#detach();
  };

  #handleError = (event: Event): void => {
    this.#rejectPending(event);
  };

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #detach(): void {
    this.#socket.removeEventListener("message", this.#handleMessage);
    this.#socket.removeEventListener("close", this.#handleClose);
    this.#socket.removeEventListener("error", this.#handleError);
  }
}
