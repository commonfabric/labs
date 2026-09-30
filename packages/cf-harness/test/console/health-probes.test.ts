import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  askCfcVmStatus,
  CFC_VM_STATUS_BOUND_MS,
  type ConsolePathReading,
  consolePatternIndexHealthProbes,
  type ConsolePolicyReading,
  consoleRunscHealthProbe,
  consoleSandboxHealthProbe,
  consoleVmHealthProbe,
  consoleVmStore,
  readConsolePath,
  readConsolePolicy,
  touchCfcVmDaemon,
} from "../../console/health-probes.ts";
import type { RunscSandboxConfig } from "../../src/sandbox/runsc.ts";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { join } from "@std/path";
import { ConsoleHealth } from "../../console/health.ts";
import { PatternIndexClient } from "../../src/pattern-index/client.ts";

const signer = await Identity.fromPassphrase("console health observations");

/**
 * Whether this process searches a directory whose mode forbids it, as a
 * privileged one does. No mode makes a path unreadable to such a process, so
 * the case needing one cannot be set up for it.
 */
const searchesDespiteMode = (): boolean => {
  const dir = Deno.makeTempDirSync({ prefix: "cf-harness-path-mode-" });
  try {
    Deno.mkdirSync(join(dir, "in"));
    Deno.chmodSync(dir, 0o000);
    try {
      Deno.statSync(join(dir, "in"));
      return true;
    } catch {
      return false;
    }
  } finally {
    Deno.chmodSync(dir, 0o700);
    Deno.removeSync(dir, { recursive: true });
  }
};

/**
 * A fake cfc-vm daemon at `<directory>/daemon.sock`, serving each connection
 * the way the real one does. A connection closed before it sends a line is
 * closed in turn, and nothing else happens: the real daemon does not count it
 * as activity. A line is recorded without its newline and
 * answered with what `answer` returns before the daemon hangs up, or, where
 * that is `undefined`, held open unanswered until the daemon is closed.
 * `leaveSocket` makes closing the daemon leave its socket file behind, as a
 * daemon that is killed does.
 */
const fakeVmDaemon = (
  directory: string,
  answer: (line: string) => string | undefined,
  options: { leaveSocket?: boolean } = {},
) => {
  const socket = join(directory, "daemon.sock");
  // Closing a listener removes the path it bound; one bound elsewhere and
  // moved into place leaves its socket where the probe looks.
  const bound = options.leaveSocket ? join(directory, "bound.sock") : socket;
  const listener = Deno.listen({ transport: "unix", path: bound });
  if (options.leaveSocket) Deno.renameSync(bound, socket);
  const lines: string[] = [];
  const held: Deno.Conn[] = [];
  const asked = Promise.withResolvers<void>();
  const serve = async (connection: Deno.Conn) => {
    const line = await readLine(connection);
    if (line === undefined) {
      connection.close();
      return;
    }
    lines.push(line);
    asked.resolve();
    const reply = answer(line);
    if (reply === undefined) {
      held.push(connection);
      return;
    }
    await connection.write(new TextEncoder().encode(`${reply}\n`));
    connection.close();
  };
  const serving = (async () => {
    for await (const connection of listener) {
      await serve(connection).catch(() => {});
    }
  })().catch(() => {});
  return {
    lines,
    /** Settles once the daemon has read its first line. */
    asked: asked.promise,
    /** Answers every connection held so far with `reply`, and hangs up. */
    answerHeld: async (reply: string) => {
      for (const connection of held.splice(0)) {
        await connection.write(new TextEncoder().encode(`${reply}\n`));
        connection.close();
      }
    },
    close: async () => {
      for (const connection of held) connection.close();
      listener.close();
      await serving;
    },
  };
};

/**
 * Reads from `connection` up to its first newline, or to its end, or returns
 * `undefined` for a connection that ended without a byte.
 */
const readLine = async (
  connection: Deno.Conn,
): Promise<string | undefined> => {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(256);
  let text = "";
  while (!text.includes("\n")) {
    const read = await connection.read(buffer);
    if (read === null) return text === "" ? undefined : text;
    text += decoder.decode(buffer.subarray(0, read), { stream: true });
  }
  return text.split("\n")[0];
};

describe("health-probes", () => {
  describe("consoleSandboxHealthProbe()", () => {
    for (const registered of [true, false]) {
      it(`reports Docker responding with runsc-cfc ${registered ? "registered" : "missing"}`, async () => {
        const probe = consoleSandboxHealthProbe(() =>
          Promise.resolve({
            runtimes: registered ? { "runsc-cfc": {} } : { runc: {} },
          })
        );
        const rows = await probe.read();
        expect(rows.map(({ id, state, value }) => ({ id, state, value })))
          .toEqual([
            { id: "sandbox.docker", state: "ok", value: "responding" },
            {
              id: "sandbox.runtime",
              state: registered ? "ok" : "failed",
              value: registered
                ? "runsc-cfc registered"
                : "runsc-cfc not registered",
            },
          ]);
        expect(rows.every((row) => Number.isFinite(Date.parse(row.checkedAt!))))
          .toBe(true);
        expect(rows[1]).toMatchObject({
          label: "Sandbox Runtime",
          source: "docker info",
          detail: "docker info --format '{{json .Runtimes}}'",
        });
        expect(rows[1].remedy).toBe(
          registered
            ? undefined
            : "Install the runsc-cfc runtime and reload Docker's runtime registration.",
        );
      });
    }

    for (const runtimes of [undefined, null, [], "invalid"]) {
      it(`leaves availability unknown for ${JSON.stringify(runtimes)} runtime metadata`, async () => {
        const probe = consoleSandboxHealthProbe(() =>
          Promise.resolve({ runtimes, unreadable: "daemon unavailable" })
        );
        const rows = await probe.read();
        expect(rows.map((row) => [row.state, row.reason])).toEqual([
          ["unknown", "daemon unavailable"],
          ["unknown", "daemon unavailable"],
        ]);
      });
    }
  });

  describe("consoleRunscHealthProbe()", () => {
    /** The parts of a resolved configuration the probe reads. */
    const config = (policy?: string) =>
      ({
        runscBinary: "/store/bin/runsc",
        rootfs: "/store/images/kitchensink",
        ...(policy !== undefined ? { cfcPolicyPath: policy } : {}),
      }) as RunscSandboxConfig;

    /**
     * Answers each path from `readings`; otherwise the rootfs is a directory
     * and every other path an executable file.
     */
    const examine =
      (readings: Record<string, ConsolePathReading>) =>
      (path: string): ConsolePathReading =>
        readings[path] ??
          (path === "/store/images/kitchensink"
            ? { found: "directory" }
            : { found: "file", executable: true });

    /** Answers each policy from `readings`, and a JSON object otherwise. */
    const readPolicy =
      (readings: Record<string, ConsolePolicyReading>) =>
      (path: string): ConsolePolicyReading =>
        readings[path] ?? { found: "policy" };

    const observe = async (
      resolve: () => RunscSandboxConfig,
      readings: Record<string, ConsolePathReading> = {},
      mode: CfcEnforcementMode = "enforce-strict",
      policies: Record<string, ConsolePolicyReading> = {},
    ) =>
      (await consoleRunscHealthProbe(
        resolve,
        mode,
        examine(readings),
        readPolicy(policies),
      ).read())
        .map(({ id, state, value }) => ({ id, state, value }));

    it("returns every row ok for an executable binary, a policy that parses and a rootfs directory", async () => {
      const rows = await consoleRunscHealthProbe(
        () => config("/store/policy.json"),
        "enforce-strict",
        examine({}),
        readPolicy({}),
      ).read();

      expect(rows.map(({ id, state, value }) => ({ id, state, value })))
        .toEqual([
          { id: "sandbox.runsc", state: "ok", value: "executable" },
          {
            id: "sandbox.runtime",
            state: "ok",
            value: "direct runsc driver, CFC policy configured",
          },
          { id: "sandbox.rootfs", state: "ok", value: "present" },
        ]);
      expect(rows[0]).toMatchObject({
        label: "Runsc Binary",
        group: "sandbox",
        source: "runsc configuration",
        detail: "/store/bin/runsc",
      });
      expect(rows[1]).toMatchObject({
        label: "Sandbox Runtime",
        detail:
          "runsc /store/bin/runsc; rootfs /store/images/kitchensink; CFC policy /store/policy.json",
      });
      expect(rows[2]).toMatchObject({
        label: "Sandbox Rootfs",
        group: "sandbox",
        source: "runsc configuration",
        detail: "/store/images/kitchensink",
      });
      expect(rows.every((row) => Number.isFinite(Date.parse(row.checkedAt!))))
        .toBe(true);
    });

    for (
      const [what, reading, value] of [
        ["nothing at the binary path", { found: "absent" }, "missing"],
        [
          "a file without execute permission",
          { found: "file", executable: false },
          "not executable",
        ],
        [
          "a directory at the binary path",
          { found: "directory" },
          "not executable",
        ],
        [
          "neither a file nor a directory at the binary path",
          { found: "other" },
          "not executable",
        ],
      ] as const
    ) {
      it(`returns the binary row failed and \`${value}\` for ${what}`, async () => {
        expect(
          (await observe(() => config("/store/policy.json"), {
            "/store/bin/runsc": reading,
          }))[0],
        ).toEqual({ id: "sandbox.runsc", state: "failed", value });
      });
    }

    it("returns the binary row unknown when the binary could not be looked at", async () => {
      expect(
        (await observe(() => config("/store/policy.json"), {
          "/store/bin/runsc": { found: "unreadable", reason: "EACCES" },
        }))[0],
      ).toEqual({
        id: "sandbox.runsc",
        state: "unknown",
        value: "not verified",
      });
    });

    for (const mode of ["enforce-strict", "enforce-explicit"] as const) {
      it(`returns the runtime row failed when no CFC policy is configured and turns enforce at \`${mode}\``, async () => {
        // The engine refuses every such turn before any tool runs.
        const [, row] = await consoleRunscHealthProbe(
          () => config(),
          mode,
          examine({}),
        ).read();

        expect(row).toMatchObject({
          id: "sandbox.runtime",
          state: "failed",
          value: "no CFC policy, so every turn is refused",
        });
        expect(row.reason).toContain(mode);
        expect(row.remedy).toContain("CF_HARNESS_RUNSC_CFC_POLICY");
      });
    }

    it("returns the runtime row degraded when no CFC policy is configured and turns only observe", async () => {
      const [, row] = await consoleRunscHealthProbe(
        () => config(),
        "observe",
        examine({}),
      ).read();

      expect(row).toMatchObject({
        id: "sandbox.runtime",
        state: "degraded",
        value: "direct runsc driver, no CFC policy",
      });
      expect(row.reason).toContain("untracked");
    });

    for (
      const [what, reading, value, reason] of [
        [
          "absent",
          { found: "absent" },
          "CFC policy missing",
          "Nothing exists at the configured CFC policy path.",
        ],
        [
          "a directory",
          { found: "directory" },
          "CFC policy not a file",
          "The configured CFC policy path is not a file.",
        ],
        [
          "neither a file nor a directory",
          { found: "other" },
          "CFC policy not a file",
          "The configured CFC policy path is not a file.",
        ],
      ] as const
    ) {
      it(`returns the runtime row failed when the configured CFC policy is ${what}`, async () => {
        let reads = 0;
        const [, row] = await consoleRunscHealthProbe(
          () => config("/store/policy.json"),
          "enforce-strict",
          examine({ "/store/policy.json": reading }),
          () => {
            reads += 1;
            return { found: "policy" };
          },
        ).read();

        expect(row).toMatchObject({
          id: "sandbox.runtime",
          state: "failed",
          value,
          reason,
        });
        expect(row.remedy).toContain("CF_HARNESS_RUNSC_CFC_POLICY");
        // A path that is not a file is not read.
        expect(reads).toBe(0);
      });
    }

    for (
      const [what, reading, value] of [
        [
          "the console was refused permission to read it",
          { found: "denied", reason: "PermissionDenied: read" },
          "CFC policy unreadable",
        ],
        [
          "it does not parse as a JSON object",
          { found: "malformed", reason: "SyntaxError: Unexpected token" },
          "CFC policy malformed",
        ],
      ] as const
    ) {
      it(`returns the runtime row failed, carrying the reason, when the configured CFC policy is a file and ${what}`, async () => {
        const [, row] = await consoleRunscHealthProbe(
          () => config("/store/policy.json"),
          "enforce-strict",
          examine({}),
          readPolicy({ "/store/policy.json": reading }),
        ).read();

        expect(row).toMatchObject({
          id: "sandbox.runtime",
          state: "failed",
          value,
        });
        expect(row.reason).toContain(reading.reason);
        expect(typeof row.remedy).toBe("string");
      });
    }

    it("returns the runtime row unknown, not failed, when reading the configured CFC policy failed other than by permission", async () => {
      const [, row] = await consoleRunscHealthProbe(
        () => config("/store/policy.json"),
        "enforce-strict",
        examine({}),
        readPolicy({
          "/store/policy.json": { found: "unreadable", reason: "EIO" },
        }),
      ).read();

      expect(row).toMatchObject({
        id: "sandbox.runtime",
        state: "unknown",
        value: "not verified",
        reason: "EIO",
      });
      expect(row.remedy).toBeUndefined();
    });

    for (
      const [what, reading, value] of [
        ["nothing at the rootfs path", { found: "absent" }, "missing"],
        [
          "a file at the rootfs path",
          { found: "file", executable: false },
          "not a directory",
        ],
        [
          "neither a file nor a directory at the rootfs path",
          { found: "other" },
          "not a directory",
        ],
      ] as const
    ) {
      it(`returns the rootfs row failed and \`${value}\` for ${what}`, async () => {
        const rows = await consoleRunscHealthProbe(
          () => config("/store/policy.json"),
          "enforce-strict",
          examine({ "/store/images/kitchensink": reading }),
          readPolicy({}),
        ).read();

        expect(rows[2]).toMatchObject({
          id: "sandbox.rootfs",
          state: "failed",
          value,
          detail: "/store/images/kitchensink",
        });
        expect(rows[2].remedy).toContain("CF_HARNESS_SANDBOX_ROOTFS");
        // The other rows are not what a missing rootfs is reported by.
        expect(rows.slice(0, 2).map(({ state }) => state)).toEqual([
          "ok",
          "ok",
        ]);
      });
    }

    it("returns the rootfs row unknown when the rootfs could not be looked at", async () => {
      expect(
        (await observe(() => config("/store/policy.json"), {
          "/store/images/kitchensink": {
            found: "unreadable",
            reason: "EACCES",
          },
        }))[2],
      ).toEqual({
        id: "sandbox.rootfs",
        state: "unknown",
        value: "not verified",
      });
    });

    it("returns the runtime row unknown, not failed, when the configured CFC policy could not be looked at", async () => {
      const rows = await consoleRunscHealthProbe(
        () => config("/store/policy.json"),
        "enforce-strict",
        examine({
          "/store/policy.json": { found: "unreadable", reason: "EACCES" },
        }),
        readPolicy({}),
      ).read();

      expect(rows[1]).toMatchObject({
        id: "sandbox.runtime",
        state: "unknown",
        value: "not verified",
        reason: "EACCES",
      });
      expect(rows[1].remedy).toBeUndefined();
    });

    it("returns every row unknown when the observation itself throws", async () => {
      // `ConsoleHealth` reports a probe whose read rejects through the
      // probe's own unavailable rows: a failure to look is not a failure of
      // the runtime.
      const health = new ConsoleHealth([], [
        consoleRunscHealthProbe(
          () => config("/store/policy.json"),
          "enforce-strict",
          () => {
            throw new Error("examining failed");
          },
        ),
      ]);

      await health.refresh();

      const rows = health.snapshot().rows;
      expect(rows.map(({ id, state, value, reason }) => ({
        id,
        state,
        value,
        reason,
      }))).toEqual([
        {
          id: "sandbox.runsc",
          state: "unknown",
          value: "not verified",
          reason: "The runsc configuration could not be examined.",
        },
        {
          id: "sandbox.runtime",
          state: "unknown",
          value: "not verified",
          reason: "The runsc configuration could not be examined.",
        },
        {
          id: "sandbox.rootfs",
          state: "unknown",
          value: "not verified",
          reason: "The runsc configuration could not be examined.",
        },
      ]);
      expect(rows.every((row) => row.checkedAt !== null)).toBe(true);
    });

    it("returns the runtime row failed with the driver's reason when the configuration is refused", async () => {
      const rows = await consoleRunscHealthProbe(
        () => {
          throw new Error("runsc sandbox needs a rootfs");
        },
        "enforce-strict",
        examine({}),
      ).read();

      expect(rows.map(({ id, state, value }) => ({ id, state, value })))
        .toEqual([
          { id: "sandbox.runsc", state: "unknown", value: "not verified" },
          {
            id: "sandbox.runtime",
            state: "failed",
            value: "configuration refused",
          },
          { id: "sandbox.rootfs", state: "unknown", value: "not verified" },
        ]);
      expect(rows[1].reason).toBe("runsc sandbox needs a rootfs");
    });
  });

  describe("consoleVmStore()", () => {
    /** A store directory holding `config.json` with `config`, or none. */
    const withStore = async (
      config: Record<string, unknown> | undefined,
      body: (directory: string) => Promise<void> | void,
    ) => {
      const directory = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      try {
        if (config !== undefined) {
          await Deno.writeTextFile(
            join(directory, "config.json"),
            JSON.stringify(config),
          );
        }
        await body(directory);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    };

    it("returns the store `CFC_VM_HOME` names, the image the rootfs names in it, and its idle timeout", async () => {
      await withStore({ idleTimeoutSec: 300 }, (directory) => {
        const rootfs = join(
          Deno.realPathSync(directory),
          "images",
          "kitchensink",
        );

        expect(
          consoleVmStore(rootfs, { CFC_VM_HOME: directory }, {
            platform: "darwin",
          }),
        ).toEqual({ directory, imageKey: "kitchensink", idleTimeoutSec: 300 });
      });
    });

    it("returns the store under `HOME` when `CFC_VM_HOME` is unset", async () => {
      await withStore(undefined, async (home) => {
        const directory = join(
          home,
          "Library",
          "Application Support",
          "cfc-vm",
        );
        await Deno.mkdir(directory, { recursive: true });
        await Deno.writeTextFile(join(directory, "config.json"), "{}");

        for (const env of [{ HOME: home }, { CFC_VM_HOME: "", HOME: home }]) {
          expect(
            consoleVmStore("/elsewhere/rootfs", env, { platform: "darwin" }),
          ).toEqual({ directory, idleTimeoutSec: 600 });
        }
      });
    });

    it("returns the daemon's own idle timeout where `config.json` names none it can use", async () => {
      for (
        const config of [{}, { idleTimeoutSec: 0 }, { idleTimeoutSec: "5" }]
      ) {
        await withStore(config, (directory) => {
          expect(
            consoleVmStore("/r", { CFC_VM_HOME: directory }, {
              platform: "darwin",
            })?.idleTimeoutSec,
          ).toBe(600);
        });
      }
    });

    it("returns no image for a rootfs outside the store's `images`", async () => {
      await withStore({}, (directory) => {
        const store = consoleVmStore(
          join(Deno.realPathSync(directory), "rootfs", "kitchensink"),
          { CFC_VM_HOME: directory },
          { platform: "darwin" },
        );

        expect(store?.imageKey).toBeUndefined();
      });
    });

    it("returns `undefined` off macOS", async () => {
      await withStore({}, (directory) => {
        expect(
          consoleVmStore(join(directory, "images", "kitchensink"), {
            CFC_VM_HOME: directory,
          }, { platform: "linux" }),
        ).toBeUndefined();
      });
    });

    it("returns `undefined` for a directory with no `config.json`", async () => {
      await withStore(undefined, (directory) => {
        expect(
          consoleVmStore(join(directory, "images", "kitchensink"), {
            CFC_VM_HOME: directory,
          }, { platform: "darwin" }),
        ).toBeUndefined();
      });
    });

    it("returns `undefined` when neither `CFC_VM_HOME` nor `HOME` is set", () => {
      expect(consoleVmStore("/r", {}, { platform: "darwin" })).toBeUndefined();
    });
  });

  describe("consoleVmHealthProbe()", () => {
    /** What a running daemon answers, as the real one does. */
    const STATUS = {
      activeClients: 0,
      forwardPorts: [],
      guest: {
        memAvailableKiB: 1_883_096,
        memTotalKiB: 2_040_268,
        rootfs: 0,
        runsc: 0,
      },
      idleSec: 29,
      images: ["kitchensink"],
      pid: 21275,
      shares: {},
      uptimeSec: 1592,
    };

    /** Runs `body` over an empty temporary store directory. */
    const withStore = async (body: (directory: string) => Promise<void>) => {
      const directory = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      try {
        await body(directory);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    };

    const store = (directory: string, imageKey = "kitchensink") => ({
      directory,
      imageKey,
      idleTimeoutSec: 600,
    });

    /** The row the probe returns, alone. */
    const readRow = async (probe: ReturnType<typeof consoleVmHealthProbe>) => {
      const rows = await probe.read();
      expect(rows.map((row) => row.id)).toEqual(["sandbox.vm"]);
      return rows[0];
    };

    it("returns idle without connecting when the store has no daemon socket", async () => {
      await withStore(async (directory) => {
        let asked = 0;
        const row = await readRow(
          consoleVmHealthProbe(store(directory), {
            ask: () => {
              asked += 1;
              return Promise.resolve({ found: "no-daemon" });
            },
          }),
        );

        expect(asked).toBe(0);
        expect(row).toMatchObject({
          label: "Sandbox VM",
          state: "ok",
          value: "idle; starts on first use",
        });
      });
    });

    it("returns idle when nothing listens on the socket the store holds", async () => {
      await withStore(async (directory) => {
        // What a daemon that stopped without removing its socket leaves.
        const listener = Deno.listen({
          transport: "unix",
          path: join(directory, "live.sock"),
        });
        await Deno.rename(
          join(directory, "live.sock"),
          join(directory, "daemon.sock"),
        );
        listener.close();

        const row = await readRow(consoleVmHealthProbe(store(directory)));

        expect(row).toMatchObject({
          state: "ok",
          value: "idle; starts on first use",
        });
      });
    });

    it("returns running with the daemon's uptime, guest memory and images, and says the question is activity", async () => {
      await withStore(async (directory) => {
        const daemon = fakeVmDaemon(directory, () => JSON.stringify(STATUS));
        try {
          const row = await readRow(consoleVmHealthProbe(store(directory)));

          expect(daemon.lines).toEqual(["#cfcvm status"]);
          expect(row).toMatchObject({ state: "ok", value: "running" });
          expect(row.detail).toContain("up 26m 32s");
          expect(row.detail).toContain(
            "guest memory 1839 MiB available of 1992 MiB",
          );
          expect(row.detail).toContain("images kitchensink");
          expect(row.reason).toContain("counts as activity");
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns failed naming the image the VM has not attached and the store holds no block image for", async () => {
      await withStore(async (directory) => {
        const daemon = fakeVmDaemon(
          directory,
          () => JSON.stringify({ ...STATUS, images: ["other"] }),
        );
        try {
          const row = await readRow(consoleVmHealthProbe(store(directory)));

          expect(row).toMatchObject({
            state: "failed",
            value: "the VM has no kitchensink image",
          });
          expect(row.remedy).toContain("ext4/kitchensink.ext4");
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns running when the store holds the block image the VM has not attached", async () => {
      await withStore(async (directory) => {
        await Deno.mkdir(join(directory, "ext4"));
        await Deno.writeTextFile(
          join(directory, "ext4", "kitchensink.ext4"),
          "",
        );
        const daemon = fakeVmDaemon(
          directory,
          () => JSON.stringify({ ...STATUS, images: [] }),
        );
        try {
          const row = await readRow(consoleVmHealthProbe(store(directory)));

          expect(row).toMatchObject({ state: "ok", value: "running" });
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns failed when the daemon takes the question and gives no answer within the bound", async () => {
      await withStore(async (directory) => {
        using time = new FakeTime();
        const daemon = fakeVmDaemon(directory, () => undefined);
        try {
          const reading = consoleVmHealthProbe(store(directory)).read();
          await daemon.asked;
          time.tick(CFC_VM_STATUS_BOUND_MS);
          const [row] = await reading;

          expect(row).toMatchObject({
            state: "failed",
            value: "the VM daemon does not answer",
          });
          expect(row.reason).toContain(`${CFC_VM_STATUS_BOUND_MS} ms`);
          expect(row.remedy).toContain("daemon.log");
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns running for an answer that comes after the ten seconds the daemon gives its guest", async () => {
      await withStore(async (directory) => {
        using time = new FakeTime();
        const daemon = fakeVmDaemon(directory, () => undefined);
        try {
          const reading = consoleVmHealthProbe(store(directory)).read();
          await daemon.asked;
          time.tick(12_000);
          await daemon.answerHeld(JSON.stringify(STATUS));
          const [row] = await reading;

          expect(row).toMatchObject({ state: "ok", value: "running" });
        } finally {
          await daemon.close();
        }
      });
    });

    it("leaves no timer running once the daemon has answered", async () => {
      await withStore(async (directory) => {
        using time = new FakeTime();
        const daemon = fakeVmDaemon(directory, () => JSON.stringify(STATUS));
        try {
          const reading = await askCfcVmStatus(join(directory, "daemon.sock"));

          expect(reading.found).toBe("status");
          expect(time.next()).toBe(false);
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns failed when the daemon answers with something other than its status", async () => {
      await withStore(async (directory) => {
        const daemon = fakeVmDaemon(directory, () => "error: busy");
        try {
          const row = await readRow(consoleVmHealthProbe(store(directory)));

          expect(row).toMatchObject({
            state: "failed",
            value: "the VM daemon does not answer",
          });
        } finally {
          await daemon.close();
        }
      });
    });

    for (
      const [what, answer] of [
        ["no `images` list", { error: "busy", guest: STATUS.guest }],
        ["an image that is not a name", { ...STATUS, images: [1] }],
        ["a `guest` that is not an object", { ...STATUS, guest: "down" }],
      ] as const
    ) {
      it(`returns failed when the daemon answers with ${what}, which is not a status`, async () => {
        await withStore(async (directory) => {
          const daemon = fakeVmDaemon(directory, () => JSON.stringify(answer));
          try {
            const row = await readRow(consoleVmHealthProbe(store(directory)));

            expect(row).toMatchObject({
              state: "failed",
              value: "the VM daemon does not answer",
            });
          } finally {
            await daemon.close();
          }
        });
      });
    }

    for (
      const guest of [{}, { memTotalKiB: 2_040_268 }, {
        memAvailableKiB: 1_883_096,
      }]
    ) {
      it(`returns failed when the daemon answers with the guest's figures ${JSON.stringify(Object.keys(guest))} alone`, async () => {
        await withStore(async (directory) => {
          const daemon = fakeVmDaemon(
            directory,
            () => JSON.stringify({ ...STATUS, guest }),
          );
          try {
            const row = await readRow(consoleVmHealthProbe(store(directory)));

            expect(row).toMatchObject({
              state: "failed",
              value: "the VM guest does not answer",
            });
          } finally {
            await daemon.close();
          }
        });
      });
    }

    it("asks a running daemon no more often than its idle timeout and two of its idle checks, finding it listening between", async () => {
      await withStore(async (directory) => {
        // Fake time moves the wall clock the row's times are read from, so
        // the second read is not in the first one's millisecond.
        using time = new FakeTime();
        const daemon = fakeVmDaemon(directory, () => JSON.stringify(STATUS));
        try {
          let now = 1_000_000;
          let touches = 0;
          const probe = consoleVmHealthProbe(store(directory), {
            now: () => now,
            touch: (socket) => {
              touches += 1;
              return touchCfcVmDaemon(socket);
            },
          });

          const first = await readRow(probe);
          now += 629_999;
          time.tick(629_999);
          const between = await readRow(probe);

          expect(daemon.lines).toEqual(["#cfcvm status"]);
          expect(touches).toBe(1);
          expect(between).toMatchObject({
            state: first.state,
            value: first.value,
            detail: first.detail,
          });
          expect(between.checkedAt).not.toBe(first.checkedAt);
          expect(between.reason).toContain(first.checkedAt);

          now += 1;
          await readRow(probe);
          expect(daemon.lines.length).toBe(2);
        } finally {
          await daemon.close();
        }
      });
    });

    it("returns idle, and asks nothing, once the daemon it last asked has stopped and left its socket", async () => {
      await withStore(async (directory) => {
        const probe = consoleVmHealthProbe(store(directory));
        const daemon = fakeVmDaemon(directory, () => JSON.stringify(STATUS), {
          leaveSocket: true,
        });
        expect(await readRow(probe)).toMatchObject({ value: "running" });
        await daemon.close();

        expect(await readRow(probe)).toMatchObject({
          state: "ok",
          value: "idle; starts on first use",
        });
        expect(daemon.lines).toEqual(["#cfcvm status"]);
      });
    });

    it("asks a daemon that has replaced the one it last asked at once", async () => {
      await withStore(async (directory) => {
        const probe = consoleVmHealthProbe(store(directory));
        const first = fakeVmDaemon(directory, () => JSON.stringify(STATUS));
        await readRow(probe);
        await first.close();
        const second = fakeVmDaemon(directory, () => "error: busy");
        try {
          expect(await readRow(probe)).toMatchObject({
            state: "failed",
            value: "the VM daemon does not answer",
          });
          expect(second.lines).toEqual(["#cfcvm status"]);
        } finally {
          await second.close();
        }
      });
    });

    const answeredButNotOk: {
      what: string;
      answer: Record<string, unknown>;
      examine?: (path: string) => ConsolePathReading;
      expected: { state: string; value: string };
    }[] = [{
      what: "the image the rootfs names missing",
      answer: { ...STATUS, images: ["other"] },
      expected: { state: "failed", value: "the VM has no kitchensink image" },
    }, {
      what: "the image's block file unreadable",
      answer: { ...STATUS, images: ["other"] },
      examine: () => ({ found: "unreadable", reason: "denied" }),
      expected: { state: "unknown", value: "not verified" },
    }, {
      what: "no figures from the guest",
      answer: { ...STATUS, guest: {} },
      expected: { state: "failed", value: "the VM guest does not answer" },
    }];
    for (const { what, answer, examine, expected } of answeredButNotOk) {
      it(`asks once in five reads within its interval where the answer found ${what}`, async () => {
        // A status question is activity, so asking one at every read would
        // keep the VM up for as long as anything reads the row.
        await withStore(async (directory) => {
          const daemon = fakeVmDaemon(directory, () => JSON.stringify(answer));
          try {
            let now = 1_000_000;
            let touches = 0;
            const probe = consoleVmHealthProbe(store(directory), {
              now: () => now,
              touch: (socket) => {
                touches += 1;
                return touchCfcVmDaemon(socket);
              },
              ...(examine !== undefined ? { examine } : {}),
            });

            for (let read = 0; read < 5; read += 1) {
              expect(await readRow(probe)).toMatchObject(expected);
              now += 30_000;
            }

            expect(daemon.lines).toEqual(["#cfcvm status"]);
            expect(touches).toBe(4);
          } finally {
            await daemon.close();
          }
        });
      });
    }

    it("returns running once the missing image's block file is installed, without asking the daemon again", async () => {
      await withStore(async (directory) => {
        const daemon = fakeVmDaemon(
          directory,
          () => JSON.stringify({ ...STATUS, images: [] }),
        );
        try {
          const probe = consoleVmHealthProbe(store(directory));
          expect(await readRow(probe)).toMatchObject({ state: "failed" });

          await Deno.mkdir(join(directory, "ext4"));
          await Deno.writeTextFile(
            join(directory, "ext4", "kitchensink.ext4"),
            "",
          );

          expect(await readRow(probe)).toMatchObject({
            state: "ok",
            value: "running",
          });
          expect(daemon.lines).toEqual(["#cfcvm status"]);
        } finally {
          await daemon.close();
        }
      });
    });

    it("asks again at the next read after an answer that was no status", async () => {
      await withStore(async (directory) => {
        let reply = "error: busy";
        const daemon = fakeVmDaemon(directory, () => reply);
        try {
          const probe = consoleVmHealthProbe(store(directory));
          expect(await readRow(probe)).toMatchObject({ state: "failed" });

          reply = JSON.stringify(STATUS);

          expect(await readRow(probe)).toMatchObject({ value: "running" });
          expect(daemon.lines.length).toBe(2);
        } finally {
          await daemon.close();
        }
      });
    });

    for (const gone of ["no socket", "a socket nothing listens on"] as const) {
      it(`asks again after it found ${gone}, even where the socket then looks unchanged`, async () => {
        // The socket's identity is held fixed, so that only having found no
        // daemon stands between the last answer and the next question.
        await withStore(async (directory) => {
          const unchanged = Deno.lstatSync(directory);
          let present = true;
          const probe = consoleVmHealthProbe(store(directory), {
            lstat: () => {
              if (!present) throw new Deno.errors.NotFound("no socket");
              return unchanged;
            },
          });
          const first = fakeVmDaemon(directory, () => JSON.stringify(STATUS));
          await readRow(probe);
          await first.close();
          present = gone === "a socket nothing listens on";
          expect(await readRow(probe)).toMatchObject({
            value: "idle; starts on first use",
          });

          present = true;
          const second = fakeVmDaemon(
            directory,
            () => JSON.stringify(STATUS),
          );
          try {
            await readRow(probe);

            expect(second.lines).toEqual(["#cfcvm status"]);
          } finally {
            await second.close();
          }
        });
      });
    }

    it("returns unknown when the socket could not be looked at", async () => {
      const row = await readRow(
        consoleVmHealthProbe(store("/store"), {
          lstat: () => {
            throw new Deno.errors.PermissionDenied("denied");
          },
        }),
      );

      expect(row).toMatchObject({ state: "unknown", value: "not verified" });
    });
  });

  describe("readConsolePolicy()", () => {
    it("returns what a policy file holds: a JSON object, or malformed", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-harness-policy-" });
      try {
        const write = async (name: string, text: string) => {
          await Deno.writeTextFile(join(dir, name), text);
          return join(dir, name);
        };

        expect(
          readConsolePolicy(
            await write("ok.json", '{"path_labels":[],"sink_rules":[]}'),
          ),
        ).toEqual({ found: "policy" });
        for (
          const text of ["", "{", "[]", "null", '"policy"', "42"]
        ) {
          expect(
            readConsolePolicy(await write("bad.json", text)).found,
          ).toBe("malformed");
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns denied for a read refused by permission, and unreadable for any other failed read", () => {
      const denied = new Deno.errors.PermissionDenied(
        "Permission denied (os error 13): open '/store/policy.json'",
      );

      expect(readConsolePolicy("/store/policy.json", () => {
        throw denied;
      })).toEqual({ found: "denied", reason: String(denied) });
      const gone = new Deno.errors.NotFound("gone between stat and read");
      expect(readConsolePolicy("/store/policy.json", () => {
        throw gone;
      })).toEqual({ found: "unreadable", reason: String(gone) });
    });

    it({
      name: "returns denied for a policy file whose mode forbids reading it",
      ignore: searchesDespiteMode(),
      fn: async () => {
        const dir = await Deno.makeTempDir({ prefix: "cf-harness-policy-" });
        const policy = join(dir, "policy.json");
        try {
          await Deno.writeTextFile(policy, "{}");
          await Deno.chmod(policy, 0o000);

          expect(readConsolePolicy(policy).found).toBe("denied");
        } finally {
          await Deno.chmod(policy, 0o600);
          await Deno.remove(dir, { recursive: true });
        }
      },
    });
  });

  describe("readConsolePath()", () => {
    it("returns unreadable, carrying the error, for a look that fails other than as not found", () => {
      const denied = new Deno.errors.PermissionDenied(
        "Permission denied (os error 13): stat '/store/bin/runsc'",
      );

      expect(readConsolePath("/store/bin/runsc", () => {
        throw denied;
      })).toEqual({ found: "unreadable", reason: String(denied) });
      expect(readConsolePath("/store/bin/runsc", () => {
        throw new Deno.errors.NotFound("not there");
      })).toEqual({ found: "absent" });
    });

    it("returns what is at each path, and absent only for a path that is not there", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-harness-path-" });
      try {
        const executable = join(dir, "runsc");
        const plain = join(dir, "policy.json");
        await Deno.writeTextFile(executable, "");
        await Deno.chmod(executable, 0o755);
        await Deno.writeTextFile(plain, "{}");
        await Deno.chmod(plain, 0o644);

        expect(readConsolePath(executable)).toEqual({
          found: "file",
          executable: true,
        });
        expect(readConsolePath(plain)).toEqual({
          found: "file",
          executable: false,
        });
        expect(readConsolePath(dir)).toEqual({ found: "directory" });
        expect(readConsolePath(join(dir, "missing"))).toEqual({
          found: "absent",
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it({
      name:
        "returns unreadable, not absent, for a path it has no permission to look at",
      ignore: searchesDespiteMode(),
      fn: async () => {
        const dir = await Deno.makeTempDir({ prefix: "cf-harness-path-" });
        const locked = join(dir, "locked");
        try {
          await Deno.mkdir(locked);
          await Deno.writeTextFile(join(locked, "runsc"), "");
          await Deno.chmod(locked, 0o000);

          const reading = readConsolePath(join(locked, "runsc"));
          expect(reading.found).toBe("unreadable");
          expect(
            reading.found === "unreadable" ? reading.reason : "",
          ).toContain(join(locked, "runsc"));
        } finally {
          await Deno.chmod(locked, 0o700);
          await Deno.remove(dir, { recursive: true });
        }
      },
    });
  });

  describe("consolePatternIndexHealthProbes()", () => {
    it("returns the observed cause separately from the remedy for negative index responses", async () => {
      const client = new PatternIndexClient({
        signer,
        baseUrl: "https://index.test",
        fetchFn: () =>
          Promise.resolve(Response.json({
            ok: false,
            did: signer.did(),
            enrolled: false,
          })),
      });
      const health = new ConsoleHealth(
        [],
        consolePatternIndexHealthProbes(
          "https://index.test",
          () => Promise.resolve(client),
        ),
      );
      await health.refresh();
      expect(health.snapshot().rows).toMatchObject([{
        id: "index.reachable",
        state: "failed",
        reason: "The index reports that its health check failed.",
        remedy: "Check the pattern index deployment.",
      }, {
        id: "index.enrolled",
        state: "failed",
        reason: "The index reports no enrollment for the console identity.",
        remedy:
          "Enroll the console's identity through https://index.test/enroll.",
      }]);
    });

    for (const suffix of ["", "?token=query-secret#fragment-secret"]) {
      it(`omits URL credentials from diagnostics with suffix ${JSON.stringify(suffix)}`, async () => {
        const baseUrl =
          `https://user-secret:password-secret@index.test/api/${suffix}`;
        const health = new ConsoleHealth(
          [],
          consolePatternIndexHealthProbes(
            baseUrl,
            () =>
              Promise.resolve(
                new PatternIndexClient({
                  signer,
                  baseUrl,
                  fetchFn: () =>
                    Promise.resolve(Response.json({
                      ok: false,
                      did: signer.did(),
                      enrolled: false,
                    })),
                }),
              ),
          ),
        );
        expect(JSON.stringify(health.snapshot())).not.toContain("-secret");
        await health.refresh();
        const rows = health.snapshot().rows;
        expect(rows[1]).toMatchObject({
          state: suffix === "" ? "failed" : "unknown",
          detail:
            "GET enrollmentStatus at https://index.test/api/, for the console identity",
          remedy: suffix === ""
            ? "Enroll the console's identity through https://index.test/api/enroll."
            : "Check the configured index URL, network access, and console identity file.",
        });
        expect(JSON.stringify(rows)).not.toContain("-secret");
      });
    }

    it("uses independent read-only endpoints and the console identity under the configured prefix", async () => {
      const requests: Request[] = [];
      const client = new PatternIndexClient({
        signer,
        baseUrl: "https://index.test/api/",
        fetchFn: (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Promise.resolve(
            Response.json(
              new URL(request.url).pathname.endsWith("/health")
                ? { ok: true }
                : { did: signer.did(), enrolled: true },
            ),
          );
        },
      });
      const probes = consolePatternIndexHealthProbes(
        "https://index.test/api/",
        () => Promise.resolve(client),
      );
      const health = new ConsoleHealth([], probes);
      await health.refresh();
      expect(
        requests.map((request) => [request.method, request.url, request.body]),
      ).toEqual([
        ["GET", "https://index.test/api/health", null],
        [
          "GET",
          `https://index.test/api/enrollmentStatus?did=${
            encodeURIComponent(signer.did())
          }`,
          null,
        ],
      ]);
      expect(
        health.snapshot().rows.map((row) => [row.id, row.state, row.value]),
      ).toEqual([
        ["index.reachable", "ok", "responding"],
        ["index.enrolled", "ok", "console identity enrolled"],
      ]);
      expect(health.snapshot().rows[0]).toMatchObject({
        label: "Pattern Index Reachability",
        source: "index /health",
        detail: "GET health at https://index.test/api/",
      });
    });

    for (
      const testCase of [
        {
          body: { did: signer.did(), enrolled: false },
          state: "failed",
          value: "console identity not enrolled",
        },
        {
          body: { did: "did:key:someone-else", enrolled: true },
          state: "unknown",
          value: "not verified",
        },
        {
          body: { did: signer.did(), enrolled: "true" },
          state: "unknown",
          value: "not verified",
        },
        { body: [], state: "unknown", value: "not verified" },
      ]
    ) {
      it(`reports ${testCase.state} for enrollment response ${JSON.stringify(testCase.body)}`, async () => {
        const client = new PatternIndexClient({
          signer,
          baseUrl: "https://index.test",
          fetchFn: () => Promise.resolve(Response.json(testCase.body)),
        });
        const probe =
          consolePatternIndexHealthProbes("https://index.test", () =>
            Promise.resolve(client))[1];
        const rows = await probe.read();
        expect(rows[0]).toMatchObject({
          state: testCase.state,
          value: testCase.value,
        });
        expect(rows[0].remedy).toEqual(expect.any(String));
      });
    }

    it("preserves an HTTP failure's status without copying its response body into operator diagnostics", async () => {
      const client = new PatternIndexClient({
        signer,
        baseUrl: "https://index.test",
        fetchFn: () =>
          Promise.resolve(
            Response.json({ error: "private diagnostic" }, { status: 503 }),
          ),
      });
      const health = new ConsoleHealth(
        [],
        consolePatternIndexHealthProbes(
          "https://index.test",
          () => Promise.resolve(client),
        ),
      );
      await health.refresh();
      const rows = health.snapshot().rows;
      expect(rows.map((row) => row.state)).toEqual(["unknown", "unknown"]);
      expect(rows.every((row) => row.reason?.includes("HTTP 503"))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("private diagnostic");
    });
  });
});
