import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { describe, it } from "@std/testing/bdd";

import {
  createLocalJobApi,
  LOCAL_BROWSER_RESULT_MAX_BYTES,
} from "../../src/local-jobs/api.ts";
import { LocalJobBrowserHost } from "../../src/local-jobs/browser-host.ts";
import type { LocalJobProfile } from "../../src/local-jobs/profiles.ts";
import { LocalJobStore } from "../../src/local-jobs/store.ts";

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
  options: {
    fabricLane?: () => boolean;
    heartbeatMs?: number;
    browserHost?: (id: string) => LocalJobBrowserHost | undefined;
    profiles?: Map<string, LocalJobProfile>;
  } = {},
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
      ["a continued job that is not an id", { ...BODY, continues: 1 }],
      ["an empty continued job", { ...BODY, continues: "" }],
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

  describe("POST /jobs continuing a job", () => {
    /**
     * Helper for tests, which builds the API with a second profile and adds
     * one job, ended `completed` unless `state` says otherwise.
     */
    const withParent = async (
      state: "completed" | "queued" | "running" = "completed",
    ) => {
      const api = apiWith({
        profiles: new Map([["ask", ASK], ["other", ASK]]),
      });
      const { job } = await (await api.post("/jobs", BODY)).json();
      if (state !== "queued") api.store.claimNext();
      if (state === "completed") {
        api.store.finish(job.id, {
          state: "completed",
          result: { answer: "Saturn" },
        });
      }
      return { ...api, parent: job.id as string };
    };

    /** A reply's body, continuing `parent`. */
    const reply = (parent: string) => ({
      ...BODY,
      idempotencyKey: "weaver-ask:2",
      task: "And its largest moon?",
      continues: parent,
    });

    it("returns 201 with a job that names the one it continues, and 200 with it again for the same request", async () => {
      const { post, parent, kicked } = await withParent();

      const first = await post("/jobs", reply(parent));
      const again = await post("/jobs", reply(parent));

      expect(first.status).toBe(201);
      const { job } = await first.json();
      expect(job).toMatchObject({
        continues: parent,
        state: "queued",
        request: { task: "And its largest moon?", continues: parent },
      });
      expect(again.status).toBe(200);
      expect((await again.json()).job.id).toBe(job.id);
      expect(kicked).toEqual(["kick", "kick"]);
    });

    it("returns 409 for a key resent continuing another job", async () => {
      const { post, parent, store } = await withParent();
      await post("/jobs", reply(parent));
      const other = (await (await post("/jobs", {
        ...BODY,
        idempotencyKey: "weaver-ask:3",
      })).json()).job.id;
      // The reply is queued ahead of it.
      store.claimNext();
      store.claimNext();
      store.finish(other, { state: "failed", errorCode: "PROVIDER_FAILURE" });

      const response = await post("/jobs", reply(other));

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("idempotency_conflict");
    });

    it("answers a used key as a conflict before judging the parent it names", async () => {
      const { post, parent, store } = await withParent();
      await post("/jobs", reply(parent));
      const live = (await (await post("/jobs", {
        ...BODY,
        idempotencyKey: "weaver-ask:3",
      })).json()).job.id;

      for (const named of ["job-missing", live]) {
        const response = await post("/jobs", reply(named));

        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("idempotency_conflict");
      }
      expect(store.list(10)).toHaveLength(3);
    });

    it("returns 404, adding nothing, for a job no caller holds", async () => {
      const { post, store } = await withParent();

      const response = await post("/jobs", reply("job-missing"));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        code: "not_found",
        error: "No job `job-missing`.",
      });
      expect(store.list(10)).toHaveLength(1);
    });

    it("returns 404, as for no job, for another caller's or another profile's job", async () => {
      const { post, parent, store } = await withParent();

      const caller = await post("/jobs", {
        ...reply(parent),
        caller: "moments",
      });
      const profile = await post("/jobs", {
        ...reply(parent),
        profile: "other",
      });

      for (const response of [caller, profile]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          ok: false,
          code: "not_found",
          error: `No job \`${parent}\`.`,
        });
      }
      expect(store.list(10)).toHaveLength(1);
    });

    it("returns 409, adding nothing, for a job that is queued or running", async () => {
      for (const state of ["queued", "running"] as const) {
        const { post, parent, store } = await withParent(state);

        const response = await post("/jobs", reply(parent));

        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("parent_running");
        expect(store.list(10)).toHaveLength(1);
      }
    });

    it("accepts a job that ended any way", async () => {
      const { post, store } = apiWith();
      const ended = [];
      for (const ending of ["failed", "cancelled", "interrupted"] as const) {
        const { job } = await (await post("/jobs", {
          ...BODY,
          idempotencyKey: `weaver-ask:${ending}`,
        })).json();
        store.claimNext();
        store.finish(job.id, {
          state: ending,
          errorCode: "PROVIDER_FAILURE",
        });
        ended.push(job.id);
      }

      for (const [index, parent] of ended.entries()) {
        const response = await post("/jobs", {
          ...reply(parent),
          idempotencyKey: `weaver-reply:${index}`,
        });
        expect(response.status).toBe(201);
      }
    });

    it("carries what a job continues in the one-job and list answers, and nothing for one that continues none", async () => {
      const { post, call, parent } = await withParent();
      const { job } = await (await post("/jobs", reply(parent))).json();

      const one = (await (await call(`/jobs/${job.id}`)).json()).job;
      const first = (await (await call(`/jobs/${parent}`)).json()).job;
      const list = (await (await call("/jobs")).json()).jobs;

      expect(one.continues).toBe(parent);
      expect(first).not.toHaveProperty("continues");
      expect(
        list.map((entry: { id: string; continues?: string }) => [
          entry.id,
          entry.continues,
        ]),
      ).toEqual([[job.id, parent], [parent, undefined]]);
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
    it("returns refused command details in the job snapshot and event stream", async () => {
      const { store, post, call } = apiWith();
      try {
        const { job } = await (await post("/jobs", BODY)).json();
        store.claimNext();
        const command = {
          command: "loom.compose",
          ok: false,
          code: "bad-args",
          error: "components must contain between 1 and 100 references",
        };
        store.report(job.id, "command", command);
        store.finish(job.id, { state: "completed", result: { answer: "x" } });

        const snapshot = await (await call(`/jobs/${job.id}`)).json();
        expect(snapshot.job.commands).toEqual([command]);
        const sent = await frames(await call(`/jobs/${job.id}/events?after=2`));
        expect(sent[0]).toBe(
          `id: 3\nevent: command\ndata: ${
            JSON.stringify({
              seq: 3,
              at: store.events(job.id, 2)[0].at,
              ...command,
            })
          }`,
        );
      } finally {
        store.close();
      }
    });

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
    for (const ending of ["terminal", "cancel", "request abort"] as const) {
      it(`removes the service abort listener on ${ending}`, async () => {
        const { store, post, call, stopping } = apiWith();
        const added = spy(stopping.signal, "addEventListener");
        const removed = spy(stopping.signal, "removeEventListener");
        const request = new AbortController();
        let response: Response | undefined;
        try {
          const { job } = await (await post("/jobs", BODY)).json();
          store.claimNext();
          response = await call(`/jobs/${job.id}/events`, {
            signal: request.signal,
          });
          expect(added.calls).toHaveLength(1);
          if (ending === "terminal") {
            store.finish(job.id, { state: "completed" });
            await response.text();
          } else if (ending === "cancel") {
            await response.body!.cancel();
          } else {
            request.abort();
            await response.text();
          }
          expect(stopping.signal.aborted).toBe(false);
          expect(
            removed.calls.some((call) =>
              call.args[0] === "abort" &&
              call.args[1] === added.calls[0].args[1]
            ),
          ).toBe(true);
        } finally {
          stopping.abort();
          if (response && !response.bodyUsed) await response.body!.cancel();
          added.restore();
          removed.restore();
          store.close();
        }
      });
    }

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

  describe("the browser host routes", () => {
    /** Helper for tests, which builds the API with one host per job. */
    const browsing = (heartbeatMs?: number) => {
      const hosts = new Map<string, LocalJobBrowserHost>();
      const api = apiWith({
        browserHost: (id) => hosts.get(id),
        ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
      });
      const declare = async () => {
        const { job } = await (await api.post("/jobs", BODY)).json();
        const host = new LocalJobBrowserHost();
        hosts.set(job.id, host);
        return { id: job.id as string, host };
      };
      return { ...api, declare };
    };

    it("refuses a browser host field that is not an object", async () => {
      const { post } = apiWith();
      const response = await post("/jobs", { ...BODY, browserHost: true });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "`browserHost` must be an object.",
      );
    });

    it("refuses a browser host the profile does not admit", async () => {
      const { post } = apiWith();
      const response = await post("/jobs", { ...BODY, browserHost: {} });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "beyond_profile",
        error: "The profile does not admit a browser host.",
      });
    });

    it("answers 409 for a job that declared no host", async () => {
      const { post, call } = browsing();
      const { job } = await (await post("/jobs", BODY)).json();
      for (
        const response of [
          await call(`/jobs/${job.id}/browser/stream`),
          await post(`/jobs/${job.id}/browser/result`, { id: "1" }),
        ]
      ) {
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("no_browser_host");
      }
    });

    it("streams operations, takes their answers, and shows the host on the job", async () => {
      const { call, post, declare } = browsing();
      const { id, host } = await declare();
      const opened = host.perform({ action: "open", url: "https://a.test" });
      const read = frames(await call(`/jobs/${id}/browser/stream`), 1);
      expect(await read).toEqual([
        'event: request\ndata: {"id":"1","operation":{"action":"open","url":"https://a.test"}}',
      ]);
      expect((await (await call(`/jobs/${id}`)).json()).job.browser)
        .toMatchObject({
          state: "open",
          outstanding: 1,
          withdrawn: 0,
        });

      const result = {
        status: "ok",
        page: { url: "https://a.test/", title: "A" },
      };
      const answered = await post(`/jobs/${id}/browser/result`, {
        id: "1",
        result,
      });
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ ok: true });
      expect(await opened).toEqual(result);
      const again = await post(`/jobs/${id}/browser/result`, {
        id: "1",
        result,
      });
      expect(await again.json()).toEqual({ ok: true, duplicate: true });
    });

    it("refuses an unknown operation, a non-result, a body that is not an object, and an oversized result", async () => {
      const { call, post, declare } = browsing();
      const { id, host } = await declare();
      const snapshot = host.perform({ action: "snapshot", interactive: true });
      await frames(await call(`/jobs/${id}/browser/stream`), 1);

      const unknown = await post(`/jobs/${id}/browser/result`, {
        id: "7",
        result: {},
      });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()).code).toBe("unknown_operation");
      for (const body of ["[]", "not json"]) {
        const response = await post(`/jobs/${id}/browser/result`, body);
        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("invalid_request");
      }
      const declared = await call(`/jobs/${id}/browser/result`, {
        method: "POST",
        headers: {
          "content-length": String(LOCAL_BROWSER_RESULT_MAX_BYTES + 1),
        },
        body: "{}",
      });
      expect(declared.status).toBe(413);
      const oversized = await post(
        `/jobs/${id}/browser/result`,
        "x".repeat(LOCAL_BROWSER_RESULT_MAX_BYTES + 1),
      );
      expect(oversized.status).toBe(413);

      // Counted in bytes as they arrive, whatever length is declared: a
      // two-byte character each counts twice.
      const multibyte = await post(
        `/jobs/${id}/browser/result`,
        "\u00e9".repeat(LOCAL_BROWSER_RESULT_MAX_BYTES / 2 + 1),
      );
      expect(multibyte.status).toBe(413);
      const streamed = await call(`/jobs/${id}/browser/result`, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            const chunk = new Uint8Array(1024 * 1024).fill(0x20);
            for (
              let i = 0;
              i <= LOCAL_BROWSER_RESULT_MAX_BYTES / chunk.length;
              i++
            ) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      });
      expect(streamed.status).toBe(413);

      const empty = await call(`/jobs/${id}/browser/result`, {
        method: "POST",
      });
      expect(empty.status).toBe(400);
      expect((await empty.json()).code).toBe("invalid_request");
      const broken = await call(`/jobs/${id}/browser/result`, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("the connection dropped"));
          },
        }),
      });
      expect(broken.status).toBe(400);
      expect((await broken.json()).error).toBe("The body could not be read.");

      const invalid = await post(`/jobs/${id}/browser/result`, {
        id: "1",
        result: { status: "fine" },
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).code).toBe("invalid_result");
      expect((await snapshot).status).toBe("failed");
    });

    it("answers 404 for another method or route under browser", async () => {
      const { call, declare } = browsing();
      const { id } = await declare();
      expect(
        (await call(`/jobs/${id}/browser/stream`, { method: "POST" }))
          .status,
      ).toBe(404);
      expect((await call(`/jobs/${id}/browser/elsewhere`)).status).toBe(404);
    });

    it("says it is alive on a quiet stream, and ends it, leaving the host open, when the service stops", async () => {
      const { call, declare, stopping } = browsing(5);
      const { id, host } = await declare();
      const response = await call(`/jobs/${id}/browser/stream`);
      const reader = response.body!.pipeThrough(new TextDecoderStream())
        .getReader();
      expect((await reader.read()).value).toContain(": heartbeat");
      stopping.abort();
      for (;;) {
        if ((await reader.read()).done) break;
      }
      expect(host.view().state).toBe("open");
    });

    it("ends a stream whose request is already aborted", async () => {
      const { call, declare, stopping } = browsing();
      const { id } = await declare();
      stopping.abort();
      expect(await frames(await call(`/jobs/${id}/browser/stream`))).toEqual(
        [],
      );
    });

    it("says close on a closed host's stream and ends it", async () => {
      const { call, declare } = browsing();
      const { id, host } = await declare();
      const read = frames(await call(`/jobs/${id}/browser/stream`));
      host.close();
      expect(await read).toEqual(["event: close\ndata: {}"]);
    });
  });
});
