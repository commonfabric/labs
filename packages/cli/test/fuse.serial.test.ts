import { expect } from "@std/expect";
import { basename, join, resolve, toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { writeFailedSupervisorStartupStatus } from "../../fuse/mod.ts";
import {
  awaitBackgroundMountStartup,
  awaitForegroundMountExit,
  buildMountStatusRows,
  childStatusPathForStatePath,
  defaultSystemUnmount,
  formatMountStatusTable,
  fuse,
  isFuseProcessCommand,
  mountStatusHeader,
  runUnmount,
} from "../commands/fuse.ts";
import {
  parseSupervisorArgs,
  supervisorHelp,
} from "../lib/fuse-mount-flags.ts";
import {
  buildFuseChildCommand,
  cleanupFuseChild,
  recordFuseMountState,
  runFuseSupervisor,
} from "../lib/fuse-supervisor.ts";
import {
  buildBackgroundSupervisorDenoArgs,
  buildFuseBinaryArgs,
  buildFuseChildDenoArgs,
  ensureExecShim,
  F_MNTONNAME_OFF,
  findMountForPath,
  isAlive,
  isMountpointInTable,
  isMountStateAlive,
  mountpointHash,
  type MountStateEntry,
  type MountTableState,
  parseStatfsMountpoints,
  readAllMountStates,
  readDarwinMountpoints,
  readMountState,
  STATFS_SIZE,
  writeMountState,
} from "../lib/fuse.ts";
import { withEnv } from "./utils.ts";

const CHILD_PID = 321;

function mountStateFixture(
  overrides: Partial<MountStateEntry> = {},
): MountStateEntry {
  return {
    pid: Deno.pid,
    childPid: CHILD_PID,
    mountpoint: "/tmp/test-mount",
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    startedAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

/** One readiness report, in the form the FUSE child writes to its stdout. */
function readinessLine(
  state: string,
  extra: Record<string, unknown> = {},
): string {
  return `${
    JSON.stringify({
      state,
      pid: CHILD_PID,
      mountpoint: "/tmp/test-mount",
      updatedAt: "2026-03-17T00:00:00.000Z",
      ...extra,
    })
  }\n`;
}

/** A channel whose writers all exit once the given chunks are through. */
function readinessStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A channel a live mount keeps open after reporting. */
function openReadinessStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** An open channel the test pushes readiness lines into on its own schedule. */
function controllableReadinessStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (line: string) => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (line: string) => controller.enqueue(encoder.encode(line)),
  };
}

/** A supervisor that stays up: its exit never settles. */
function liveSupervisor(): Promise<Deno.CommandStatus> {
  return new Promise<Deno.CommandStatus>(() => {});
}

function trackRemoval(removed: string[]): (path: string) => Promise<void> {
  return async (path: string) => {
    removed.push(path);
    await Deno.remove(path).catch(() => undefined);
  };
}

describe("mountpointHash", () => {
  it("returns a 16-char hex string", async () => {
    const hash = await mountpointHash("/tmp/cf-fuse");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", async () => {
    const a = await mountpointHash("/tmp/cf-fuse");
    const b = await mountpointHash("/tmp/cf-fuse");
    expect(a).toBe(b);
  });

  it("differs for different paths", async () => {
    const a = await mountpointHash("/tmp/cf-fuse-a");
    const b = await mountpointHash("/tmp/cf-fuse-b");
    expect(a).not.toBe(b);
  });
});

describe("mount state operations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-fuse-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("writeMountState creates file and readMountState reads it back", async () => {
    const entry = {
      pid: 12345,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "./fixtures/test-key.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    };

    const path = await writeMountState(tmpDir, entry);
    expect(path).toContain(tmpDir);
    expect(path).toMatch(/\.json$/);

    const result = await readMountState(tmpDir, "/tmp/test-mount");
    expect(result).not.toBeNull();
    expect(result!.entry).toEqual({
      ...entry,
      identity: resolve(entry.identity),
    });
    expect(result!.path).toBe(path);
  });

  it("readMountState returns null for missing mountpoint", async () => {
    const result = await readMountState(tmpDir, "/nonexistent/path");
    expect(result).toBeNull();
  });

  it("readMountState returns null when state dir does not exist", async () => {
    const result = await readMountState(
      join(tmpDir, "nonexistent"),
      "/tmp/test",
    );
    expect(result).toBeNull();
  });

  it("readAllMountStates returns all entries", async () => {
    await writeMountState(tmpDir, {
      pid: 111,
      mountpoint: "/tmp/mount-a",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id-a.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: 222,
      mountpoint: "/tmp/mount-b",
      apiUrl: "http://localhost:9000",
      identity: "/tmp/id-b.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(2);

    const pids = all.map((r) => r.entry.pid).sort();
    expect(pids).toEqual([111, 222]);
  });

  it("readAllMountStates returns empty for nonexistent dir", async () => {
    const all = await readAllMountStates(join(tmpDir, "nope"));
    expect(all).toEqual([]);
  });

  it("readAllMountStates skips corrupt JSON files", async () => {
    // Write a valid entry
    await writeMountState(tmpDir, {
      pid: 333,
      mountpoint: "/tmp/mount-ok",
      apiUrl: "",
      identity: "/tmp/id-ok.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    // Write a corrupt file
    await Deno.writeTextFile(join(tmpDir, "corrupt.json"), "not json{{{");

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
    expect(all[0].entry.pid).toBe(333);
  });

  it("readAllMountStates ignores non-json files", async () => {
    await writeMountState(tmpDir, {
      pid: 444,
      mountpoint: "/tmp/mount-x",
      apiUrl: "",
      identity: "/tmp/id-x.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await Deno.writeTextFile(join(tmpDir, "readme.txt"), "ignore me");

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
  });

  it("writeMountState overwrites existing entry for same mountpoint", async () => {
    const mp = "/tmp/same-mount";
    await writeMountState(tmpDir, {
      pid: 100,
      mountpoint: mp,
      apiUrl: "",
      identity: "/tmp/original.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: 200,
      mountpoint: mp,
      apiUrl: "http://new",
      identity: "./relative.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const result = await readMountState(tmpDir, mp);
    expect(result!.entry.pid).toBe(200);
    expect(result!.entry.apiUrl).toBe("http://new");
    expect(result!.entry.identity).toBe(resolve("./relative.pem"));

    // Only one file should exist for this mountpoint
    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
  });

  it("findMountForPath prefers the longest matching mountpoint", async () => {
    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/cf-fuse",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/base.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/cf-fuse/nested",
      apiUrl: "http://localhost:9000",
      identity: "/tmp/nested.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const match = await findMountForPath(
      "/tmp/cf-fuse/nested/space/pieces/example/result/add.handler",
      tmpDir,
    );

    expect(match).not.toBeNull();
    expect(match!.entry.mountpoint).toBe("/tmp/cf-fuse/nested");
    expect(match!.entry.apiUrl).toBe("http://localhost:9000");
  });

  it("findMountForPath ignores stale entries and removes them", async () => {
    const stalePath = await writeMountState(tmpDir, {
      pid: 1073741824,
      mountpoint: "/tmp/cf-fuse",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/stale.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    const match = await findMountForPath(
      "/tmp/cf-fuse/space/pieces/example/result/add.handler",
      tmpDir,
    );

    expect(match).toBeNull();
    await expect(Deno.stat(stalePath)).rejects.toThrow();
  });

  it("findMountForPath matches symlinked aliases for the same mountpoint", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: realMount,
      apiUrl: "http://localhost:8000",
      identity: "/tmp/base.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    const match = await findMountForPath(
      join(aliasRoot, "mount/space/pieces/example/result/add.handler"),
      tmpDir,
    );

    expect(match).not.toBeNull();
    expect(match!.entry.mountpoint).toBe(realMount);
  });

  it("readMountState still finds legacy state files after canonical hashing changes", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    const aliasMount = join(aliasRoot, "mount");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    const legacyKey = new TextEncoder().encode(resolve(aliasMount));
    const legacyHash = await crypto.subtle.digest("SHA-256", legacyKey);
    const legacyPath = join(
      tmpDir,
      `${
        Array.from(new Uint8Array(legacyHash)).map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("").slice(0, 16)
      }.json`,
    );
    await Deno.writeTextFile(
      legacyPath,
      JSON.stringify({
        pid: Deno.pid,
        mountpoint: aliasMount,
        apiUrl: "http://localhost:8000",
        identity: "/tmp/base.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const result = await readMountState(tmpDir, aliasMount);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(legacyPath);
    expect(result!.entry.mountpoint).toBe(resolve(aliasMount));
  });

  it("readMountState prefers a live compatible state entry over a stale canonical one", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    const aliasMount = join(aliasRoot, "mount");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    const canonicalPath = join(
      tmpDir,
      `${await mountpointHash(aliasMount)}.json`,
    );
    await Deno.writeTextFile(
      canonicalPath,
      JSON.stringify({
        pid: 1073741824,
        mountpoint: realMount,
        apiUrl: "http://localhost:8001",
        identity: "/tmp/stale.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const legacyKey = new TextEncoder().encode(resolve(aliasMount));
    const legacyHash = await crypto.subtle.digest("SHA-256", legacyKey);
    const legacyPath = join(
      tmpDir,
      `${
        Array.from(new Uint8Array(legacyHash)).map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("").slice(0, 16)
      }.json`,
    );
    await Deno.writeTextFile(
      legacyPath,
      JSON.stringify({
        pid: Deno.pid,
        mountpoint: aliasMount,
        apiUrl: "http://localhost:8000",
        identity: "/tmp/live.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const result = await readMountState(tmpDir, aliasMount);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(legacyPath);
    expect(result!.entry.pid).toBe(Deno.pid);
    expect(result!.entry.apiUrl).toBe("http://localhost:8000");
  });

  it("ensureExecShim creates a repo-rooted shim that targets packages/cli/mod.ts", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "repo");
    const importMetaUrl = toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
      .href;
    let shimPath = "";
    let shim = "";

    shimPath = await ensureExecShim(stateDir, importMetaUrl);
    shim = await Deno.readTextFile(shimPath);

    expect(shimPath).toBe(join(repoRoot, ".cf", "fuse", "cf-exec"));
    expect(shimPath).not.toBe(join(stateDir, "cf-exec"));
    expect(shim).toContain("#!/usr/bin/env bash");
    expect(shim).toContain("export CF_EXEC_SHEBANG=1");
    expect(shim).toContain("export CF_CLI_NAME=cf");
    expect(shim).toContain('" run --allow-net');
    expect(shim).toContain(join(repoRoot, "packages/cli/mod.ts"));
    expect(shim).toContain('"$@"');
  });

  it("normalizes invalid CF_CLI_NAME values before writing the exec shim", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "repo");
    const importMetaUrl = toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
      .href;
    let shim = "";

    await withEnv("CF_CLI_NAME", '$(touch "/tmp/pwned")', async () => {
      const shimPath = await ensureExecShim(stateDir, importMetaUrl);
      shim = await Deno.readTextFile(shimPath);
    });

    expect(shim).toContain("export CF_CLI_NAME=cf");
    expect(shim).not.toContain("touch");
    expect(shim).not.toContain("$(");
    expect(shim).not.toContain("`");
  });

  it("ensureExecShim falls back to stateDir when repo root is not writable", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "readonly-repo");
    await Deno.mkdir(join(repoRoot, "packages/cli/lib"), { recursive: true });
    await Deno.chmod(repoRoot, 0o555);

    try {
      const importMetaUrl =
        toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
          .href;
      const shimPath = await ensureExecShim(stateDir, importMetaUrl);
      const shim = await Deno.readTextFile(shimPath);

      expect(shimPath.startsWith(join(stateDir, "cf-exec-"))).toBe(true);
      expect(shimPath).not.toBe(join(stateDir, "cf-exec"));
      expect(basename(shimPath)).toMatch(/^cf-exec-[0-9a-f]{16}$/);
      expect(shim).toContain("#!/usr/bin/env bash");
      expect(shim).toContain("export CF_EXEC_SHEBANG=1");
      expect(shim).toContain(join(repoRoot, "packages/cli/mod.ts"));
    } finally {
      await Deno.chmod(repoRoot, 0o755);
    }
  });

  it("always removes foreground mount state files before exiting", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    await expect(
      awaitForegroundMountExit(
        {
          status: Promise.resolve({
            success: false,
            code: 23,
            signal: "SIGTERM",
          }),
        },
        statePath,
        (code: number) => {
          throw new Error(`exit:${code}`);
        },
      ),
    ).rejects.toThrow(/exit:23/);

    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("returns once the child reports mounted and both processes are alive", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const alive: number[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([readinessLine("mounted")]),
        isAlive: (pid) => {
          alive.push(pid);
          return true;
        },
      }),
    ).resolves.toBeUndefined();

    // Both the supervisor and the FUSE child are confirmed, in that order.
    expect(alive).toEqual([CHILD_PID, Deno.pid]);
    await expect(Deno.stat(statePath)).resolves.toBeDefined();
  });

  it("returns while the mount still holds the readiness channel open", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());

    // A live mount never closes the channel, so the wait has to settle on the
    // readiness line rather than on end of stream.
    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: openReadinessStream([readinessLine("mounted")]),
        isAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("puts no deadline on readiness, however much time passes", async () => {
    // Nothing about the readiness wait is time-based, so no count of events can
    // show the absence of a deadline. A wall clock can: an hour of virtual time
    // passes with the child still starting, and the wait must survive it and
    // then settle on the report that finally arrives. A reintroduced deadline
    // would fire during the tick and fail this test.
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const channel = controllableReadinessStream();
    const time = new FakeTime();

    try {
      const startup = awaitBackgroundMountStartup(Deno.pid, statePath, {
        readiness: channel.stream,
        supervisorExit: liveSupervisor(),
        isAlive: () => true,
      });
      let ended = false;
      startup.then(() => ended = true, () => ended = true);

      await time.tickAsync(60 * 60 * 1000);
      expect(ended).toBe(false);

      channel.push(readinessLine("mounted"));
      await expect(startup).resolves.toBeUndefined();
    } finally {
      time.restore();
    }
  });

  it("reads past a starting report to the mounted report", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([
          readinessLine("starting"),
          readinessLine("mounted"),
        ]),
        isAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("reassembles a readiness report split across reads", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const line = readinessLine("mounted");

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([
          line.slice(0, 12),
          line.slice(12, 30),
          line.slice(30),
        ]),
        isAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("reassembles a report whose multi-byte characters are split across reads", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    // A mountpoint name can be non-ASCII, and a pipe splits writes wherever it
    // likes, including through a character.
    const line = `${
      JSON.stringify({
        state: "mounted",
        pid: CHILD_PID,
        mountpoint: "/tmp/montaña-café-\u{1F600}",
      })
    }\n`;
    const bytes = new TextEncoder().encode(line);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      chunks.push(bytes.slice(i, i + 3));
    }

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        isAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores unparseable output and settles on the report that follows", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream(["{not-json\n", readinessLine("mounted")]),
        isAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects background mounts whose channel ends without a report", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const childStatusPath = childStatusPathForStatePath(statePath);
    await Deno.writeTextFile(childStatusPath, readinessLine("starting"));
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([]),
        childStatusPath,
        isAlive: () => true,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/Background FUSE process exited during startup/i);

    expect(removed).toEqual([statePath, childStatusPath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
    await expect(Deno.stat(childStatusPath)).rejects.toThrow();
  });

  it("rejects background mounts when the supervisor exits before any report", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const removed: string[] = [];

    // An orphaned FUSE child inherits the write end and holds the channel open,
    // so end of stream never comes and the supervisor's exit is the only signal
    // that no report is coming.
    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        readiness: openReadinessStream([]),
        supervisorExit: Promise.resolve(
          { success: false, code: 1, signal: null } as Deno.CommandStatus,
        ),
        isAlive: () => true,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/Background FUSE process exited during startup/i);

    expect(removed).toEqual([statePath]);
  });

  it("rejects background mounts when the child reports startup failure", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const childStatusPath = childStatusPathForStatePath(statePath);
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([
          readinessLine("failed", { error: "fuse_session_mount failed" }),
        ]),
        childStatusPath,
        isAlive: () => true,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/fuse_session_mount failed/);

    expect(removed).toEqual([statePath, childStatusPath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("rejects background mounts when the child reports exiting during startup", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([readinessLine("exiting")]),
        isAlive: () => true,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/child reported exiting/i);

    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("rejects background mounts when the child dies after reporting mounted", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const childStatusPath = childStatusPathForStatePath(statePath);
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([readinessLine("mounted")]),
        childStatusPath,
        isAlive: (pid) => pid !== CHILD_PID,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/child exited after reporting mounted/i);

    expect(removed).toEqual([statePath, childStatusPath]);
  });

  it("rejects background mounts when the supervisor dies after the child reports mounted", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([readinessLine("mounted")]),
        isAlive: (pid) => pid !== Deno.pid,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/Background FUSE process exited during startup/i);

    expect(removed).toEqual([statePath]);
  });

  it("rejects a mounted report that carries no child pid", async () => {
    const statePath = await writeMountState(tmpDir, mountStateFixture());
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(Deno.pid, statePath, {
        supervisorExit: liveSupervisor(),
        readiness: readinessStream([
          `${JSON.stringify({ state: "mounted" })}\n`,
        ]),
        isAlive: () => true,
        removeStateFile: trackRemoval(removed),
      }),
    ).rejects.toThrow(/child exited after reporting mounted/i);

    expect(removed).toEqual([statePath]);
  });

  it("does not read child status sidecars as mount state entries", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
      childStatusPath: "",
    });
    await Deno.writeTextFile(
      childStatusPathForStatePath(statePath),
      JSON.stringify({
        state: "mounted",
        pid: 321,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:00.000Z",
      }),
    );
    await Deno.writeTextFile(
      `${statePath}.child-status.json`,
      JSON.stringify({
        state: "mounted",
        pid: 321,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:00.000Z",
      }),
    );

    const states = await readAllMountStates(tmpDir);

    expect(states.map(({ path }) => path)).toEqual([statePath]);
  });

  it("formats active supervisor and child status rows", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
      logFile: "/tmp/cf-fuse-test-mount.log",
      childStatusPath: join(tmpDir, "child-status"),
    });
    await Deno.writeTextFile(
      join(tmpDir, "child-status"),
      JSON.stringify({
        state: "mounted",
        pid: 456,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:01.000Z",
      }),
    );

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => true,
      isMountpointInTable: () => Promise.resolve("present"),
    });

    expect(formatMountStatusTable(rows)).toBe([
      mountStatusHeader,
      [
        "/tmp/test-mount",
        "123",
        "456",
        "mounted",
        "2026-03-17T00:00:00.000Z",
        "/tmp/cf-fuse-test-mount.log",
      ].join("\t"),
    ].join("\n"));
    expect(rows).toHaveLength(1);
    expect((await Deno.stat(statePath)).isFile).toBe(true);
  });

  it("sweeps a dead-PID entry only when the mount is also absent", async () => {
    // The one truly-stale case: no process AND no kernel mount. Only here is it
    // safe to remove the state file and show nothing.
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const removed: string[] = [];

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => false,
      isMountpointInTable: () => Promise.resolve("absent"),
      removeMountStateFile: async (path) => {
        removed.push(path);
        await Deno.remove(path);
      },
    });

    expect(rows).toEqual([]);
    expect(formatMountStatusTable(rows)).toBe("No active FUSE mounts.");
    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("shows a dead-PID mount still present in the table as dead and keeps it", async () => {
    // The whole point of the trio: a severed mount whose daemon already died.
    // The table is consulted BEFORE the PID, so this surfaces one row (not the
    // old "No active FUSE mounts.") and the state file is NOT swept.
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const removed: string[] = [];

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => false,
      isMountpointInTable: () => Promise.resolve("present"),
      removeMountStateFile: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("/tmp/test-mount");
    expect(rows[0][3]).toBe("dead");
    expect(removed).toEqual([]);
    expect((await Deno.stat(statePath)).isFile).toBe(true);
  });

  it("shows a dead-PID mount with an unknown table probe as unknown and keeps it", async () => {
    // An unreadable table is never treated as proof the mount is gone. Even a
    // dead PID must not destroy the evidence: show the row, keep the file.
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const removed: string[] = [];

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => false,
      isMountpointInTable: () => Promise.resolve("unknown"),
      removeMountStateFile: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("unknown");
    expect(removed).toEqual([]);
    expect((await Deno.stat(statePath)).isFile).toBe(true);
  });

  it("reports a live mount whose entry is in the mount table as mounted", async () => {
    await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => true,
      isMountpointInTable: () => Promise.resolve("present"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("running");
  });

  it("reports an alive-PID mount absent from the table as dead", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const removed: string[] = [];

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => true,
      isMountpointInTable: () => Promise.resolve("absent"),
      removeMountStateFile: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("dead");
    // A dead mount is surfaced, not swept: the state file must remain.
    expect(removed).toEqual([]);
    expect((await Deno.stat(statePath)).isFile).toBe(true);
  });

  it("reports an alive-PID mount with an unknown table probe as unknown", async () => {
    await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => true,
      isMountpointInTable: () => Promise.resolve("unknown"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("unknown");
  });
});

describe("fuse help", () => {
  it("mentions executable .handler files and .tool entries", () => {
    const help = fuse.getHelp();
    expect(help).toContain("executable");
    expect(help).toContain("*.handler");
    expect(help).toContain("*.tool");
  });
});

describe("isAlive", () => {
  it("returns true for the current process", () => {
    expect(isAlive(Deno.pid)).toBe(true);
  });

  it("returns false for a bogus PID", () => {
    // PID 2^30 is extremely unlikely to exist
    expect(isAlive(1073741824)).toBe(false);
  });
});

describe("buildFuseChildDenoArgs", () => {
  it("builds minimal args", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/path/to/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).toEqual([
      "run",
      "--unstable-ffi",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "/path/to/mod.ts",
      "/mnt",
    ]);
  });

  it("includes api-url and identity when provided", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "./key.pem",
      execCli: "/tmp/cf-exec",
    });
    expect(args).toContain("--api-url");
    expect(args).toContain("http://localhost:8000");
    expect(args).toContain("--identity");
    expect(args).toContain("./key.pem");
    expect(args).toContain("--exec-cli");
    expect(args).toContain("/tmp/cf-exec");
  });

  it("omits api-url, identity, and exec-cli when empty", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).not.toContain("--api-url");
    expect(args).not.toContain("--identity");
    expect(args).not.toContain("--exec-cli");
  });

  it("passes CFC mount options through to the daemon", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      allowOther: true,
      cfcMode: "enforce-explicit",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cf-writeback.json",
      dangerouslyAllowIncompatibleSchema: true,
    });
    expect(args).toContain("--allow-other");
    expect(args).toContain("--cfc-mode");
    expect(args).toContain("enforce-explicit");
    expect(args).toContain("--cfc-annotations");
    expect(args).toContain("--cfc-xattr-namespace");
    expect(args).toContain("both");
    expect(args).toContain("--cfc-writeback-xattrs");
    expect(args).toContain("--cfc-writeback-state");
    expect(args).toContain("/tmp/cf-writeback.json");
    expect(args).toContain("--dangerously-allow-incompatible-schema");
  });

  it("passes noattrcache through to the daemon", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      noattrcache: true,
    });
    expect(args).toContain("--noattrcache");
    expect(args).not.toContain("--attrcache-timeout");
  });

  it("passes attrcache-timeout through to the daemon", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "2",
    });
    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("2");
    expect(args).not.toContain("--noattrcache");
  });

  it("forwards an attrcache-timeout of zero to the daemon", () => {
    // "0" selects untuned caching in the daemon and must survive every
    // forwarding layer even though the layers test the field for truthiness.
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "0",
    });
    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("0");

    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "0",
    });
    const supIndex = supervisorArgs.indexOf("--attrcache-timeout");
    expect(supIndex).toBeGreaterThan(-1);
    expect(supervisorArgs[supIndex + 1]).toBe("0");

    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      execPath: "/usr/local/bin/cf",
      attrcacheTimeout: "0",
    });
    const childIndex = child.args.indexOf("--attrcache-timeout");
    expect(childIndex).toBeGreaterThan(-1);
    expect(child.args[childIndex + 1]).toBe("0");
  });

  it("omits NFS cache mount options when unset", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).not.toContain("--noattrcache");
    expect(args).not.toContain("--attrcache-timeout");
  });
});

describe("FUSE supervisor command construction", () => {
  it("writes failed supervisor status for daemon startup failures", async () => {
    const writes: Array<{ state: string; extra?: Record<string, unknown> }> =
      [];

    await writeFailedSupervisorStartupStatus(
      new Error("connectSpace failed"),
      (state, extra) => {
        writes.push({ state, extra });
        return Promise.resolve();
      },
    );

    expect(writes).toEqual([{
      state: "failed",
      extra: { error: "Error: connectSpace failed" },
    }]);

    await expect(writeFailedSupervisorStartupStatus(
      new Error("status path unavailable"),
      () => Promise.reject(new Error("write failed")),
    )).resolves.toBeUndefined();
  });

  it("builds a background supervisor invocation that does not load libfuse", () => {
    const args = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home", "work"],
      statePath: "/tmp/cf-state.json",
      supervisorStatusPath: "/tmp/cf-state.json.child-status",
      allowOther: true,
      noattrcache: true,
      cfcMode: "observe",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cfc.json",
      dangerouslyAllowIncompatibleSchema: true,
    });

    expect(args.slice(0, 2)).toEqual(["run", "--allow-run"]);
    expect(args).not.toContain("--allow-read");
    expect(args).not.toContain("--allow-write");
    // The supervisor writes the mount state and reads nothing, so it is granted
    // write access to that one file and no read access at all.
    expect(args).toContain("--allow-write=/tmp/cf-state.json");
    expect(args.some((arg) => arg.startsWith("--allow-read"))).toBe(false);
    expect(args).not.toContain("--allow-env");
    expect(args).not.toContain("--allow-net");
    expect(args).not.toContain("--unstable-ffi");
    expect(args).not.toContain("--allow-ffi");
    expect(args).toContain("/repo/packages/cli/lib/fuse-supervisor.ts");
    expect(args).not.toContain("fuse-supervisor");
    expect(args).not.toContain("/repo/packages/fuse/mod.ts");
    expect(args).not.toContain("fuse-daemon");
    expect(args).toContain("--log-file");
    expect(args).toContain("/tmp/cf-fuse-mnt.log");
    expect(args).toContain("--state-path");
    expect(args).toContain("/tmp/cf-state.json");
    expect(args).toContain("--supervisor-status");
    expect(args).toContain("/tmp/cf-state.json.child-status");
    expect(args).toContain("--noattrcache");
    expect(args).toContain("--dangerously-allow-incompatible-schema");
    expect(args.filter((arg) => arg === "--space").length).toBe(2);
  });

  it("builds a distinct FUSE child invocation that owns libfuse", () => {
    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: [],
      supervisorStatusPath: "/tmp/cf-status.json",
    });
    const childArgs = buildFuseChildDenoArgs({
      modPath: "/repo/packages/fuse/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: [],
      supervisorStatusPath: "/tmp/cf-status.json",
    });

    expect(childArgs).not.toEqual(supervisorArgs);
    expect(childArgs).toContain("--unstable-ffi");
    expect(childArgs).toContain("--allow-ffi");
    expect(childArgs).toContain("/repo/packages/fuse/mod.ts");
    expect(childArgs).toContain("--supervisor-status");
    expect(childArgs).toContain("/tmp/cf-status.json");
    expect(childArgs).not.toContain(
      "/repo/packages/cli/lib/fuse-supervisor.ts",
    );
    expect(childArgs).not.toContain("fuse-supervisor");
  });

  it("represents the supervisor-spawned FUSE child as a distinct command", () => {
    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home"],
      importMetaUrl: toFileUrl("/repo/packages/cli/lib/fuse-supervisor.ts")
        .href,
      execPath: "/usr/bin/deno",
    });

    expect(child.command).toBe("/usr/bin/deno");
    expect(child.args).toContain("--allow-ffi");
    expect(child.args).toContain("/repo/packages/fuse/mod.ts");
    expect(child.args).not.toContain("fuse-supervisor");
    expect(child.args).not.toContain("/repo/packages/cli/mod.ts");
  });

  it("represents the compiled supervisor-spawned FUSE child as a direct subcommand", () => {
    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home"],
      execPath: "/usr/local/bin/cf",
      supervisorStatusPath: "/tmp/cf-status",
      attrcacheTimeout: "2",
      dangerouslyAllowIncompatibleSchema: true,
    });

    expect(child.command).toBe("/usr/local/bin/cf");
    expect(child.args).toContain("fuse-daemon");
    expect(child.args).toContain("--supervisor-status");
    expect(child.args).toContain("/tmp/cf-status");
    const flagIndex = child.args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(child.args[flagIndex + 1]).toBe("2");
    expect(child.args).toContain("--dangerously-allow-incompatible-schema");
  });

  it("terminates the spawned FUSE child during supervisor cleanup", async () => {
    const signals: Deno.Signal[] = [];

    await cleanupFuseChild({
      killed: false,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
      },
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does not terminate the spawned FUSE child after it has already exited", async () => {
    const signals: Deno.Signal[] = [];

    await cleanupFuseChild({
      killed: true,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
      },
    });

    expect(signals).toEqual([]);
  });

  it("waits for the spawned FUSE child during supervisor cleanup", async () => {
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;
    const status = new Promise<Deno.CommandStatus>((resolve) => {
      resolveStatus = resolve;
    });

    await cleanupFuseChild({
      killed: false,
      status,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
        resolveStatus({ success: true, code: 0, signal: null });
      },
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates if the spawned FUSE child ignores graceful cleanup", async () => {
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;
    const status = new Promise<Deno.CommandStatus>((resolve) => {
      resolveStatus = resolve;
    });

    await cleanupFuseChild({
      killed: false,
      status,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          resolveStatus({ success: false, code: 137, signal: "SIGKILL" });
        }
      },
    }, {
      timeoutMs: 0,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("recognizes Deno and compiled FUSE supervisor process commands", () => {
    expect(
      isFuseProcessCommand("deno run packages/cli/lib/fuse-supervisor.ts /mnt"),
    )
      .toBe(true);
    expect(isFuseProcessCommand("/usr/local/bin/cf fuse-supervisor /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("/usr/local/bin/cf fuse-daemon /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("deno run packages/fuse/mod.ts /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("deno run unrelated.ts fuse"))
      .toBe(false);
  });

  it("treats a live FUSE child PID as active mount state", () => {
    expect(isMountStateAlive({
      pid: 1073741824,
      childPid: Deno.pid,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    })).toBe(true);
  });

  it("writes the whole mount state without a pre-existing file", async () => {
    const dir = await Deno.makeTempDir({ prefix: "cf-fuse-state-" });
    const statePath = join(dir, "mount.json");
    try {
      // The mount command no longer writes this file, so the supervisor must
      // not depend on anything already being there.
      await recordFuseMountState({
        mountpoint: "/tmp/test-mount",
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        execCli: "",
        logFile: "/tmp/cf-fuse-test.log",
        spaces: [],
        statePath,
        supervisorStatusPath: "/tmp/cf-fuse-test.child-status",
        supervisorPid: 200,
      }, 300);

      const state = JSON.parse(await Deno.readTextFile(statePath));
      expect(state).toMatchObject({
        pid: 200,
        childPid: 300,
        mountpoint: "/tmp/test-mount",
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        logFile: "/tmp/cf-fuse-test.log",
        childStatusPath: "/tmp/cf-fuse-test.child-status",
      });
      expect(typeof state.startedAt).toBe("string");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  });

  it("fails supervisor startup when the mount state cannot be written", async () => {
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;

    class FakeCommand {
      constructor(_command: string | URL, _options: Deno.CommandOptions) {}

      spawn() {
        return {
          pid: 300,
          status: new Promise<Deno.CommandStatus>((resolve) => {
            resolveStatus = resolve;
          }),
          kill: (signal: Deno.Signal) => {
            signals.push(signal);
            resolveStatus({ success: true, code: 143, signal });
          },
        };
      }
    }

    await expect(runFuseSupervisor({
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      statePath: "/tmp/cf-fuse-unwritable-state.json",
      supervisorPid: 200,
      command: FakeCommand,
      writeMountStateFile: () => Promise.reject(new Error("disk full")),
      addSignalListener: () => undefined,
      removeSignalListener: () => undefined,
    })).rejects.toThrow(/Unable to record FUSE mount state: .*disk full/);

    // The child must not outlive a supervisor that cannot record it.
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("hands the child this process's stdout so readiness reaches the mount command", async () => {
    let childOptions: Deno.CommandOptions | undefined;

    class FakeCommand {
      constructor(_command: string | URL, options: Deno.CommandOptions) {
        childOptions = options;
      }

      spawn() {
        return {
          pid: 300,
          status: Promise.resolve({ success: true, code: 0, signal: null }),
          kill: () => undefined,
        };
      }
    }

    await expect(runFuseSupervisor({
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      supervisorPid: 200,
      command: FakeCommand,
      addSignalListener: () => undefined,
      removeSignalListener: () => undefined,
      exit: () => undefined,
    })).resolves.toBeUndefined();

    // The FUSE child writes its readiness to the descriptor it inherits here.
    // Any other setting drops that report on the floor, and the mount command,
    // which waits on it with no deadline, waits for as long as the mount is up.
    expect(childOptions?.stdout).toBe("inherit");
  });

  it("installs supervisor signal handlers before recording mount state", async () => {
    const addedSignals: Deno.Signal[] = [];
    let handlersInstalledBeforeRecord = false;

    class FakeCommand {
      constructor(_command: string | URL, _options: Deno.CommandOptions) {}

      spawn() {
        return {
          pid: 300,
          status: Promise.resolve({ success: true, code: 0, signal: null }),
          kill: () => undefined,
        };
      }
    }

    await expect(runFuseSupervisor({
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      statePath: "/tmp/cf-fuse-signal-order-state.json",
      supervisorPid: 200,
      command: FakeCommand,
      writeMountStateFile: () => {
        handlersInstalledBeforeRecord = addedSignals.includes("SIGTERM") &&
          addedSignals.includes("SIGINT");
        return Promise.resolve();
      },
      addSignalListener: (signal) => {
        addedSignals.push(signal);
      },
      removeSignalListener: () => undefined,
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
    })).rejects.toThrow(/exit:0/);

    expect(handlersInstalledBeforeRecord).toBe(true);
  });
});

describe("buildFuseBinaryArgs", () => {
  const base = {
    mountpoint: "/mnt",
    apiUrl: "http://localhost:8000",
    identity: "/tmp/id.key",
    execCli: "/tmp/cf-exec",
  };

  it("builds a compiled-binary daemon invocation", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      spaces: ["home", "work"],
    });

    expect(args.slice(0, 2)).toEqual(["fuse-daemon", "/mnt"]);
    expect(args).not.toContain("run");
    expect(args).not.toContain("--allow-ffi");
    expect(args).not.toContain("fuse-supervisor");
    const apiIndex = args.indexOf("--api-url");
    expect(args[apiIndex + 1]).toBe("http://localhost:8000");
    const identityIndex = args.indexOf("--identity");
    expect(args[identityIndex + 1]).toBe("/tmp/id.key");
    const execIndex = args.indexOf("--exec-cli");
    expect(args[execIndex + 1]).toBe("/tmp/cf-exec");
    expect(args.filter((arg) => arg === "--space").length).toBe(2);
  });

  it("builds a compiled-binary supervisor invocation with its lifecycle paths", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-supervisor",
      ...base,
      logFile: "/tmp/cf-fuse.log",
      statePath: "/tmp/state.json",
      supervisorStatusPath: "/tmp/state.json.child-status",
    });

    expect(args.slice(0, 2)).toEqual(["fuse-supervisor", "/mnt"]);
    const logIndex = args.indexOf("--log-file");
    expect(args[logIndex + 1]).toBe("/tmp/cf-fuse.log");
    const stateIndex = args.indexOf("--state-path");
    expect(args[stateIndex + 1]).toBe("/tmp/state.json");
    const statusIndex = args.indexOf("--supervisor-status");
    expect(args[statusIndex + 1]).toBe("/tmp/state.json.child-status");
  });

  it("omits every optional flag that was not requested", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });

    expect(args).toEqual(["fuse-daemon", "/mnt"]);
  });

  it("forwards the mount and CFC flags", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      allowOther: true,
      noattrcache: true,
      cfcMode: "enforce-explicit",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cfc.json",
      dangerouslyAllowIncompatibleSchema: true,
    });

    expect(args).toContain("--allow-other");
    expect(args).toContain("--noattrcache");
    const modeIndex = args.indexOf("--cfc-mode");
    expect(args[modeIndex + 1]).toBe("enforce-explicit");
    expect(args).toContain("--cfc-annotations");
    const nsIndex = args.indexOf("--cfc-xattr-namespace");
    expect(args[nsIndex + 1]).toBe("both");
    expect(args).toContain("--cfc-writeback-xattrs");
    const stateIndex = args.indexOf("--cfc-writeback-state");
    expect(args[stateIndex + 1]).toBe("/tmp/cfc.json");
    expect(args).toContain("--dangerously-allow-incompatible-schema");
  });

  it("forwards an attrcache-timeout of zero", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      attrcacheTimeout: "0",
    });

    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("0");
    expect(args).not.toContain("--noattrcache");
  });
});

describe("parseSupervisorArgs", () => {
  it("parses the mountpoint and cache flags", () => {
    const { options, help } = parseSupervisorArgs([
      "/mnt",
      "--api-url",
      "http://localhost:8000",
      "--noattrcache",
      "--dangerously-allow-incompatible-schema",
      "--space",
      "home",
    ]);

    expect(help).toBe(false);
    expect(options.mountpoint).toBe("/mnt");
    expect(options.apiUrl).toBe("http://localhost:8000");
    expect(options.noattrcache).toBe(true);
    expect(options.dangerouslyAllowIncompatibleSchema).toBe(true);
    expect(options.attrcacheTimeout).toBeUndefined();
    expect(options.spaces).toEqual(["home"]);
  });

  it("parses an attrcache-timeout value, including zero", () => {
    expect(
      parseSupervisorArgs(["/mnt", "--attrcache-timeout", "2"]).options
        .attrcacheTimeout,
    ).toBe("2");
    expect(
      parseSupervisorArgs(["/mnt", "--attrcache-timeout", "0"]).options
        .attrcacheTimeout,
    ).toBe("0");
  });

  it("rejects an attrcache-timeout with no value", () => {
    expect(() => parseSupervisorArgs(["/mnt", "--attrcache-timeout"]))
      .toThrow("Missing value for --attrcache-timeout");
  });

  it("rejects unknown options", () => {
    expect(() => parseSupervisorArgs(["/mnt", "--nosuchflag"]))
      .toThrow("Unknown fuse supervisor option: --nosuchflag");
  });

  it("rejects an argv that names no mountpoint", () => {
    expect(() => parseSupervisorArgs(["--debug"]))
      .toThrow("Missing mountpoint for fuse supervisor.");
  });

  it("round-trips every flag both supervisor argv builders emit", () => {
    // The builders and this parser read one flag table, and this is the
    // property that table exists for: a flag the command sets survives the hop
    // into the supervisor whichever entrypoint runs it.
    const flags = {
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse.log",
      spaces: ["home", "work"],
      debug: true,
      allowOther: true,
      noattrcache: true,
      attrcacheTimeout: "0",
      cfcMode: "observe",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cfc.json",
      dangerouslyAllowIncompatibleSchema: true,
      statePath: "/tmp/state.json",
      supervisorStatusPath: "/tmp/state.json.child-status",
    };

    const cliModPath = "/repo/packages/cli/lib/fuse-supervisor.ts";
    const denoArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath,
      ...flags,
    });
    expect(
      parseSupervisorArgs(denoArgs.slice(denoArgs.indexOf(cliModPath) + 1))
        .options,
    ).toEqual(flags);

    const binaryArgs = buildFuseBinaryArgs({
      subcommand: "fuse-supervisor",
      ...flags,
    });
    expect(parseSupervisorArgs(binaryArgs.slice(1)).options).toEqual(flags);
  });

  it("reports help without requiring a mountpoint", () => {
    expect(parseSupervisorArgs(["--help"]).help).toBe(true);
    expect(supervisorHelp()).toContain("--attrcache-timeout <seconds>");
    expect(supervisorHelp()).toContain("--noattrcache");
    expect(supervisorHelp()).toContain(
      "--dangerously-allow-incompatible-schema",
    );
  });
});

describe("fuse mount option validation", () => {
  // The mount action validates before it resolves an identity, creates the
  // mountpoint, or spawns anything, so these never reach a real mount.
  const neverMounted = "/tmp/cf-fuse-never-mounted";

  it("rejects an attrcache-timeout below the supported range", async () => {
    await expect(
      fuse.parse(["mount", neverMounted, "--attrcache-timeout", "-1"]),
    ).rejects.toThrow("Invalid --attrcache-timeout value: -1");
    await expect(Deno.stat(neverMounted)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("rejects an attrcache-timeout above the supported range", async () => {
    await expect(
      fuse.parse(["mount", neverMounted, "--attrcache-timeout", "86401"]),
    ).rejects.toThrow("Invalid --attrcache-timeout value: 86401");
  });

  it("documents both cache flags in the mount help", () => {
    const help = fuse.getCommand("mount")!.getHelp();
    expect(help).toContain("--noattrcache");
    expect(help).toContain("--attrcache-timeout");
    expect(help).toContain("Conflicts");
    expect(help).toContain("--dangerously-allow-incompatible-schema");
  });
});

describe("isMountpointInTable", () => {
  it("reports present on darwin when getfsstat lists the mountpoint", async () => {
    const state = await isMountpointInTable("/mnt", {
      os: "darwin",
      listDarwinMountpoints: () => ["/", "/dev", "/mnt"],
    });
    expect(state).toBe("present");
  });

  it("reports absent on darwin when getfsstat omits the mountpoint", async () => {
    const state = await isMountpointInTable("/mnt", {
      os: "darwin",
      listDarwinMountpoints: () => ["/", "/dev"],
    });
    expect(state).toBe("absent");
  });

  it("reports unknown on darwin when getfsstat is unavailable (null)", async () => {
    // A null return means the FFI probe could not run. It must never be
    // downgraded to "absent" — an unreadable table is not proof the mount is
    // gone, and a false "absent" hides a real (possibly stale) mount.
    const state = await isMountpointInTable("/mnt", {
      os: "darwin",
      listDarwinMountpoints: () => null,
    });
    expect(state).toBe("unknown");
  });

  it("readDarwinMountpoints maps a native getfsstat error (-1) to null, not []", () => {
    // getfsstat returns -1 on failure. Mapping that to [] would read as
    // "absent" and hide a real mount — it must become null → "unknown". The
    // injected-null test above cannot reach this: it replaces the whole lister,
    // so it never exercises the native return-code mapping.
    expect(readDarwinMountpoints(() => -1)).toBe(null);
    // A zero count is a genuine (if unusual) empty table, not an error.
    expect(readDarwinMountpoints(() => 0)).toEqual([]);
  });

  it("readDarwinMountpoints maps a negative SECOND call (post-alloc) to null", () => {
    // The count call succeeds (1 record), but the fill call returns -1. This is
    // the distinct `if (n < 0) return null` branch after the buffer is
    // allocated — it must also collapse to null → "unknown", not [].
    let call = 0;
    const fn = () => (call++ === 0 ? 1 : -1);
    expect(readDarwinMountpoints(fn)).toBe(null);
  });

  it("readDarwinMountpoints maps a thrown native call to null", () => {
    // Any exception from the FFI path (e.g. a bad pointer) collapses to null →
    // "unknown", never an empty/partial list read as "absent".
    let call = 0;
    const fn = () => {
      if (call++ === 0) return 1;
      throw new Error("boom");
    };
    expect(readDarwinMountpoints(fn)).toBe(null);
  });

  if (Deno.build.os !== "darwin") {
    it("readDarwinMountpoints returns null when the getfsstat FFI is unavailable", () => {
      // With no injected call, openGetfsstat() tries to dlopen libSystem, which
      // only exists on darwin. On linux CI the dlopen throws → openGetfsstat
      // returns null → readDarwinMountpoints returns null (→ "unknown").
      expect(readDarwinMountpoints()).toBe(null);
    });
  }

  it("parseStatfsMountpoints reads f_mntonname from each packed statfs record", () => {
    // Hand-build a getfsstat-style buffer of two `struct statfs` records and
    // assert the pure parse loop extracts both NUL-terminated mountpoints. This
    // exercises the darwin FFI parse loop deterministically on any OS (linux CI
    // never runs the syscall that would fill the buffer).
    const enc = new TextEncoder();
    const buf = new Uint8Array(2 * STATFS_SIZE);
    const write = (record: number, path: string) => {
      const bytes = enc.encode(path);
      buf.set(bytes, record * STATFS_SIZE + F_MNTONNAME_OFF);
      // Leave the following byte as its zero-initialized value: the NUL that
      // terminates f_mntonname.
    };
    write(0, "/tmp/mnt-a");
    write(1, "/tmp/mnt-b");
    expect(parseStatfsMountpoints(buf, 2)).toEqual([
      "/tmp/mnt-a",
      "/tmp/mnt-b",
    ]);
  });

  it("parseStatfsMountpoints clamps a NUL-less f_mntonname to its fixed length", () => {
    // f_mntonname is a fixed 1024-byte field; a (corrupt) record with no NUL in
    // it must be clamped to the field length rather than read past into the next
    // record. Fill the whole field of a single record with 'a' (no terminator).
    const F_MNTONNAME_LEN = 1024;
    const buf = new Uint8Array(STATFS_SIZE);
    buf.fill(0x61, F_MNTONNAME_OFF, F_MNTONNAME_OFF + F_MNTONNAME_LEN);
    const [only] = parseStatfsMountpoints(buf, 1);
    expect(only).toBe("a".repeat(F_MNTONNAME_LEN));
  });

  it("isMountpointInTable falls back to resolve() when the parent cannot be realPath'd", async () => {
    // A mountpoint under a nonexistent parent makes parentCanonicalizedMountpoint
    // realPath the parent, fail, and fall back to the resolved path — the only
    // candidate. We prove it reached that branch by matching the resolved path
    // in a synthetic /proc/mounts.
    const mountpoint = "/no-such-parent-xyz-123/mnt";
    const present = await isMountpointInTable(mountpoint, {
      os: "linux",
      readProcMounts: () =>
        Promise.resolve(`fuse ${resolve(mountpoint)} fuse.cf rw 0 0\n`),
    });
    expect(present).toBe("present");
    const absent = await isMountpointInTable(mountpoint, {
      os: "linux",
      readProcMounts: () => Promise.resolve("proc /proc proc rw 0 0\n"),
    });
    expect(absent).toBe("absent");
  });

  if (Deno.build.os === "darwin") {
    it("reads the real darwin mount table over FFI and always finds root", async () => {
      // Smoke test the real getfsstat FFI path (no injected lister). The root
      // filesystem is always mounted, so "/" must be reported present.
      const state = await isMountpointInTable("/", { os: "darwin" });
      expect(state).toBe("present");
    });
  }

  it("reports present on linux when /proc/mounts lists the mountpoint", async () => {
    const state = await isMountpointInTable("/mnt", {
      os: "linux",
      readProcMounts: () =>
        Promise.resolve(
          "proc /proc proc rw,nosuid 0 0\nfuse /mnt fuse.cf rw 0 0\n",
        ),
    });
    expect(state).toBe("present");
  });

  it("reports absent on linux when /proc/mounts omits the mountpoint", async () => {
    const state = await isMountpointInTable("/mnt", {
      os: "linux",
      readProcMounts: () => Promise.resolve("proc /proc proc rw,nosuid 0 0\n"),
    });
    expect(state).toBe("absent");
  });

  it("decodes /proc/mounts octal escapes before comparing (space in path)", async () => {
    // A mountpoint containing a space is written as `/tmp/a\040b` in
    // /proc/mounts. Without decoding, that field never equals the candidate
    // "/tmp/a b" and a live mount looks "absent" — a dangerous false negative.
    const state = await isMountpointInTable("/tmp/a b", {
      os: "linux",
      readProcMounts: () =>
        Promise.resolve(
          "proc /proc proc rw 0 0\nfuse /tmp/a\\040b fuse.cf rw 0 0\n",
        ),
    });
    expect(state).toBe("present");
  });

  it("reports unknown on linux when the /proc/mounts read fails", async () => {
    const state = await isMountpointInTable("/mnt", {
      os: "linux",
      readProcMounts: () => Promise.reject(new Error("no such file")),
    });
    expect(state).toBe("unknown");
  });
});

describe("fuse unmount", () => {
  const mountpoint = "/tmp/cf-fuse-unmount-test";
  const absMountpoint = resolve(mountpoint);

  function stateFile(
    overrides: Partial<MountStateEntry> = {},
  ): { entry: MountStateEntry; path: string } {
    return {
      entry: mountStateFixture({ mountpoint: absMountpoint, ...overrides }),
      path: "/tmp/cf-state/deadbeef.json",
    };
  }

  it("runs the system unmount even when the daemon is already dead", async () => {
    const systemUnmountCalls: string[] = [];
    const tableStates: MountTableState[] = ["present", "absent"];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile()),
      isAlive: () => false, // daemon dead: PID path is skipped entirely
      kill: () => {},
      isMountpointInTable: () =>
        Promise.resolve(tableStates.shift() ?? "absent"),
      systemUnmount: (mp) => {
        systemUnmountCalls.push(mp);
        return Promise.resolve({ code: 0, stderr: "" });
      },
      removeMountStateFile: () => Promise.resolve(),
      verifyIsFuseProcess: () => Promise.resolve(false),
    });

    expect(systemUnmountCalls).toEqual([absMountpoint]);
    expect(result.ok).toBe(true);
  });

  it("fails when the system unmount errors and the mount survives", async () => {
    const removed: string[] = [];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile()),
      isAlive: () => false,
      kill: () => {},
      // Still present before AND after — the unmount did not take.
      isMountpointInTable: () => Promise.resolve("present"),
      systemUnmount: () =>
        Promise.resolve({ code: 1, stderr: "umount: Resource busy" }),
      removeMountStateFile: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      verifyIsFuseProcess: () => Promise.resolve(false),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("still mounted");
    expect(result.message).toContain("sudo umount -f");
    // The state file must survive so the stale mount stays visible.
    expect(removed).toEqual([]);
  });

  it("succeeds and removes the state file when the mount is gone after", async () => {
    const removed: string[] = [];
    const tableStates: MountTableState[] = ["present", "absent"];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile()),
      isAlive: () => false,
      kill: () => {},
      isMountpointInTable: () =>
        Promise.resolve(tableStates.shift() ?? "absent"),
      systemUnmount: () => Promise.resolve({ code: 0, stderr: "" }),
      removeMountStateFile: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      verifyIsFuseProcess: () => Promise.resolve(false),
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe(`Unmounted ${absMountpoint}`);
    expect(removed).toEqual(["/tmp/cf-state/deadbeef.json"]);
  });

  it("treats an unknown table state as not-absent and does not report success", async () => {
    const systemUnmountCalls: string[] = [];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile()),
      isAlive: () => false,
      kill: () => {},
      // before="unknown" (attempt unmount) and still "unknown" after.
      isMountpointInTable: () => Promise.resolve("unknown"),
      systemUnmount: (mp) => {
        systemUnmountCalls.push(mp);
        return Promise.resolve({ code: 0, stderr: "" });
      },
      removeMountStateFile: () => Promise.resolve(),
      verifyIsFuseProcess: () => Promise.resolve(false),
    });

    // unknown is not-absent, so we still attempt the system unmount...
    expect(systemUnmountCalls).toEqual([absMountpoint]);
    // ...but a still-unknown table cannot confirm success.
    expect(result.ok).toBe(false);
  });

  it("finds the state file via the default enumerating lookup, never hashing the leaf", async () => {
    // The default readMountState dep must enumerate state files and match
    // lexically. It must NOT realPath the mountpoint leaf, which hangs on the
    // stale mount we are unmounting. We prove the default path is used by NOT
    // injecting readMountState and pointing at a real state dir.
    const dir = await Deno.makeTempDir({ prefix: "cf-fuse-unmount-state-" });
    const mp = join(dir, "mountpoint");
    try {
      // Write the state under an ARBITRARY filename — NOT the mountpoint hash
      // writeMountState would use. A hashing lookup would miss this file; only
      // an enumerating lookup finds it. This is what makes the test non-vacuous.
      const statePath = join(dir, "not-the-mountpoint-hash.json");
      await Deno.writeTextFile(
        statePath,
        JSON.stringify({
          pid: 1073741824, // bogus, dead PID: the PID branch is skipped
          mountpoint: mp,
          apiUrl: "",
          identity: "",
          startedAt: "2026-03-17T00:00:00.000Z",
        }),
      );
      const tableStates: MountTableState[] = ["present", "absent"];

      const result = await runUnmount(mp, {
        stateDir: dir,
        // No readMountState / isAlive injected: exercise the real defaults.
        isMountpointInTable: () =>
          Promise.resolve(tableStates.shift() ?? "absent"),
        systemUnmount: () => Promise.resolve({ code: 0, stderr: "" }),
        verifyIsFuseProcess: () => Promise.resolve(false),
      });

      expect(result.ok).toBe(true);
      // Success removes the resolved state file it found by enumeration.
      await expect(Deno.stat(statePath)).rejects.toThrow();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  });

  it("succeeds despite a nonzero system-unmount exit, and logs that code", async () => {
    // Success is gated on the mount table, not the unmount exit code: a
    // fusermount3/umount that exits nonzero while the mount actually went away
    // is still a success. But the nonzero code must be surfaced in a log line
    // so the operator can see what happened.
    const logs: string[] = [];
    const tableStates: MountTableState[] = ["present", "absent"];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile()),
      isAlive: () => false,
      kill: () => {},
      isMountpointInTable: () =>
        Promise.resolve(tableStates.shift() ?? "absent"),
      systemUnmount: () =>
        Promise.resolve({ code: 17, stderr: "umount: already unmounting" }),
      removeMountStateFile: () => Promise.resolve(),
      verifyIsFuseProcess: () => Promise.resolve(false),
      log: (message) => logs.push(message),
    });

    expect(result.ok).toBe(true);
    expect(logs.some((line) => line.includes("17"))).toBe(true);
  });

  it("bounds a wedged system unmount by the deadline so it never hangs", async () => {
    // A real umount on a wedged mount can block in the kernel. defaultSystemUnmount
    // spawns the child, races it against a deadline, and unrefs it on timeout, so
    // it always returns (letting runUnmount print the sudo-umount-f hint) instead
    // of hanging on the child. A `sleep 30` stands in for the wedged umount.
    const start = Date.now();
    const result = await defaultSystemUnmount("/does-not-matter", {
      command: new Deno.Command("sleep", {
        args: ["30"],
        stdout: "null",
        stderr: "piped",
      }),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ code: 1, stderr: "system unmount timed out" });
    // Returned on the ~100ms deadline, nowhere near the 30s child.
    expect(elapsed).toBeLessThan(5000);
  });

  it("SIGTERMs a verified live FUSE process, then proceeds to the table probe", async () => {
    // A live daemon PID that verifies as a FUSE process must be sent SIGTERM,
    // and the flow must then poll for exit and fall through to the mount-table
    // probe. isAlive returns true through the guard checks and the first poll
    // iteration, then false so the poll loop exits promptly.
    const killed: Array<[number, Deno.Signal]> = [];
    const logs: string[] = [];
    let aliveCalls = 0;
    const tableStates: MountTableState[] = ["present", "absent"];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile({ pid: 4242 })),
      // true for: pid liveness check, the `if` guard, and one poll iteration;
      // false afterwards so the poll loop body runs exactly once and exits.
      isAlive: () => aliveCalls++ < 3,
      verifyIsFuseProcess: () => Promise.resolve(true),
      kill: (pid, signal) => {
        killed.push([pid, signal]);
      },
      isMountpointInTable: () =>
        Promise.resolve(tableStates.shift() ?? "absent"),
      systemUnmount: () => Promise.resolve({ code: 0, stderr: "" }),
      removeMountStateFile: () => Promise.resolve(),
      log: (message) => logs.push(message),
    });

    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(logs.some((line) => line.includes("SIGTERM"))).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("skips the kill when the live PID is not a FUSE process", async () => {
    // A stale state file can point at a PID that has been recycled to an
    // unrelated process. When ps-verification fails, we must NOT signal it —
    // and must log that we skipped — while still attempting the system unmount.
    const killed: number[] = [];
    const logs: string[] = [];
    const tableStates: MountTableState[] = ["present", "absent"];

    const result = await runUnmount(mountpoint, {
      readMountState: () => Promise.resolve(stateFile({ pid: 4242 })),
      isAlive: () => true, // PID is alive but (below) not a FUSE process
      verifyIsFuseProcess: () => Promise.resolve(false),
      kill: (pid) => {
        killed.push(pid);
      },
      isMountpointInTable: () =>
        Promise.resolve(tableStates.shift() ?? "absent"),
      systemUnmount: () => Promise.resolve({ code: 0, stderr: "" }),
      removeMountStateFile: () => Promise.resolve(),
      log: (message) => logs.push(message),
    });

    expect(killed).toEqual([]);
    expect(
      logs.some((line) =>
        line.includes("does not appear to be a FUSE process")
      ),
    ).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("defaultSystemUnmount returns code 0 on a clean system unmount", async () => {
    // The success path: the injected command exits 0, so the result reports
    // code 0 and empty stderr (the branch the timeout test never reaches).
    const result = await defaultSystemUnmount("/does-not-matter", {
      command: new Deno.Command("sh", {
        args: ["-c", "exit 0"],
        stdout: "null",
        stderr: "piped",
      }),
      timeoutMs: 5000,
    });
    expect(result).toEqual({ code: 0, stderr: "" });
  });

  it("defaultSystemUnmount surfaces a nonzero exit code and decoded stderr", async () => {
    // A busy/failed unmount exits nonzero; the code and stderr must be reported
    // back rather than swallowed, so runUnmount can log them.
    const result = await defaultSystemUnmount("/does-not-matter", {
      command: new Deno.Command("sh", {
        args: ["-c", "echo 'device busy' >&2; exit 3"],
        stdout: "null",
        stderr: "piped",
      }),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("device busy");
  });

  it("defaultSystemUnmount maps a spawn failure to a nonzero result", async () => {
    // If the unmount binary cannot even be spawned, spawn() throws; the catch
    // must convert that into a nonzero result so runUnmount still returns and
    // prints its sudo-umount-f hint instead of propagating the error.
    const result = await defaultSystemUnmount("/does-not-matter", {
      command: new Deno.Command(
        "/nonexistent/definitely-not-a-real-binary-xyz",
        { stdout: "null", stderr: "piped" },
      ),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("builds the default platform unmount command when none is injected", async () => {
    // Exercises the real default command construction (umount on darwin,
    // fusermount3 on linux) against a mountpoint that isn't mounted, so it
    // fails fast — or the binary is absent and spawn() fails. Either way it
    // returns a nonzero result rather than throwing or hanging.
    const result = await defaultSystemUnmount(
      "/definitely-not-mounted-cf-fuse-test",
      { timeoutMs: 5000 },
    );
    expect(typeof result.code).toBe("number");
    expect(result.code).not.toBe(0);
  });
});

describe("debug flag forwarding", () => {
  it("survives every forwarding layer", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      debug: true,
    });
    expect(args).toContain("--debug");

    const binaryArgs = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      debug: true,
    });
    expect(binaryArgs).toContain("--debug");

    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      debug: true,
    });
    expect(supervisorArgs).toContain("--debug");

    const denoChild = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      execPath: "deno",
      debug: true,
    });
    expect(denoChild.args).toContain("--debug");

    const compiledChild = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      execPath: "/usr/local/bin/cf",
      debug: true,
    });
    expect(compiledChild.args).toContain("--debug");

    expect(parseSupervisorArgs(["/mnt", "--debug"]).options.debug).toBe(true);
  });

  it("omits --debug from every layer when unset", () => {
    const args = buildFuseChildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).not.toContain("--debug");

    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(supervisorArgs).not.toContain("--debug");

    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      execPath: "/usr/local/bin/cf",
    });
    expect(child.args).not.toContain("--debug");

    expect(parseSupervisorArgs(["/mnt"]).options.debug).toBeUndefined();
  });
});
