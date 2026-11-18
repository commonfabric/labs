import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { staticGitHubCredential } from "./github-auth.ts";
import { GITHUB_ORGANIZATION } from "./lib.ts";
import { organizationRepos } from "./organization-repos.ts";

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
