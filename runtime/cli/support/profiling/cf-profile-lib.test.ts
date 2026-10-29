import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  createProfileOutputRelay,
  DEBUGGER_WAITING_MESSAGE,
  escapeRegex,
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  type KillableProcess,
  mirrorOutput,
  parseProfileArgs,
  pickInspectPort,
  profileTimestamp,
  profilingChildEnv,
  slugifyProfileName,
  stopCaptureOnce,
  waitForCliStatusOrStopOnCaptureFailure,
} from "./cf-profile-lib.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const successStatus: Deno.CommandStatus = {
  success: true,
  code: 0,
  signal: null,
};
const failureStatus: Deno.CommandStatus = {
  success: false,
  code: 1,
  signal: null,
};

function createSink() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    sink: {
      write(data: Uint8Array): number {
        chunks.push(data);
        return data.length;
      },
    },
  };
}

Deno.test("inspectWaitFlag pauses the profiled process until capture attaches", () => {
  assertEquals(
    inspectWaitFlag("127.0.0.1", 9333),
    "--inspect-wait=127.0.0.1:9333",
  );
});

Deno.test("profilingChildEnv removes Deno coverage collection", () => {
  assertEquals(
    profilingChildEnv({
      DENO_COVERAGE_DIR: "coverage/raw/workspace",
      KEEP_ME: "yes",
    }),
    { KEEP_ME: "yes" },
  );
});

Deno.test("parseProfileArgs separates profiler options from CLI arguments", () => {
  const parsed = parseProfileArgs([
    "--profile-output=profile.cpuprofile",
    "--profile-summary-pattern=done",
    "--profile-start-pattern=start",
    "--profile-stop-pattern=stop",
    "--profile-inspect-port=9333",
    "test",
    "--filter=unit",
  ]);

  assertEquals(parsed, {
    options: {
      outputPath: "profile.cpuprofile",
      summaryPattern: "done",
      profileStartPattern: "start",
      profileStopPattern: "stop",
      inspectPort: 9333,
    },
    cliArgs: ["test", "--filter=unit"],
  });
});

Deno.test("parseProfileArgs accepts an output directory", () => {
  const parsed = parseProfileArgs(["--profile-dir=profiles", "test"]);

  assertEquals(parsed.options.outputDir, "profiles");
  assertEquals(parsed.cliArgs, ["test"]);
});

Deno.test("parseProfileArgs rejects invalid profiler options", () => {
  const cases: Array<[string[], string]> = [
    [
      ["--profile-output=profile.cpuprofile", "--profile-dir=profiles"],
      "Pass either --profile-output or --profile-dir, not both",
    ],
    [
      ["--profile-inspect-port=0"],
      "--profile-inspect-port must be a positive number",
    ],
    [
      ["--profile-target-url-pattern=mod.ts"],
      "cf-profile uses the inspector URL emitted by its child process",
    ],
    [
      ["--profile-timeout-ms=5000"],
      "cf-profile does not support timeout-based options",
    ],
    [
      ["--profile-connect-timeout-ms=2500"],
      "cf-profile does not support timeout-based options",
    ],
  ];

  for (const [args, message] of cases) {
    assertThrows(() => parseProfileArgs(args), Error, message);
  }
});

Deno.test("findInspectorWebSocketUrl reads the inspector URL from stderr text", () => {
  assertEquals(
    findInspectorWebSocketUrl(
      "Debugger listening on ws://127.0.0.1:9333/abc\n",
    ),
    "ws://127.0.0.1:9333/abc",
  );
  assertEquals(findInspectorWebSocketUrl("no inspector yet"), undefined);
});

Deno.test("slugifyProfileName makes stable output path names", () => {
  assertEquals(
    slugifyProfileName(["test", "--filter=hello world", "a/b"]),
    "test-filter-hello-world-a-b",
  );
  assertEquals(slugifyProfileName(["***"]), "cf");
  assertEquals(slugifyProfileName(["a".repeat(100)]), "a".repeat(80));
});

Deno.test("profileTimestamp uses filename-safe separators", () => {
  assertMatch(profileTimestamp(), /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
});

Deno.test("escapeRegex escapes regex syntax", () => {
  assertEquals(
    escapeRegex("a+b*(c)[d]{e}|f?^$\\."),
    "a\\+b\\*\\(c\\)\\[d\\]\\{e\\}\\|f\\?\\^\\$\\\\\\.",
  );
});

Deno.test("pickInspectPort returns a requested port", () => {
  assertEquals(pickInspectPort(9333), 9333);
});

Deno.test("pickInspectPort allocates a TCP port", () => {
  assert(pickInspectPort() > 0);
});

Deno.test("pickInspectPort closes non-TCP listeners before throwing", () => {
  let closed = false;

  assertThrows(
    () =>
      pickInspectPort(undefined, () => ({
        addr: {
          transport: "unix",
          path: "/tmp/profile.sock",
        } as Deno.Addr,
        close: () => {
          closed = true;
        },
      })),
    Error,
    "Expected a TCP listener while allocating inspect port",
  );
  assertEquals(closed, true);
});

Deno.test("stopCaptureOnce sends one signal", () => {
  const state = { sent: false };
  const signals: Deno.Signal[] = [];

  stopCaptureOnce(state, {
    kill: (signal) => {
      signals.push(signal);
    },
  });
  stopCaptureOnce(state, {
    kill: (signal) => {
      signals.push(signal);
    },
  });

  assertEquals(state.sent, true);
  assertEquals(signals, ["SIGINT"]);
});

Deno.test("stopCaptureOnce records a sent signal when kill fails", () => {
  const state = { sent: false };

  stopCaptureOnce(state, {
    kill: () => {
      throw new Error("already exited");
    },
  });

  assertEquals(state.sent, true);
});

Deno.test("createProfileOutputRelay resolves the inspector URL exactly once", () => {
  const urls: string[] = [];
  const { onCliOutput } = createProfileOutputRelay({
    captureRef: {},
    captureStopState: { sent: false },
    captureStopSignal: "SIGTERM",
    onInspectorUrl: (url) => urls.push(url),
  });

  onCliOutput("startup noise\n");
  onCliOutput("Debugger listening on ws://127.0.0.1:9229/abc\n");
  // A later inspector line does not resolve a second time.
  onCliOutput("Debugger listening on ws://127.0.0.1:9229/def\n");

  assertEquals(urls, ["ws://127.0.0.1:9229/abc"]);
});

Deno.test("createProfileOutputRelay stops the capture on the debugger-waiting message", () => {
  const signals: Deno.Signal[] = [];
  const captureStopState = { sent: false };
  const captureRef: { current?: KillableProcess } = {
    current: { kill: (signal) => signals.push(signal) },
  };
  const { onCliOutput } = createProfileOutputRelay({
    captureRef,
    captureStopState,
    captureStopSignal: "SIGTERM",
    onInspectorUrl: () => {},
  });

  onCliOutput(`${DEBUGGER_WAITING_MESSAGE}\n`);

  assertEquals(signals, ["SIGTERM"]);
  assertEquals(captureStopState.sent, true);
});

Deno.test("createProfileOutputRelay's stopCapture is inert before a capture starts", () => {
  const captureStopState = { sent: false };
  const { onCliOutput, stopCapture } = createProfileOutputRelay({
    captureRef: {}, // the capture process has not spawned yet
    captureStopState,
    captureStopSignal: "SIGTERM",
    onInspectorUrl: () => {},
  });

  // The debugger message can arrive before the capture exists; nothing to signal.
  onCliOutput(`${DEBUGGER_WAITING_MESSAGE}\n`);
  stopCapture();

  assertEquals(captureStopState.sent, false);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure stops the CLI after capture failure", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve(failureStatus),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
        cliStatus.resolve({
          success: false,
          code: 143,
          signal,
        });
      },
    },
  );

  assertEquals(await result, {
    success: false,
    code: 143,
    signal: "SIGTERM",
  });
  assertEquals(cliStopState.sent, true);
  assertEquals(signals, ["SIGTERM"]);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure leaves the CLI running after capture success", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve(successStatus),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  await Promise.resolve();
  cliStatus.resolve(successStatus);

  assertEquals(await result, successStatus);
  assertEquals(cliStopState.sent, false);
  assertEquals(signals, []);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure returns when the CLI exits first", async () => {
  const cliStopState = { sent: false };
  const signals: Deno.Signal[] = [];

  const result = await waitForCliStatusOrStopOnCaptureFailure(
    Promise.resolve(successStatus),
    new Promise(() => {}),
    cliStopState,
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  assertEquals(result, successStatus);
  assertEquals(cliStopState.sent, false);
  assertEquals(signals, []);
});

Deno.test("mirrorOutput ignores a missing stream", async () => {
  const { chunks, sink } = createSink();

  await mirrorOutput(null, sink);

  assertEquals(chunks, []);
});

Deno.test("mirrorOutput forwards text and flushes decoder state", async () => {
  const { chunks, sink } = createSink();
  const seen: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array());
      controller.enqueue(encoder.encode("hello"));
      controller.enqueue(Uint8Array.of(0xc3));
      controller.close();
    },
  });

  await mirrorOutput(stream, sink, (text) => seen.push(text));

  assertEquals(seen, ["hello", "\uFFFD"]);
  assertEquals(
    decoder.decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all);
        next.set(chunk, all.length);
        return next;
      }, new Uint8Array()),
    ),
    "hello\uFFFD",
  );
});
