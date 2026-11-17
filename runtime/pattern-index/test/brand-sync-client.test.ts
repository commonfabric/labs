import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { BrandSyncError, syncBrandPatterns } from "../src/brand-sync-client.ts";
import type { PatternIndexFetch } from "../src/http-fetch.ts";

const REQUEST = { repository: "acme/patterns", commit: "c0ffee" };

const ANSWER = {
  brand: { githubOrg: "acme", displayName: "Acme" },
  results: [{
    path: "p/a.tsx",
    patternId: "A",
    lineageId: "L",
    created: true,
    visibility: "published",
  }],
  removed: [],
};

/** A fetch that records its one request and answers with `response`. */
const answering = (response: Response) => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn: PatternIndexFetch = (input, init) => {
    seen.push({ url: String(input), init });
    return Promise.resolve(response);
  };
  return { fetchFn, seen };
};

describe("brand-sync-client", () => {
  describe("syncBrandPatterns()", () => {
    it("posts the request with the token as its bearer, and returns the answer", async () => {
      const { fetchFn, seen } = answering(Response.json(ANSWER));
      const answer = await syncBrandPatterns(
        "https://index.test/api/",
        "jwt",
        REQUEST,
        fetchFn,
      );
      expect(answer.results[0].patternId).toBe("A");
      expect(seen[0].url).toBe("https://index.test/api/syncBrandPatterns");
      expect(seen[0].init?.method).toBe("POST");
      expect(new Headers(seen[0].init?.headers).get("Authorization")).toBe(
        "Bearer jwt",
      );
      expect(JSON.parse(String(seen[0].init?.body))).toEqual(REQUEST);
    });

    it("throws a `BrandSyncError` carrying the status and the index's message", async () => {
      const { fetchFn } = answering(
        Response.json({ error: "repo not enrolled" }, { status: 403 }),
      );
      const error = await syncBrandPatterns(
        "https://index.test",
        "jwt",
        REQUEST,
        fetchFn,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(BrandSyncError);
      expect(error.status).toBe(403);
      expect(error.message).toBe(
        "pattern index syncBrandPatterns 403: repo not enrolled",
      );
    });

    it("throws when a successful answer is not one it can read", async () => {
      const { fetchFn } = answering(Response.json({ results: [{}] }));
      await expect(
        syncBrandPatterns("https://index.test", "jwt", REQUEST, fetchFn),
      ).rejects.toThrow("results[0] is malformed");
    });
  });
});
