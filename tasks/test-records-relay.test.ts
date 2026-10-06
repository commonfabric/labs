import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  composeCiContext,
  memberActorIdsOf,
  parseRelayArgs,
  relayArtifacts,
  runFactsOfPayload,
  runRelay,
  shouldShipRun,
} from "./test-records-relay.ts";
import { gunzipToText } from "@commonfabric/test-support/records";

const PAYLOAD = {
  workflow_run: {
    id: 987654,
    run_attempt: 2,
    name: "CI",
    event: "pull_request",
    head_sha: "a".repeat(40),
    head_branch: "feature-branch",
    run_started_at: "2026-08-17T20:30:00Z",
    repository: { full_name: "commonfabric/labs" },
    head_repository: { full_name: "commonfabric/labs" },
    actor: { login: "octocat", id: 5453321 },
  },
};

describe("test-records-relay", () => {
  describe("runFactsOfPayload()", () => {
    it("returns the run facts of a workflow_run payload", () => {
      expect(runFactsOfPayload(PAYLOAD)).toEqual({
        workflowRunId: "987654",
        runAttempt: 2,
        workflow: "CI",
        event: "pull_request",
        headSha: "a".repeat(40),
        headBranch: "feature-branch",
        runStartedAt: "2026-08-17T20:30:00Z",
        fork: false,
        actorId: "5453321",
      });
    });

    it("returns fork for a differing head repository, and for a payload without both names", () => {
      const forked = structuredClone(PAYLOAD);
      forked.workflow_run.head_repository.full_name = "attacker/labs";
      expect(runFactsOfPayload(forked).fork).toBe(true);
      const bare = structuredClone(PAYLOAD) as {
        workflow_run: Record<string, unknown>;
      };
      delete bare.workflow_run.head_repository;
      expect(runFactsOfPayload(bare).fork).toBe(true);
    });

    it("throws for a payload with no run facts", () => {
      expect(() => runFactsOfPayload({})).toThrow();
    });
  });

  describe("shouldShipRun()", () => {
    const members = new Set(["5453321", "12029"]);

    it("returns true for a same-repository run whatever the actor", () => {
      const run = runFactsOfPayload(PAYLOAD);
      expect(shouldShipRun(run, members)).toBe(true);
      expect(shouldShipRun(run, new Set<string>())).toBe(true);
    });

    it("returns true for a fork run by a listed member", () => {
      const forked = structuredClone(PAYLOAD);
      forked.workflow_run.head_repository.full_name = "octocat/labs";
      expect(shouldShipRun(runFactsOfPayload(forked), members)).toBe(true);
    });

    it("returns false for a fork run by an unlisted actor", () => {
      const forked = structuredClone(PAYLOAD);
      forked.workflow_run.head_repository.full_name = "someone/labs";
      forked.workflow_run.actor = { login: "someone", id: 999999999 };
      expect(shouldShipRun(runFactsOfPayload(forked), members)).toBe(false);
    });

    it("returns false for a fork run with no readable actor, and with an empty list", () => {
      const forked = structuredClone(PAYLOAD) as {
        workflow_run: Record<string, unknown>;
      };
      (forked.workflow_run.head_repository as { full_name: string })
        .full_name = "someone/labs";
      delete forked.workflow_run.actor;
      expect(shouldShipRun(runFactsOfPayload(forked), members)).toBe(false);
      const memberFork = structuredClone(PAYLOAD);
      memberFork.workflow_run.head_repository.full_name = "octocat/labs";
      expect(
        shouldShipRun(runFactsOfPayload(memberFork), new Set<string>()),
      ).toBe(false);
    });
  });

  describe("composeCiContext()", () => {
    it("takes run identity from the payload and machine facts from the artifact", () => {
      const context = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        {
          job: "Test (3/8)",
          shard: "3/8",
          commit: "b".repeat(40),
          os: "linux",
          arch: "x86_64",
          denoVersion: "2.9.4",
        },
        "test-records-test-3",
      );
      expect(context.commit).toBe("b".repeat(40));
      expect(context.ci?.job).toBe("Test (3/8)");
      expect(context.ci?.shard).toBe("3/8");
      expect(context.ci?.headCommit).toBe("a".repeat(40));
      expect(context.branch).toBe("feature-branch");
      expect(context.startedAt).toBe("2026-08-17T20:30:00Z");
      expect(context.env).toBe("ci");
      expect(context.dirty).toBe(false);
      expect(context.ci?.event).toBe("pull_request");
      expect(context.ci?.fork).toBe(false);
    });

    it("carries the seed the job shuffled by, and none it did not report", () => {
      const seeded = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        { shuffleSeed: 20260922 },
        "test-records-check",
      );
      expect(seeded.shuffleSeed).toBe(20260922);
      const unseeded = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        {},
        "test-records-check",
      );
      expect(Object.hasOwn(unseeded, "shuffleSeed")).toBe(false);
    });

    it("takes the producing attempt from the artifact name suffix", () => {
      const context = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        {},
        "test-records-check-a1",
      );
      expect(context.ci?.runAttempt).toBe(1);
      const unsuffixed = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        {},
        "test-records-check",
      );
      expect(unsuffixed.ci?.runAttempt).toBe(2);
    });

    it("falls back to the artifact name when job.json is missing", () => {
      const context = composeCiContext(
        runFactsOfPayload(PAYLOAD),
        {},
        "test-records-check",
      );
      expect(context.ci?.job).toBe("test-records-check");
      expect(context.commit).toBe("a".repeat(40));
      expect(context.os).toBe("unknown");
    });

    it("records no head commit for a push run", () => {
      const push = structuredClone(PAYLOAD);
      push.workflow_run.event = "push";
      const context = composeCiContext(
        runFactsOfPayload(push),
        {},
        "test-records-check",
      );
      expect(context.ci?.headCommit).toBeUndefined();
    });
  });

  describe("relayArtifacts()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-relay-" });
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    });

    it("ships one deterministic object per artifact directory", async () => {
      const artifact = join(dir, "test-records-check");
      await Deno.mkdir(artifact);
      await Deno.writeTextFile(
        join(artifact, "job.json"),
        JSON.stringify({
          job: "Check",
          commit: "b".repeat(40),
          os: "linux",
          arch: "x86_64",
          denoVersion: "2.9.4",
          shuffleSeed: 20260922,
        }),
      );
      await Deno.writeTextFile(
        join(artifact, "records.ndjson"),
        '{"line":"record","test":{"k":"gate","s":"repo","n":"check-docs"},' +
          '"outcome":"pass","durationMs":1500}\n' +
          "not a record\n",
      );

      const requests: { url: string; body: Uint8Array }[] = [];
      const failed = await relayArtifacts({
        artifactsDir: dir,
        run: runFactsOfPayload(PAYLOAD),
        bucket: "cf-ci-metadata",
        prefix: "labs/test-records/submissions/ci",
        token: "token-1",
        fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
          requests.push({
            url: String(input),
            body: init?.body as Uint8Array,
          });
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as typeof fetch,
      });

      expect(failed).toEqual([]);
      expect(requests.length).toBe(1);
      const bytes = requests[0]!.body;
      const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(
        bytes,
      );
      expect(bodyText).toContain(
        '"name":"labs/test-records/submissions/ci/v1/2026/08/17/' +
          'run-987654-test-records-check.ndjson"',
      );
      // The gzip payload sits between the second blank line and the final
      // boundary; find both in bytes, since character indexes drift on
      // binary content.
      const indexOfBytes = (needle: string, from: number): number => {
        const pattern = new TextEncoder().encode(needle);
        outer: for (let i = from; i <= bytes.length - pattern.length; i++) {
          for (let j = 0; j < pattern.length; j++) {
            if (bytes[i + j] !== pattern[j]) continue outer;
          }
          return i;
        }
        return -1;
      };
      const firstBlank = indexOfBytes("\r\n\r\n", 0);
      const payloadStart = indexOfBytes("\r\n\r\n", firstBlank + 4) + 4;
      let payloadEnd = -1;
      for (let i = bytes.length - 4; i >= 0; i--) {
        if (indexOfBytes("\r\n--", i) === i) {
          payloadEnd = i;
          break;
        }
      }
      const gzipped = bytes.slice(payloadStart, payloadEnd);
      const ndjson = await gunzipToText(gzipped);
      const lines = ndjson.trimEnd().split("\n");
      expect(lines.length).toBe(2);
      const context = JSON.parse(lines[0]!);
      expect(context.line).toBe("context");
      expect(context.ci.job).toBe("Check");
      expect(context.shuffleSeed).toBe(20260922);
      expect(JSON.parse(lines[1]!).test.n).toBe("check-docs");
    });

    it("returns the names of artifacts whose create failed", async () => {
      await Deno.mkdir(join(dir, "test-records-bad"));
      await Deno.writeTextFile(
        join(dir, "test-records-bad", "records.ndjson"),
        "",
      );
      const failed = await relayArtifacts({
        artifactsDir: dir,
        run: runFactsOfPayload(PAYLOAD),
        bucket: "b",
        prefix: "p",
        token: "t",
        fetch: (() =>
          Promise.resolve(
            new Response("denied", { status: 403 }),
          )) as typeof fetch,
      });
      expect(failed).toEqual(["test-records-bad"]);
    });

    it("fails an artifact with no records file rather than ship it empty", async () => {
      await Deno.mkdir(join(dir, "test-records-truncated"));
      let fetched = 0;
      const failed = await relayArtifacts({
        artifactsDir: dir,
        run: runFactsOfPayload(PAYLOAD),
        bucket: "b",
        prefix: "p",
        token: "t",
        fetch: (() => {
          fetched++;
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as typeof fetch,
      });
      expect(failed).toEqual(["test-records-truncated"]);
      expect(fetched).toBe(0);
    });

    it("treats an existing object as shipped", async () => {
      await Deno.mkdir(join(dir, "test-records-dup"));
      await Deno.writeTextFile(
        join(dir, "test-records-dup", "records.ndjson"),
        "",
      );
      const failed = await relayArtifacts({
        artifactsDir: dir,
        run: runFactsOfPayload(PAYLOAD),
        bucket: "b",
        prefix: "p",
        token: "t",
        fetch: (() =>
          Promise.resolve(
            new Response("precondition", { status: 412 }),
          )) as typeof fetch,
      });
      expect(failed).toEqual([]);
    });
  });

  describe("parseRelayArgs()", () => {
    it("returns the directories of a full command line", () => {
      expect(parseRelayArgs(["--artifacts", "d", "--run-json", "r.json"]))
        .toEqual({ artifactsDir: "d", runJson: "r.json" });
      expect(parseRelayArgs(["--artifacts", "d"]))
        .toEqual({ artifactsDir: "d" });
    });

    it("returns undefined for malformed command lines", () => {
      expect(parseRelayArgs([])).toBeUndefined();
      expect(parseRelayArgs(["--artifacts"])).toBeUndefined();
      expect(parseRelayArgs(["--mystery", "x"])).toBeUndefined();
      expect(parseRelayArgs(["--run-json", "r.json"])).toBeUndefined();
    });
  });

  describe("memberActorIdsOf()", () => {
    it("splits, trims, and drops empty entries", () => {
      const ids = memberActorIdsOf((name) =>
        name === "TEST_RECORDS_MEMBER_ACTOR_IDS" ? " 1, 22 ,,333 " : undefined
      );
      expect([...ids].sort()).toEqual(["1", "22", "333"]);
      expect(memberActorIdsOf(() => undefined).size).toBe(0);
    });
  });

  describe("runRelay()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-relay-run-" });
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    });

    async function writePayload(payload: unknown): Promise<string> {
      const path = join(dir, "payload.json");
      await Deno.writeTextFile(path, JSON.stringify(payload));
      return path;
    }

    it("ships a same-repository run and returns zero", async () => {
      const artifacts = join(dir, "artifacts");
      await Deno.mkdir(join(artifacts, "test-records-check"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(artifacts, "test-records-check", "records.ndjson"),
        "",
      );
      let created = 0;
      const code = await runRelay({
        artifactsDir: artifacts,
        runJson: await writePayload(PAYLOAD),
        env: (name) =>
          name === "TEST_RECORDS_GCS_TOKEN" ? "token-1" : undefined,
        fetchImpl: (() => {
          created++;
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as typeof fetch,
      });
      expect(code).toBe(0);
      expect(created).toBe(1);
    });

    it("ships nothing for a fork run by an unlisted actor", async () => {
      const forkPayload = structuredClone(PAYLOAD) as {
        workflow_run: Record<string, unknown>;
      };
      forkPayload.workflow_run.head_repository = { full_name: "fork/labs" };
      forkPayload.workflow_run.actor = { id: 999 };
      const code = await runRelay({
        artifactsDir: join(dir, "absent"),
        runJson: await writePayload(forkPayload),
        env: (name) =>
          name === "TEST_RECORDS_MEMBER_ACTOR_IDS" ? "1,2" : undefined,
        fetchImpl: (() => {
          throw new Error("nothing must ship");
        }) as unknown as typeof fetch,
      });
      expect(code).toBe(0);
    });

    it("returns one when an artifact fails to ship", async () => {
      const artifacts = join(dir, "artifacts");
      await Deno.mkdir(join(artifacts, "test-records-truncated"), {
        recursive: true,
      });
      const code = await runRelay({
        artifactsDir: artifacts,
        runJson: await writePayload(PAYLOAD),
        env: (name) =>
          name === "TEST_RECORDS_GCS_TOKEN" ? "token-1" : undefined,
      });
      expect(code).toBe(1);
    });

    it("throws without a payload or a token", async () => {
      await expect(runRelay({
        artifactsDir: dir,
        env: () => undefined,
      })).rejects.toThrow("no event payload");
      await expect(runRelay({
        artifactsDir: dir,
        runJson: await writePayload(PAYLOAD),
        env: () => undefined,
      })).rejects.toThrow("TEST_RECORDS_GCS_TOKEN");
    });
  });
});
