import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { PatternIndexClient, PatternIndexError } from "../src/client.ts";
import { feedbackEventType, recordPatternFeedback } from "../src/feedback.ts";

const signer = await Identity.fromPassphrase("pattern-index feedback tests");

describe("feedback", () => {
  describe("feedbackEventType()", () => {
    it("returns the event for each supported verdict", () => {
      expect(feedbackEventType("up")).toBe("thumbs_up");
      expect(feedbackEventType("down")).toBe("thumbs_down");
    });

    it("returns `undefined` for unsupported and inherited names", () => {
      for (
        const verdict of ["constructor", "toString", "sideways", "", null, 1]
      ) {
        expect(feedbackEventType(verdict)).toBeUndefined();
      }
    });
  });

  describe("recordPatternFeedback()", () => {
    it("records both feedback events with the signer's DID and optional note", async () => {
      const bodies: unknown[] = [];
      const client = new PatternIndexClient({
        baseUrl: "https://index.test/api",
        signer,
        fetchFn: (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Promise.resolve(Response.json({ ok: true }));
        },
      });
      expect(
        await recordPatternFeedback(client, {
          patternId: "up-pattern",
          eventType: "thumbs_up",
          note: "Useful result",
        }),
      ).toEqual({ ok: true });
      expect(
        await recordPatternFeedback(client, {
          patternId: "down-pattern",
          eventType: "thumbs_down",
        }),
      ).toEqual({ ok: true });
      expect(bodies).toEqual([
        {
          patternId: "up-pattern",
          eventType: "thumbs_up",
          note: "Useful result",
          did: signer.did(),
        },
        {
          patternId: "down-pattern",
          eventType: "thumbs_down",
          did: signer.did(),
        },
      ]);
    });

    it("returns a refusal when a successful reply did not record the event", async () => {
      const client = new PatternIndexClient({
        baseUrl: "https://index.test/api",
        signer,
        fetchFn: () => Promise.resolve(Response.json({ ok: false })),
      });
      expect(
        await recordPatternFeedback(client, {
          patternId: "test",
          eventType: "thumbs_down",
        }),
      ).toEqual({
        ok: false,
        message:
          "the pattern index answered but did not record the thumbs_down event",
      });
    });

    it("propagates distinct 401 and 403 index failures", async () => {
      for (const status of [401, 403]) {
        const client = new PatternIndexClient({
          baseUrl: "https://index.test/api",
          signer,
          fetchFn: () =>
            Promise.resolve(
              Response.json({ error: "private detail" }, { status }),
            ),
        });
        await expect(recordPatternFeedback(client, {
          patternId: "test",
          eventType: "thumbs_up",
        })).rejects.toMatchObject(
          {
            name: "PatternIndexError",
            status,
            message: `pattern index recordEvent failed (${status})`,
            detail: "private detail",
          } satisfies Partial<PatternIndexError>,
        );
      }
    });

    it("propagates transport failures without turning them into refusals", async () => {
      const failure = new Error("transport unavailable");
      const client = new PatternIndexClient({
        baseUrl: "https://index.test/api",
        signer,
        fetchFn: () => Promise.reject(failure),
      });
      await expect(recordPatternFeedback(client, {
        patternId: "test",
        eventType: "thumbs_up",
      })).rejects.toBe(failure);
    });
  });
});
