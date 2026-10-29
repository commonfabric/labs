import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  CAPTURE_STOP_SIGNAL,
  captureDenoInspectorProfile,
  guardCaptureStopSignal,
  markProfilerStarted,
  markProfileStoppedOnce,
  parseArg,
  type ProfileCaptureState,
  profileErrorOutputPath,
  type ProfileStopState,
  recordConsoleProfileMessage,
  requireArg,
  resumeDebuggerOnPause,
  sendInspectorCommand,
  settleInspectorCommand,
  startProfilerIfReady,
  stopActiveProfiler,
  stringifyRemoteObject,
  waitForWebSocketOpen,
  writeProfileCaptureFiles,
} from "./capture-deno-inspector-profile-lib.ts";

function createState(): ProfileCaptureState {
  return {
    consoleMessages: [],
    profilerActive: false,
    profilerStarting: false,
    sawProfileStart: false,
    sawProfileStop: false,
  };
}

function createProfilerStarter(start: () => Promise<void>) {
  return {
    enable: () => Promise.resolve(),
    setSamplingInterval: (_params: { interval: number }) => Promise.resolve(),
    start,
  };
}

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  added: string[] = [];
  removed: string[] = [];
  sent: string[] = [];
  #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.added.push(type);
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.removed.push(type);
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event = new Event(type)): Event {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

class FakeCelestial {
  calls: string[] = [];
  closeError: unknown;
  closePromise: Promise<void> | undefined;
  closeStarted: PromiseWithResolvers<void> | undefined;
  closeThrow: unknown;
  profilerEnableError: unknown;
  samplingIntervalError: unknown;
  starts = 0;
  stops = 0;
  removedListeners: string[] = [];
  runtimeEnableError: unknown;
  startError: unknown;
  startPromise: Promise<void> | undefined;
  profilerEnabled = false;
  profilerEnableGate: PromiseWithResolvers<void> | undefined;
  profilerEnableCalled = Promise.withResolvers<void>();
  profile: unknown = { nodes: [] };
  samplingIntervals: number[] = [];
  #listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  Runtime = {
    enable: () => {
      this.calls.push("Runtime.enable");
      if (this.runtimeEnableError) {
        return Promise.reject(this.runtimeEnableError);
      }
      return Promise.resolve();
    },
  };

  Console = {
    enable: () => {
      this.calls.push("Console.enable");
      return Promise.resolve();
    },
  };

  Debugger = {
    enable: (_params: Record<string, unknown>) => {
      this.calls.push("Debugger.enable");
      return Promise.resolve();
    },
  };

  Profiler = {
    enable: () => {
      this.calls.push("Profiler.enable");
      this.profilerEnableCalled.resolve();
      if (this.profilerEnableError) {
        return Promise.reject(this.profilerEnableError);
      }
      const gate = this.profilerEnableGate?.promise ?? Promise.resolve();
      return gate.then(() => {
        this.profilerEnabled = true;
      });
    },
    setSamplingInterval: (params: { interval: number }) => {
      this.calls.push("Profiler.setSamplingInterval");
      if (this.samplingIntervalError) {
        return Promise.reject(this.samplingIntervalError);
      }
      this.samplingIntervals.push(params.interval);
      return Promise.resolve();
    },
    start: () => {
      this.calls.push("Profiler.start");
      this.starts += 1;
      // What the inspector answers a `Profiler.start` it has not enabled yet.
      if (!this.profilerEnabled) {
        return Promise.reject(new Error("Profiler is not enabled (-32000)"));
      }
      if (this.startError) return Promise.reject(this.startError);
      return this.startPromise ?? Promise.resolve();
    },
    stop: () => {
      this.calls.push("Profiler.stop");
      this.stops += 1;
      return Promise.resolve({ profile: this.profile });
    },
  };

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) return;
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) return;
    this.removedListeners.push(type);
    this.#listeners.get(type)?.delete(listener);
  }

  close(): Promise<void> {
    this.calls.push("close");
    this.closeStarted?.resolve();
    if (this.closeThrow) throw this.closeThrow;
    if (this.closeError) return Promise.reject(this.closeError);
    return this.closePromise ?? Promise.resolve();
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  dispatchConsole(...args: Record<string, unknown>[]): void {
    this.dispatch(
      "Runtime.consoleAPICalled",
      new CustomEvent("Runtime.consoleAPICalled", { detail: { args } }),
    );
  }
}

async function withTempDir(
  run: (tmpDir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "profile-lib-test-" });
  try {
    await run(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

function createCaptureRuntime(options: {
  addSignalListener?: (signal: Deno.Signal, handler: () => void) => void;
  celestial: FakeCelestial;
  logs: string[];
  errors?: string[];
  noSignalSupport?: boolean;
  resumed?: PromiseWithResolvers<void>;
  started?: PromiseWithResolvers<void>;
  signalHandlers?: Partial<Record<Deno.Signal, () => void>>;
  ws?: FakeWebSocket;
  removeSignalListener?: (
    signal: Deno.Signal,
    handler: () => void,
  ) => void;
}) {
  const ws = options.ws ?? new FakeWebSocket();
  ws.readyState = WebSocket.OPEN;
  const errors = options.errors ?? [];
  return {
    addSignalListener: options.noSignalSupport
      ? undefined
      : (signal: Deno.Signal, handler: () => void) => {
        if (options.addSignalListener) {
          options.addSignalListener(signal, handler);
          return;
        }
        if (options.signalHandlers) {
          options.signalHandlers[signal] = handler;
        }
      },
    console: {
      log: (message?: unknown, ...optionalParams: unknown[]) => {
        const text = [message, ...optionalParams].map(String).join(" ");
        options.logs.push(text);
        if (text === "profile: resumed target") {
          options.resumed?.resolve();
        }
        if (text === "profile: profiler started") {
          options.started?.resolve();
        }
      },
      error: (message?: unknown, ...optionalParams: unknown[]) => {
        errors.push([message, ...optionalParams].map(String).join(" "));
      },
    },
    createCelestial: () => options.celestial,
    createWebSocket: () => ws as unknown as WebSocket,
    removeSignalListener: options.removeSignalListener ?? (() => {}),
  };
}

describe("capture-deno-inspector-profile helpers", () => {
  it("parses named string arguments", () => {
    const args = [
      "--websocket-url=ws://127.0.0.1:9333/session",
      "--output=profile.cpuprofile",
    ];

    assertEquals(
      parseArg(args, "websocket-url"),
      "ws://127.0.0.1:9333/session",
    );
    assertEquals(parseArg(args, "missing"), undefined);
  });

  it("requires non-empty arguments", () => {
    assertEquals(
      requireArg(["--output=profile.cpuprofile"], "output"),
      "profile.cpuprofile",
    );
    assertThrows(
      () => requireArg(["--output="], "output"),
      Error,
      "--output is required",
    );
  });

  it("resolves when the websocket is already open", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    await waitForWebSocketOpen(ws as unknown as WebSocket);

    assertEquals(ws.added, []);
  });

  it("resolves after the websocket opens", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws as unknown as WebSocket);

    ws.dispatch("open");
    await opened;

    assertEquals(ws.added, ["open", "error", "close"]);
    assertEquals(ws.removed, ["open", "error", "close"]);
  });

  it("rejects when the websocket reports an error", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws as unknown as WebSocket);
    const event = ws.dispatch("error");

    let caught: unknown;
    try {
      await opened;
    } catch (error) {
      caught = error;
    }

    assertEquals(caught, event);
    assertEquals(ws.removed, ["open", "error", "close"]);
  });

  it("rejects when the websocket closes before opening", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws as unknown as WebSocket);
    const event = ws.dispatch("close", new CloseEvent("close"));

    let caught: unknown;
    try {
      await opened;
    } catch (error) {
      caught = error;
    }

    assertEquals(caught, event);
    assertEquals(ws.removed, ["open", "error", "close"]);
  });

  it("rejects when the websocket is already closed", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.CLOSED;

    let caught: unknown;
    try {
      await waitForWebSocketOpen(ws as unknown as WebSocket);
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "WebSocket closed before opening");
    assertEquals(ws.added, []);
  });

  it("resumes once when the debugger pauses", () => {
    const target = new EventTarget();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    resumeDebuggerOnPause(target, ws as unknown as WebSocket, -2);
    target.dispatchEvent(new Event("Debugger.paused"));
    target.dispatchEvent(new Event("Debugger.paused"));

    assertEquals(ws.sent, [
      '{"id":-2,"method":"Debugger.resume","params":{}}',
    ]);
  });

  it("can stop listening for debugger pauses", () => {
    const target = new EventTarget();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    const stopListening = resumeDebuggerOnPause(
      target,
      ws as unknown as WebSocket,
      -2,
    );
    stopListening();
    target.dispatchEvent(new Event("Debugger.paused"));

    assertEquals(ws.sent, []);
  });

  it("sends inspector commands when the websocket is open", () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    assertEquals(
      sendInspectorCommand(ws as unknown as WebSocket, -1, "Debugger.resume"),
      true,
    );

    assertEquals(ws.sent, [
      '{"id":-1,"method":"Debugger.resume","params":{}}',
    ]);
  });

  it("skips inspector commands when the websocket is closed", () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.CLOSED;

    assertEquals(
      sendInspectorCommand(ws as unknown as WebSocket, -1, "Debugger.resume"),
      false,
    );
    assertEquals(ws.sent, []);
  });

  it("settles inspector commands when the websocket closes", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const command = new Promise<void>(() => {});
    const settled = settleInspectorCommand(
      ws as unknown as WebSocket,
      () => command,
    );

    ws.readyState = WebSocket.CLOSED;
    ws.dispatch("close", new CloseEvent("close"));

    let caught: unknown;
    try {
      await settled;
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "WebSocket closed");
    assertEquals(ws.removed, ["close", "error"]);
  });

  it("rejects inspector commands when the websocket is already closed", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.CLOSED;

    let caught: unknown;
    try {
      await settleInspectorCommand(
        ws as unknown as WebSocket,
        () => Promise.resolve(),
      );
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "WebSocket closed");
    assertEquals(ws.added, []);
  });

  it("rejects inspector commands on websocket errors", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const settled = settleInspectorCommand(
      ws as unknown as WebSocket,
      () => new Promise<void>(() => {}),
    );
    const event = ws.dispatch("error");

    let caught: unknown;
    try {
      await settled;
    } catch (error) {
      caught = error;
    }

    assertEquals(caught, event);
    assertEquals(ws.removed, ["close", "error"]);
  });

  it("rejects inspector commands that throw before returning a promise", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    let caught: unknown;
    try {
      await settleInspectorCommand(ws as unknown as WebSocket, () => {
        throw new Error("boom");
      });
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "boom");
    assertEquals(ws.removed, ["close", "error"]);
  });

  it("ignores command completion after a websocket close has settled it", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const command = Promise.withResolvers<void>();
    const settled = settleInspectorCommand(
      ws as unknown as WebSocket,
      () => command.promise,
    );

    ws.readyState = WebSocket.CLOSED;
    ws.dispatch("close", new CloseEvent("close"));
    command.resolve();

    let caught: unknown;
    try {
      await settled;
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "WebSocket closed");
  });

  it("listens for websocket close before sending inspector commands", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const settled = settleInspectorCommand(
      ws as unknown as WebSocket,
      () => {
        ws.readyState = WebSocket.CLOSED;
        ws.dispatch("close", new CloseEvent("close"));
        return new Promise<void>(() => {});
      },
    );

    let caught: unknown;
    try {
      await settled;
    } catch (error) {
      caught = error;
    }

    assertEquals((caught as Error).message, "WebSocket closed");
    assertEquals(ws.removed, ["close", "error"]);
  });

  it("formats remote console values", () => {
    assertEquals(stringifyRemoteObject({ value: 0 }), "0");
    assertEquals(stringifyRemoteObject({ unserializableValue: "NaN" }), "NaN");
    assertEquals(stringifyRemoteObject({ description: "Map(0)" }), "Map(0)");
    assertEquals(stringifyRemoteObject({ type: "object" }), "[object]");
    assertEquals(stringifyRemoteObject({}), "[unknown]");
  });

  it("enables, configures, and starts the profiler when the websocket is open", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const logs: string[] = [];
    const calls: string[] = [];

    const started = await startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      {
        enable: () => {
          calls.push("enable");
          return Promise.resolve();
        },
        setSamplingInterval: ({ interval }) => {
          calls.push(`sampling:${interval}`);
          return Promise.resolve();
        },
        start: () => {
          calls.push("start");
          return Promise.resolve();
        },
      },
      (message) => logs.push(message),
    );

    assertEquals(started, true);
    expect(calls).toEqual(["enable", "sampling:100", "start"]);
    assertEquals(state.profilerActive, true);
    assertEquals(state.sawProfileStop, false);
    assertEquals(logs, ["profile: profiler started"]);
  });

  it("can preserve a stop latch when the profiler starts", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    state.sawProfileStop = true;

    const started = await startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      createProfilerStarter(() => Promise.resolve()),
      () => {},
      { clearStop: false },
    );

    assertEquals(started, true);
    assertEquals(state.profilerActive, true);
    assertEquals(state.sawProfileStop, true);
  });

  it("marks profile stop once", () => {
    const state: ProfileStopState = { ended: false };

    assertEquals(markProfileStoppedOnce(state, "summary-matched"), true);
    assertEquals(markProfileStoppedOnce(state, "signal-SIGINT"), false);
    assertEquals(state, { ended: true, reason: "summary-matched" });
  });

  it("does not start the profiler twice", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    state.profilerActive = true;
    let starts = 0;

    const started = await startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      createProfilerStarter(
        () => {
          starts += 1;
          return Promise.resolve();
        },
      ),
    );

    assertEquals(started, false);
    assertEquals(starts, 0);
  });

  it("does not start the profiler while a start is already in flight", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    let resolveStart: (() => void) | undefined;
    const startCalled = Promise.withResolvers<void>();
    let starts = 0;

    const firstStart = startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      createProfilerStarter(
        () => {
          starts += 1;
          startCalled.resolve();
          return new Promise<void>((resolve) => {
            resolveStart = resolve;
          });
        },
      ),
    );
    assertEquals(state.profilerStarting, true);
    await startCalled.promise;

    const secondStarted = await startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      createProfilerStarter(
        () => {
          starts += 1;
          return Promise.resolve();
        },
      ),
    );
    resolveStart?.();
    const firstStarted = await firstStart;

    assertEquals(secondStarted, false);
    assertEquals(firstStarted, true);
    assertEquals(starts, 1);
    assertEquals(state.profilerStarting, false);
    assertEquals(state.profilerActive, true);
  });

  it("clears the in-flight start state when profiler start fails", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    let caught: unknown;

    try {
      await startProfilerIfReady(
        state,
        ws as unknown as WebSocket,
        createProfilerStarter(() => Promise.reject(new Error("closed"))),
      );
    } catch (error) {
      caught = error;
    }

    assertEquals(
      (caught as Error).message,
      "Profiler.start failed during Profiler.start: Error: closed",
    );
    assertEquals(state.profilerStarting, false);
    assertEquals(state.profilerActive, false);
  });

  it("clears the in-flight start state when the websocket closes during profiler start", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    const startCalled = Promise.withResolvers<void>();
    const started = startProfilerIfReady(
      state,
      ws as unknown as WebSocket,
      createProfilerStarter(() => {
        startCalled.resolve();
        return new Promise<void>(() => {});
      }),
    );
    assertEquals(state.profilerStarting, true);
    await startCalled.promise;

    ws.readyState = WebSocket.CLOSED;
    ws.dispatch("close", new CloseEvent("close"));

    let caught: unknown;
    try {
      await started;
    } catch (error) {
      caught = error;
    }

    assertEquals(
      (caught as Error).message,
      "Profiler.start failed during Profiler.start: Error: WebSocket closed",
    );
    assertEquals(state.profilerStarting, false);
    assertEquals(state.profilerActive, false);
  });

  it("stops an active profiler", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    state.profilerActive = true;

    const result = await stopActiveProfiler(
      state,
      ws as unknown as WebSocket,
      {
        stop: () => Promise.resolve({ profile: { nodes: [] } }),
      },
    );

    assertEquals(result, { profile: { nodes: [] }, stopError: undefined });
    assertEquals(state.profilerActive, false);
  });

  it("records profiler stop failures", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    state.profilerActive = true;

    const result = await stopActiveProfiler(
      state,
      ws as unknown as WebSocket,
      {
        stop: () => Promise.reject(new Error("closed")),
      },
    );

    assertEquals(result.profile, null);
    assertEquals(result.stopError, "Profiler.stop failed: Error: closed");
    assertEquals(state.profilerActive, true);
  });

  it("records profiler stop failures when the websocket closes during stop", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    state.profilerActive = true;

    const stopped = stopActiveProfiler(
      state,
      ws as unknown as WebSocket,
      {
        stop: () => new Promise<{ profile: unknown }>(() => {}),
      },
    );

    ws.readyState = WebSocket.CLOSED;
    ws.dispatch("close", new CloseEvent("close"));

    const result = await stopped;

    assertEquals(result.profile, null);
    assertEquals(
      result.stopError,
      "Profiler.stop failed: Error: WebSocket closed",
    );
    assertEquals(state.profilerActive, true);
  });

  it("skips stopping when the profiler is inactive", async () => {
    const state = createState();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;
    let stops = 0;

    const result = await stopActiveProfiler(
      state,
      ws as unknown as WebSocket,
      {
        stop: () => {
          stops += 1;
          return Promise.resolve({ profile: {} });
        },
      },
    );

    assertEquals(result, { profile: null, stopError: undefined });
    assertEquals(stops, 0);
  });

  it("builds profiler error output paths", () => {
    assertEquals(
      profileErrorOutputPath("/tmp/profile.cpuprofile"),
      "/tmp/profile.error.txt",
    );
    assertEquals(
      profileErrorOutputPath("/tmp/profile.json"),
      "/tmp/profile.json.error.txt",
    );
  });

  it("writes captured profile and console files", async () => {
    const state = createState();
    state.consoleMessages.push("one", "two");
    const writes: Array<[string, string]> = [];
    const mkdirs: string[] = [];

    await writeProfileCaptureFiles({
      outputPath: "/tmp/profile.cpuprofile",
      consoleOutputPath: "/tmp/profile.console.log",
      state,
      profile: { nodes: [] },
      writer: {
        mkdir: (path) => {
          mkdirs.push(path);
          return Promise.resolve();
        },
        writeTextFile: (path, data) => {
          writes.push([path, data]);
          return Promise.resolve();
        },
      },
    });

    assertEquals(mkdirs, ["/tmp"]);
    assertEquals(writes, [
      ["/tmp/profile.cpuprofile", JSON.stringify({ nodes: [] }, null, 2)],
      ["/tmp/profile.console.log", "one\ntwo"],
    ]);
  });

  it("writes profiler stop errors", async () => {
    const state = createState();
    const writes: Array<[string, string]> = [];

    await writeProfileCaptureFiles({
      outputPath: "/tmp/profile.cpuprofile",
      state,
      profile: null,
      stopError: "stop failed",
      writer: {
        mkdir: () => Promise.reject(new Error("exists")),
        writeTextFile: (path, data) => {
          writes.push([path, data]);
          return Promise.resolve();
        },
      },
    });

    assertEquals(writes, [["/tmp/profile.error.txt", "stop failed"]]);
  });

  it("marks start and stop latches from console messages", () => {
    const state = createState();

    const startMessage = recordConsoleProfileMessage(
      state,
      "begin profile",
      /begin profile/,
      /stop profile/,
    );
    const stopMessage = recordConsoleProfileMessage(
      state,
      "stop profile",
      /begin profile/,
      /stop profile/,
    );

    expect(startMessage).toEqual({
      startedProfile: true,
      hadProfileStop: false,
    });
    expect(stopMessage).toEqual({
      startedProfile: false,
      hadProfileStop: false,
    });
    expect(state.consoleMessages).toEqual(["begin profile", "stop profile"]);
    expect(state.sawProfileStart).toBe(true);
    expect(state.sawProfileStop).toBe(true);
  });

  it("reports whether a stop latch existed before a start message", () => {
    const state = createState();
    state.sawProfileStop = true;

    const message = recordConsoleProfileMessage(
      state,
      "begin profile",
      /begin profile/,
      /stop profile/,
    );

    expect(message).toEqual({
      startedProfile: true,
      hadProfileStop: true,
    });
  });

  it("clears an early stop latch when profiling actually starts", () => {
    const state = createState();
    state.sawProfileStop = true;

    markProfilerStarted(state);

    expect(state.profilerActive).toBe(true);
    expect(state.sawProfileStop).toBe(false);
  });

  it("captures a profile after a summary console message", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      const consoleOutputPath = `${tmpDir}/profile.console.log`;
      const done = captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          `--console-output=${consoleOutputPath}`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 0);
      assertEquals(celestial.starts, 1);
      assertEquals(celestial.stops, 1);
      assertEquals(celestial.samplingIntervals, [100]);
      assertStringIncludes(
        await Deno.readTextFile(outputPath),
        '"nodes": []',
      );
      assertEquals(await Deno.readTextFile(consoleOutputPath), "done\ndone");
      assertEquals(logs.includes("profile: summary matched"), true);
    });
  });

  it("enables the profiler as part of a marker-triggered start", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const errors: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      const done = captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          "--summary-pattern=(?!)",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, errors, resumed, started }),
      );

      await resumed.promise;
      celestial.profilerEnabled = false;
      celestial.dispatchConsole({ value: "profile start" });
      const startedBeforeCaptureEnded = await Promise.race([
        started.promise.then(() => true),
        done.then(() => false),
      ]);
      assertEquals(
        startedBeforeCaptureEnded,
        true,
        `capture ended before profiler started: ${errors.join("\n")}`,
      );
      celestial.dispatchConsole({ value: "profile stop" });

      assertEquals(await done, 0);
      assertEquals(celestial.starts, 1);
      assertEquals(celestial.stops, 1);
      expect(celestial.calls).toEqual([
        "Runtime.enable",
        "Console.enable",
        "Debugger.enable",
        "Profiler.enable",
        "Profiler.setSamplingInterval",
        "Profiler.start",
        "Profiler.stop",
        "close",
      ]);
      assertEquals(logs.includes("profile: profile stop matched"), true);
    });
  });

  it("starts from a marker that arrives before the profiler is enabled", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const gate = Promise.withResolvers<void>();
      celestial.profilerEnableGate = gate;
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=(?!)",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed, started }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "profile start" });
      await celestial.profilerEnableCalled.promise;
      assertEquals(celestial.starts, 0);

      gate.resolve();
      await started.promise;
      celestial.dispatchConsole({ value: "profile stop" });

      assertEquals(await done, 0);
      assertEquals(celestial.starts, 1);
      assertEquals(celestial.stops, 1);
    });
  });

  it("keeps a stop seen before the start marker from ending the profile", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const gate = Promise.withResolvers<void>();
      celestial.profilerEnableGate = gate;
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=(?!)",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed, started }),
      );

      // A stop that precedes the start marker is stale, so the transaction
      // clears it before enabling the profiler.
      await resumed.promise;
      celestial.dispatchConsole({ value: "profile stop" });
      celestial.dispatchConsole({ value: "profile start" });
      await celestial.profilerEnableCalled.promise;

      gate.resolve();
      await started.promise;
      celestial.dispatchConsole({ value: "profile stop" });

      assertEquals(await done, 0);
      assertEquals(celestial.starts, 1);
      assertEquals(celestial.stops, 1);
    });
  });

  it("preserves a live stop after clearing an earlier stop", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const gate = Promise.withResolvers<void>();
      celestial.profilerEnableGate = gate;
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed, started }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "profile stop" });
      celestial.dispatchConsole({ value: "profile start" });
      await celestial.profilerEnableCalled.promise;
      celestial.dispatchConsole({ value: "profile stop" });

      gate.resolve();
      await started.promise;
      await Promise.resolve();
      // Bounds the regression if the live stop above is dropped.
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 0);
      assertEquals(logs.includes("profile: profile stop matched"), true);
      assertEquals(celestial.stops, 1);
    });
  });

  it("stops from a marker that arrived while the profiler was still enabling", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const gate = Promise.withResolvers<void>();
      celestial.profilerEnableGate = gate;
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed, started }),
      );

      // No stop preceded the start marker, so the stop that follows it is the
      // live one and survives the profiler actually starting.
      await resumed.promise;
      celestial.dispatchConsole({ value: "profile start" });
      await celestial.profilerEnableCalled.promise;
      celestial.dispatchConsole({ value: "profile stop" });

      gate.resolve();
      await started.promise;
      await Promise.resolve();
      // Ends the run if the stop above was dropped, so the reason below is
      // what distinguishes the two outcomes rather than a hang.
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 0);
      assertEquals(logs.includes("profile: profile stop matched"), true);
      assertEquals(celestial.stops, 1);
    });
  });

  it("stops from a marker that arrives while profiler start is in flight", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const start = Promise.withResolvers<void>();
      celestial.startPromise = start.promise;
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "profile start" });
      await Promise.resolve();
      celestial.dispatchConsole({ value: "done" });
      start.resolve();

      assertEquals(await done, 0);
      assertEquals(celestial.starts, 1);
      assertEquals(celestial.stops, 1);
      assertEquals(logs.includes("profile: summary matched"), true);
    });
  });

  it("fails when a required profile start marker is missing before summary", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const errors: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      const consoleOutputPath = `${tmpDir}/profile.console.log`;
      const done = captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          `--console-output=${consoleOutputPath}`,
          "--summary-pattern=done",
          "--profile-start-pattern=profile start",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, errors, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 1);
      assertEquals(celestial.starts, 0);
      assertEquals(celestial.stops, 0);
      assertStringIncludes(
        errors.join("\n"),
        "Profile start pattern was not observed: profile start",
      );
      assertStringIncludes(
        await Deno.readTextFile(profileErrorOutputPath(outputPath)),
        "Profile start pattern was not observed: profile start",
      );
      assertEquals(await Deno.readTextFile(consoleOutputPath), "done");
      assertEquals(logs.includes("profile: summary matched"), true);
    });
  });

  for (
    const failure of [
      {
        description: "profiler enable",
        step: "Profiler.enable",
        fail: (celestial: FakeCelestial) => {
          celestial.profilerEnableError = new Error("closed");
        },
        starts: 0,
      },
      {
        description: "sampling interval",
        step: "Profiler.setSamplingInterval",
        fail: (celestial: FakeCelestial) => {
          celestial.samplingIntervalError = new Error("closed");
        },
        starts: 0,
      },
      {
        description: "profiler start",
        step: "Profiler.start",
        fail: (celestial: FakeCelestial) => {
          celestial.startError = new Error("closed");
        },
        starts: 1,
      },
    ] as const
  ) {
    it(`reports the ${failure.description} transaction step`, async () => {
      await withTempDir(async (tmpDir) => {
        const celestial = new FakeCelestial();
        failure.fail(celestial);
        const logs: string[] = [];
        const errors: string[] = [];
        const outputPath = `${tmpDir}/profile.cpuprofile`;

        const code = await captureDenoInspectorProfile(
          [
            `--output=${outputPath}`,
            "--websocket-url=ws://127.0.0.1:9333/session",
          ],
          createCaptureRuntime({ celestial, logs, errors }),
        );

        const expectedError =
          `Profiler.start failed during ${failure.step}: Error: closed`;
        assertEquals(code, 1);
        assertEquals(celestial.starts, failure.starts);
        assertEquals(celestial.stops, 0);
        assertStringIncludes(errors.join("\n"), expectedError);
        assertStringIncludes(
          await Deno.readTextFile(`${tmpDir}/profile.error.txt`),
          expectedError,
        );
        assertEquals(logs.includes("profile: profiler-start-failed"), true);
      });
    });
  }

  it("ignores profiler start markers after start failure cleanup begins", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.startError = new Error("closed");
      const logs: string[] = [];
      const errors: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--profile-start-pattern=profile start",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, errors, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "profile start" });
      await Promise.resolve();
      celestial.dispatchConsole({ value: "profile start" });

      assertEquals(await done, 1);
      assertEquals(celestial.starts, 1);
      assertEquals(
        errors.filter((line) => line.includes("Profiler.start failed")).length,
        1,
      );
    });
  });

  it("ignores profiler start markers after a stop signal", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.startError = new Error("WebSocket closed");
      const logs: string[] = [];
      const errors: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const signalHandlers: Partial<Record<Deno.Signal, () => void>> = {};
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      const done = captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          "--profile-start-pattern=Usage",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({
          celestial,
          logs,
          errors,
          resumed,
          signalHandlers,
        }),
      );

      await resumed.promise;
      signalHandlers.SIGINT?.();
      celestial.dispatchConsole({ value: "Usage:" });

      assertEquals(await done, 1);
      assertEquals(celestial.starts, 0);
      assertEquals(
        errors.some((line) => line.includes("Profiler.start failed")),
        false,
      );
      assertStringIncludes(
        errors.join("\n"),
        "Profile start pattern was not observed: Usage",
      );
      assertStringIncludes(
        await Deno.readTextFile(profileErrorOutputPath(outputPath)),
        "Profile start pattern was not observed: Usage",
      );
    });
  });

  it("fails when the inspector websocket closes before a required profile start marker", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const errors: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const ws = new FakeWebSocket();
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      const done = captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          "--profile-start-pattern=profile start",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, errors, resumed, ws }),
      );

      await resumed.promise;
      ws.readyState = WebSocket.CLOSED;
      ws.dispatch("close", new CloseEvent("close"));

      assertEquals(await done, 1);
      assertEquals(celestial.starts, 0);
      assertEquals(celestial.stops, 0);
      assertStringIncludes(
        errors.join("\n"),
        "Profile start pattern was not observed: profile start",
      );
      assertStringIncludes(
        await Deno.readTextFile(profileErrorOutputPath(outputPath)),
        "Profile start pattern was not observed: profile start",
      );
      assertEquals(logs.includes("profile: websocket closed"), true);
    });
  });

  it("fails when the websocket closes while resuming before a required profile start marker", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const errors: string[] = [];
      const ws = new FakeWebSocket();
      const outputPath = `${tmpDir}/profile.cpuprofile`;
      ws.send = (data: string) => {
        ws.sent.push(data);
        ws.readyState = WebSocket.CLOSED;
      };

      const code = await captureDenoInspectorProfile(
        [
          `--output=${outputPath}`,
          "--profile-start-pattern=profile start",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, errors, ws }),
      );

      assertEquals(code, 1);
      assertEquals(celestial.starts, 0);
      assertEquals(celestial.stops, 0);
      assertStringIncludes(
        errors.join("\n"),
        "Profile start pattern was not observed: profile start",
      );
      assertStringIncludes(
        await Deno.readTextFile(profileErrorOutputPath(outputPath)),
        "Profile start pattern was not observed: profile start",
      );
      assertEquals(logs.includes("profile: websocket closed"), true);
    });
  });

  it("continues when signal listeners cannot be registered", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({
          addSignalListener: () => {
            throw new Error("unsupported");
          },
          celestial,
          logs,
          resumed,
        }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 0);
      assertEquals(logs.includes("profile: summary matched"), true);
    });
  });

  it("does not remove signal handlers when signal support is absent", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const removed: Deno.Signal[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({
          celestial,
          logs,
          noSignalSupport: true,
          resumed,
          removeSignalListener: (signal) => {
            removed.push(signal);
          },
        }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });

      assertEquals(await done, 0);
      assertEquals(removed, []);
    });
  });

  it("cleans up listeners and the inspector client when startup fails", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.runtimeEnableError = new Error("runtime unavailable");
      const logs: string[] = [];
      const removed: Deno.Signal[] = [];

      let caught: unknown;
      try {
        await captureDenoInspectorProfile(
          [
            `--output=${tmpDir}/profile.cpuprofile`,
            "--websocket-url=ws://127.0.0.1:9333/session",
          ],
          createCaptureRuntime({
            celestial,
            logs,
            removeSignalListener: (signal) => {
              removed.push(signal);
            },
          }),
        );
      } catch (error) {
        caught = error;
      }

      assertEquals((caught as Error).message, "runtime unavailable");
      assertEquals(removed, ["SIGINT", "SIGTERM"]);
      assertEquals(celestial.removedListeners, ["Runtime.consoleAPICalled"]);
      assertEquals(celestial.calls.includes("close"), true);
    });
  });

  it("reports inspector client close failures after successful capture", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.closeError = new Error("close failed");
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });

      let caught: unknown;
      try {
        await done;
      } catch (error) {
        caught = error;
      }

      assertEquals((caught as Error).message, "close failed");
    });
  });

  it("reports inspector client close throws after successful capture", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.closeThrow = new Error("close threw");
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({ celestial, logs, resumed }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });

      let caught: unknown;
      try {
        await done;
      } catch (error) {
        caught = error;
      }

      assertEquals((caught as Error).message, "close threw");
    });
  });

  it("preserves startup failures when inspector client close also fails", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      celestial.closeError = new Error("close failed");
      celestial.runtimeEnableError = new Error("runtime unavailable");

      let caught: unknown;
      try {
        await captureDenoInspectorProfile(
          [
            `--output=${tmpDir}/profile.cpuprofile`,
            "--websocket-url=ws://127.0.0.1:9333/session",
          ],
          createCaptureRuntime({ celestial, logs: [] }),
        );
      } catch (error) {
        caught = error;
      }

      assertEquals((caught as Error).message, "runtime unavailable");
    });
  });

  it("stops from a signal and removes registered signal handlers", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const signalHandlers: Partial<Record<Deno.Signal, () => void>> = {};
      const removed: Deno.Signal[] = [];
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({
          celestial,
          logs,
          resumed,
          signalHandlers,
          removeSignalListener: (signal) => {
            removed.push(signal);
            if (signal === "SIGTERM") throw new Error("already gone");
          },
        }),
      );

      await resumed.promise;
      signalHandlers.SIGTERM?.();

      assertEquals(await done, 0);
      assertEquals(celestial.stops, 1);
      assertEquals(logs.includes("profile: signal-SIGTERM"), true);
      assertEquals(removed, ["SIGINT", "SIGTERM"]);
    });
  });

  it("keeps signal handlers while the inspector client closes", async () => {
    await withTempDir(async (tmpDir) => {
      const celestial = new FakeCelestial();
      const closeStarted = Promise.withResolvers<void>();
      const logs: string[] = [];
      const resumed = Promise.withResolvers<void>();
      const signalHandlers: Partial<Record<Deno.Signal, () => void>> = {};
      const removed: Deno.Signal[] = [];
      celestial.closeStarted = closeStarted;
      celestial.closePromise = new Promise<void>(() => {});
      const done = captureDenoInspectorProfile(
        [
          `--output=${tmpDir}/profile.cpuprofile`,
          "--summary-pattern=done",
          "--websocket-url=ws://127.0.0.1:9333/session",
        ],
        createCaptureRuntime({
          celestial,
          logs,
          resumed,
          signalHandlers,
          removeSignalListener: (signal) => {
            removed.push(signal);
            delete signalHandlers[signal];
          },
        }),
      );

      await resumed.promise;
      celestial.dispatchConsole({ value: "done" });
      await closeStarted.promise;

      assertEquals(typeof signalHandlers.SIGINT, "function");
      signalHandlers.SIGINT?.();

      assertEquals(await done, 0);
      assertEquals(removed, ["SIGINT", "SIGTERM"]);
      assertEquals(signalHandlers.SIGINT, undefined);
    });
  });

  it("loads the capture entry point without running it as main", async () => {
    // That evaluating the entry point does not run it as main is the assertion,
    // so the evaluation belongs here.
    // deno-lint-ignore cf-imports/no-inline-module-import
    await import("./capture-deno-inspector-profile.ts?entrypoint-coverage");
  });

  it("entry point reports missing arguments before opening a websocket", async () => {
    const script = new URL(
      "./capture-deno-inspector-profile.ts",
      import.meta.url,
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script.href],
      stderr: "piped",
      stdout: "piped",
    }).output();

    assertEquals(result.success, false);
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "--output is required",
    );
  });

  it("guards only the capture stop signal, leaving SIGINT for Ctrl-C", () => {
    const registered: Array<[Deno.Signal, () => void]> = [];
    guardCaptureStopSignal((signal, handler) => {
      registered.push([signal, handler]);
    });

    // Only the stop signal is guarded — SIGINT stays at its default disposition
    // so an interactive Ctrl-C can still terminate the process.
    assertEquals(registered.map(([signal]) => signal), [CAPTURE_STOP_SIGNAL]);
    assertEquals(CAPTURE_STOP_SIGNAL, "SIGTERM");
    // The guard handler is a no-op: it neither throws nor exits, so a stop
    // signal arriving after the capture removed its own handlers cannot
    // terminate the process.
    for (const [, handler] of registered) {
      handler();
    }
  });

  it("tolerates platforms where signal listeners cannot be registered", () => {
    // A throwing addSignalListener (signals unsupported) must not propagate.
    guardCaptureStopSignal(() => {
      throw new Error("signals unavailable");
    });
  });
});
