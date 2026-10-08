import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import { join } from "@std/path";

import {
  type LocalJob,
  type LocalJobEvent,
  type LocalJobRequest,
  LocalJobStore,
  RUNNER_RESTARTED,
} from "../../src/local-jobs/store.ts";

/** A request with plain inputs. */
const request = (task = "Name a moon of Saturn."): LocalJobRequest => ({
  task,
  resultSchema: { type: "object", properties: { answer: { type: "string" } } },
});

/** Helper for tests, which narrows an enqueue to the job it added. */
const added = (
  result: ReturnType<LocalJobStore["enqueue"]>,
): { job: LocalJob; created: boolean } => {
  if ("conflict" in result) throw new Error(result.conflict);
  return result;
};

/** Helper for tests, which opens an in-memory store on a fixed clock. */
const openStore = () => {
  let tick = 0;
  let id = 0;
  return LocalJobStore.open(":memory:", {
    now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)),
    newId: () => `job-${++id}`,
  });
};

describe("local-jobs/store", () => {
  describe("enqueue()", () => {
    it("adds a queued job with its first event", () => {
      const store = openStore();
      const { job, created } = added(store.enqueue(
        "cfs:weaver",
        "ask",
        "key-1",
        request(),
      ));

      expect(created).toBe(true);
      expect(job).toMatchObject({
        id: "job-1",
        caller: "cfs:weaver",
        profile: "ask",
        idempotencyKey: "key-1",
        request: request(),
        state: "queued",
        seq: 1,
        commands: [],
        createdAt: "2026-10-05T12:00:00.000Z",
      });
      expect(store.events("job-1")).toEqual([{
        seq: 1,
        at: "2026-10-05T12:00:00.000Z",
        kind: "state",
        body: { state: "queued" },
      }]);
    });

    it("returns the existing job for a key resent with the same request, whatever its key order", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "key-1", {
        task: "t",
        resultSchema: { type: "object", required: ["a"] },
      });

      const again = added(store.enqueue("cfs:weaver", "ask", "key-1", {
        resultSchema: { required: ["a"], type: "object" },
        task: "t",
      }));

      expect(again.created).toBe(false);
      expect(again.job.id).toBe("job-1");
      expect(store.list(10)).toHaveLength(1);
    });

    it("compares nested JSON values independently of object key order but preserves array order", () => {
      const store = openStore();
      const original = {
        ...request(),
        context: { outer: { b: [1, 2], a: { x: "yes", y: 3 } } },
      };
      try {
        store.enqueue("c", "ask", "k", original);
        expect(
          added(
            store.enqueue("c", "ask", "k", {
              ...original,
              context: { outer: { a: { y: 3, x: "yes" }, b: [1, 2] } },
            }),
          ).created,
        ).toBe(false);
        expect(
          store.enqueue("c", "ask", "k", {
            ...original,
            context: { outer: { b: [2, 1], a: { x: "yes", y: 3 } } },
          }),
        ).toHaveProperty("conflict");
        expect(
          store.enqueue("c", "ask", "k", {
            ...original,
            context: { outer: { b: [1, 2], a: { x: "no", y: 3 } } },
          }),
        ).toHaveProperty("conflict");
      } finally {
        store.close();
      }
    });

    it("compares the JSON-normalized request and retries a stored sorted row after reopening", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-hash-" });
      const path = join(dir, "jobs.sqlite");
      let store = LocalJobStore.open(path);
      const original = {
        ...request(),
        context: {
          missing: undefined,
          negativeZero: -0,
          infinite: Infinity,
          array: [undefined, 1],
        },
      };
      try {
        const job = added(store.enqueue("c", "ask", "k", original)).job;
        expect(
          added(
            store.enqueue(
              "c",
              "ask",
              "k",
              JSON.parse(JSON.stringify(original)),
            ),
          ).job.id,
        ).toBe(job.id);
        store.close();
        const db = new Database(path);
        try {
          const sorted = JSON.stringify(
            original,
            (_key, value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(
                  Object.keys(value).sort().map((key) => [key, value[key]]),
                )
                : value,
          );
          db.prepare("UPDATE jobs SET request_json = ? WHERE id = ?").run(
            sorted,
            job.id,
          );
        } finally {
          db.close();
        }
        store = LocalJobStore.open(path);
        expect(added(store.enqueue("c", "ask", "k", original)).job.id).toBe(
          job.id,
        );
      } finally {
        store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns a conflict, adding nothing, for a key resent with a different request or profile", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "key-1", request());

      expect(store.enqueue("cfs:weaver", "ask", "key-1", request("x")))
        .toEqual({
          conflict:
            "The idempotency key `key-1` already names a different request.",
        });
      expect(store.enqueue("cfs:weaver", "other", "key-1", request()))
        .toHaveProperty("conflict");
      expect(store.list(10)).toHaveLength(1);
    });

    it("keeps one caller's keys apart from another's", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "key-1", request());

      const other = added(
        store.enqueue("moments", "ask", "key-1", request("x")),
      );

      expect(other.created).toBe(true);
    });

    it("records the job a request continues, and none for one that continues nothing", () => {
      const store = openStore();
      const parent = added(store.enqueue("cfs:weaver", "ask", "a", request()));

      const child = added(store.enqueue("cfs:weaver", "ask", "b", {
        ...request("And Titan?"),
        continues: parent.job.id,
      }));

      expect(child.job.continues).toBe(parent.job.id);
      expect(child.job.request.continues).toBe(parent.job.id);
      expect(store.get(parent.job.id)).not.toHaveProperty("continues");
      expect(store.list(10).map((job) => job.continues)).toEqual([
        parent.job.id,
        undefined,
      ]);
    });

    it("throws, adding nothing, for a request continuing a job it does not hold", () => {
      const store = openStore();

      expect(() =>
        store.enqueue("cfs:weaver", "ask", "a", {
          ...request(),
          continues: "job-missing",
        })
      ).toThrow();
      expect(store.list(10)).toEqual([]);
    });

    it("compares what a request continues as part of the request", () => {
      const store = openStore();
      const first = added(store.enqueue("c", "ask", "p1", request())).job.id;
      const second = added(store.enqueue("c", "ask", "p2", request())).job.id;
      store.enqueue("c", "ask", "k", { ...request(), continues: first });

      expect(
        added(
          store.enqueue("c", "ask", "k", { ...request(), continues: first }),
        )
          .created,
      ).toBe(false);
      expect(
        store.enqueue("c", "ask", "k", { ...request(), continues: second }),
      )
        .toHaveProperty("conflict");
      expect(store.enqueue("c", "ask", "k", request())).toHaveProperty(
        "conflict",
      );
    });
  });

  describe("reading", () => {
    it("returns `undefined` for a job it does not hold", () => {
      expect(openStore().get("job-404")).toBeUndefined();
    });

    it("lists the newest jobs first, at most `limit`", () => {
      const store = openStore();
      for (const key of ["a", "b", "c"]) {
        store.enqueue("cfs:weaver", "ask", key, request());
      }

      expect(store.list(2).map((job) => job.idempotencyKey)).toEqual([
        "c",
        "b",
      ]);
    });

    it("returns the events after a `seq`", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();

      expect(store.events("job-1", 1).map((event) => event.body)).toEqual([
        { state: "running" },
      ]);
    });
  });

  describe("claimNext()", () => {
    it("starts the oldest queued job, and returns `undefined` with none left", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.enqueue("cfs:weaver", "ask", "b", request());

      expect(store.claimNext()?.idempotencyKey).toBe("a");
      expect(store.claimNext()).toMatchObject({
        idempotencyKey: "b",
        state: "running",
        startedAt: expect.any(String),
      });
      expect(store.claimNext()).toBeUndefined();
    });
  });

  describe("report()", () => {
    it("appends a running job's steps and commands to its view", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();

      store.report("job-1", "step", { turn: 1, tool: "list_commands" });
      store.report("job-1", "command", { command: "loom.compose", ok: true });
      store.report("job-1", "step", { turn: 2, tool: "submit_result" });

      expect(store.get("job-1")).toMatchObject({
        seq: 5,
        step: { turn: 2, tool: "submit_result" },
        commands: [{ command: "loom.compose", ok: true }],
      });
    });

    it("appends nothing for a job that is not running", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());

      expect(store.report("job-1", "step", { tool: "x" })).toBeUndefined();
      expect(store.report("job-404", "step", { tool: "x" })).toBeUndefined();
      expect(store.get("job-1")?.seq).toBe(1);
    });
  });

  describe("requestCancel()", () => {
    it("ends a queued job `cancelled` at once", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());

      expect(store.requestCancel("job-1")).toMatchObject({
        state: "cancelled",
        cancelRequestedAt: expect.any(String),
        finishedAt: expect.any(String),
      });
      expect(store.claimNext()).toBeUndefined();
    });

    it("marks a running job, once, and leaves it to end when its run stops", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();

      const marked = store.requestCancel("job-1");
      store.requestCancel("job-1");

      expect(marked?.state).toBe("running");
      expect(marked?.cancelRequestedAt).toBeDefined();
      expect(store.events("job-1", 2).map((event) => event.kind)).toEqual([
        "cancel",
      ]);
    });

    it("leaves an ended job as it is, and returns `undefined` for an unknown one", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();
      store.finish("job-1", { state: "completed", result: { answer: "x" } });

      expect(store.requestCancel("job-1")?.state).toBe("completed");
      expect(store.requestCancel("job-404")).toBeUndefined();
    });
  });

  describe("finish()", () => {
    /** Helper for tests, which enqueues and claims one job. */
    const running = () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();
      return store;
    };

    it("ends a running job `completed` with its result and report", () => {
      const store = running();

      const job = store.finish("job-1", {
        state: "completed",
        result: { answer: "Titan" },
        errorCode: "IGNORED",
        report: { modelTurns: 2 },
      });

      expect(job).toMatchObject({
        state: "completed",
        result: { answer: "Titan" },
        report: { modelTurns: 2 },
        finishedAt: expect.any(String),
      });
      expect(job?.errorCode).toBeUndefined();
      expect(store.events("job-1", 2).map((event) => event.body)).toEqual([
        { state: "completed" },
      ]);
    });

    it("ends a running job `failed` with its error code", () => {
      const store = running();

      const job = store.finish("job-1", {
        state: "failed",
        errorCode: "LIMIT_REACHED",
      });

      expect(job).toMatchObject({
        state: "failed",
        errorCode: "LIMIT_REACHED",
      });
      expect(job?.result).toBeUndefined();
      expect(store.events("job-1", 2)[0].body).toEqual({
        state: "failed",
        errorCode: "LIMIT_REACHED",
      });
    });

    it("ends a job asked to stop `cancelled`, whatever its run reported", () => {
      const store = running();
      store.requestCancel("job-1");

      const job = store.finish("job-1", {
        state: "failed",
        errorCode: "PROVIDER_FAILURE",
      });

      expect(job?.state).toBe("cancelled");
      expect(job?.errorCode).toBeUndefined();
    });

    it("stores a completed job's missing result as `null`, and a failure without a code as none", () => {
      const store = running();
      expect(store.finish("job-1", { state: "completed" })?.result).toBeNull();

      const other = openStore();
      other.enqueue("cfs:weaver", "ask", "a", request());
      other.claimNext();
      expect(other.finish("job-1", { state: "failed" })?.errorCode)
        .toBeUndefined();
    });

    it("returns `undefined` for a job that is not running", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());

      expect(store.finish("job-1", { state: "completed" })).toBeUndefined();
      expect(store.get("job-1")?.state).toBe("queued");
    });
  });

  describe("recover()", () => {
    it("ends every running job `interrupted` and leaves queued ones to start", () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "a", request());
      store.enqueue("cfs:weaver", "ask", "b", request());
      store.claimNext();

      expect(store.recover()).toEqual(["job-1"]);
      expect(store.get("job-1")).toMatchObject({
        state: "interrupted",
        errorCode: RUNNER_RESTARTED,
      });
      expect(store.get("job-2")?.state).toBe("queued");
      expect(store.recover()).toEqual([]);
    });
  });

  describe("subscribe()", () => {
    it("tells a listener of each committed event until it stops", () => {
      const store = openStore();
      const seen: [string, LocalJobEvent][] = [];
      const stop = store.subscribe((id, event) => seen.push([id, event]));

      store.enqueue("cfs:weaver", "ask", "a", request());
      store.claimNext();
      store.recover();
      stop();
      store.enqueue("cfs:weaver", "ask", "b", request());

      expect(seen.map(([id, event]) => [id, event.seq, event.body.state]))
        .toEqual([
          ["job-1", 1, "queued"],
          ["job-1", 2, "running"],
          ["job-1", 3, "interrupted"],
        ]);
    });
  });

  describe("open()", () => {
    it("keeps refused command details in events and the job snapshot across a reopen", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-errors-" });
      try {
        const path = join(dir, "jobs.sqlite");
        const first = LocalJobStore.open(path);
        const { job } = added(
          first.enqueue("cfs:weaver", "ask", "a", request()),
        );
        first.claimNext();
        const command = {
          command: "loom.compose",
          ok: false,
          code: "bad-args",
          hostCode: "refused",
          error: "components must contain between 1 and 100 references",
        };
        first.report(job.id, "command", command);
        first.close();

        const second = LocalJobStore.open(path);
        try {
          expect(second.get(job.id)?.commands).toEqual([command]);
          expect(second.events(job.id, 2)[0].body).toEqual(command);
        } finally {
          second.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("keeps jobs across a reopen of the same file", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-store-" });
      try {
        const path = join(dir, "jobs.sqlite");
        const first = LocalJobStore.open(path);
        first.enqueue("cfs:weaver", "ask", "a", request());
        first.close();

        const second = LocalJobStore.open(path);
        expect(second.list(10).map((job) => job.idempotencyKey)).toEqual([
          "a",
        ]);
        expect(second.list(10)[0].id).toMatch(/^job-/);
        second.close();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("adds the lineage column to a store written before it existed, keeping its jobs", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-store-" });
      try {
        const path = join(dir, "jobs.sqlite");
        const before = new Database(path, { create: true });
        try {
          before.exec(`
            CREATE TABLE jobs (
              id TEXT PRIMARY KEY,
              caller TEXT NOT NULL,
              profile TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_json TEXT NOT NULL,
              state TEXT NOT NULL,
              cancel_requested_at TEXT,
              attempt INTEGER NOT NULL DEFAULT 0,
              result_json TEXT,
              error_code TEXT,
              report_json TEXT,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              UNIQUE (caller, idempotency_key)
            );
            INSERT INTO jobs (id, caller, profile, idempotency_key,
              request_json, state, result_json, created_at, finished_at)
            VALUES ('job-old', 'cfs:weaver', 'ask', 'a',
              '{"task":"Name a moon.","resultSchema":true}', 'completed',
              '{"answer":"Titan"}', '2026-10-01T00:00:00.000Z',
              '2026-10-01T00:01:00.000Z');
          `);
        } finally {
          before.close();
        }

        const store = LocalJobStore.open(path);
        try {
          const old = store.get("job-old");
          expect(old).toMatchObject({
            state: "completed",
            result: {
              answer: "Titan",
            },
          });
          expect(old).not.toHaveProperty("continues");
          const reply = added(store.enqueue("cfs:weaver", "ask", "b", {
            ...request("And Rhea?"),
            continues: "job-old",
          }));
          expect(reply.job.continues).toBe("job-old");
        } finally {
          store.close();
        }

        const reopened = LocalJobStore.open(path);
        try {
          expect(reopened.list(10).map((job) => job.continues)).toEqual([
            "job-old",
            undefined,
          ]);
        } finally {
          reopened.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws for a file that is not a database", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-store-" });
      try {
        const path = join(dir, "jobs.sqlite");
        await Deno.writeTextFile(path, "not a database ".repeat(100));

        expect(() => LocalJobStore.open(path)).toThrow();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
