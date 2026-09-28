import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import * as path from "@std/path";
import { COVERAGE_SUGGESTION_MARKER } from "./ci-check-lib.ts";
import { gateComment } from "./coverage-gate.ts";
import { postCoverageComment } from "./post-coverage-comment.ts";

/** The head commit the run that wrote a payload tested. */
const TESTED = "a".repeat(40);

/** A request the poster made that changes the pull request. */
interface Write {
  method: string;
  url: string;
  body: string;
}

/** What one run of the poster did and said. */
interface Run {
  writes: Write[];
  logged: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Runs the poster against a payload file holding `contents`, with GitHub
 * answering the comment listing with `existing` (or with `listingStatus`
 * where that is not 200) and recording every write into `writes`, which a
 * caller passes to read them from a run that throws.
 */
async function run(
  contents: string | undefined,
  existing: readonly string[] = [],
  listingStatus = 200,
  head = TESTED,
  tested: string | null = TESTED,
  writes: Write[] = [],
): Promise<Run> {
  const dir = await Deno.makeTempDir({ prefix: "coverage-comment-test-" });
  const file = path.join(dir, "coverage-comment.json");
  if (contents !== undefined) await Deno.writeTextFile(file, contents);

  const result: Run = { writes, logged: [], errors: [], warnings: [] };
  const originals = {
    fetch: globalThis.fetch,
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const text = (args: unknown[]) => args.map(String).join(" ");
  console.log = (...args) => result.logged.push(text(args));
  console.error = (...args) => result.errors.push(text(args));
  console.warn = (...args) => result.warnings.push(text(args));
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      result.writes.push({
        method,
        url,
        body: JSON.parse(String(init?.body)).body,
      });
      return Promise.resolve(new Response('{"id":1}', { status: 200 }));
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ head: { sha: head } }), { status: 200 }),
      );
    }
    // A 404 is not retried, so a lookup answered with one fails at once.
    if (listingStatus !== 200) {
      return Promise.resolve(new Response("nope", { status: listingStatus }));
    }
    const comments = existing.map((body, index) => ({ id: index + 1, body }));
    return Promise.resolve(
      new Response(JSON.stringify(comments), { status: 200 }),
    );
  };
  Deno.env.set("COVERAGE_COMMENT_FILE", file);
  if (tested === null) Deno.env.delete("HEAD_SHA");
  else Deno.env.set("HEAD_SHA", tested);
  try {
    await postCoverageComment();
  } finally {
    globalThis.fetch = originals.fetch;
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
    Deno.env.delete("COVERAGE_COMMENT_FILE");
    Deno.env.delete("HEAD_SHA");
    await Deno.remove(dir, { recursive: true });
  }
  return result;
}

const COMMENTS_URL =
  "https://api.github.com/repos/commonfabric/labs/issues/4211/comments";
const FIRST_COMMENT_URL =
  "https://api.github.com/repos/commonfabric/labs/issues/comments/1";

const regressed = gateComment(4211, false, ["| packages/bakery | rose |"]);
const resolved = gateComment(4211, true, ["| packages/bakery | no rise |"]);

describe("postCoverageComment()", () => {
  it("posts the comment when no marked comment exists", async () => {
    const { writes } = await run(JSON.stringify(regressed), [
      "a review comment",
    ]);
    expect(writes).toEqual([
      { method: "POST", url: COMMENTS_URL, body: regressed.body },
    ]);
  });

  it("refuses a payload naming a pull request the run did not test", async () => {
    // The payload comes from the pull request's own code, and this posts
    // with a write token, so a payload naming another pull request's
    // number, or an issue's, posts nothing there.
    const { writes, errors } = await run(
      JSON.stringify(regressed),
      [],
      200,
      "b".repeat(40),
    );
    expect(writes).toEqual([]);
    expect(errors.join("\n")).toContain("nothing is posted");
  });

  it("throws, posting nothing, when it is not told which commit the run tested", async () => {
    const writes: Write[] = [];
    await expect(
      run(JSON.stringify(regressed), [], 200, TESTED, null, writes),
    ).rejects.toThrow("`HEAD_SHA` is required");
    expect(writes).toEqual([]);
  });

  it("throws on an empty `HEAD_SHA` even with no payload to post", async () => {
    await expect(run(undefined, [], 200, TESTED, "")).rejects.toThrow(
      "`HEAD_SHA` is required",
    );
  });

  it("updates the marked comment in place", async () => {
    const { writes } = await run(JSON.stringify(regressed), [
      "a review comment",
      `${COVERAGE_SUGGESTION_MARKER}\nwhat an earlier run found`,
    ]);
    expect(writes).toEqual([{
      method: "PATCH",
      url: "https://api.github.com/repos/commonfabric/labs/issues/comments/2",
      body: regressed.body,
    }]);
  });

  it("leaves a marked comment that already says the same untouched", async () => {
    const { writes, logged } = await run(JSON.stringify(regressed), [
      regressed.body,
    ]);
    expect(writes).toEqual([]);
    expect(logged).toEqual([
      "Coverage comment on PR #4211 already up to date.",
    ]);
  });

  it("replaces the marked comment's body with a resolved one", async () => {
    const { writes } = await run(JSON.stringify(resolved), [regressed.body]);
    expect(writes).toEqual([
      { method: "PATCH", url: FIRST_COMMENT_URL, body: resolved.body },
    ]);
    expect(writes[0].body).toContain("<details>");
    expect(writes[0].body).toContain("coverage gate in the <strong>Status");
  });

  it("posts nothing for a resolved gate when no marked comment exists", async () => {
    const { writes, logged } = await run(JSON.stringify(resolved), [
      "a review comment",
    ]);
    expect(writes).toEqual([]);
    expect(logged).toEqual([
      "No coverage comment on PR #4211; nothing to resolve.",
    ]);
  });

  it("leaves an already-resolved comment untouched", async () => {
    const { writes } = await run(JSON.stringify(resolved), [resolved.body]);
    expect(writes).toEqual([]);
  });

  it("logs a failed comment lookup rather than throwing", async () => {
    const { writes, warnings } = await run(JSON.stringify(regressed), [], 404);
    expect(writes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "could not post or update coverage comment on PR #4211",
    );
  });

  it("reports an absent payload file", async () => {
    const { writes, logged } = await run(undefined);
    expect(writes).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^No .*coverage-comment\.json present/);
  });

  it("reports a payload that is not JSON", async () => {
    const { writes, errors } = await run("{not json");
    expect(writes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Could not parse .*coverage-comment\.json: /);
  });

  describe("payloads it skips", () => {
    // Each differs from a payload the poster does post, which the last case
    // pins, so a case passes only where that difference turned it away.

    const cases: [string, unknown][] = [
      ["a payload that is not an object", "regressed"],
      ["a payload with no body", { prNumber: 4211, state: "regressed" }],
      ["a pull request that is not a number", { ...regressed, prNumber: "1" }],
      ["a pull request that is not a positive whole number", {
        ...regressed,
        prNumber: 0,
      }],
      ["a state it does not know", { ...regressed, state: "ungated" }],
      ["a body that does not open with the marker", {
        ...regressed,
        body: "Cover these lines.",
      }],
    ];
    for (const [what, payload] of cases) {
      it(`skips ${what}`, async () => {
        const { writes, errors } = await run(JSON.stringify(payload));
        expect(writes).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^Invalid coverage comment payload in /);
      });
    }

    it("posts the payload those cases each differ from", async () => {
      const { writes } = await run(JSON.stringify(regressed));
      expect(writes).toHaveLength(1);
    });
  });
});
