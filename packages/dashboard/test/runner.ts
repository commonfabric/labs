import { fromFileUrl } from "@std/path";
import {
  shuffleFlag,
  shuffleSeed,
} from "@commonfabric/test-support/shuffle";

const DASHBOARD_DIRECTORY = fromFileUrl(new URL("../", import.meta.url));

// The three commands the dashboard's tests run in, and what separates them.
// The `*.browser.test.ts` name routes a file to the browser pass: the same
// glob ignored here selects the files `test-browser` hands to deno-web-test.
// The two favicon files are named one by one because what sets them apart is
// the permissions they need rather than anything in their names.
export const TEST_COMMANDS = [
  [
    "test",
    shuffleFlag(shuffleSeed()),
    "--allow-env",
    "--allow-read",
    "--allow-write",
    `--allow-run=${Deno.execPath()},git`,
    "--ignore=**/*.browser.test.ts",
    "--ignore=favicon-raster.test.ts",
    "--ignore=regenerate-favicons.test.ts",
  ],
  ["task", "test-favicon-raster"],
  ["task", "test-browser"],
] as const;

interface RunningCommand {
  status: Promise<{ code: number }>;
  kill(): void;
}

type SpawnCommand = (
  args: readonly string[],
  env: Record<string, string>,
) => RunningCommand;

function spawnCommand(
  args: readonly string[],
  env: Record<string, string>,
): RunningCommand {
  const child = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd: DASHBOARD_DIRECTORY,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return child;
}

interface Interrupt {
  signal: Deno.Signal;
  status: number;
}

const INTERRUPTS: readonly Interrupt[] = Deno.build.os === "windows"
  ? [{ signal: "SIGINT", status: 130 }, { signal: "SIGBREAK", status: 131 }]
  : [
    { signal: "SIGHUP", status: 129 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGTERM", status: 143 },
  ];

export async function runDashboardTests(options: {
  spawn?: SpawnCommand;
  makeTempDirectory?: () => Promise<string>;
  removeDirectory?: (directory: string) => Promise<void>;
  interrupts?: readonly Interrupt[];
  addSignalListener?: typeof Deno.addSignalListener;
  removeSignalListener?: typeof Deno.removeSignalListener;
} = {}): Promise<number> {
  const spawn = options.spawn ?? spawnCommand;
  const directory = await (options.makeTempDirectory ??
    (() => Deno.makeTempDir({ prefix: "commontools-dashboard-tests-" })))();
  const removeDirectory = options.removeDirectory ??
    ((path) => Deno.remove(path, { recursive: true }));
  // The dashboard's own caches are the only thing this directory holds. The
  // runner removes it once the last command has finished, and what it waits
  // for is the commands themselves. The browser command leaves Chrome's crash
  // handler, zygote, and GPU processes running after it exits, and those write
  // into whatever directory `TMPDIR` names, so `TMPDIR` keeps naming the
  // machine's own temporary directory.
  const env = { DASHBOARD_CACHE_DIR: directory };
  const interrupts = options.interrupts ?? INTERRUPTS;
  const addSignalListener = options.addSignalListener ?? Deno.addSignalListener;
  const removeSignalListener = options.removeSignalListener ??
    Deno.removeSignalListener;
  const handlers = new Map<Deno.Signal, () => void>();
  let interrupted: Interrupt | undefined;
  let active: RunningCommand | undefined;
  const receivedInterrupt = (): Interrupt | undefined => interrupted;

  for (const interrupt of interrupts) {
    const handler = () => {
      if (interrupted) return;
      interrupted = interrupt;
      try {
        active?.kill();
      } catch {
        // The child completed between receiving the signal and forwarding it.
      }
    };
    handlers.set(interrupt.signal, handler);
    addSignalListener(interrupt.signal, handler);
  }

  try {
    for (const args of TEST_COMMANDS) {
      const beforeSpawn = receivedInterrupt();
      if (beforeSpawn) return beforeSpawn.status;
      active = spawn(args, env);
      try {
        const code = (await active.status).code;
        const afterStatus = receivedInterrupt();
        if (afterStatus) return afterStatus.status;
        if (code !== 0) return code;
      } catch (error) {
        const afterError = receivedInterrupt();
        if (afterError) return afterError.status;
        throw error;
      } finally {
        active = undefined;
      }
    }
    return 0;
  } finally {
    for (const [signal, handler] of handlers) {
      removeSignalListener(signal, handler);
    }
    await removeDirectory(directory);
  }
}

if (import.meta.main) {
  Deno.exitCode = await runDashboardTests();
}
