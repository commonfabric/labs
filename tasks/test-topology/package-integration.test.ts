import { expect } from "@std/expect";
import { dirname, fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { serverExecutionCiLane } from "../server-execution-ci.ts";
import type {
  ServerExecutionOnSkip,
  ServerExecutionSuite,
} from "../server-execution-on-skips.ts";
import { loadPackageIntegrationSuites } from "./package-integration.ts";
import { type Suite, unavailableUnits } from "./suite.ts";

const root = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

/** The suites as they stand with a stated first-party default. */
async function suitesWith(
  defaultEnabled: boolean,
  skips: Record<ServerExecutionSuite, ServerExecutionOnSkip[]> = {
    patterns: [],
    runner: [],
    "runtime-client": [],
    shell: [],
  },
): Promise<Suite[]> {
  return await loadPackageIntegrationSuites(root, defaultEnabled, skips);
}

/** One suite by name, from a set. */
function byId(suites: readonly Suite[], id: string): Suite {
  return suites.find((suite) => suite.id === id)!;
}

describe("the package integration suites", () => {
  it("gives each arm the server that arm needs", async () => {
    // The opposite arm is a compile-time define baked into the browser
    // shell inside a binary, which a server run from source cannot
    // reproduce. Naming a capability is how a suite says which of the two
    // it needs without either the workflow or the other suites knowing
    // that there are two.

    const suites = await suitesWith(serverExecutionCiLane("default").enabled);
    // Both arms take a compiled binary. The shell's tests drive a browser
    // at the server, and the shell is a bundle inside the binary; the
    // opposite arm needs one for a second reason, its posture being a
    // define baked into that same shell.
    expect(byId(suites, "package-integration").needs).toContain(
      "toolshed-baked",
    );
    expect(byId(suites, "package-integration-opposite").needs).toContain(
      "toolshed-baked-opposite",
    );
    expect(byId(suites, "package-integration").variant).toBeUndefined();
  });

  it("carries the ON-arm skip list on whichever arm resolves ON", async () => {
    // The skip list belongs to the arm that is ON rather than to a role, so
    // a flip of the first-party default moves it between the two suites. A
    // list that stayed with one of them would take tests out of the arm
    // that can run them and leave them in the arm that cannot. The list is
    // stated here rather than read from the repository, which holds an
    // empty one whenever the ON arm is complete.

    const file = "packages/runner/integration/reconnection.test.ts";
    const skips = {
      patterns: [],
      runner: [{
        file: "integration/reconnection.test.ts",
        phase: "phase-2" as const,
        reason: "a stated skip, so the property has something to move",
      }],
      "runtime-client": [],
      shell: [],
    };

    for (const defaultEnabled of [true, false]) {
      const suites = await suitesWith(defaultEnabled, skips);
      const on = byId(
        suites,
        defaultEnabled ? "package-integration" : "package-integration-opposite",
      );
      const off = byId(
        suites,
        defaultEnabled ? "package-integration-opposite" : "package-integration",
      );
      expect([...unavailableUnits(on)]).toEqual([file]);
      expect([...unavailableUnits(off)]).toEqual([]);
      expect(on.units).not.toContain(file);
      expect(off.units).toContain(file);
    }
  });

  it("runs the shell's integration tests without a visible browser", async () => {
    const suites = await suitesWith(serverExecutionCiLane("default").enabled);
    const suite = byId(suites, "package-integration");
    const unit = suite.units.find((name) =>
      name.startsWith("packages/shell/")
    )!;
    const [invocation] = await suite.command([{ unit, skip: [] }], {
      root,
      outputDir: await Deno.makeTempDir({ prefix: "package-integration-" }),
      spoolDir: "/spool",
    });
    expect(invocation!.env?.HEADLESS).toBe("1");
    expect(invocation!.junit?.[0]?.scope).toBe("shell");
  });
});
