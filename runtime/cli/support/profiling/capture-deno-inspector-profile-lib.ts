import { dirname } from "@std/path";

export type InspectorTarget = {
  description?: string;
  id: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
};

export type ProfileCaptureState = {
  consoleMessages: string[];
  profilerActive: boolean;
  profilerStarting: boolean;
  sawProfileStart: boolean;
  sawProfileStop: boolean;
};

export type ProfileStopState = {
  ended: boolean;
  reason?: string;
};

type ProfilerController = {
  enable(): Promise<unknown>;
  setSamplingInterval(params: { interval: number }): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<{ profile: unknown }>;
};

type ProfileCaptureRuntimeApi = {
  Console: { enable(): Promise<unknown> };
  Debugger: { enable(params: Record<string, unknown>): Promise<unknown> };
  Profiler: ProfilerController;
  Runtime: { enable(): Promise<unknown> };
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  close(): Promise<void>;
};

type ProfileFileWriter = {
  mkdir(
    path: string,
    options: { recursive: boolean },
  ): Promise<unknown>;
  writeTextFile(path: string, data: string): Promise<unknown>;
};

type ProfileWriteOptions = {
  outputPath: string;
  consoleOutputPath?: string;
  state: ProfileCaptureState;
  profile: unknown;
  stopError?: string;
  writer?: ProfileFileWriter;
};

type InspectorCommandSocket = Pick<WebSocket, "readyState" | "send">;
type InspectorCommandWebSocket = Pick<
  WebSocket,
  "readyState" | "addEventListener" | "removeEventListener"
>;

type ProfileCaptureConsole = {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
};

export type ProfileCaptureRuntime = {
  addSignalListener?: (
    signal: Deno.Signal,
    handler: () => void,
  ) => void;
  console?: ProfileCaptureConsole;
  createCelestial(ws: WebSocket): ProfileCaptureRuntimeApi;
  createWebSocket(url: string): WebSocket;
  removeSignalListener?: (
    signal: Deno.Signal,
    handler: () => void,
  ) => void;
};

export function sendInspectorCommand(
  ws: InspectorCommandSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ id, method, params }));
  return true;
}

export function settleInspectorCommand<T>(
  ws: InspectorCommandWebSocket,
  command: () => Promise<T>,
): Promise<T> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("WebSocket closed"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      ws.removeEventListener("close", handleClose);
      ws.removeEventListener("error", handleError);
    };
    const beginSettle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      return true;
    };
    const settleResolve = (value: T) => {
      if (!beginSettle()) return;
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (!beginSettle()) return;
      reject(error);
    };
    const handleClose = () => {
      settleReject(new Error("WebSocket closed"));
    };
    const handleError = (event: Event) => {
      settleReject(event);
    };

    ws.addEventListener("close", handleClose);
    ws.addEventListener("error", handleError);
    let commandPromise: Promise<T>;
    try {
      commandPromise = command();
    } catch (error) {
      settleReject(error);
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      settleReject(new Error("WebSocket closed"));
      return;
    }
    commandPromise.then(
      (value) => {
        settleResolve(value);
      },
      (error) => {
        settleReject(error);
      },
    );
  });
}

export function resumeDebuggerOnPause(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ws: InspectorCommandSocket,
  id: number,
): () => void {
  const stopListening = () => {
    target.removeEventListener("Debugger.paused", handlePaused);
  };
  const handlePaused = () => {
    stopListening();
    sendInspectorCommand(ws, id, "Debugger.resume");
  };

  target.addEventListener("Debugger.paused", handlePaused);
  return stopListening;
}

export function parseArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function requireArg(args: string[], name: string): string {
  const value = parseArg(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("WebSocket closed before opening"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (event: Event) => {
      cleanup();
      reject(event);
    };
    const handleClose = (event: CloseEvent) => {
      cleanup();
      reject(event);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);
  });
}

export function stringifyRemoteObject(value: Record<string, unknown>): string {
  if ("value" in value && value.value !== undefined) {
    return String(value.value);
  }
  if ("unserializableValue" in value && value.unserializableValue) {
    return String(value.unserializableValue);
  }
  if ("description" in value && value.description) {
    return String(value.description);
  }
  if ("type" in value) {
    return `[${String(value.type)}]`;
  }
  return "[unknown]";
}

export function recordConsoleProfileMessage(
  state: ProfileCaptureState,
  text: string,
  profileStartRegex?: RegExp,
  profileStopRegex?: RegExp,
): { startedProfile: boolean; hadProfileStop: boolean } {
  const hadProfileStart = state.sawProfileStart;
  const hadProfileStop = state.sawProfileStop;
  state.consoleMessages.push(text);
  if (profileStartRegex?.test(text)) {
    state.sawProfileStart = true;
  }
  if (profileStopRegex?.test(text)) {
    state.sawProfileStop = true;
  }
  return {
    startedProfile: !hadProfileStart && state.sawProfileStart,
    hadProfileStop,
  };
}

export function markProfilerStarted(
  state: ProfileCaptureState,
  options: { clearStop?: boolean } = {},
): void {
  state.profilerActive = true;
  state.profilerStarting = false;
  if (options.clearStop ?? true) {
    state.sawProfileStop = false;
  }
}

export function markProfileStoppedOnce(
  state: ProfileStopState,
  reason: string,
): boolean {
  if (state.ended) return false;
  state.ended = true;
  state.reason ??= reason;
  return true;
}

/**
 * Enables, configures, and starts the profiler as one guarded transaction.
 * A marker-triggered start may happen after the debugger resumes, so the
 * profiler domain is enabled at the point where its active state is required.
 * The inspector could still disable the domain between the enable reply and
 * start command; if that produces -32000 again, prefer a bounded retry of this
 * transaction over moving the enable earlier in the handshake.
 */
export async function startProfilerIfReady(
  state: ProfileCaptureState,
  ws: InspectorCommandWebSocket,
  profiler: Pick<
    ProfilerController,
    "enable" | "setSamplingInterval" | "start"
  >,
  log: (message: string) => void = () => {},
  options: { clearStop?: boolean } = {},
): Promise<boolean> {
  if (
    state.profilerActive || state.profilerStarting ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  state.profilerStarting = true;
  try {
    if (options.clearStop ?? true) {
      // Clear only stops that preceded this transaction. A stop observed while
      // the inspector commands are in flight must survive the eventual start.
      state.sawProfileStop = false;
    }
    const steps = [
      { name: "Profiler.enable", command: () => profiler.enable() },
      {
        name: "Profiler.setSamplingInterval",
        command: () => profiler.setSamplingInterval({ interval: 100 }),
      },
      { name: "Profiler.start", command: () => profiler.start() },
    ] as const;
    for (const step of steps) {
      try {
        await settleInspectorCommand(ws, step.command);
      } catch (error) {
        throw new Error(
          `Profiler.start failed during ${step.name}: ${error}`,
          { cause: error },
        );
      }
    }
    markProfilerStarted(state, { clearStop: false });
    log("profile: profiler started");
    return true;
  } finally {
    state.profilerStarting = false;
  }
}

export async function stopActiveProfiler(
  state: ProfileCaptureState,
  ws: InspectorCommandWebSocket,
  profiler: Pick<ProfilerController, "stop">,
): Promise<{ profile: unknown; stopError?: string }> {
  let profile: unknown = null;
  let stopError: string | undefined;
  if (state.profilerActive && ws.readyState === WebSocket.OPEN) {
    try {
      profile = (await settleInspectorCommand(ws, () => profiler.stop()))
        .profile;
      state.profilerActive = false;
    } catch (error) {
      stopError = `Profiler.stop failed: ${error}`;
    }
  }

  return { profile, stopError };
}

export function profileErrorOutputPath(outputPath: string): string {
  return outputPath.endsWith(".cpuprofile")
    ? outputPath.replace(/\.cpuprofile$/i, ".error.txt")
    : `${outputPath}.error.txt`;
}

export async function writeProfileCaptureFiles(
  options: ProfileWriteOptions,
): Promise<void> {
  const writer = options.writer ?? Deno;
  await writer.mkdir(dirname(options.outputPath), { recursive: true }).catch(
    () => {},
  );
  if (options.profile) {
    await writer.writeTextFile(
      options.outputPath,
      JSON.stringify(options.profile, null, 2),
    );
  } else if (options.stopError) {
    await writer.writeTextFile(
      profileErrorOutputPath(options.outputPath),
      options.stopError,
    );
  }

  if (options.consoleOutputPath) {
    await writer.writeTextFile(
      options.consoleOutputPath,
      options.state.consoleMessages.join("\n"),
    );
  }
}

/**
 * The signal cf-profile sends to stop this one-shot capture once the profiled
 * command finishes. SIGTERM rather than SIGINT, so an interactive Ctrl-C
 * (SIGINT) is left at its default disposition and can still terminate the
 * process if it hangs after the capture has removed its own signal handlers.
 */
export const CAPTURE_STOP_SIGNAL: Deno.Signal = "SIGTERM";

/**
 * Install a no-op listener for CAPTURE_STOP_SIGNAL that stays for the whole
 * process lifetime, so a late stop signal never terminates this process with
 * 128+signal.
 *
 * captureDenoInspectorProfile installs and then removes its own stop-signal
 * handlers as it runs, which leaves a window between that removal and the
 * process reaching Deno.exit. The parent (cf-profile) sends CAPTURE_STOP_SIGNAL
 * to stop this capture once the profiled command finishes; a signal landing in
 * that window would exit with 128+signal and report a failure even though the
 * profile was already written. This listener keeps the default terminate
 * disposition disabled for that one signal across the whole run, and fires
 * alongside the capture's own handler, so graceful stop is unaffected. SIGINT
 * stays unguarded, so an interactive Ctrl-C can still terminate the process
 * after its own handlers are gone.
 */
export function guardCaptureStopSignal(
  addSignalListener: (signal: Deno.Signal, handler: () => void) => void,
): void {
  try {
    addSignalListener(CAPTURE_STOP_SIGNAL, () => {});
  } catch {
    // Signals are unavailable on some platforms; nothing to guard.
  }
}

export async function captureDenoInspectorProfile(
  args: string[],
  runtime: ProfileCaptureRuntime,
): Promise<number> {
  const outputPath = requireArg(args, "output");
  const consoleOutputPath = parseArg(args, "console-output");
  const summaryPattern = parseArg(args, "summary-pattern") ??
    "\\d+ passed, \\d+ failed";
  const profileStartPattern = parseArg(args, "profile-start-pattern");
  const profileStopPattern = parseArg(args, "profile-stop-pattern");
  const websocketUrl = requireArg(args, "websocket-url");
  const output = runtime.console ?? console;
  const summaryRegex = new RegExp(summaryPattern);
  const profileStartRegex = profileStartPattern
    ? new RegExp(profileStartPattern)
    : undefined;
  const profileStopRegex = profileStopPattern
    ? new RegExp(profileStopPattern)
    : undefined;
  const profileStopState: ProfileStopState = { ended: false };
  const stopReason = Promise.withResolvers<string>();
  let stopReasonSent = false;
  const state: ProfileCaptureState = {
    consoleMessages: [],
    profilerActive: false,
    profilerStarting: false,
    sawProfileStart: !profileStartRegex,
    sawProfileStop: false,
  };
  let pendingProfilerStopReason: string | undefined;
  let profilerStartError: string | undefined;
  let missingProfileStartError: string | undefined;

  const target = {
    id: websocketUrl,
    title: websocketUrl,
    type: "node",
    webSocketDebuggerUrl: websocketUrl,
  };
  output.log(`profile: target ${target.title ?? target.id}`);

  const ws = runtime.createWebSocket(target.webSocketDebuggerUrl);
  await waitForWebSocketOpen(ws);
  output.log("profile: websocket open");

  const celestial = runtime.createCelestial(ws);

  const requestStop = (reason: string): void => {
    if (stopReasonSent) return;
    stopReasonSent = true;
    stopReason.resolve(reason);
  };
  const requestProfilerStop = (reason: string): void => {
    if (state.profilerStarting) {
      pendingProfilerStopReason ??= reason;
      return;
    }
    requestStop(reason);
  };
  const recordProfilerStartError = (error: unknown): void => {
    profilerStartError = error instanceof Error && Object.hasOwn(error, "cause")
      ? error.message
      : `Profiler.start failed: ${error}`;
    output.error(`profile: ${profilerStartError}`);
    requestStop("profiler-start-failed");
  };
  const startProfiler = async (
    options: { clearStop?: boolean } = {},
  ): Promise<void> => {
    let started = false;
    try {
      started = await startProfilerIfReady(
        state,
        ws,
        celestial.Profiler,
        (message) => output.log(message),
        options,
      );
    } catch (error) {
      recordProfilerStartError(error);
      return;
    }
    if (started && state.sawProfileStop) {
      pendingProfilerStopReason ??= "profile-stop-matched";
    }
    if (started && pendingProfilerStopReason) {
      const reason = pendingProfilerStopReason;
      pendingProfilerStopReason = undefined;
      requestStop(reason);
    }
  };
  const handleConsoleApiCalled = (event: Event): void => {
    const detail = (event as CustomEvent<{ args: Record<string, unknown>[] }>)
      .detail;
    const text = detail.args
      .map((arg) => stringifyRemoteObject(arg))
      .join(" ");
    if (stopReasonSent || profileStopState.ended) {
      state.consoleMessages.push(text);
      return;
    }
    const profileMessage = recordConsoleProfileMessage(
      state,
      text,
      profileStartRegex,
      profileStopRegex,
    );
    if (profileMessage.startedProfile) {
      const startOptions = { clearStop: profileMessage.hadProfileStop };
      void startProfiler(startOptions);
    }
    if (summaryRegex.test(text)) {
      requestProfilerStop("summary-matched");
    }
    if (state.profilerActive && state.sawProfileStop) {
      requestProfilerStop("profile-stop-matched");
    }
  };

  const signalHandlers: Array<[Deno.Signal, () => void]> = [];
  const cleanupSignal = Promise.withResolvers<void>();
  let cleanupSignalSent = false;
  let cleanupStarted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      const handler = () => {
        if (cleanupStarted && !cleanupSignalSent) {
          cleanupSignalSent = true;
          cleanupSignal.resolve();
        }
        requestProfilerStop(`signal-${signal}`);
      };
      if (runtime.addSignalListener) {
        runtime.addSignalListener(signal, handler);
        signalHandlers.push([signal, handler]);
      }
    } catch {
      // Signals are best-effort here.
    }
  }
  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) {
      try {
        runtime.removeSignalListener?.(signal, handler);
      } catch {
        // Listener may already be gone.
      }
    }
  };

  const stopProfile = async (reason: string): Promise<void> => {
    if (markProfileStoppedOnce(profileStopState, reason)) {
      const { profile, stopError } = await stopActiveProfiler(
        state,
        ws,
        celestial.Profiler,
      );
      if (profileStartPattern && !state.sawProfileStart) {
        missingProfileStartError =
          `Profile start pattern was not observed: ${profileStartPattern}`;
        output.error(`profile: ${missingProfileStartError}`);
      }
      await writeProfileCaptureFiles({
        outputPath,
        consoleOutputPath,
        state,
        profile,
        stopError: profilerStartError ?? stopError ?? missingProfileStartError,
      });
    }
  };

  const handleClose = () => requestStop("websocket-closed");
  let caughtError: unknown;
  let cleanupError: unknown;
  let hasCaughtError = false;
  let consoleListenerAdded = false;
  let websocketCloseListenerAdded = false;
  let stopResumeOnPause: (() => void) | undefined;
  try {
    celestial.addEventListener(
      "Runtime.consoleAPICalled",
      handleConsoleApiCalled,
    );
    consoleListenerAdded = true;

    await celestial.Runtime.enable();
    output.log("profile: runtime enabled");
    await celestial.Console.enable();
    await celestial.Debugger.enable({});

    if (state.sawProfileStart) {
      await startProfiler();
    }

    stopResumeOnPause = resumeDebuggerOnPause(celestial, ws, -2);
    ws.addEventListener("close", handleClose);
    websocketCloseListenerAdded = true;
    sendInspectorCommand(ws, -1, "Runtime.runIfWaitingForDebugger");
    output.log("profile: resumed target");

    if (ws.readyState === WebSocket.CLOSED) {
      requestStop("websocket-closed");
    }

    const reason = await stopReason.promise;
    await stopProfile(reason);
    if (reason === "profile-stop-matched") {
      output.log("profile: profile stop matched");
    } else if (reason === "summary-matched") {
      output.log("profile: summary matched");
    } else if (reason === "websocket-closed") {
      output.log("profile: websocket closed");
    } else {
      output.log(`profile: ${reason}`);
    }
  } catch (error) {
    hasCaughtError = true;
    caughtError = error;
  } finally {
    if (websocketCloseListenerAdded) {
      ws.removeEventListener("close", handleClose);
    }
    stopResumeOnPause?.();
    if (consoleListenerAdded) {
      celestial.removeEventListener(
        "Runtime.consoleAPICalled",
        handleConsoleApiCalled,
      );
    }
    cleanupStarted = true;
    try {
      const closeResult = await Promise.race([
        celestial.close().then(
          () => ({ kind: "closed" as const }),
          (error) => ({ kind: "error" as const, error }),
        ),
        cleanupSignal.promise.then(() => ({ kind: "interrupted" as const })),
      ]);
      if (closeResult.kind === "error" && !hasCaughtError) {
        cleanupError = closeResult.error;
      }
    } catch (error) {
      if (!hasCaughtError) cleanupError = error;
    } finally {
      cleanupStarted = false;
    }
  }

  try {
    if (hasCaughtError) throw caughtError;
    if (cleanupError !== undefined) throw cleanupError;

    output.log(
      JSON.stringify(
        {
          reason: profileStopState.reason,
          outputPath,
          consoleMessages: state.consoleMessages.length,
        },
        null,
        2,
      ),
    );

    return profilerStartError || missingProfileStartError ? 1 : 0;
  } finally {
    removeSignalHandlers();
  }
}
