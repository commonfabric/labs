import { assertEquals, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";

import {
  BACKGROUND_LOG_ENV,
  backgroundLogStream,
  buildBackgroundChildCommand,
  classifyLaunch,
  READY_MARKER,
  redirectConsoleToFile,
  runBackgroundParent,
  type SpawnedChild,
  writeListeningMarker,
} from "@/background.ts";

// A ReadableStream that emits the given text chunks and then closes, standing in
// for a spawned child's stdout.
function stdoutOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

Deno.test("classifyLaunch separates control flags from server args", () => {
  const foreground = classifyLaunch(["--port=8002"]);
  assertEquals(foreground.background, false);
  assertEquals(foreground.logFile, undefined);
  assertEquals(foreground.serverArgs, ["--port=8002"]);

  const parent = classifyLaunch([
    "--port=8002",
    "--background",
    "--log-file=/tmp/toolshed.log",
  ]);
  assertEquals(parent.background, true);
  assertEquals(parent.logFile, "/tmp/toolshed.log");
  assertEquals(parent.serverArgs, ["--port=8002"]);
});

Deno.test("buildBackgroundChildCommand re-runs the compiled binary directly", () => {
  const { command, args } = buildBackgroundChildCommand({
    execPath: "/opt/common-binaries/toolshed",
    mainModule: "file:///proj/runtime/toolshed/index.ts",
    serverArgs: ["--port=8002"],
  });
  assertEquals(command, "/opt/common-binaries/toolshed");
  // Only the server's own arguments: the child is marked through the
  // environment, not the command line.
  assertEquals(args, ["--port=8002"]);
});

Deno.test("buildBackgroundChildCommand re-runs deno against the entry module", () => {
  const { command, args } = buildBackgroundChildCommand({
    execPath: "/usr/local/bin/deno",
    mainModule: "file:///proj/runtime/toolshed/index.ts",
    serverArgs: ["--port=8002"],
  });
  assertEquals(command, "/usr/local/bin/deno");
  assertEquals(args, [
    "run",
    "--unstable-otel",
    "-A",
    "/proj/runtime/toolshed/index.ts",
    "--port=8002",
  ]);
});

Deno.test("runBackgroundParent marks the child through the environment", async () => {
  let seenEnv: Record<string, string> | undefined;
  const child: SpawnedChild = {
    pid: 4321,
    stdout: stdoutOf([`${READY_MARKER}\n`]),
    status: new Promise<Deno.CommandStatus>(() => {}),
    unref: () => {},
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: (_command, _args, env) => {
        seenEnv = env;
        return child;
      },
      exit: () => {},
      writeOut: () => {},
      writeErr: () => {},
      readLog: () => Promise.resolve(""),
    },
  );

  assertEquals(seenEnv?.[BACKGROUND_LOG_ENV], "/tmp/toolshed.log");
});

Deno.test("runBackgroundParent detaches and exits 0 once the child is listening", async () => {
  let unrefed = false;
  let exitCode: number | undefined;
  const out: string[] = [];
  const child: SpawnedChild = {
    pid: 4321,
    stdout: stdoutOf([`${READY_MARKER}\n`]),
    // A listening child stays up, so its status never resolves during the wait.
    status: new Promise<Deno.CommandStatus>(() => {}),
    unref: () => {
      unrefed = true;
    },
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: () => child,
      exit: (code) => {
        exitCode = code;
      },
      writeOut: (line) => out.push(line),
      writeErr: () => {},
      readLog: () => Promise.resolve(""),
    },
  );

  assertEquals(unrefed, true);
  assertEquals(exitCode, 0);
  assertStringIncludes(out.join("\n"), "pid 4321");
});

Deno.test("runBackgroundParent surfaces the log and the code when the child dies first", async () => {
  let unrefed = false;
  let exitCode: number | undefined;
  const errs: string[] = [];
  const child: SpawnedChild = {
    pid: 4321,
    // stdout closes without ever emitting the marker: the child exited early.
    stdout: stdoutOf(["Server is starting on port http://0.0.0.0:8002\n"]),
    status: Promise.resolve({ success: false, code: 3, signal: null }),
    unref: () => {
      unrefed = true;
    },
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: () => child,
      exit: (code) => {
        exitCode = code;
      },
      writeOut: () => {},
      writeErr: (line) => errs.push(line),
      readLog: () => Promise.resolve("Port 8002 is already in use"),
    },
  );

  assertEquals(unrefed, false);
  assertEquals(exitCode, 3);
  const text = errs.join("\n");
  assertStringIncludes(text, "exited with code 3");
  assertStringIncludes(text, "Port 8002 is already in use");
});

Deno.test("runBackgroundParent finds a marker split across reads", async () => {
  let exitCode: number | undefined;
  const child: SpawnedChild = {
    pid: 77,
    // A non-matching first read longer than the marker forces the rolling-tail
    // slice; the marker then straddles the two reads.
    stdout: stdoutOf([
      "initializing the server runtime\ntoolshed-",
      "listening\n",
    ]),
    status: new Promise<Deno.CommandStatus>(() => {}),
    unref: () => {},
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: [],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: () => child,
      exit: (code) => {
        exitCode = code;
      },
      writeOut: () => {},
      writeErr: () => {},
      readLog: () => Promise.resolve(""),
    },
  );

  assertEquals(exitCode, 0);
});

Deno.test({
  name: "backgroundLogStream appends each write to the file",
  // The stream owns a file handle for the server's life; a test does not close
  // it, so opt out of the resource sanitizer rather than expose a closer.
  sanitizeResources: false,
}, async () => {
  const path = await Deno.makeTempFile({
    prefix: "toolshed-bg-",
    suffix: ".log",
  });
  try {
    const stream = backgroundLogStream(path);
    stream.write("first line\n");
    stream.write("second line\n");
    assertEquals(await Deno.readTextFile(path), "first line\nsecond line\n");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test({
  name: "redirectConsoleToFile routes console output to the file",
  sanitizeResources: false,
}, async () => {
  const path = await Deno.makeTempFile({
    prefix: "toolshed-bg-",
    suffix: ".log",
  });
  const saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  try {
    redirectConsoleToFile(path);
    console.log("hello", 42);
    console.error("boom");
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    console.warn = saved.warn;
    console.error = saved.error;
  }
  const contents = await Deno.readTextFile(path);
  assertStringIncludes(contents, "hello 42");
  assertStringIncludes(contents, "boom");
  await Deno.remove(path);
});

Deno.test("writeListeningMarker writes the marker line to stdout", () => {
  const stdout = Deno.stdout as { writeSync(bytes: Uint8Array): number };
  const original = stdout.writeSync;
  const decoder = new TextDecoder();
  let captured = "";
  try {
    stdout.writeSync = (bytes: Uint8Array) => {
      captured += decoder.decode(bytes);
      return bytes.length;
    };
    writeListeningMarker();
  } finally {
    stdout.writeSync = original;
  }
  assertEquals(captured, `${READY_MARKER}\n`);
});

Deno.test({
  name: "runBackgroundParent spawns a real child and reads its marker",
  // Spawns a real `deno run` child, so the process and its streams are not the
  // synchronous resources the sanitizers track.
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const script = await Deno.makeTempFile({
    prefix: "toolshed-marker-",
    suffix: ".ts",
  });
  const logFile = await Deno.makeTempFile({
    prefix: "toolshed-log-",
    suffix: ".log",
  });
  await Deno.writeTextFile(
    script,
    `Deno.stdout.writeSync(new TextEncoder().encode("${READY_MARKER}\\n"));\n`,
  );
  let exitCode: number | undefined;
  try {
    await runBackgroundParent(
      {
        execPath: Deno.execPath(),
        mainModule: toFileUrl(script).href,
        serverArgs: [],
        logFile,
      },
      // Real defaultSpawn (no spawn override): exercises the actual subprocess
      // launch and the stdout read to the readiness marker.
      {
        exit: (code) => {
          exitCode = code;
        },
        writeOut: () => {},
        writeErr: () => {},
      },
    );
  } finally {
    await Deno.remove(script);
    await Deno.remove(logFile);
  }
  assertEquals(exitCode, 0);
});
