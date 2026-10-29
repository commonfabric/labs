/**
 * CPU-profiles the runtime web-worker of a running integration browser via
 * the Chrome DevTools Protocol — no external tooling.
 *
 * Connects a second CDP client to the browser websocket endpoint (Chrome
 * supports multiple concurrent CDP sessions), discovers page targets, and
 * auto-attaches to their dedicated workers using the flattened session
 * protocol. `start()`/`stop()` then drive the V8 sampling profiler on the
 * worker whose script URL matches a substring (default: "worker").
 *
 * The resulting profile can be written as a `.cpuprofile` (loadable in Chrome
 * DevTools / speedscope) plus a ranked self-time text report, mirroring
 * `runtime/runner/test/traverse-replay/profile-driver.ts`.
 */

export type CPUProfile = {
  nodes: Array<{
    id: number;
    hitCount?: number;
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
    };
    children?: number[];
  }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
};

type AttachedWorker = {
  sessionId: string;
  targetId: string;
  url: string;
  attachedAt: number;
};

const SEND_TIMEOUT_MS = 30_000;

export class CdpWorkerProfiler {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      method: string;
      sessionId?: string;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  #workers = new Map<string, AttachedWorker>();
  #profilingSessionId: string | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => this.#onMessage(event);
    ws.onclose = () => this.#rejectAll("CDP websocket closed");
    ws.onerror = () => this.#rejectAll("CDP websocket error");
  }

  #rejectAll(reason: string, sessionId?: string) {
    for (const [id, pending] of [...this.#pending.entries()]) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.reject(new Error(`${pending.method}: ${reason}`));
    }
  }

  /**
   * Connect to the browser-level websocket endpoint (from
   * `AstralBrowser#wsEndpoint()`), discover all page targets, and auto-attach
   * to their dedicated workers.
   */
  static async connect(browserWsEndpoint: string): Promise<CdpWorkerProfiler> {
    const ws = new WebSocket(browserWsEndpoint);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not connect to browser CDP"));
    });
    const profiler = new CdpWorkerProfiler(ws);
    await profiler.#discoverAndAttach();
    return profiler;
  }

  #onMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data as string) as {
      id?: number;
      error?: { message: string };
      result?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (!pending) return;
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "Target.attachedToTarget") {
      const params = msg.params as {
        sessionId: string;
        targetInfo: { targetId: string; type: string; url: string };
      };
      const { sessionId, targetInfo } = params;
      if (targetInfo.type === "worker") {
        this.#workers.set(sessionId, {
          sessionId,
          targetId: targetInfo.targetId,
          url: targetInfo.url,
          attachedAt: performance.now(),
        });
        // Workers wait for the debugger when auto-attached with
        // waitForDebuggerOnStart; resume just in case (no-op otherwise).
        this.#send("Runtime.runIfWaitingForDebugger", {}, sessionId)
          .catch(() => {});
      } else if (targetInfo.type === "page" || targetInfo.type === "iframe") {
        // Auto-attach to this page's (future and current) dedicated workers.
        this.#send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }, sessionId).catch(() => {});
      }
    } else if (msg.method === "Target.detachedFromTarget") {
      const params = msg.params as { sessionId: string };
      this.#workers.delete(params.sessionId);
      // A command sent to a detached session never gets a response.
      this.#rejectAll("target detached", params.sessionId);
    } else if (msg.method === "Target.targetCreated") {
      const params = msg.params as {
        targetInfo: { targetId: string; type: string };
      };
      if (params.targetInfo.type === "page") {
        this.#send("Target.attachToTarget", {
          targetId: params.targetInfo.targetId,
          flatten: true,
        }).catch(() => {});
      }
    }
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP ${method}: websocket is not open`));
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(
            new Error(
              `CDP ${method} (session ${
                sessionId ?? "browser"
              }) timed out after ${SEND_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, SEND_TIMEOUT_MS);
      this.#pending.set(id, {
        method,
        sessionId,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async #discoverAndAttach(): Promise<void> {
    // Attach (flattened) to all current page targets; new pages arrive via
    // Target.targetCreated → attachToTarget below.
    const { targetInfos } = await this.#send("Target.getTargets") as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    for (const info of targetInfos) {
      if (info.type !== "page") continue;
      await this.#send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
    }
    // Discover pages created after us (fresh-page load measurements);
    // Target.targetCreated is handled in #onMessage.
    await this.#send("Target.setDiscoverTargets", { discover: true });
  }

  /** Worker sessions currently attached, most recent first. */
  workers(): AttachedWorker[] {
    return [...this.#workers.values()].sort(
      (a, b) => b.attachedAt - a.attachedAt,
    );
  }

  /** Wait until a worker whose URL contains `urlSubstring` is attached. */
  async waitForWorker(
    urlSubstring: string,
    timeoutMs = 30_000,
  ): Promise<AttachedWorker> {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const worker = this.workers().find((w) => w.url.includes(urlSubstring));
      if (worker) return worker;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Timed out waiting for worker matching "${urlSubstring}". ` +
        `Attached workers: ${this.workers().map((w) => w.url).join(", ")}`,
    );
  }

  /**
   * Start the sampling profiler on the most recently attached worker whose
   * URL contains `urlSubstring`.
   */
  async start(
    urlSubstring = "worker",
    samplingIntervalUs = 250,
  ): Promise<void> {
    const worker = await this.waitForWorker(urlSubstring);
    this.#profilingSessionId = worker.sessionId;
    await this.#send("Profiler.enable", {}, worker.sessionId);
    await this.#send(
      "Profiler.setSamplingInterval",
      { interval: samplingIntervalUs },
      worker.sessionId,
    );
    await this.#send("Profiler.start", {}, worker.sessionId);
  }

  /** Stop the profiler started by `start()` and return the profile. */
  async stop(): Promise<CPUProfile> {
    const sessionId = this.#profilingSessionId;
    if (!sessionId) throw new Error("Profiler was not started.");
    this.#profilingSessionId = undefined;
    const { profile } = await this.#send(
      "Profiler.stop",
      {},
      sessionId,
    ) as { profile: CPUProfile };
    return profile;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Render a ranked self-time report (top frames + by-file) from a profile.
 * Sample time is attributed via timeDeltas, like
 * test/traverse-replay/profile-driver.ts.
 */
export function renderProfileReport(
  profile: CPUProfile,
  label: string,
  options: { topFrames?: number; topFiles?: number } = {},
): string {
  const nodeTime = new Map<number, number>();
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      nodeTime.set(id, (nodeTime.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
  }
  const totalUs = [...nodeTime.values()].reduce((a, b) => a + b, 0);

  const byFrame = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const node of profile.nodes) {
    const us = nodeTime.get(node.id) ?? 0;
    if (us === 0) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").pop() || "(internal)";
    const frame = `${functionName || "(anonymous)"} @ ${file}:${
      lineNumber + 1
    }`;
    byFrame.set(frame, (byFrame.get(frame) ?? 0) + us);
    byFile.set(file, (byFile.get(file) ?? 0) + us);
  }

  const fmt = (us: number) =>
    `${(us / 1000).toFixed(0).padStart(7)}ms ${
      ((us / totalUs) * 100).toFixed(1).padStart(5)
    }%`;

  let report = `# Worker CPU profile: ${label}\n`;
  report +=
    `wall: ${((profile.endTime - profile.startTime) / 1000).toFixed(0)}ms, ` +
    `sampled: ${(totalUs / 1000).toFixed(0)}ms\n\n`;
  report += `## Top frames by self time\n`;
  for (
    const [frame, us] of [...byFrame.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, options.topFrames ?? 45)
  ) {
    report += `${fmt(us)}  ${frame}\n`;
  }
  report += `\n## By file\n`;
  for (
    const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, options.topFiles ?? 15)
  ) {
    report += `${fmt(us)}  ${file}\n`;
  }
  return report;
}

/**
 * The runtime worker's script URL fragment.
 *
 * A property of how the runtime names its worker, not of any one measurement,
 * which is why it is here rather than restated by each scenario that profiles.
 */
export const RUNTIME_WORKER_URL = "worker-runtime";

/**
 * Connect a profiler to a running browser and wait for its runtime worker.
 *
 * Resolves to `undefined` rather than throwing when anything goes wrong, and
 * closes the half-open connection on the way out. Profiling is instrumentation:
 * a scenario that cannot be profiled still has a scenario to run, so every seam
 * here degrades to unprofiled instead of failing the caller.
 */
export async function attachWorkerProfiler(
  wsEndpoint: string,
  workerUrl = RUNTIME_WORKER_URL,
): Promise<CdpWorkerProfiler | undefined> {
  let profiler: CdpWorkerProfiler | undefined;
  try {
    profiler = await CdpWorkerProfiler.connect(wsEndpoint);
    await profiler.waitForWorker(workerUrl);
    return profiler;
  } catch (error) {
    console.warn("Worker CPU profiler setup failed, disabling:", error);
    profiler?.close();
    return undefined;
  }
}

/**
 * Start a profile, reporting whether it actually started.
 *
 * `context` names the thing being profiled in the warning, so a run that loses
 * one capture out of many says which. The sampling interval is the caller's:
 * the profiler's own default suits a single interaction, while a window of
 * minutes needs a coarser period to stay inside the CDP message limit.
 */
export async function startWorkerProfile(
  profiler: CdpWorkerProfiler,
  context: string,
  options: { workerUrl?: string; samplingIntervalUs?: number } = {},
): Promise<boolean> {
  try {
    await profiler.start(
      options.workerUrl ?? RUNTIME_WORKER_URL,
      options.samplingIntervalUs ?? 250,
    );
    return true;
  } catch (error) {
    console.warn(`Worker CPU profile start failed (${context}):`, error);
    return false;
  }
}

/**
 * Stop a profile and write both artifacts: `<pathPrefix>.cpuprofile`, which
 * Chrome DevTools and speedscope load, and `<pathPrefix>.report.txt`, the
 * ranked self-time report.
 *
 * `pathPrefix` and `label` carry the scenario's own parameters — the board
 * size, the iteration, the phase — so they are the caller's to compose. Set
 * `logReport` to put the ranked report in the run's output, which is what makes
 * a headless run answer the question without opening a file.
 */
export async function writeWorkerProfile(
  profiler: CdpWorkerProfiler,
  options: {
    pathPrefix: string;
    label: string;
    context?: string;
    logReport?: boolean;
  },
): Promise<void> {
  const context = options.context ?? options.label;
  try {
    const profile = await profiler.stop();
    await Deno.writeTextFile(
      `${options.pathPrefix}.cpuprofile`,
      JSON.stringify(profile),
    );
    const report = renderProfileReport(profile, options.label);
    await Deno.writeTextFile(`${options.pathPrefix}.report.txt`, report);
    if (options.logReport) console.log(report);
    console.log(
      `Worker CPU profile written: ${options.pathPrefix}.cpuprofile`,
    );
  } catch (error) {
    console.warn(`Worker CPU profile capture failed (${context}):`, error);
  }
}
