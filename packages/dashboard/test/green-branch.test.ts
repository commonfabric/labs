import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { GreenBranch } from "../green-branch.ts";

const REPO = "example/repo";
const NOW = Date.UTC(2026, 9, 6, 12, 0);
const HOUR = 3_600_000;
const sha = (digit: string) => digit.repeat(40);

/** An update of the branch to `after`, made `hours` before `NOW`. */
const update = (id: number, after: string, hours: number) => ({
  id,
  after,
  timestamp: new Date(NOW - hours * HOUR).toISOString(),
});

type Update = ReturnType<typeof update>;

describe("GreenBranch", () => {
  // GitHub is stubbed: `pages` holds the activity record's pages, newest
  // first, each linking to the next through its `Link` header, the page at
  // `failsAt` cannot be read, and `requests` collects every url asked for.

  let pages: Update[][] = [];
  let failsAt: number | undefined;
  let requests: URL[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");

  beforeEach(() => {
    pages = [];
    failsAt = undefined;
    requests = [];
    Deno.env.set("GH_TOKEN", "test-token");
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      const index = Number(url.searchParams.get("after") ?? "0");
      if (index === failsAt) {
        return Promise.resolve(new Response("down", { status: 502 }));
      }
      const next = new URL(url);
      next.searchParams.set("after", String(index + 1));
      return Promise.resolve(Response.json(pages[index] ?? [], {
        headers: index + 1 < pages.length
          ? { link: `<${next}>; rel="next"` }
          : {},
      }));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  });

  describe("instance members", () => {
    describe("refresh()", () => {
      it("asks for the updates of the branch's ref, a hundred to a page", async () => {
        await new GreenBranch(REPO, "main-green").refresh(0);
        expect(requests.map((url) => url.href)).toEqual([
          `https://api.github.com/repos/${REPO}/activity?ref=refs%2Fheads%2Fmain-green&per_page=100`,
        ]);
      });

      it("reads every page the `Link` header names, back to `since`", async () => {
        pages = [
          [update(5, sha("5"), 1), update(4, sha("4"), 2)],
          [update(3, sha("3"), 3), update(2, sha("2"), 5), update(1, sha("1"), 6)],
          [update(0, sha("9"), 7)],
        ];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(NOW - 4 * HOUR);
        expect(requests.length).toBe(2);
        expect(["5", "4", "3", "2"].map((digit) => branch.mark(sha(digit))))
          .toEqual([
            { branch: "main-green", current: true },
            { branch: "main-green", current: false },
            { branch: "main-green", current: false },
            undefined,
          ]);
      });

      it("reads only the updates made since the last read, and moves the current commit to the newest", async () => {
        pages = [[update(1, sha("1"), 2)], [update(0, sha("9"), 3)]];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(0);
        pages = [[update(2, sha("2"), 1), update(1, sha("1"), 2)], [
          update(0, sha("9"), 3),
        ]];
        requests = [];
        await branch.refresh(0);
        expect(requests.length).toBe(1);
        expect(["2", "1", "9"].map((digit) => branch.mark(sha(digit))?.current))
          .toEqual([true, false, false]);
      });

      it("keeps nothing of a read whose later page cannot be read, and reads those updates next time", async () => {
        pages = [[update(1, sha("1"), 2)]];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(0);
        pages = [[update(3, sha("3"), 1)], [
          update(2, sha("2"), 1.5),
          update(1, sha("1"), 2),
        ]];
        failsAt = 1;
        await branch.refresh(0);
        expect(branch.mark(sha("1"))?.current).toBe(true);
        expect(branch.mark(sha("3"))).toBeUndefined();
        failsAt = undefined;
        await branch.refresh(0);
        expect(["3", "2", "1"].map((digit) => branch.mark(sha(digit))?.current))
          .toEqual([true, false, false]);
      });

      it("asks for ten updates to a page once it has read some", async () => {
        pages = [[update(1, sha("1"), 1)]];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(0);
        await branch.refresh(0);
        expect(requests.map((url) => url.searchParams.get("per_page")))
          .toEqual(["100", "10"]);
      });

      it("shares one read between refreshes asked for while it reads", async () => {
        pages = [[update(1, sha("1"), 1)]];
        const branch = new GreenBranch(REPO, "main-green");
        await Promise.all([branch.refresh(0), branch.refresh(0)]);
        expect(requests.length).toBe(1);
      });

      it("forgets a commit the branch was at before `since`, but not the commit it is at now", async () => {
        pages = [[update(2, sha("2"), 30), update(1, sha("1"), 40)]];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(0);
        await branch.refresh(NOW - 24 * HOUR);
        expect(branch.mark(sha("2"))).toEqual({
          branch: "main-green",
          current: true,
        });
        expect(branch.mark(sha("1"))).toBeUndefined();
      });

      it("is at no commit once the branch has been deleted", async () => {
        pages = [[update(2, sha("0"), 1), update(1, sha("1"), 2)]];
        const branch = new GreenBranch(REPO, "main-green");
        await branch.refresh(0);
        expect(branch.mark(sha("1"))).toEqual({
          branch: "main-green",
          current: false,
        });
        expect(branch.mark(sha("0"))).toBeUndefined();
      });
    });

    describe("mark()", () => {
      it("returns `undefined` before the branch is read, and for a commit it was never at", async () => {
        pages = [[update(1, sha("1"), 1)]];
        const branch = new GreenBranch(REPO, "main-green");
        expect(branch.mark(sha("1"))).toBeUndefined();
        await branch.refresh(0);
        expect(branch.mark(sha("2"))).toBeUndefined();
      });
    });
  });
});
