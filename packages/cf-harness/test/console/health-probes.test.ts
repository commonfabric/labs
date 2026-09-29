import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type ConsolePathReading,
  consolePatternIndexHealthProbes,
  consoleRunscHealthProbe,
  consoleSandboxHealthProbe,
  readConsolePath,
} from "../../console/health-probes.ts";
import type { RunscSandboxConfig } from "../../src/sandbox/runsc.ts";
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

    /** Answers each path from `readings`, and an executable file otherwise. */
    const examine =
      (readings: Record<string, ConsolePathReading>) =>
      (path: string): ConsolePathReading =>
        readings[path] ?? { found: "file", executable: true };

    const observe = async (
      resolve: () => RunscSandboxConfig,
      readings: Record<string, ConsolePathReading> = {},
    ) =>
      (await consoleRunscHealthProbe(resolve, examine(readings)).read()).map((
        { id, state, value },
      ) => ({ id, state, value }));

    it("returns both rows ok for an executable binary and a present policy", async () => {
      const rows = await consoleRunscHealthProbe(
        () => config("/store/policy.json"),
        examine({}),
      ).read();

      expect(rows.map(({ id, state, value }) => ({ id, state, value })))
        .toEqual([
          { id: "sandbox.runsc", state: "ok", value: "executable" },
          {
            id: "sandbox.runtime",
            state: "ok",
            value: "direct runsc driver, CFC policy configured",
          },
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

    it("returns the runtime row degraded when no CFC policy is configured", async () => {
      expect((await observe(() => config()))[1]).toEqual({
        id: "sandbox.runtime",
        state: "degraded",
        value: "direct runsc driver, no CFC policy",
      });
    });

    it("returns the runtime row failed when the configured CFC policy is absent", async () => {
      expect(
        (await observe(() => config("/store/policy.json"), {
          "/store/policy.json": { found: "absent" },
        }))[1],
      ).toEqual({
        id: "sandbox.runtime",
        state: "failed",
        value: "CFC policy missing",
      });
    });

    it("returns the runtime row unknown, not failed, when the configured CFC policy could not be looked at", async () => {
      const rows = await consoleRunscHealthProbe(
        () => config("/store/policy.json"),
        examine({
          "/store/policy.json": { found: "unreadable", reason: "EACCES" },
        }),
      ).read();

      expect(rows[1]).toMatchObject({
        id: "sandbox.runtime",
        state: "unknown",
        value: "not verified",
        reason: "EACCES",
      });
      expect(rows[1].remedy).toBeUndefined();
    });

    it("returns both rows unknown when the observation itself throws", async () => {
      // `ConsoleHealth` reports a probe whose read rejects through the
      // probe's own unavailable rows: a failure to look is not a failure of
      // the runtime.
      const health = new ConsoleHealth([], [
        consoleRunscHealthProbe(() => config("/store/policy.json"), () => {
          throw new Error("examining failed");
        }),
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
      ]);
      expect(rows.every((row) => row.checkedAt !== null)).toBe(true);
    });

    it("returns the runtime row failed with the driver's reason when the configuration is refused", async () => {
      const rows = await consoleRunscHealthProbe(() => {
        throw new Error("runsc sandbox needs a rootfs");
      }, examine({})).read();

      expect(rows.map(({ id, state, value }) => ({ id, state, value })))
        .toEqual([
          { id: "sandbox.runsc", state: "unknown", value: "not verified" },
          {
            id: "sandbox.runtime",
            state: "failed",
            value: "configuration refused",
          },
        ]);
      expect(rows[1].reason).toBe("runsc sandbox needs a rootfs");
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
        expect(readConsolePath(dir)).toEqual({ found: "other" });
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
