import { expect } from "@std/expect";
import { join } from "@std/path";
import { stub } from "@std/testing/mock";

import { fuse, fuseDaemon, fuseSupervisor } from "../commands/fuse.ts";
import { withEnv } from "./utils.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`Deno.exit(${code})`);
  }
}

describe("fuse-commands", () => {
  let home: string;

  beforeEach(async () => {
    home = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "fuse-commands-home-" }),
    );
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true });
  });

  it("prints that there are no mounts for `fuse status` with no mount state", async () => {
    const logs: string[] = [];
    using _log = stub(console, "log", (...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    await withEnv("HOME", home, async () => {
      await fuse.parse(["status"]);
    });
    expect(logs).toEqual(["No active FUSE mounts."]);
  });

  it("prints that a directory nothing is mounted on is unmounted for `fuse unmount`", async () => {
    // Linux reads the mount table from `/proc/mounts`, which a sandboxed
    // runner may not let a process read; an empty table states the case on
    // every machine. macOS reads its table through `getfsstat`, where nothing
    // is mounted on a new temporary directory.
    const mountpoint = join(home, "never-mounted");
    await Deno.mkdir(mountpoint);
    const readTextFile = Deno.readTextFile;
    using _mounts = stub(
      Deno,
      "readTextFile",
      (path: string | URL, options?: Deno.ReadFileOptions) =>
        path === "/proc/mounts"
          ? Promise.resolve("")
          : readTextFile(path, options),
    );
    const logs: string[] = [];
    using _log = stub(console, "log", (...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    await withEnv("HOME", home, async () => {
      await fuse.parse(["unmount", mountpoint]);
    });
    expect(logs).toEqual([`Unmounted ${mountpoint}`]);
  });

  it("prints the daemon's usage and exits with status 1 for `fuse-daemon` with no mountpoint", async () => {
    const errors: string[] = [];
    using _error = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    using _exit = stub(Deno, "exit", (code?: number): never => {
      throw new ExitCalled(code);
    });
    const error = await fuseDaemon.parse([]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExitCalled);
    expect(error).toEqual(expect.objectContaining({ code: 1 }));
    expect(errors).toEqual([expect.stringContaining("Usage: mod.ts")]);
  });

  it("fails naming its own executable when that cannot be spawned for `fuse-supervisor`", async () => {
    // A compiled binary path that does not exist makes the spawn fail before
    // any process starts, and the failure names the path it tried.
    const execPath = join(home, "missing", "cf");
    using _execPath = stub(Deno, "execPath", () => execPath);
    await expect(fuseSupervisor.parse([join(home, "mnt")])).rejects.toThrow(
      execPath,
    );
  });
});
