import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { Database } from "@db/sqlite";
import { fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

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
  });

  describe("messages", () => {
    const body = (key: string, instructions?: string) => ({
      caller: "cfs:weaver",
      idempotencyKey: key,
      message: key,
      ...(instructions !== undefined ? { instructions } : {}),
    });
    const accept = (
      store: LocalJobStore,
      id: string,
      key: string,
      instructions?: string,
    ) => {
      const accepted = store.acceptMessage(id, body(key, instructions));
      if ("code" in accepted) throw new Error(accepted.code);
      return accepted;
    };
    const seed = () => {
      const store = openStore();
      store.enqueue("cfs:weaver", "ask", "initial", request());
      return store;
    };

    it("takes messages in acceptance order only while the holder is running", () => {
      const store = seed();
      try {
        accept(store, "job-1", "A");
        accept(store, "job-1", "B");
        expect(store.takeMessages("job-1", 1)).toEqual([]);
        store.claimNext();
        expect(store.takeMessages("job-1", 2)).toEqual(["A", "B"]);
        expect(store.takeMessages("job-1", 3)).toEqual([]);
        expect(store.get("job-1")?.messages).toMatchObject([{
          key: "A",
          delivery: "delivered",
          turn: 2,
        }, { key: "B", delivery: "delivered", turn: 2 }]);
      } finally {
        store.close();
      }
    });

    it("opens one follow-up and moves the remaining messages before the terminal event", () => {
      const store = seed();
      try {
        store.claimNext();
        accept(store, "job-1", "A");
        accept(store, "job-1", "B");
        const seen: [string, LocalJobEvent][] = [];
        store.subscribe((id, event) => seen.push([id, event]));
        store.finish("job-1", { state: "completed", recordedRun: true });
        expect(store.events("job-1").slice(-3).map((event) => event.body))
          .toEqual([
            { key: "A", delivery: "follow-up", jobId: "job-2" },
            { key: "B", delivery: "moved", jobId: "job-2" },
            { state: "completed" },
          ]);
        for (const id of ["job-1", "job-2"]) {
          expect(seen.filter(([job]) => job === id).map(([, event]) => event))
            .toEqual(store.events(id, id === "job-1" ? 4 : 0));
        }
        expect(store.get("job-1")).toMatchObject({
          continuedBy: "job-2",
          messages: [{ key: "A", delivery: "follow-up", jobId: "job-2" }, {
            key: "B",
            delivery: "pending",
            jobId: "job-2",
          }],
        });
        expect(store.get("job-2")).toMatchObject({
          continues: "job-1",
          openedBy: { key: "A" },
          messages: [{ key: "B" }],
        });
        store.claimNext();
        expect(store.takeMessages("job-2", 1)).toEqual(["B"]);
      } finally {
        store.close();
      }
    });

    it("notifies both listeners in per-job sequence order across reentrant writes", () => {
      const store = openStore();
      const first: [string, LocalJobEvent][] = [];
      const second: [string, LocalJobEvent][] = [];
      let claimed: string | undefined;
      let taken: string[] | undefined;
      try {
        store.subscribe((id, event) => {
          first.push([id, event]);
          if (
            event.kind === "state" && event.body.state === "queued" &&
            store.get(id)?.continues === "job-1"
          ) {
            claimed = store.claimNext()?.id;
            taken = store.takeMessages(id, 1);
            store.finish(id, { state: "completed", recordedRun: true });
          }
        });
        store.subscribe((id, event) => second.push([id, event]));
        store.enqueue("cfs:weaver", "ask", "initial", request());
        store.claimNext();
        accept(store, "job-1", "A");
        accept(store, "job-1", "B");
        accept(store, "job-1", "C");

        store.finish("job-1", { state: "completed", recordedRun: true });

        expect(claimed).toBe("job-2");
        expect(taken).toEqual(["B", "C"]);
        expect(store.get("job-2")?.state).toBe("completed");
        expect(first).toEqual(second);
        for (const seen of [first, second]) {
          for (const id of ["job-1", "job-2"]) {
            expect(seen.filter(([job]) => job === id).map(([, event]) => event))
              .toEqual(store.events(id));
          }
        }
        expect(
          store.events("job-2").map((event) =>
            event.body.delivery ?? event.body.state
          ),
        ).toEqual([
          "queued",
          "pending",
          "pending",
          "running",
          "delivered",
          "delivered",
          "completed",
        ]);
      } finally {
        store.close();
      }
    });

    it("notifies nothing on rollback and only committed events on the next write", () => {
      let fail = false;
      let clockCalls = 0;
      const store = LocalJobStore.open(":memory:", {
        now: () => {
          if (fail && ++clockCalls === 2) {
            throw new Error("second append failed");
          }
          return new Date("2026-10-05T12:00:00.000Z");
        },
      });
      const seen: [string, LocalJobEvent][] = [];
      try {
        const { job } = added(
          store.enqueue("cfs:weaver", "ask", "initial", request()),
        );
        store.claimNext();
        accept(store, job.id, "A");
        accept(store, job.id, "B");
        store.subscribe((id, event) => seen.push([id, event]));
        const before = store.get(job.id)!;
        const eventsBefore = store.events(job.id);

        fail = true;
        expect(() => store.takeMessages(job.id, 2)).toThrow(
          "second append failed",
        );

        expect(seen).toEqual([]);
        expect(store.get(job.id)).toEqual(before);
        expect(store.events(job.id)).toEqual(eventsBefore);

        fail = false;
        expect(store.takeMessages(job.id, 7)).toEqual(["A", "B"]);
        expect(seen).toEqual(
          store.events(job.id, before.seq).map((event) => [job.id, event]),
        );
        expect(seen.map(([, event]) => event.body)).toEqual([
          { key: "A", delivery: "delivered", turn: 7 },
          { key: "B", delivery: "delivered", turn: 7 },
        ]);
        expect(store.get(job.id)?.messages).toMatchObject([
          { key: "A", delivery: "delivered", turn: 7 },
          { key: "B", delivery: "delivered", turn: 7 },
        ]);
      } finally {
        store.close();
      }
    });

    for (const queuedC of [false, true]) {
      it(`keeps instruction replacements in separate follow-ups with C ${queuedC ? "accepted while queued" : "moved after cancellation"}`, () => {
        const store = seed();
        try {
          store.claimNext();
          accept(store, "job-1", "old");
          store.requestCancel("job-1");
          accept(store, "job-1", "A", "Framing A");
          accept(store, "job-1", "B", "Framing B");
          if (!queuedC) accept(store, "job-1", "C");
          expect(store.takeMessages("job-1", 2)).toEqual(["old"]);
          store.finish("job-1", { state: "cancelled", recordedRun: true });
          if (queuedC) accept(store, "job-1", "C");
          expect(store.get("job-2")?.request).toMatchObject({
            task: "A",
            instructions: "Framing A",
          });
          store.claimNext();
          expect(store.takeMessages("job-2", 1)).toEqual([]);
          store.finish("job-2", { state: "completed", recordedRun: true });
          expect(store.get("job-3")?.request).toMatchObject({
            task: "B",
            instructions: "Framing B",
          });
          store.claimNext();
          expect(store.takeMessages("job-3", 1)).toEqual(["C"]);
          expect(store.get("job-2")?.messages).toMatchObject([{
            key: "B",
            delivery: "follow-up",
            jobId: "job-3",
          }, { key: "C", delivery: "delivered", turn: 1, jobId: "job-3" }]);
        } finally {
          store.close();
        }
      });
    }

    it("clears the holder's post-cancel restriction when a plain message moves", () => {
      const store = seed();
      try {
        store.claimNext();
        store.requestCancel("job-1");
        accept(store, "job-1", "A");
        accept(store, "job-1", "B");
        expect(store.takeMessages("job-1", 1)).toEqual([]);
        store.finish("job-1", { state: "completed", recordedRun: true });
        store.claimNext();
        expect(store.takeMessages("job-2", 1)).toEqual(["B"]);
      } finally {
        store.close();
      }
    });

    for (
      const ending of [
        "queued cancel",
        "cancel",
        "profile failure",
        "recovery",
      ] as const
    ) {
      it(`drops waiting messages before the terminal event on ${ending}`, () => {
        const store = seed();
        try {
          if (ending !== "queued cancel") store.claimNext();
          accept(store, "job-1", "A");
          const seen: LocalJobEvent[] = [];
          store.subscribe((id, event) => {
            if (id === "job-1") seen.push(event);
          });
          if (ending === "queued cancel") store.requestCancel("job-1");
          else if (ending === "cancel") {
            store.requestCancel("job-1");
            accept(store, "job-1", "B");
            store.finish("job-1", { state: "cancelled" });
          } else if (ending === "recovery") store.recover();
          else {store.finish("job-1", {
              state: "failed",
              errorCode: "PROFILE_UNAVAILABLE",
            });}
          const reason = ending.includes("cancel")
            ? "cancelled"
            : ending === "recovery"
            ? "interrupted"
            : "not_continuable";
          expect(store.get("job-1")?.messages).toMatchObject([
            { key: "A", delivery: "dropped", reason },
            ...(ending === "cancel"
              ? [{ key: "B", delivery: "dropped", reason: "not_continuable" }]
              : []),
          ]);
          expect(seen).toEqual(
            store.events("job-1", ending === "queued cancel" ? 2 : 3),
          );
          expect(seen.at(-1)?.kind).toBe("state");
          expect(
            seen.slice(0, -1).filter((event) => event.kind === "message").at(-1)
              ?.body.delivery,
          ).toBe("dropped");
          expect(store.list(10)).toHaveLength(1);
        } finally {
          store.close();
        }
      });
    }

    it("keeps accepted messages, lineage and replay across a reopen", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-messages-" });
      const path = join(dir, "jobs.sqlite");
      let store = LocalJobStore.open(path);
      try {
        const id =
          added(store.enqueue("cfs:weaver", "ask", "initial", request())).job
            .id;
        store.claimNext();
        accept(store, id, "A");
        accept(store, id, "B");
        store.finish(id, { state: "completed", recordedRun: true });
        const view = store.get(id);
        const events = store.events(id);
        store.close();
        store = LocalJobStore.open(path);
        expect(store.get(id)).toEqual(view);
        expect(store.acceptMessage(id, body("A")))
          .toMatchObject({
            created: false,
            message: { delivery: "follow-up" },
            job: { continues: id },
          });
        expect(store.events(id)).toEqual(events);
        store.claimNext();
        expect(store.takeMessages(view!.continuedBy!, 1)).toEqual(["B"]);
      } finally {
        store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("opens an existing store without continuation columns idempotently", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-migrate-" });
      const path = join(dir, "jobs.sqlite");
      try {
        const legacy = new Database(path);
        legacy.exec(`CREATE TABLE jobs (
          id TEXT PRIMARY KEY, caller TEXT NOT NULL, profile TEXT NOT NULL,
          idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
          cancel_requested_at TEXT, attempt INTEGER NOT NULL DEFAULT 0,
          result_json TEXT, error_code TEXT, report_json TEXT, created_at TEXT NOT NULL,
          started_at TEXT, finished_at TEXT, UNIQUE(caller, idempotency_key)
        );`);
        legacy.prepare(
          `INSERT INTO jobs (id, caller, profile, idempotency_key, request_json, state, created_at)
          VALUES ('old', 'cfs:weaver', 'ask', 'old-key', :request, 'completed', '2026-01-01')`,
        ).run({ request: JSON.stringify(request()) });
        legacy.exec(`CREATE TABLE messages (
          seq INTEGER PRIMARY KEY, caller TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          target TEXT NOT NULL REFERENCES jobs(id), message TEXT NOT NULL, instructions TEXT,
          accepted_at TEXT NOT NULL, holder TEXT NOT NULL REFERENCES jobs(id),
          delivery TEXT NOT NULL, turn INTEGER, reason TEXT,
          opened_job TEXT REFERENCES jobs(id), after_cancel INTEGER NOT NULL DEFAULT 0,
          UNIQUE(caller, idempotency_key)
        );
        INSERT INTO messages(caller, idempotency_key, target, message, accepted_at, holder, delivery, turn)
        VALUES ('cfs:weaver', 'legacy-message', 'old', 'Legacy message', '2026-01-01', 'old', 'delivered', 1);`);
        legacy.close();
        for (let opening = 0; opening < 2; opening++) {
          const store = LocalJobStore.open(path);
          try {
            expect(store.get("old")).toMatchObject({
              state: "completed",
              request: request(),
              messages: [],
            });
            expect(store.acceptMessage("old", body("A")))
              .toMatchObject({ code: "not_continuable" });
            expect(store.acceptMessage("old", {
              caller: "cfs:weaver",
              idempotencyKey: "legacy-message",
              message: "Legacy message",
            })).toMatchObject({
              created: false,
              message: { delivery: "delivered", turn: 1 },
            });
            if (opening === 0) {
              const pending =
                added(store.enqueue("test", "ask", "running", request())).job;
              store.claimNext();
              store.recordRunRoot(pending.id, "/recorded/harness-run");
            }
            expect(store.runningRuns()).toEqual([{
              id: expect.any(String),
              runRoot: "/recorded/harness-run",
            }]);
          } finally {
            store.close();
          }
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("replays a dropped message after recovery without appending events", () => {
      const store = seed();
      try {
        store.claimNext();
        accept(store, "job-1", "A");
        store.recover();
        const events = store.events("job-1");
        expect(store.acceptMessage("job-1", body("A")))
          .toMatchObject({
            created: false,
            message: { delivery: "dropped", reason: "interrupted" },
            job: { state: "interrupted" },
          });
        expect(store.events("job-1")).toEqual(events);
      } finally {
        store.close();
      }
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
        errorDetail: "IGNORED",
        report: { modelTurns: 2 },
      });

      expect(job).toMatchObject({
        state: "completed",
        result: { answer: "Titan" },
        report: { modelTurns: 2 },
        finishedAt: expect.any(String),
      });
      expect(job?.errorCode).toBeUndefined();
      expect(job?.errorDetail).toBeUndefined();
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

    it("ends a running job `failed` with the detail of its error, in its view and its last event", () => {
      const store = running();

      const job = store.finish("job-1", {
        state: "failed",
        errorCode: "INVALID_RESULT",
        errorDetail: "no structured result was submitted",
      });

      expect(job).toMatchObject({
        state: "failed",
        errorCode: "INVALID_RESULT",
        errorDetail: "no structured result was submitted",
      });
      expect(store.events("job-1", 2)[0].body).toEqual({
        state: "failed",
        errorCode: "INVALID_RESULT",
        errorDetail: "no structured result was submitted",
      });
    });

    it("ends a job asked to stop `cancelled`, whatever its run reported", () => {
      const store = running();
      store.requestCancel("job-1");

      const job = store.finish("job-1", {
        state: "failed",
        errorCode: "PROVIDER_FAILURE",
        errorDetail: "the model failed",
      });

      expect(job?.state).toBe("cancelled");
      expect(job?.errorCode).toBeUndefined();
      expect(job?.errorDetail).toBeUndefined();
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
    it("recovers an acknowledged job after the writer is killed and preserves its idempotency key", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-killed-" });
      const path = join(dir, "jobs.sqlite");
      const module = new URL("../../src/local-jobs/store.ts", import.meta.url);
      try {
        const child = await runDenoCommandWithTemporaryLock({
          root: fromFileUrl(new URL("../../../../", import.meta.url)),
          args: () => [
            "eval",
            "--no-lock",
            `
            import { LocalJobStore } from ${JSON.stringify(module.href)};
            const store = LocalJobStore.open(${JSON.stringify(path)});
            const result = store.enqueue("caller", "read", "key", ${
              JSON.stringify(request())
            });
            await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(result)));
            Deno.kill(Deno.pid, "SIGKILL");
          `,
          ],
        });
        expect(child.signal).toBe("SIGKILL");
        const acknowledged = JSON.parse(new TextDecoder().decode(child.stdout));
        expect(acknowledged.created).toBe(true);
        const reopened = LocalJobStore.open(path);
        try {
          expect(reopened.get(acknowledged.job.id)).toMatchObject({
            state: "queued",
            request: request(),
            seq: 1,
          });
          expect(added(reopened.enqueue("caller", "read", "key", request())))
            .toMatchObject({
              created: false,
              job: { id: acknowledged.job.id },
            });
          expect(reopened.enqueue("caller", "read", "key", request("other")))
            .toHaveProperty("conflict");
          expect(reopened.list(10)).toHaveLength(1);
        } finally {
          reopened.close();
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("uses full synchronous WAL commits for acknowledged jobs", async () => {
      const dir = await Deno.makeTempDir({ prefix: "local-jobs-durable-" });
      const exec = spy(Database.prototype, "exec");
      let store: LocalJobStore | undefined;
      try {
        store = LocalJobStore.open(join(dir, "jobs.sqlite"));
        const database = exec.calls[0].self;
        expect(database?.prepare("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "wal",
        });
        expect(database?.prepare("PRAGMA synchronous").get()).toEqual({
          synchronous: 2,
        });
      } finally {
        exec.restore();
        store?.close();
        await Deno.remove(dir, { recursive: true });
      }
    });

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
