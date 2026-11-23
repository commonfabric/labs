import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type * as Config from "../config.ts";

/**
 * Loads a copy of the configuration, named `copy`, that reads the loom and
 * weaver repositories `given` as its environment, and returns the two names it
 * settles on.
 */
async function repositoriesWith(
  copy: string,
  given: { DASHBOARD_LOOM_REPO: string; DASHBOARD_WEAVER_REPO: string },
): Promise<string[]> {
  const saved = Object.keys(given).map((name) => ({
    name,
    value: Deno.env.get(name),
  }));
  try {
    for (const [name, value] of Object.entries(given)) {
      Deno.env.set(name, value);
    }
    const config: typeof Config = await import(`../config.ts?${copy}`);
    return [config.LOOM_REPO, config.WEAVER_REPO];
  } finally {
    for (const { name, value } of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

describe("config", () => {
  it("names the loom and weaver repositories by the names they have now when the environment gives names they had before", async () => {
    expect(
      await repositoriesWith("renamed", {
        DASHBOARD_LOOM_REPO: "commonfabric/loom",
        DASHBOARD_WEAVER_REPO: "commonfabric/commonfabric-weaver",
      }),
    ).toEqual(["commonfabric/cfs", "commonfabric/weaver"]);
  });

  it("names the loom and weaver repositories as the environment gives names no repository was renamed from", async () => {
    expect(
      await repositoriesWith("unrenamed", {
        DASHBOARD_LOOM_REPO: "acme/fork",
        DASHBOARD_WEAVER_REPO: "acme/w",
      }),
    ).toEqual(["acme/fork", "acme/w"]);
  });
});
