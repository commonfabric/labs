import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { staticGitHubCredential } from "./github-auth.ts";
import { GitHubAnswers, GITHUB_ORGANIZATION } from "./lib.ts";
import { organizationRepos, repositoryNames } from "./organization-repos.ts";
import { describe, it } from "@commonfabric/test-support/test";

const credential = staticGitHubCredential("organization-repos-test");

function repo(name: string, fields: Record<string, unknown> = {}) {
  return {
    full_name: `${GITHUB_ORGANIZATION.name}/${name}`,
    default_branch: "main",
    archived: false,
    pushed_at: "2026-11-01T00:00:00Z",
    ...fields,
  };
}

/** Answers the organization's repository listing with `pages`, in order. */
function listing(pages: unknown[][]) {
  const requested: string[] = [];
  const fetch = stub(globalThis, "fetch", (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.pathname + url.search);
    const page = Number(url.searchParams.get("page"));
    return Promise.resolve(Response.json(pages[page - 1] ?? []));
  });
  return { requested, [Symbol.dispose]: () => fetch.restore() };
}

describe("organization-repos", () => {
  describe("organizationRepos()", () => {
    it("returns every repository that is not archived, reading pages until one is short", async () => {
      const full = Array.from({ length: 100 }, (_, index) => repo(`r${index}`));
      using wire = listing([
        full,
        [repo("old", { archived: true }), repo("new", { pushed_at: null })],
      ]);

      const repos = await organizationRepos(credential);

      expect(repos.length).toBe(101);
      expect(repos[0]).toEqual({
        name: `${GITHUB_ORGANIZATION.name}/r0`,
        branch: "main",
        pushedAt: "2026-11-01T00:00:00Z",
      });
      expect(repos.at(-1)).toEqual({
        name: `${GITHUB_ORGANIZATION.name}/new`,
        branch: "main",
        pushedAt: null,
      });
      expect(repos.some((repo) => repo.name.endsWith("/old"))).toBe(false);
      expect(wire.requested).toEqual([1, 2].map((page) =>
        `/orgs/${GITHUB_ORGANIZATION.name}/repos?per_page=100&page=${page}`
      ));
    });

    it("makes each request with the options given, so that one asked again is conditional", async () => {
      const asked: (string | null)[] = [];
      using _fetch = stub(globalThis, "fetch", (_input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        asked.push(etag);
        return Promise.resolve(
          etag === null
            ? Response.json([repo("fresh")], { headers: { etag: '"listing"' } })
            : new Response(null, { status: 304 }),
        );
      });
      const answers = new GitHubAnswers();

      const first = await organizationRepos(credential, { answers });
      const again = await organizationRepos(credential, { answers });
      await organizationRepos(credential);

      expect(again).toEqual(first);
      expect(first.map((held) => held.name)).toEqual([`${GITHUB_ORGANIZATION.name}/fresh`]);
      expect(asked).toEqual([null, '"listing"', null]);
    });

    it("throws when the listing is not an array", async () => {
      using _fetch = stub(
        globalThis,
        "fetch",
        () => Promise.resolve(Response.json({ message: "moved" })),
      );
      await expect(organizationRepos(credential)).rejects.toThrow(
        "GitHub organization repositories returned invalid data",
      );
    });

    for (
      const [what, entry] of [
        ["a repository that is not an object", "r"],
        ["a repository without a name", repo("r", { full_name: 1 })],
        ["a repository without a default branch", repo("r", { default_branch: null })],
        ["a repository whose archived flag is not a boolean", repo("r", { archived: "no" })],
        ["a repository whose push time is not a string", repo("r", { pushed_at: 5 })],
      ] as const
    ) {
      it(`throws for ${what}`, async () => {
        using _wire = listing([[repo("fine"), entry]]);
        await expect(organizationRepos(credential)).rejects.toThrow(
          "GitHub organization repositories returned invalid data",
        );
      });
    }
  });

  describe("repositoryNames()", () => {
    it("returns the name of every repository of the organization given, archived ones included", async () => {
      const full = Array.from({ length: 100 }, (_, index) => ({
        ...repo(`r${index}`),
        full_name: `elsewhere/r${index}`,
      }));
      using wire = listing([
        full,
        [{ ...repo("old", { archived: true }), full_name: "elsewhere/old" }],
      ]);

      const names = await repositoryNames("elsewhere", credential);

      expect(names.length).toBe(101);
      expect(names.slice(0, 2)).toEqual(["r0", "r1"]);
      expect(names.at(-1)).toBe("old");
      expect(wire.requested).toEqual([1, 2].map((page) =>
        `/orgs/elsewhere/repos?per_page=100&page=${page}`
      ));
    });

    it("throws for a repository without a name", async () => {
      using _wire = listing([[repo("r", { full_name: 1 })]]);
      await expect(repositoryNames("elsewhere", credential)).rejects.toThrow(
        "GitHub organization repositories returned invalid data",
      );
    });
  });
});
