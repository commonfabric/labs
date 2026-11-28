import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  cleanupFuseChild,
  type FuseCommandConstructor,
  type FuseSupervisorOptions,
  recordFuseMountState,
  runFuseSupervisor,
  supervisorMain,
} from "../lib/fuse-supervisor.ts";
import type { MountStateEntry } from "../lib/fuse.ts";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

const CHILD_PID = 777;

function exited(code: number): Deno.CommandStatus {
  return { code, success: code === 0, signal: null };
}

/**
 * A command constructor whose one child exits when `onKill` settles it. The
 * child records every signal it is sent.
 */
function commandFor(
  status: Promise<Deno.CommandStatus>,
  onKill: (signal: Deno.Signal) => void = () => {},
): { command: FuseCommandConstructor; kills: Deno.Signal[] } {
  const kills: Deno.Signal[] = [];
  class StandInCommand {
    constructor(_command: string | URL, _options: Deno.CommandOptions) {}
    spawn() {
      return {
        pid: CHILD_PID,
        status,
        kill: (signal: Deno.Signal) => {
          kills.push(signal);
          onKill(signal);
        },
      };
    }
  }
  return { command: StandInCommand, kills };
}

/** Records exit codes, and resolves `reached` once `count` have arrived. */
function exitRecorder(count: number) {
  const codes: number[] = [];
  const reached = Promise.withResolvers<void>();
  return {
    codes,
    reached: reached.promise,
    exit: (code: number) => {
      codes.push(code);
      if (codes.length === count) reached.resolve();
    },
  };
}

function supervisorOptions(
  overrides: Partial<FuseSupervisorOptions> = {},
): FuseSupervisorOptions {
  return {
    mountpoint: "/tmp/fuse-supervisor",
    apiUrl: "",
    identity: "",
    execCli: "",
    execPath: "/opt/bin/cf",
    ...overrides,
  };
}

describe("fuse-supervisor", () => {
  describe("runFuseSupervisor", () => {
    for (
      const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const
    ) {
      it(`forwards ${signal} to the FUSE child once and exits with ${code}`, async () => {
        const status = Promise.withResolvers<Deno.CommandStatus>();
        const { command, kills } = commandFor(
          status.promise,
          () => status.resolve(exited(0)),
        );
        const handlers = new Map<Deno.Signal, () => void>();
        const exits = exitRecorder(1);

        const running = runFuseSupervisor(supervisorOptions({
          command,
          exit: exits.exit,
          addSignalListener: (sig, handler) => handlers.set(sig, handler),
          removeSignalListener: (sig) => handlers.delete(sig),
        }));
        const handler = handlers.get(signal)!;
        handler();
        handler();

        await running;
        await exits.reached;
        expect(kills).toEqual([signal]);
        expect(exits.codes).toEqual([code]);
        expect([...handlers.keys()]).toEqual([]);
      });
    }

    it("exits with status 1 when forwarding a signal loses track of the child", async () => {
      const status = Promise.withResolvers<Deno.CommandStatus>();
      const { command, kills } = commandFor(
        status.promise,
        () => status.reject(new Error("child lost")),
      );
      const handlers = new Map<Deno.Signal, () => void>();
      const exits = exitRecorder(1);

      const running = runFuseSupervisor(supervisorOptions({
        command,
        exit: exits.exit,
        addSignalListener: (sig, handler) => handlers.set(sig, handler),
        removeSignalListener: () => {},
      }));
      handlers.get("SIGTERM")!();

      await expect(running).rejects.toThrow("child lost");
      await exits.reached;
      expect(exits.codes).toEqual([1]);
      expect(kills[0]).toBe("SIGTERM");
    });

    it("runs the child to its exit status when signal listeners are unsupported", async () => {
      const { command, kills } = commandFor(Promise.resolve(exited(5)));
      const exits = exitRecorder(1);
      const writes: string[] = [];

      await runFuseSupervisor(supervisorOptions({
        command,
        exit: exits.exit,
        writeMountStateFile: (path) => {
          writes.push(path);
          return Promise.resolve();
        },
        addSignalListener: () => {
          throw new Error("unsupported");
        },
        removeSignalListener: () => {
          throw new Error("unsupported");
        },
      }));

      expect(exits.codes).toEqual([5]);
      expect(kills).toEqual([]);
      expect(writes).toEqual([]);
    });
  });

  describe("cleanupFuseChild", () => {
    it("returns without waiting when the child is already gone at the signal", async () => {
      const kills: Deno.Signal[] = [];
      await cleanupFuseChild({
        kill: (signal) => {
          kills.push(signal);
          throw new TypeError("Child process has already terminated");
        },
        status: new Promise(() => {}),
      });
      expect(kills).toEqual(["SIGTERM"]);
    });

    it("returns when the child exits as it is sent SIGKILL", async () => {
      const kills: Deno.Signal[] = [];
      const status = Promise.withResolvers<Deno.CommandStatus>();
      await cleanupFuseChild({
        kill: (signal) => {
          kills.push(signal);
          if (signal === "SIGKILL") {
            status.resolve(exited(137));
            throw new TypeError("Child process has already terminated");
          }
        },
        status: status.promise,
      }, { timeoutMs: 0 });
      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("sends one signal and does not escalate when it cannot watch the child's status", async () => {
      const kills: Deno.Signal[] = [];
      await cleanupFuseChild(
        { kill: (signal) => kills.push(signal) },
        { signal: "SIGINT", timeoutMs: 0 },
      );
      expect(kills).toEqual(["SIGINT"]);
    });

    it("sends nothing to a child that has already exited", async () => {
      const kills: Deno.Signal[] = [];
      await cleanupFuseChild({
        killed: true,
        kill: (signal) => kills.push(signal),
        status: new Promise(() => {}),
      });
      expect(kills).toEqual([]);
    });
  });

  describe("recordFuseMountState", () => {
    it("writes nothing when the supervisor has no state path", async () => {
      const writes: string[] = [];
      await recordFuseMountState(
        supervisorOptions({
          writeMountStateFile: (path) => {
            writes.push(path);
            return Promise.resolve();
          },
        }),
        CHILD_PID,
      );
      expect(writes).toEqual([]);
    });

    it("writes both PIDs and the mount's settings to the state path", async () => {
      const writes: [string, MountStateEntry][] = [];
      await recordFuseMountState(
        supervisorOptions({
          statePath: "/state/mount.json",
          supervisorPid: 42,
          apiUrl: "http://fabric.test",
          identity: "/keys/id.key",
          supervisorStatusPath: "/state/status.json",
          logFile: "/logs/fuse.log",
          writeMountStateFile: (path, entry) => {
            writes.push([path, entry]);
            return Promise.resolve();
          },
        }),
        CHILD_PID,
      );
      expect(writes).toEqual([["/state/mount.json", {
        pid: 42,
        childPid: CHILD_PID,
        mountpoint: "/tmp/fuse-supervisor",
        apiUrl: "http://fabric.test",
        identity: "/keys/id.key",
        startedAt: expect.any(String),
        childStatusPath: "/state/status.json",
        logFile: "/logs/fuse.log",
      }]]);
    });

    it("leaves the log file out of the entry when it is empty", async () => {
      const entries: MountStateEntry[] = [];
      await recordFuseMountState(
        supervisorOptions({
          statePath: "/state/mount.json",
          logFile: "",
          writeMountStateFile: (_path, entry) => {
            entries.push(entry);
            return Promise.resolve();
          },
        }),
        CHILD_PID,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].logFile).toBeUndefined();
    });

    it("reports a failed write as unable to record the mount state", async () => {
      await expect(recordFuseMountState(
        supervisorOptions({
          statePath: "/state/mount.json",
          writeMountStateFile: () => Promise.reject(new Error("disk full")),
        }),
        CHILD_PID,
      )).rejects.toThrow(
        "Unable to record FUSE mount state: Error: disk full",
      );
    });
  });

  describe("supervisorMain", () => {
    function harness(run: (options: FuseSupervisorOptions) => Promise<void>) {
      const logs: string[] = [];
      const errors: string[] = [];
      const exits: number[] = [];
      return {
        logs,
        errors,
        exits,
        deps: {
          run,
          exit: (code: number) => {
            exits.push(code);
          },
          output: {
            log: (message: string) => logs.push(message),
            error: (message: string) => errors.push(message),
          },
        },
      };
    }

    it("prints help without running the supervisor", async () => {
      const runs: FuseSupervisorOptions[] = [];
      const h = harness((options) => {
        runs.push(options);
        return Promise.resolve();
      });
      await supervisorMain(["--help"], h.deps);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("--state-path");
      expect(runs).toEqual([]);
      expect(h.exits).toEqual([]);
    });

    it("runs the supervisor with the parsed mount flags", async () => {
      const runs: FuseSupervisorOptions[] = [];
      const h = harness((options) => {
        runs.push(options);
        return Promise.resolve();
      });
      await supervisorMain(["/mnt/x", "--debug"], h.deps);
      expect(runs).toEqual([
        expect.objectContaining({ mountpoint: "/mnt/x", debug: true }),
      ]);
      expect(h.errors).toEqual([]);
      expect(h.exits).toEqual([]);
    });

    it("reports an unparseable argv on stderr and exits with status 1", async () => {
      const runs: FuseSupervisorOptions[] = [];
      const h = harness((options) => {
        runs.push(options);
        return Promise.resolve();
      });
      await supervisorMain(["/mnt/x", "--bogus"], h.deps);
      expect(h.errors).toEqual(["Unknown fuse supervisor option: --bogus"]);
      expect(h.exits).toEqual([1]);
      expect(runs).toEqual([]);
    });

    it("reports a supervisor failure on stderr and exits with status 1", async () => {
      const h = harness(() => Promise.reject(new Error("spawn failed")));
      await supervisorMain(["/mnt/x"], h.deps);
      expect(h.errors).toEqual([expect.stringContaining("spawn failed")]);
      expect(h.exits).toEqual([1]);
    });
  });

  describe("run as a script", () => {
    const supervisorPath = fromFileUrl(
      new URL("../lib/fuse-supervisor.ts", import.meta.url),
    );

    async function runScript(args: string[]) {
      const output = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../../", import.meta.url)),
        cwd: fromFileUrl(new URL("../", import.meta.url)),
        args: (lock) => ["run", `--lock=${lock}`, supervisorPath, ...args],
      });
      const decoder = new TextDecoder();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    }

    it("prints help on stdout and exits with status 0 for --help", async () => {
      const result = await runScript(["--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: fuse-supervisor <mountpoint>");
      expect(result.stdout).toContain("--state-path");
      expect(result.stderr).toBe("");
    });

    it("reports an unknown option on stderr and exits with status 1", async () => {
      const result = await runScript(["/mnt/x", "--bogus"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Unknown fuse supervisor option: --bogus\n");
    });
  });
});
