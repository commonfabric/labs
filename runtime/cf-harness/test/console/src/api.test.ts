import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cancelTurn,
  listIndexPatterns,
  listRuns,
  readIndexPattern,
  readRun,
  readRunFile,
  readRunFlow,
  searchIndexPatterns,
  startTask,
} from "../../../console/src/api.ts";

const realFetch = globalThis.fetch;

/** Answers every request with one response, and remembers what was asked. */
const answerWith = (
  response: Response,
): { calls: number; paths: string[]; bodies: unknown[] } => {
  const record = { calls: 0, paths: [] as string[], bodies: [] as unknown[] };
  globalThis.fetch = (input, init) => {
    record.calls += 1;
    record.bodies.push(
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    );
    if (typeof input === "string") {
      record.paths.push(input);
    } else if (input instanceof Request) {
      record.paths.push(new URL(input.url).pathname);
    } else {
      record.paths.push(input.pathname);
    }
    return Promise.resolve(response);
  };
  return record;
};

describe("console/src/api", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("cancelTurn", () => {
    it("resolves when the server takes the cancel", async () => {
      const asked = answerWith(Response.json({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked.calls).toBe(1);
    });

    it("asks under the page's mount, which is the root outside a page", async () => {
      // Every path goes through console/src/mount.ts; with no location (a
      // test), the mount is the console's own root and the path is as it was.
      const asked = answerWith(Response.json({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked.paths).toEqual(["/api/cancel"]);
    });

    it("tells the server the console page asked for the cancel", async () => {
      const asked = answerWith(Response.json({ sessionId: "session-a" }));

      await cancelTurn("session-a", "turn-a");

      expect(asked.bodies).toEqual([{
        sessionId: "session-a",
        turnId: "turn-a",
        reason: "canceled from the console page",
      }]);
    });

    it("rejects with the reason a refused cancel reported", async () => {
      answerWith(
        Response.json({ error: "no turn is running", code: "turn_not_found" }, {
          status: 404,
        }),
      );

      await expect(cancelTurn("session-a", "turn-a")).rejects.toThrow(
        "no turn is running",
      );
    });

    it("rejects with the status a refusal carrying no body reported", async () => {
      answerWith(new Response("", { status: 403, statusText: "Forbidden" }));

      await expect(cancelTurn("session-a")).rejects.toThrow("Forbidden");
    });
  });

  describe("startTask", () => {
    it("starts a turn in a new session when the page has none", async () => {
      const asked = answerWith(
        Response.json({ sessionId: "session-a", turnId: "turn-a" }),
      );

      expect(await startTask("build a counter")).toEqual({
        sessionId: "session-a",
        turnId: "turn-a",
      });
      expect(asked.paths).toEqual(["/api/task"]);
      expect(asked.bodies).toEqual([{ text: "build a counter" }]);
    });

    it("sends the turn to the session the page already has", async () => {
      const asked = answerWith(
        Response.json({ sessionId: "session-a", turnId: "turn-b" }),
      );

      await startTask("now make it blue", "session-a");

      expect(asked.bodies).toEqual([
        { text: "now make it blue", sessionId: "session-a" },
      ]);
    });

    it("rejects with the text of a refusal that is not JSON", async () => {
      // An unbuilt page or a crashed handler answers in plain text.
      answerWith(new Response("handler crashed\n", { status: 500 }));

      await expect(startTask("build a counter")).rejects.toThrow(
        "handler crashed",
      );
    });

    it("rejects with the whole body of a JSON refusal whose error is not text", async () => {
      answerWith(Response.json({ error: { code: "busy" } }, { status: 409 }));

      await expect(startTask("build a counter")).rejects.toThrow(
        '{"error":{"code":"busy"}}',
      );
    });
  });

  describe("listRuns", () => {
    it("returns the runs the server listed", async () => {
      const asked = answerWith(Response.json({ runs: [{ runId: "run-a" }] }));

      expect(await listRuns()).toEqual([{ runId: "run-a" }]);
      expect(asked.paths).toEqual(["/api/runs"]);
    });
  });

  describe("readRun", () => {
    it("reads the run its id names, escaped as one path segment", async () => {
      const asked = answerWith(Response.json({ runId: "run/a" }));

      expect(await readRun("run/a")).toEqual({ runId: "run/a" });
      expect(asked.paths).toEqual(["/api/runs/run%2Fa"]);
    });
  });

  describe("readRunFlow", () => {
    it("reads the map of the run its id names", async () => {
      const asked = answerWith(Response.json({ runId: "run/a", turns: [] }));

      expect(await readRunFlow("run/a")).toEqual({ runId: "run/a", turns: [] });
      expect(asked.paths).toEqual(["/api/runs/run%2Fa/flow"]);
    });
  });

  describe("pattern index calls", () => {
    it("names listPatterns to the server and sends no body", async () => {
      const asked = answerWith(Response.json({ patterns: [] }));

      expect(await listIndexPatterns()).toEqual({ patterns: [] });
      expect(asked.paths).toEqual(["/api/index/call"]);
      expect(asked.bodies).toEqual([{ fn: "listPatterns" }]);
    });

    it("asks getPattern for the pattern its id names", async () => {
      const asked = answerWith(Response.json({ patternId: "pattern-a" }));

      expect(await readIndexPattern("pattern-a")).toEqual({
        patternId: "pattern-a",
      });
      expect(asked.bodies).toEqual([
        { fn: "getPattern", body: { patternId: "pattern-a" } },
      ]);
    });

    it("passes the search request to searchPatterns", async () => {
      const asked = answerWith(Response.json({ results: [] }));

      expect(await searchIndexPatterns({ text: "counter" })).toEqual({
        results: [],
      });
      expect(asked.bodies).toEqual([
        { fn: "searchPatterns", body: { text: "counter" } },
      ]);
    });
  });

  describe("readRunFile", () => {
    it("returns the file's text unparsed", async () => {
      const asked = answerWith(new Response('{"not": "parsed"'));

      expect(await readRunFile("run/a", "tool-outputs", "out 1.json")).toBe(
        '{"not": "parsed"',
      );
      expect(asked.paths).toEqual([
        "/api/runs/run%2Fa/tool-outputs/out%201.json",
      ]);
    });

    it("rejects naming the file the server would not serve", async () => {
      answerWith(new Response("missing", { status: 404 }));

      await expect(readRunFile("run-a", "artifacts", "plan.md")).rejects
        .toThrow("plan.md is not readable");
    });
  });
});
