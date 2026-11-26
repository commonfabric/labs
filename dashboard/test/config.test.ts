import { expect } from "@std/expect";
import type * as Config from "../config.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The variables that name the cfs and weaver repositories. */
const VARIABLES = [
  "DASHBOARD_CFS_REPO",
  "DASHBOARD_LOOM_REPO",
  "DASHBOARD_WEAVER_REPO",
];

/**
 * Loads a copy of the configuration, named `copy`, whose environment sets the
 * variables `given` sets and none of the others that name the cfs and weaver
 * repositories, and returns the two names it settles on.
 */
async function repositoriesWith(
  copy: string,
  given: Record<string, string>,
): Promise<string[]> {
  const saved = VARIABLES.map((name) => ({ name, value: Deno.env.get(name) }));
  try {
    for (const name of VARIABLES) Deno.env.delete(name);
    for (const [name, value] of Object.entries(given)) {
      Deno.env.set(name, value);
    }
    const config: typeof Config = await import(`../config.ts?${copy}`);
    return [config.CFS_REPO, config.WEAVER_REPO];
  } finally {
    for (const { name, value } of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

describe("config", () => {
  it("names the cfs and weaver repositories by the names they have now when the environment gives names they had before", async () => {
    expect(
      await repositoriesWith("renamed", {
        DASHBOARD_LOOM_REPO: "commonfabric/loom",
        DASHBOARD_WEAVER_REPO: "commonfabric/commonfabric-weaver",
      }),
    ).toEqual(["commonfabric/cfs", "commonfabric/weaver"]);
  });

  it("names the cfs and weaver repositories as the environment gives names no repository was renamed from, preferring DASHBOARD_CFS_REPO", async () => {
    expect(
      await repositoriesWith("unrenamed", {
        DASHBOARD_CFS_REPO: "acme/fork",
        DASHBOARD_LOOM_REPO: "acme/older",
        DASHBOARD_WEAVER_REPO: "acme/w",
      }),
    ).toEqual(["acme/fork", "acme/w"]);
  });
});
