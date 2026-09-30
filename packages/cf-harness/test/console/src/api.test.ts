import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cancelTurn } from "../../../console/src/api.ts";

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
});
