import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  pickInspectPort,
  profilingChildEnv,
} from "./cf-profile-lib.ts";

const decoder = new TextDecoder();

type ReleasePortResult =
  | { found: true; port: number }
  | { found: false };
type CaptureProfilerStartResult =
  | { found: true }
  | { found: false };

async function readTextStream(
  stream: ReadableStream<Uint8Array> | null,
  onText?: (text: string) => void,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const streamDecoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = streamDecoder.decode(value, { stream: true });
      text += chunk;
      onText?.(text);
    }
    const tail = streamDecoder.decode();
    text += tail;
    onText?.(text);
    return text;
  } finally {
    reader.releaseLock();
  }
}

function findReleasePort(text: string): number | undefined {
  const match = text.match(/profile release port (\d+)/);
  if (!match) return undefined;
  return Number(match[1]);
}

async function releaseChildProcess(releasePort: number): Promise<void> {
  const connection = await Deno.connect({
    hostname: "127.0.0.1",
    port: releasePort,
  });
  connection.close();
}

async function releaseChildProcessAfterProfilerStart(
  releasePortPromise: Promise<ReleasePortResult>,
  captureProfilerStartPromise: Promise<CaptureProfilerStartResult>,
): Promise<boolean> {
  const [releasePort, captureProfilerStart] = await Promise.all([
    releasePortPromise,
    captureProfilerStartPromise,
  ]);
  if (!releasePort.found || !captureProfilerStart.found) {
    return false;
  }
  await releaseChildProcess(releasePort.port);
  return true;
}

async function waitForReleasedChildProcess(
  child: Deno.ChildProcess | undefined,
  releaseDone: Promise<boolean>,
  releasePortPromise: Promise<ReleasePortResult>,
): Promise<Deno.CommandStatus | undefined> {
  if (!child) return undefined;
  if (!await releaseDone) {
    return await terminateChildProcess(child);
  }
  const releasePort = await releasePortPromise;
  if (!releasePort.found) {
    return await terminateChildProcess(child);
  }
  await releaseChildProcess(releasePort.port);
  return await child.status;
}

async function terminateChildProcess(
  child: Deno.ChildProcess | undefined,
): Promise<Deno.CommandStatus | undefined> {
  if (!child) return undefined;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  return await child.status;
}

function profilingCaptureEnv(): Record<string, string> {
  const env = profilingChildEnv();
  const coverageDir = Deno.env.get("DENO_COVERAGE_DIR");
  if (coverageDir) env.DENO_COVERAGE_DIR = coverageDir;
  return env;
}

Deno.test("cf-profile captures a CPU profile for CLI help", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cf-profile-test-" });
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const metaPath = join(tmpDir, "profile.meta.json");
    const scriptPath = fromFileUrl(new URL("cf-profile.ts", import.meta.url));

    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        scriptPath,
        `--profile-output=${profilePath}`,
        "--profile-stop-pattern=Usage",
        "--help",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    assertEquals(result.code, 0, `${stdout}\n${stderr}`);
    assertStringIncludes(stdout, "cf-profile: CPU profile");
    assertStringIncludes(stdout, "Usage:");

    const profileInfo = await Deno.stat(profilePath);
    assert(profileInfo.size > 0);
    const consoleInfo = await Deno.stat(consolePath);
    assert(consoleInfo.size > 0);

    const meta = JSON.parse(await Deno.readTextFile(metaPath));
    assertEquals(meta.command, ["--help"]);
    assertEquals("profileDoneMarker" in meta, false);
    assertEquals("profileStartPattern" in meta, false);
    assertEquals(meta.profileStopPattern, "Usage");
    assertEquals(meta.cliStatus.success, true);
    assertEquals(meta.captureStatus.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cf-profile requires a CLI command", async () => {
  const scriptPath = fromFileUrl(new URL("cf-profile.ts", import.meta.url));

  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      scriptPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);

  assert(result.code !== 0, `${stdout}\n${stderr}`);
  assertStringIncludes(
    stderr,
    "cf-profile requires a Common Fabric CLI command",
  );
});

Deno.test("cf-profile exits when the child never publishes an inspector URL", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cf-profile-port-test-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const port = (listener.addr as Deno.NetAddr).port;
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const scriptPath = fromFileUrl(new URL("cf-profile.ts", import.meta.url));

    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        scriptPath,
        `--profile-output=${profilePath}`,
        `--profile-inspect-port=${port}`,
        "--help",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    assert(result.code !== 0, `${stdout}\n${stderr}`);
    assertStringIncludes(stderr, "Failed to start inspector server");
  } finally {
    listener.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("capture-deno-inspector-profile entrypoint validates required args", async () => {
  const scriptPath = fromFileUrl(
    new URL("capture-deno-inspector-profile.ts", import.meta.url),
  );

  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      scriptPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);

  assert(result.code !== 0, `${stdout}\n${stderr}`);
  assertStringIncludes(stderr, "--output is required");
});

Deno.test("capture-deno-inspector-profile waits for profiler start before summary stop", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "profile-capture-test-" });
  let target: Deno.ChildProcess | undefined;
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const targetPath = fromFileUrl(
      new URL("fixtures/profile-marker-target.ts", import.meta.url),
    );
    const capturePath = fromFileUrl(
      new URL("capture-deno-inspector-profile.ts", import.meta.url),
    );
    const inspectPort = pickInspectPort();

    target = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        inspectWaitFlag("127.0.0.1", inspectPort),
        targetPath,
      ],
      clearEnv: true,
      env: profilingChildEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const inspectorUrl = Promise.withResolvers<string>();
    const releasePort = Promise.withResolvers<ReleasePortResult>();
    let inspectorUrlFound = false;
    let releasePortFound = false;
    const targetStdoutPromise = readTextStream(target.stdout);
    const targetStderrPromise = readTextStream(target.stderr, (text) => {
      const found = findInspectorWebSocketUrl(text);
      if (found && !inspectorUrlFound) {
        inspectorUrlFound = true;
        inspectorUrl.resolve(found);
      }
      const foundReleasePort = findReleasePort(text);
      if (foundReleasePort && !releasePortFound) {
        releasePortFound = true;
        releasePort.resolve({ found: true, port: foundReleasePort });
      }
    }).then((text) => {
      if (!inspectorUrlFound) {
        inspectorUrl.reject(new Error("Inspector WebSocket URL was not found"));
      }
      if (!releasePortFound) {
        releasePort.resolve({ found: false });
      }
      return text;
    });
    const captureProfilerStart = Promise
      .withResolvers<CaptureProfilerStartResult>();
    let captureProfilerStartFound = false;
    let captureProfilerStartSettled = false;
    const resolveCaptureProfilerStart = (
      result: CaptureProfilerStartResult,
    ) => {
      if (captureProfilerStartSettled) return;
      captureProfilerStartSettled = true;
      captureProfilerStartFound = result.found;
      captureProfilerStart.resolve(result);
    };
    const capture = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        capturePath,
        `--output=${profilePath}`,
        `--console-output=${consolePath}`,
        "--summary-pattern=profile stop",
        "--profile-start-pattern=profile start",
        `--websocket-url=${await inspectorUrl.promise}`,
      ],
      clearEnv: true,
      env: profilingCaptureEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const captureStdoutPromise = readTextStream(capture.stdout, (text) => {
      if (
        text.includes("profile: profiler started") &&
        !captureProfilerStartFound
      ) {
        resolveCaptureProfilerStart({ found: true });
      }
    }).then((text) => {
      if (!captureProfilerStartSettled) {
        resolveCaptureProfilerStart({ found: false });
      }
      return text;
    });
    const captureStderrPromise = readTextStream(capture.stderr, (text) => {
      if (text.includes("Profiler.start failed")) {
        resolveCaptureProfilerStart({ found: false });
      }
    });
    const releaseDone = releaseChildProcessAfterProfilerStart(
      releasePort.promise,
      captureProfilerStart.promise,
    );
    const targetStartFailureCleanup = releaseDone.then(async (released) => {
      if (!released) {
        await terminateChildProcess(target);
      }
    });

    const captureStatus = await capture.status;
    const targetStatus = captureStatus.success
      ? await waitForReleasedChildProcess(
        target,
        releaseDone,
        releasePort.promise,
      )
      : await terminateChildProcess(target);
    await targetStartFailureCleanup;
    target = undefined;
    const targetStdout = await targetStdoutPromise;
    const targetStderr = await targetStderrPromise;
    const captureStdout = await captureStdoutPromise;
    const captureStderr = await captureStderrPromise;
    const failureOutput =
      `${captureStdout}\n${captureStderr}\n${targetStdout}\n${targetStderr}`;

    assertEquals(captureStatus.code, 0, failureOutput);
    assertEquals(targetStatus?.success, true, failureOutput);
    assertStringIncludes(captureStdout, "profile: summary matched");
    assertStringIncludes(targetStdout, "profile start");
    assertStringIncludes(targetStdout, "profile stop");

    const profileInfo = await Deno.stat(profilePath);
    assert(profileInfo.size > 0);
    const consoleLog = await Deno.readTextFile(consolePath);
    assertStringIncludes(consoleLog, "profile start");
    assertStringIncludes(consoleLog, "profile stop");
  } finally {
    await terminateChildProcess(target);
    target = undefined;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("capture-deno-inspector-profile starts from a console marker", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "profile-capture-test-" });
  let target: Deno.ChildProcess | undefined;
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const targetPath = fromFileUrl(
      new URL("fixtures/profile-marker-target.ts", import.meta.url),
    );
    const capturePath = fromFileUrl(
      new URL("capture-deno-inspector-profile.ts", import.meta.url),
    );
    const inspectPort = pickInspectPort();

    target = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        inspectWaitFlag("127.0.0.1", inspectPort),
        targetPath,
      ],
      clearEnv: true,
      env: profilingChildEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const inspectorUrl = Promise.withResolvers<string>();
    const releasePort = Promise.withResolvers<ReleasePortResult>();
    let inspectorUrlFound = false;
    let releasePortFound = false;
    const targetStdoutPromise = readTextStream(target.stdout);
    const targetStderrPromise = readTextStream(target.stderr, (text) => {
      const found = findInspectorWebSocketUrl(text);
      if (found && !inspectorUrlFound) {
        inspectorUrlFound = true;
        inspectorUrl.resolve(found);
      }
      const foundReleasePort = findReleasePort(text);
      if (foundReleasePort && !releasePortFound) {
        releasePortFound = true;
        releasePort.resolve({ found: true, port: foundReleasePort });
      }
    }).then((text) => {
      if (!inspectorUrlFound) {
        inspectorUrl.reject(new Error("Inspector WebSocket URL was not found"));
      }
      if (!releasePortFound) {
        releasePort.resolve({ found: false });
      }
      return text;
    });
    const captureProfilerStart = Promise
      .withResolvers<CaptureProfilerStartResult>();
    let captureProfilerStartFound = false;
    let captureProfilerStartSettled = false;
    const resolveCaptureProfilerStart = (
      result: CaptureProfilerStartResult,
    ) => {
      if (captureProfilerStartSettled) return;
      captureProfilerStartSettled = true;
      captureProfilerStartFound = result.found;
      captureProfilerStart.resolve(result);
    };
    const capture = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        capturePath,
        `--output=${profilePath}`,
        `--console-output=${consolePath}`,
        "--summary-pattern=(?!)",
        "--profile-start-pattern=profile start",
        "--profile-stop-pattern=profile stop",
        `--websocket-url=${await inspectorUrl.promise}`,
      ],
      clearEnv: true,
      env: profilingCaptureEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const captureStdoutPromise = readTextStream(capture.stdout, (text) => {
      if (
        text.includes("profile: profiler started") &&
        !captureProfilerStartFound
      ) {
        resolveCaptureProfilerStart({ found: true });
      }
    }).then((text) => {
      if (!captureProfilerStartSettled) {
        resolveCaptureProfilerStart({ found: false });
      }
      return text;
    });
    const captureStderrPromise = readTextStream(capture.stderr, (text) => {
      if (text.includes("Profiler.start failed")) {
        resolveCaptureProfilerStart({ found: false });
      }
    });
    const releaseDone = releaseChildProcessAfterProfilerStart(
      releasePort.promise,
      captureProfilerStart.promise,
    );
    const targetStartFailureCleanup = releaseDone.then(async (released) => {
      if (!released) {
        await terminateChildProcess(target);
      }
    });

    const captureStatus = await capture.status;
    const targetStatus = captureStatus.success
      ? await waitForReleasedChildProcess(
        target,
        releaseDone,
        releasePort.promise,
      )
      : await terminateChildProcess(target);
    await targetStartFailureCleanup;
    target = undefined;
    const targetStdout = await targetStdoutPromise;
    const targetStderr = await targetStderrPromise;
    const captureStdout = await captureStdoutPromise;
    const captureStderr = await captureStderrPromise;
    const failureOutput =
      `${captureStdout}\n${captureStderr}\n${targetStdout}\n${targetStderr}`;

    assertEquals(captureStatus.code, 0, failureOutput);
    assertEquals(targetStatus?.success, true, failureOutput);
    assertStringIncludes(captureStdout, "profile: profile stop matched");
    assertStringIncludes(targetStdout, "profile start");
    assertStringIncludes(targetStdout, "profile stop");

    const profileInfo = await Deno.stat(profilePath);
    assert(profileInfo.size > 0);
    const consoleLog = await Deno.readTextFile(consolePath);
    assertStringIncludes(consoleLog, "profile start");
    assertStringIncludes(consoleLog, "profile stop");
  } finally {
    await terminateChildProcess(target);
    await Deno.remove(tmpDir, { recursive: true });
  }
});
