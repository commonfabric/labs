import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PatternIndexError } from "../src/client.ts";
import {
  patternIndexFailure,
  patternIndexSearchRequest,
} from "../src/front.ts";

describe("front", () => {
  describe("patternIndexSearchRequest()", () => {
    it("keeps declared search fields and omits caller identity and dispatch fields", () => {
      expect(patternIndexSearchRequest({
        text: "calendar",
        limit: 3,
        tags: ["time", 1, "date"],
        did: "forged",
        fn: "publishPattern",
        includeSource: true,
      })).toEqual({ text: "calendar", limit: 3, tags: ["time", "date"] });
    });

    it("omits absent fields and fields with unsupported types", () => {
      expect(patternIndexSearchRequest({})).toEqual({});
      expect(patternIndexSearchRequest({ text: 1, limit: "3", tags: "time" }))
        .toEqual({});
    });

    it("preserves empty search values and filters nonstring tags", () => {
      expect(
        patternIndexSearchRequest({ text: "", limit: 0, tags: [null, false] }),
      )
        .toEqual({ text: "", limit: 0, tags: [] });
    });
  });

  describe("patternIndexFailure()", () => {
    it("preserves 401 signature failures and 403 allowlist refusals separately", () => {
      expect([401, 403].map((status) =>
        patternIndexFailure(
          new PatternIndexError("recordEvent", status, "private detail"),
        )
      )).toEqual([
        {
          ok: false,
          status: 401,
          error: "pattern index recordEvent failed (401)",
        },
        {
          ok: false,
          status: 403,
          error: "pattern index recordEvent failed (403)",
        },
      ]);
    });

    it("preserves other 4xx statuses while withholding raw response detail", () => {
      for (const status of [400, 404, 429, 499]) {
        expect(
          patternIndexFailure(
            new PatternIndexError("getPattern", status, "private detail"),
          ),
        )
          .toEqual({
            ok: false,
            status,
            error: `pattern index getPattern failed (${status})`,
          });
      }
    });

    it("maps failures outside the 4xx range to 502", () => {
      for (const status of [200, 302, 399, 500, 503]) {
        expect(
          patternIndexFailure(
            new PatternIndexError("searchPatterns", status, "private detail"),
          ),
        )
          .toEqual({
            ok: false,
            status: 502,
            error: `pattern index searchPatterns failed (${status})`,
          });
      }
    });

    it("returns `undefined` for internal and transport failures", () => {
      for (
        const error of [new Error("transport failed"), { status: 401 }, null]
      ) {
        expect(patternIndexFailure(error)).toBeUndefined();
      }
    });
  });
});
