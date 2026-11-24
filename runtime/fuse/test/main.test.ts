import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { CellBridgeOptions } from "../cell-bridge.ts";
import {
  logEscapedErrors,
  main,
  type MainHost,
  type MountBridge,
} from "../mod.ts";
import linuxPlatform from "../platform-linux.ts";
import type {
  FuseLib,
  FusePlatform,
  LoadedFuse,
  MountHandle,
} from "../platform.ts";
import type { FsTree } from "../tree.ts";
import { FakeBridge } from "./fake-bridge.ts";

/** What `exit` was asked to do, thrown so that `main()` stops there. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exited with ${code}`);
  }
}

const decoder = new TextDecoder();

/** A libfuse stand-in whose session loop and mount a case controls. */
interface FakeFuse extends LoadedFuse {
  readonly mounted: { mountpoint: string; table: ArrayBuffer }[];
  readonly calls: string[];
  readonly entries: bigint[];
  readonly notified: string[];
}

function fakeFuse(options: {
  loop: (fuse: FakeFuse) => Promise<number>;
  mountError?: Error;
  onMount?: () => void;
  onNotify?: () => void;
}): FakeFuse {
  const unused = (name: string) => () => {
    throw new Error(`${name} is not used by a static mount`);
  };
  const symbols: FuseLib["symbols"] = {
    fuse_session_loop: () => options.loop(fuse),
    fuse_session_destroy: unused("fuse_session_destroy"),
    fuse_opt_free_args: unused("fuse_opt_free_args"),
    fuse_reply_err: unused("fuse_reply_err"),
    fuse_reply_entry: (_req, entry) => {
      fuse.entries.push(new Deno.UnsafePointerView(entry!).getBigUint64(0));
      return 0;
    },
    fuse_reply_attr: unused("fuse_reply_attr"),
    fuse_reply_buf: unused("fuse_reply_buf"),
    fuse_reply_open: unused("fuse_reply_open"),
    fuse_reply_readlink: unused("fuse_reply_readlink"),
    fuse_reply_write: unused("fuse_reply_write"),
    fuse_reply_create: unused("fuse_reply_create"),
    fuse_reply_xattr: unused("fuse_reply_xattr"),
    fuse_reply_none: unused("fuse_reply_none"),
    fuse_add_direntry: unused("fuse_add_direntry"),
    fuse_lowlevel_notify_inval_entry: (target, parent, name) => {
      fuse.notified.push(
        `entry ${Deno.UnsafePointer.value(target)} ${parent} ${
          decoder.decode(name ?? undefined)
        }`,
      );
      options.onNotify?.();
      return Promise.resolve(0);
    },
    fuse_lowlevel_notify_inval_inode: unused(
      "fuse_lowlevel_notify_inval_inode",
    ),
  };
  const session = Deno.UnsafePointer.create(7n);
  const fuse: FakeFuse = {
    symbols,
    provider: "linux-libfuse",
    mounted: [],
    calls: [],
    entries: [],
    notified: [],
    mount(mountpoint, _args, table): MountHandle {
      if (options.mountError) throw options.mountError;
      options.onMount?.();
      fuse.mounted.push({ mountpoint: decoder.decode(mountpoint), table });
      return { session, notifyTarget: session };
    },
    unmount() {
      fuse.calls.push("unmount");
    },
    cleanup(_handle, _mountpoint, alreadyUnmounted) {
      fuse.calls.push(`cleanup alreadyUnmounted=${alreadyUnmounted}`);
    },
  };
  return fuse;
}

/** A bridge as the daemon makes one, recording how it was set up. */
class FakeMountBridge extends FakeBridge implements MountBridge {
  onInvalidate: ((parentIno: bigint, names: string[]) => void) | null = null;
  onInvalidateInode: ((ino: bigint) => void) | null = null;
  readonly setup: unknown[] = [];

  constructor(
    readonly tree: FsTree,
    readonly execCli: string,
    readonly options: CellBridgeOptions,
  ) {
    super();
  }

  init(config: { apiUrl: string; identity: string }): void {
    this.setup.push(config);
  }

  setDebug(debug: boolean): void {
    this.setup.push({ debug });
  }

  initStatus(): void {
    this.setup.push(this.options.statusProvider?.());
  }
}

/**
 * A host whose platform loads `fuse`, whose bridges are `FakeMountBridge`s
 * collected in `bridges`, and whose exit throws `Exited`.
 */
function hostFor(
  openFuse: () => LoadedFuse,
  bridges: FakeMountBridge[] = [],
  connectSpace?: (name: string) => Promise<unknown>,
): MainHost {
  const platform: FusePlatform = { ...linuxPlatform, openFuse };
  return {
    getPlatform: () => Promise.resolve(platform),
    createBridge: (tree, execCli, options) => {
      const bridge = new FakeMountBridge(tree, execCli, options);
      if (connectSpace) bridge.connectSpace = connectSpace;
      bridges.push(bridge);
      return bridge;
    },
    exit: (code): never => {
      throw new Exited(code);
    },
  };
}

/** Looks `name` up at the mount root the way the kernel would. */
function lookUp(fuse: FakeFuse, name: string): void {
  const { table } = fuse.mounted[0];
  const address = new DataView(table).getBigUint64(
    linuxPlatform.OPS_OFFSETS.lookup,
    true,
  );
  const lookup = new Deno.UnsafeFnPointer(
    Deno.UnsafePointer.create(address)!,
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
  );
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  lookup.call(
    Deno.UnsafePointer.create(1n),
    1n,
    Deno.UnsafePointer.of(nameBytes),
  );
}

describe("main()", () => {
  const quiet = () => {};
  let dir: string;
  let statusPath: string;
  let mountpoint: string;
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    statusPath = `${dir}/status.json`;
    mountpoint = `${dir}/mnt`;
    // A daemon announces its states on stdout for the process that started
    // it, and logs to the console; neither is part of these cases.
    console.log = quiet;
    console.warn = quiet;
    console.error = quiet;
  });

  afterEach(async () => {
    Object.assign(console, original);
    await Deno.remove(dir, { recursive: true });
  });

  /** The arguments of a static mount reporting to `statusPath`. */
  function staticMount(...extra: string[]): string[] {
    return [
      mountpoint,
      "--api-url=",
      "--cfc-mode=disabled",
      `--supervisor-status=${statusPath}`,
      ...extra,
    ];
  }

  async function status(): Promise<Record<string, unknown>> {
    return JSON.parse(await Deno.readTextFile(statusPath));
  }

  it("serves a static tree until the session ends, reporting each state", async () => {
    const logPath = `${dir}/fuse.log`;
    let stateWhileServing: unknown;
    const fuse = fakeFuse({
      loop: async (fuse) => {
        stateWhileServing = (await status()).state;
        lookUp(fuse, "hello.txt");
        return 0;
      },
    });

    await main(staticMount(`--log-file=${logPath}`), hostFor(() => fuse));

    expect(fuse.mounted.map((m) => m.mountpoint)).toEqual([
      `${mountpoint}\0`,
    ]);
    expect((await Deno.stat(mountpoint)).isDirectory).toBe(true);
    expect(stateWhileServing).toBe("starting");
    expect(fuse.entries).toEqual([2n]);
    expect(await status()).toMatchObject({
      state: "exited",
      exitCode: 0,
      mountpoint,
    });
    expect(fuse.calls).toEqual(["cleanup alreadyUnmounted=false"]);
    const log = await Deno.readTextFile(logPath);
    expect(log).toContain("Static mode: hello.txt\n");
    expect(log).toContain(`Mounted at ${mountpoint}\n`);
    expect(log).toContain("Cleaned up.\n");
    // The console goes back to what it was once the daemon returns.
    expect([console.log, console.warn, console.error]).toEqual([
      quiet,
      quiet,
      quiet,
    ]);
  });

  it("unmounts on SIGTERM and reports that it is exiting", async () => {
    const serving = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<number>();
    const fuse = fakeFuse({
      loop: () => {
        serving.resolve();
        return ended.promise;
      },
    });
    const originalUnmount = fuse.unmount;
    fuse.unmount = (handle, mountpointBuf) => {
      originalUnmount(handle, mountpointBuf);
      ended.resolve(0);
    };

    const running = main(staticMount(), hostFor(() => fuse));
    await serving.promise;
    Deno.kill(Deno.pid, "SIGTERM");
    await running;

    expect(fuse.calls).toEqual(["unmount", "cleanup alreadyUnmounted=true"]);
    expect(await status()).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("connects the spaces it is given through a bridge, and sends the bridge's invalidations to the kernel", async () => {
    const bridges: FakeMountBridge[] = [];
    const connected: string[] = [];
    let statusWhileServing: unknown;
    const sent = Promise.withResolvers<void>();
    const fuse = fakeFuse({
      loop: async () => {
        const [bridge] = bridges;
        statusWhileServing = bridge.options.statusProvider?.();
        bridge.options.onCfcProjectionRebuilt?.();
        bridge.onInvalidate!(1n, ["stale"]);
        await sent.promise;
        return 0;
      },
      onNotify: () => sent.resolve(),
    });

    await main(
      [
        mountpoint,
        "--api-url=http://localhost:1",
        "--identity=/keys/me",
        "--exec-cli=/bin/cf",
        "--space=work",
        "--space=play",
        "--cfc-mode=disabled",
        "--debug",
      ],
      hostFor(() => fuse, bridges, (name) => {
        connected.push(name);
        return Promise.resolve();
      }),
    );

    expect(connected).toEqual(["work", "play"]);
    const [bridge] = bridges;
    expect(bridge.execCli).toBe("/bin/cf");
    expect(bridge.setup.slice(0, 2)).toEqual([
      { apiUrl: "http://localhost:1", identity: "/keys/me" },
      { debug: true },
    ]);
    expect(statusWhileServing).toMatchObject({
      writes: { opened: 0, flushErrors: 0 },
      logFile: null,
      cfc: { mode: "disabled" },
    });
    expect(fuse.notified).toEqual(["entry 7 1 stale\0"]);
  });

  it("connects the space `home` when none is given, and reports one it cannot connect", async () => {
    const connected: string[] = [];

    await expect(
      main(
        staticMount("--api-url=http://localhost:1"),
        hostFor(
          () => fakeFuse({ loop: () => Promise.resolve(0) }),
          [],
          (name) => {
            connected.push(name);
            return Promise.reject(new Error("space not found"));
          },
        ),
      ),
    ).rejects.toThrow(new Exited(1));

    expect(connected).toEqual(["home"]);
    expect(await status()).toMatchObject({
      state: "failed",
      error: "[FUSE] space not found",
    });
  });

  it("logs errors that escape the daemon instead of ending it, counting lost writes", async () => {
    using _logging = logEscapedErrors();
    const logPath = `${dir}/fuse.log`;
    const fuse = fakeFuse({
      loop: async () => {
        const seen = Promise.withResolvers<void>();
        let count = 0;
        const see = () => {
          if (++count === 4) seen.resolve();
        };
        globalThis.addEventListener("unhandledrejection", see);
        globalThis.addEventListener("error", see);
        try {
          Promise.reject(new Error("lost"));
          Promise.reject(new Error("transport closed"));
          setTimeout(() => {
            throw new Error("thrown");
          });
          setTimeout(() => {
            throw new Error("ConnectionError: reset");
          });
          await seen.promise;
        } finally {
          globalThis.removeEventListener("unhandledrejection", see);
          globalThis.removeEventListener("error", see);
        }
        return 0;
      },
    });

    await main(staticMount(`--log-file=${logPath}`), hostFor(() => fuse));

    const log = await Deno.readTextFile(logPath);
    expect(log).toContain("[FUSE] Unhandled promise rejection: Error: lost\n");
    expect(log).toContain("[FUSE] Uncaught error: Error: thrown\n");
    expect(log).toContain(
      "[fuse] unhandled async write failure: transport closed\n",
    );
    expect(log).toContain(
      "[fuse] uncaught async write failure: ConnectionError: reset\n",
    );
    expect(log).toContain("[fuse:crash] Last operations:\n");
  });

  it("keeps serving when the status file cannot be written after the mount", async () => {
    const logPath = `${dir}/fuse.log`;
    const fuse = fakeFuse({
      loop: () => Promise.resolve(0),
      onMount: () => Deno.removeSync(`${dir}/state`, { recursive: true }),
    });
    await Deno.mkdir(`${dir}/state`);

    await main(
      [
        mountpoint,
        "--api-url=",
        "--cfc-mode=disabled",
        `--supervisor-status=${dir}/state/status.json`,
        `--log-file=${logPath}`,
      ],
      hostFor(() => fuse),
    );

    expect(fuse.calls).toEqual(["cleanup alreadyUnmounted=false"]);
    expect(await Deno.readTextFile(logPath)).toContain(
      "[FUSE] Unable to write mounted supervisor status:",
    );
  });

  it("reports a failed startup and exits for an option it cannot use", async () => {
    const neverMounted = () => {
      throw new Error("the mount is never reached");
    };

    await expect(
      main(
        staticMount("--cfc-xattr-namespace=nowhere"),
        hostFor(neverMounted),
      ),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({
      state: "failed",
      error:
        "[FUSE] Unknown --cfc-xattr-namespace=nowhere; expected trusted, compat, or both",
    });

    await expect(
      main(staticMount("--cfc-mode=sometimes"), hostFor(neverMounted)),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({ state: "failed" });

    await expect(
      main(
        staticMount("--attrcache-timeout"),
        hostFor(neverMounted),
      ),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({ state: "failed" });

    const recoveryPath = `${dir}/writeback.json`;
    await Deno.writeTextFile(recoveryPath, "{");
    await expect(
      main(
        staticMount(`--cfc-writeback-state=${recoveryPath}`),
        hostFor(neverMounted),
      ),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({
      state: "failed",
      error: expect.stringContaining(
        `Cannot read the CFC writeback recovery store ${recoveryPath}`,
      ),
    });
    expect(await Deno.readTextFile(recoveryPath)).toBe("{");
  });

  it("reports a libfuse that cannot load and a mount that fails", async () => {
    await expect(
      main(
        staticMount(),
        hostFor(() => {
          throw new Error("Could not open libfuse3");
        }),
      ),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({
      state: "failed",
      error: "[FUSE] Could not open libfuse3",
    });

    await expect(
      main(
        staticMount(),
        hostFor(() =>
          fakeFuse({
            loop: () => Promise.resolve(0),
            mountError: new Error("fuse_session_mount failed (rc=-1)"),
          })
        ),
      ),
    ).rejects.toThrow(new Exited(1));
    expect(await status()).toMatchObject({
      state: "failed",
      error: "[FUSE] fuse_session_mount failed (rc=-1)",
    });
  });

  it("exits after a failed startup even when the failure cannot be recorded", async () => {
    // The status directory goes away after `starting` is recorded, so the
    // failure that follows has nowhere to be written.

    const stateDir = `${dir}/state`;
    const args = [
      mountpoint,
      "--api-url=",
      "--cfc-mode=disabled",
      `--supervisor-status=${stateDir}/status.json`,
    ];
    const losingState = (fuse: () => LoadedFuse) => () => {
      Deno.removeSync(stateDir, { recursive: true });
      return fuse();
    };

    await Deno.mkdir(stateDir);
    await expect(
      main(
        args,
        hostFor(losingState(() => {
          throw new Error("Could not open libfuse3");
        })),
      ),
    ).rejects.toThrow(new Exited(1));
    await Deno.mkdir(stateDir);
    await expect(
      main(
        args,
        hostFor(losingState(() =>
          fakeFuse({
            loop: () => Promise.resolve(0),
            mountError: new Error("fuse_session_mount failed (rc=-1)"),
          })
        )),
      ),
    ).rejects.toThrow(new Exited(1));
  });

  it("exits without a mountpoint, and when the status file cannot be written", async () => {
    const neverMounted = () => {
      throw new Error("the mount is never reached");
    };

    await expect(main([], hostFor(neverMounted))).rejects.toThrow(
      new Exited(1),
    );
    await expect(
      main(
        [
          mountpoint,
          "--api-url=",
          "--cfc-mode=disabled",
          `--supervisor-status=${dir}/missing/status.json`,
        ],
        hostFor(neverMounted),
      ),
    ).rejects.toThrow(new Exited(1));
  });
});
