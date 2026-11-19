import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { CAPTURE_TARGET_FINISHED_MESSAGE } from "./capture-deno-inspector-profile-lib.ts";
import {
  escapeRegex,
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  mirrorCaptureOutput,
  mirrorOutput,
  parseProfileArgs,
  pickInspectPort,
  profileTimestamp,
  profilingChildEnv,
  slugifyProfileName,
  waitForCliStatusOrStopOnCaptureFailure,
  watchOutput,
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

Deno.test("watchOutput reports the first value found, exactly once", () => {
  const urls: string[] = [];
  const onText = watchOutput(
    findInspectorWebSocketUrl,
    (url) => urls.push(url),
  );

  onText("startup noise\n");
  assertEquals(urls, []);
  // A line split across chunks is found once it is complete.
  onText("Debugger listening on ws://127.0.0.1:9229/abc");
  onText("\n");
  // A later inspector line does not report a second time.
  onText("Debugger listening on ws://127.0.0.1:9229/def\n");

  assertEquals(urls, ["ws://127.0.0.1:9229/abc"]);
});

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

Deno.test("mirrorCaptureOutput reports a target that finished", async () => {
  const { chunks, sink } = createSink();
  const half = CAPTURE_TARGET_FINISHED_MESSAGE.length / 2;

  const result = await mirrorCaptureOutput(
    streamOf(
      "profile: websocket open\n",
      CAPTURE_TARGET_FINISHED_MESSAGE.slice(0, half),
      `${CAPTURE_TARGET_FINISHED_MESSAGE.slice(half)}\n`,
    ),
    sink,
  );

  assertEquals(result, { targetFinished: true });
  assertEquals(
    chunks.map((chunk) => decoder.decode(chunk)).join(""),
    `profile: websocket open\n${CAPTURE_TARGET_FINISHED_MESSAGE}\n`,
  );
});

Deno.test("mirrorCaptureOutput reports a target that did not finish", async () => {
  const { sink } = createSink();

  assertEquals(
    await mirrorCaptureOutput(streamOf("profile: websocket open\n"), sink),
    { targetFinished: false },
  );
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure stops the CLI after capture failure", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve({ status: failureStatus, targetFinished: false }),
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
  assertEquals(signals, ["SIGTERM"]);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure tolerates a CLI that already exited", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve({ status: failureStatus, targetFinished: false }),
    {
      kill: () => {
        cliStatus.resolve(successStatus);
        throw new TypeError("Child process has already terminated");
      },
    },
  );

  assertEquals(await result, successStatus);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure lets a finished CLI exit after capture failure", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve({ status: failureStatus, targetFinished: true }),
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  await Promise.resolve();
  cliStatus.resolve(successStatus);

  assertEquals(await result, successStatus);
  assertEquals(signals, []);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure leaves the CLI running after capture success", async () => {
  const cliStatus = Promise.withResolvers<Deno.CommandStatus>();
  const signals: Deno.Signal[] = [];

  const result = waitForCliStatusOrStopOnCaptureFailure(
    cliStatus.promise,
    Promise.resolve({ status: successStatus, targetFinished: false }),
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  await Promise.resolve();
  cliStatus.resolve(successStatus);

  assertEquals(await result, successStatus);
  assertEquals(signals, []);
});

Deno.test("waitForCliStatusOrStopOnCaptureFailure returns when the CLI exits first", async () => {
  const signals: Deno.Signal[] = [];

  const result = await waitForCliStatusOrStopOnCaptureFailure(
    Promise.resolve(successStatus),
    new Promise(() => {}),
    {
      kill: (signal) => {
        signals.push(signal);
      },
    },
  );

  assertEquals(result, successStatus);
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
