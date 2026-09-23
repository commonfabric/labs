import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";

import {
  buildLocalContext,
  finishRunRecording,
  readPersonalKey,
  recordingChildEnv,
  shipSpool,
  startRunRecording,
  sweepSpools,
} from "./test-records.ts";
import {
  createRunSpool,
  FragmentWriter,
  gunzipToText,
  listSpools,
  RECORD_SCHEMA_VERSION,
  type RunContext,
} from "@commonfabric/test-support/records";

const KEY = {
  client_email: "test-records-gh-octocat@proj.iam.gserviceaccount.com",
  private_key: "unused by the stub transport",
  token_uri: "https://oauth2.googleapis.com/token",
  cf_username: "octocat",
};

const CONTEXT: RunContext = {
  schema: RECORD_SCHEMA_VERSION,
  line: "context",
  reportId: "01SHIPTEST00000000000000",
  repo: "commonfabric/labs",
  commit: "d".repeat(40),
  dirty: false,
  branch: "main",
  env: "local",
  os: "darwin",
  arch: "aarch64",
  denoVersion: "2.9.4",
  startedAt: "2026-08-17T22:00:00.000Z",
};

function okFetch(
  requests: { url: string; body: Uint8Array }[],
): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body as Uint8Array });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
}

describe("test-records", () => {
  let root: string;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "test-records-owner-" });
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  });

  describe("buildLocalContext()", () => {
    it("returns this repository's commit, branch, and machine facts", async () => {
      const context = await buildLocalContext(Deno.cwd(), () => undefined);
      expect(context.repo).toBe("commonfabric/labs");
      expect(context.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(context.env).toBe("local");
      expect(context.denoVersion).toBe(Deno.version.deno);
      expect(context.agent).toBeUndefined();
    });

    it("carries the agent label when the variable is set", async () => {
      const context = await buildLocalContext(
        Deno.cwd(),
        (name) => name === "CF_TEST_AGENT" ? "probe-agent" : undefined,
      );
      expect(context.agent).toBe("probe-agent");
    });

    it("carries the branch when the checkout is on one", async () => {
      // The ambient checkout cannot drive this either way: continuous
      // integration builds a pull request from a detached merge commit, where
      // `git branch --show-current` is empty and the branch is left off. A
      // scratch repository on a named branch reaches it on every run.
      const repo = await Deno.makeTempDir({ prefix: "test-records-branch-" });
      try {
        const git = async (...args: string[]) => {
          const result = await new Deno.Command("git", {
            args: ["-C", repo, ...args],
            stdout: "null",
            stderr: "null",
          }).output();
          expect(result.success).toBe(true);
        };
        await git("init", "-b", "probe-branch");
        await git("config", "user.name", "Probe");
        await git("config", "user.email", "probe@example.invalid");
        await Deno.writeTextFile(`${repo}/probe.txt`, "probe\n");
        await git("add", "probe.txt");
        await git("commit", "-m", "probe");

        const context = await buildLocalContext(repo, () => undefined);
        expect(context.branch).toBe("probe-branch");
      } finally {
        await Deno.remove(repo, { recursive: true });
      }
    });

    it("stamps the seed of the commit it read, or the one the environment names", async () => {
      const repo = await Deno.makeTempDir({ prefix: "test-records-seed-" });
      try {
        const git = async (...args: string[]) => {
          const result = await new Deno.Command("git", {
            args: ["-C", repo, ...args],
            // Late on the 21st in the Pacific zone and early on the 22nd
            // in UTC, so reading the wrong zone reads the wrong day.
            env: { GIT_COMMITTER_DATE: "2026-09-21T23:30:00-07:00" },
            stdout: "null",
            stderr: "null",
          }).output();
          expect(result.success).toBe(true);
        };
        await git("init");
        await git("config", "user.name", "Probe");
        await git("config", "user.email", "probe@example.invalid");
        await Deno.writeTextFile(`${repo}/probe.txt`, "probe\n");
        await git("add", "probe.txt");
        await git("commit", "-m", "probe");

        const fromCommit = await buildLocalContext(repo, () => undefined);
        expect(fromCommit.shuffleSeed).toBe(20260921);
        const overridden = await buildLocalContext(
          repo,
          (name) => name === "CF_TEST_SHUFFLE_SEED" ? "7" : undefined,
        );
        expect(overridden.shuffleSeed).toBe(7);
      } finally {
        await Deno.remove(repo, { recursive: true });
      }
    });

    it("falls back to unknown facts outside a repository", async () => {
      const context = await buildLocalContext(root, () => undefined);
      expect(context.commit).toBe("unknown");
      expect(context.branch).toBeUndefined();
      expect(context.dirty).toBe(false);
    });
  });

  describe("readPersonalKey()", () => {
    it("returns undefined with the variable unset", () => {
      expect(readPersonalKey(() => undefined)).toBeUndefined();
    });

    it("returns undefined for an unreadable key path", () => {
      expect(
        readPersonalKey((name) =>
          name === "CF_TEST_RECORDS_KEY_FILE"
            ? join(root, "absent.json")
            : undefined
        ),
      ).toBeUndefined();
    });

    it("returns undefined for a file that is not a key", async () => {
      const path = join(root, "not-a-key.json");
      await Deno.writeTextFile(path, "{}");
      expect(
        readPersonalKey((name) =>
          name === "CF_TEST_RECORDS_KEY_FILE" ? path : undefined
        ),
      ).toBeUndefined();
    });
  });

  describe("startRunRecording()", () => {
    it("joins an enclosing run when the records variable is set", async () => {
      const recording = await startRunRecording((name) =>
        name === "CF_TEST_RECORDS_DIR" ? "/some/spool" : undefined
      );
      expect(recording).toEqual({ mode: "join", dir: "/some/spool" });
      expect(recordingChildEnv(recording)).toEqual({});
    });

    it("is off when the spool root cannot be created", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const blocking = join(root, "blocking-file");
      await Deno.writeTextFile(blocking, "not a directory");
      const recording = await startRunRecording((name) => {
        if (name === "CF_TEST_RECORDS_KEY_FILE") return keyPath;
        if (name === "CF_TEST_RECORDS_SPOOL_ROOT") {
          return join(blocking, "root");
        }
        return undefined;
      });
      expect(recording).toEqual({ mode: "off" });
    });

    it("is off when no spool root can be derived at all", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const recording = await startRunRecording((name) =>
        name === "CF_TEST_RECORDS_KEY_FILE" ? keyPath : undefined
      );
      expect(recording).toEqual({ mode: "off" });
    });

    it("is off with neither a run nor a key", async () => {
      const recording = await startRunRecording(() => undefined);
      expect(recording).toEqual({ mode: "off" });
    });

    it("owns a run when a key file is present", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const recording = await startRunRecording((name) => {
        if (name === "CF_TEST_RECORDS_KEY_FILE") return keyPath;
        if (name === "CF_TEST_RECORDS_SPOOL_ROOT") return root;
        return undefined;
      });
      assert(recording.mode === "own");
      expect(recordingChildEnv(recording)).toEqual({
        CF_TEST_RECORDS_DIR: recording.spool.dir,
      });
      recording.spool.close();
    });
  });

  describe("shipSpool()", () => {
    it("leaves a spool with no readable context in place", async () => {
      const dir = join(root, "run-01NOCONTEXT0000000000000");
      await Deno.mkdir(dir);
      const shipped = await shipSpool(dir, KEY, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch([]),
      });
      expect(shipped).toBe(false);
      expect((await listSpools(root)).length).toBe(1);
    });

    it("uploads one gzipped object under the holder's prefix and deletes the spool", async () => {
      const spool = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(spool.dir);
      writer?.append({
        line: "record",
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        outcome: "pass",
        durationMs: 3,
      });
      writer?.close();
      spool.close();

      const requests: { url: string; body: Uint8Array }[] = [];
      const shipped = await shipSpool(spool.dir, KEY, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(shipped).toBe(true);
      expect(requests.length).toBe(1);
      const bodyText = new TextDecoder().decode(requests[0]!.body);
      expect(bodyText).toContain(
        '"name":"labs/test-records/submissions/local/octocat/' +
          'v1/2026/08/17/01SHIPTEST00000000000000-main.ndjson"',
      );
      expect(await listSpools(root)).toEqual([]);
    });

    it("leaves the spool in place when the create fails", async () => {
      const spool = await createRunSpool(root, CONTEXT);
      spool.close();
      const shipped = await shipSpool(spool.dir, KEY, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: (() =>
          Promise.resolve(
            new Response("denied", { status: 403 }),
          )) as typeof fetch,
      });
      expect(shipped).toBe(false);
      expect((await listSpools(root)).length).toBe(1);
    });
  });

  describe("sweepSpools()", () => {
    it("ships released spools and skips the one it owns", async () => {
      const orphan = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01ORPHAN0000000000000000",
      });
      orphan.close();
      const own = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01OWNED00000000000000000",
      });

      const requests: { url: string; body: Uint8Array }[] = [];
      await sweepSpools(root, KEY, own.dir, () => undefined, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(requests.length).toBe(1);
      expect(await listSpools(root)).toEqual([own.dir]);
      own.close();
    });
  });

  describe("finishRunRecording()", () => {
    it("ships the owned spool and sweeps the root", async () => {
      const keyPath = join(root, "key.json");
      await Deno.writeTextFile(keyPath, JSON.stringify(KEY));
      const env = (name: string) => {
        if (name === "CF_TEST_RECORDS_KEY_FILE") return keyPath;
        if (name === "CF_TEST_RECORDS_SPOOL_ROOT") return root;
        return undefined;
      };
      const recording = await startRunRecording(env);
      assert(recording.mode === "own");

      const requests: { url: string; body: Uint8Array }[] = [];
      await finishRunRecording(recording, env, {
        mintToken: () => Promise.resolve("stub-token"),
        fetchImpl: okFetch(requests),
      });
      expect(requests.length).toBe(1);
      const gzipStart = findGzipStart(requests[0]!.body);
      const ndjson = await gunzipToText(requests[0]!.body.slice(
        gzipStart.start,
        gzipStart.end,
      ));
      const context = JSON.parse(ndjson.trimEnd().split("\n")[0]!);
      expect(context.line).toBe("context");
      expect(context.env).toBe("local");
      expect(await listSpools(root)).toEqual([]);
    });
  });
});

/** Byte offsets of the multipart payload between headers and tail. */
function findGzipStart(bytes: Uint8Array): { start: number; end: number } {
  const pattern = new TextEncoder().encode("\r\n\r\n");
  const matches: number[] = [];
  outer: for (let i = 0; i <= bytes.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    matches.push(i);
  }
  const tail = new TextEncoder().encode("\r\n--");
  let end = -1;
  outer: for (let i = bytes.length - tail.length; i >= 0; i--) {
    for (let j = 0; j < tail.length; j++) {
      if (bytes[i + j] !== tail[j]) continue outer;
    }
    end = i;
    break;
  }
  return { start: matches[1]! + 4, end };
}
