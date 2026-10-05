import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createLocalJobApi } from "../../lib/local-jobs/api.ts";
import type { LocalJobProfile } from "../../lib/local-jobs/profiles.ts";
import { LocalJobStore } from "../../lib/local-jobs/store.ts";

const TOKEN = "t0ken";

/** The `ask` profile requests name. */
const ASK: LocalJobProfile = {
  tools: ["loom_search", "run_command"],
  maxModelTurns: 24,
  taskRole: "direct-command",
  retry: "never",
};

/** A valid enqueue body. */
const BODY = {
  caller: "cfs:weaver",
  profile: "ask",
  idempotencyKey: "weaver-ask:1",
  task: "Make me a loom about Saturn.",
  instructions: "Answer briefly.",
  context: { screen: ["Saturn — loom"] },
  resultSchema: { type: "object" },
  tools: ["loom_search"],
  maxModelTurns: 12,
};

/** Helper for tests, which builds the API over an in-memory store. */
const apiWith = (
  options: { fabricLane?: () => boolean; heartbeatMs?: number } = {},
) => {
  const store = LocalJobStore.open(":memory:");
  const kicked: string[] = [];
  const cancelled: string[] = [];
  const stopping = new AbortController();
  const api = createLocalJobApi({
    store,
    profiles: new Map([["ask", ASK]]),
    token: TOKEN,
    kick: () => kicked.push("kick"),
    cancel: (id) => {
      cancelled.push(id);
      return store.requestCancel(id);
    },
    stopping: stopping.signal,
    ...options,
  });
  const call = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) {
      headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
    }
    return api(new Request(`http://runner${path}`, { ...init, headers }));
  };
  const post = (path: string, body: unknown) =>
    call(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { store, call, post, kicked, cancelled, stopping };
};

/** Helper for tests, which reads an event stream's frames until it ends. */
const frames = async (response: Response, stopAfter?: number) => {
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
    if (stopAfter !== undefined && text.split("\n\n").length > stopAfter) {
      await reader.cancel();
      break;
    }
  }
  return text.split("\n\n").filter((frame) => frame !== "");
};

describe("local-jobs/api", () => {
  describe("authorization", () => {
    it("returns 401 for a request without the token, or with another one", async () => {
      const { call } = apiWith();
      for (const token of [null, "other"]) {
        const response = await call("/health", { token });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          ok: false,
          code: "unauthorized",
        });
      }
    });
  });

  describe("GET /health", () => {
    it("returns the lanes that are running", async () => {
      const off = await apiWith().call("/health");
      const on = await apiWith({ fabricLane: () => true }).call("/health");

      expect(await off.json()).toEqual({
        ok: true,
        lanes: { local: true, fabric: false },
      });
      expect((await on.json()).lanes.fabric).toBe(true);
    });
  });

  describe("POST /jobs", () => {
    it("returns 201 with a new job and starts the lane, then 200 with the same job for the same request", async () => {
      const { post, kicked } = apiWith();

      const first = await post("/jobs", BODY);
      const again = await post("/jobs", BODY);

      expect(first.status).toBe(201);
      const { job } = await first.json();
      expect(job).toMatchObject({
        caller: "cfs:weaver",
        profile: "ask",
        idempotencyKey: "weaver-ask:1",
        state: "queued",
        request: {
          task: BODY.task,
          instructions: BODY.instructions,
          context: BODY.context,
          tools: ["loom_search"],
          maxModelTurns: 12,
        },
      });
      expect(again.status).toBe(200);
      expect((await again.json()).job.id).toBe(job.id);
      expect(kicked).toEqual(["kick"]);
    });

    it("returns 409 for a key that names a different request", async () => {
      const { post } = apiWith();
      await post("/jobs", BODY);

      const response = await post("/jobs", { ...BODY, task: "Another." });

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("idempotency_conflict");
    });

    it("returns 400 for an unknown profile, and for a request beyond its profile", async () => {
      const { post } = apiWith();

      const unknown = await post("/jobs", { ...BODY, profile: "admin" });
      const beyond = await post("/jobs", { ...BODY, tools: ["bash"] });

      expect(unknown.status).toBe(400);
      expect((await unknown.json()).code).toBe("unknown_profile");
      expect(beyond.status).toBe(400);
      expect(await beyond.json()).toMatchObject({
        code: "beyond_profile",
        error: "The profile does not allow `bash`.",
      });
    });

    const invalid: [string, unknown][] = [
      ["a body that is not JSON", "{"],
      ["a body that is not an object", [1]],
      ["a missing caller", { ...BODY, caller: undefined }],
      ["an empty profile", { ...BODY, profile: "" }],
      ["an overlong key", { ...BODY, idempotencyKey: "k".repeat(201) }],
      ["an empty task", { ...BODY, task: "" }],
      ["instructions that are not text", { ...BODY, instructions: 1 }],
      ["a result schema that is not a schema", { ...BODY, resultSchema: "x" }],
      ["tools that are not names", { ...BODY, tools: [1] }],
      ["a turn count below one", { ...BODY, maxModelTurns: 0 }],
      ["a fractional turn count", { ...BODY, maxModelTurns: 1.5 }],
    ];
    for (const [what, body] of invalid) {
      it(`returns 400 for ${what}`, async () => {
        const response = await apiWith().post("/jobs", body);

        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("invalid_request");
      });
    }

    it("accepts a boolean result schema and a request that narrows nothing", async () => {
      const response = await apiWith().post("/jobs", {
        caller: "cfs:weaver",
        profile: "ask",
        idempotencyKey: "k",
        task: "t",
        resultSchema: true,
      });

      expect(response.status).toBe(201);
      expect((await response.json()).job.request).toEqual({
        task: "t",
        resultSchema: true,
      });
    });
  });

  describe("GET /jobs", () => {
    it("returns the newest jobs, twenty unless a limit is named", async () => {
      const { post, call } = apiWith();
      for (const key of ["a", "b", "c"]) {
        await post("/jobs", { ...BODY, idempotencyKey: key });
      }

      const all = await (await call("/jobs")).json();
      const two = await (await call("/jobs?limit=2")).json();

      expect(all.jobs).toHaveLength(3);
      expect(
        two.jobs.map((job: { idempotencyKey: string }) => job.idempotencyKey),
      ).toEqual(["c", "b"]);
    });

    it("returns 400 for a limit outside 1 to 100", async () => {
      const { call } = apiWith();
      for (const limit of ["0", "101", "x"]) {
        expect((await call(`/jobs?limit=${limit}`)).status).toBe(400);
      }
    });
  });

  describe("one job", () => {
    it("returns the job, and 404 for one it does not hold", async () => {
      const { post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      expect((await (await call(`/jobs/${job.id}`)).json()).job.id).toBe(
        job.id,
      );
      const missing = await call("/jobs/job-404");
      expect(missing.status).toBe(404);
      expect((await missing.json()).code).toBe("not_found");
    });

    it("asks a job to stop", async () => {
      const { post, call, cancelled } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      const response = await call(`/jobs/${job.id}/cancel`, {
        method: "POST",
      });

      expect(cancelled).toEqual([job.id]);
      expect((await response.json()).job.state).toBe("cancelled");
    });
  });

  describe("routing", () => {
    it("returns 404 for another route, and 405 for another method on `/jobs`", async () => {
      const { call, post } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      expect((await call("/other")).status).toBe(404);
      expect((await call(`/jobs/${job.id}/other`)).status).toBe(404);
      expect((await call(`/jobs/${job.id}`, { method: "DELETE" })).status)
        .toBe(404);
      const wrong = await call("/jobs", { method: "PUT" });
      expect(wrong.status).toBe(405);
      expect((await wrong.json()).code).toBe("method_not_allowed");
    });
  });

  describe("GET /jobs/<id>/events", () => {
    it("streams the stored events, then new ones, and ends after the job's terminal state", async () => {
      const { store, post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();
      store.claimNext();

      const response = await call(`/jobs/${job.id}/events`);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const read = frames(response);
      store.report(job.id, "step", { turn: 1, tool: "loom_search" });
      store.finish(job.id, { state: "completed", result: { answer: "x" } });

      const sent = await read;
      expect(sent).toHaveLength(4);
      expect(sent[0]).toBe(
        `id: 1\nevent: state\ndata: ${
          JSON.stringify({
            seq: 1,
            at: store.events(job.id)[0].at,
            state: "queued",
          })
        }`,
      );
      expect(sent.map((frame) => frame.split("\n")[1])).toEqual([
        "event: state",
        "event: state",
        "event: step",
        "event: state",
      ]);
    });

    it("resumes after `after`, or after `Last-Event-ID`", async () => {
      const { store, post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();
      store.claimNext();
      store.finish(job.id, { state: "failed", errorCode: "LIMIT_REACHED" });

      const afterParam = await frames(
        await call(`/jobs/${job.id}/events?after=2`),
      );
      const afterHeader = await frames(
        await call(`/jobs/${job.id}/events`, {
          headers: { "last-event-id": "1" },
        }),
      );

      expect(afterParam.map((frame) => frame.split("\n")[0])).toEqual([
        "id: 3",
      ]);
      expect(afterHeader.map((frame) => frame.split("\n")[0])).toEqual([
        "id: 2",
        "id: 3",
      ]);
    });

    it("ends at once for an ended job read past its end", async () => {
      const { store, post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();
      store.requestCancel(job.id);

      expect(await frames(await call(`/jobs/${job.id}/events?after=9`)))
        .toEqual([]);
    });

    it("returns 400 for an `after` that is not a whole number", async () => {
      const { post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      expect((await call(`/jobs/${job.id}/events?after=-1`)).status).toBe(400);
    });

    it("says it is alive while the job is quiet, and ends when the service stops", async () => {
      const { post, call, stopping } = apiWith({ heartbeatMs: 1 });
      const { job } = await (await post("/jobs", BODY)).json();

      const response = await call(`/jobs/${job.id}/events`);
      const first = await frames(response.clone(), 2);
      stopping.abort();

      expect(first).toContain(": heartbeat");
      expect(await frames(response)).toContain(first[0]);
    });

    it("ends once, whatever stops it after its terminal event", async () => {
      const { store, post, call, stopping } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();
      store.claimNext();
      const read = frames(await call(`/jobs/${job.id}/events`));
      store.finish(job.id, { state: "completed" });

      const sent = await read;
      stopping.abort();

      expect(sent.at(-1)).toContain('"state":"completed"');
    });

    it("ends quietly when the service stops after its reader went away", async () => {
      const { post, call, stopping, store } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      await frames(await call(`/jobs/${job.id}/events`), 0);
      stopping.abort();
      store.claimNext();

      expect(store.get(job.id)?.state).toBe("running");
    });

    it("stops sending when its reader goes away", async () => {
      const { store, post, call } = apiWith();
      const { job } = await (await post("/jobs", BODY)).json();

      await frames(await call(`/jobs/${job.id}/events`), 0);
      store.claimNext();

      expect(store.get(job.id)?.state).toBe("running");
    });
  });
});
