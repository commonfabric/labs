/**
 * A pattern author's first import line: that the harness names the module that
 * exists, and corrects a guess at one that does not.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getHarnessSubagentProfileConfig,
  HARNESS_SUBAGENT_PROFILES,
} from "../src/contracts/subagent.ts";
import { DEFAULT_PARENT_TOOL_IDS } from "../src/contracts/tool-descriptor.ts";
import { getBuiltinTool } from "../src/tools/registry.ts";
import { withRuntimeModuleCorrection } from "../src/tools/run-pattern.ts";

/** Every tool surface a `run_pattern` caller can be given, by its name. */
const surfacesThatCanRunPatterns = (): readonly {
  name: string;
  toolIds: readonly string[];
}[] =>
  [
    {
      name: "parent",
      toolIds: DEFAULT_PARENT_TOOL_IDS as readonly string[],
    },
    ...HARNESS_SUBAGENT_PROFILES.map((profile) => ({
      name: profile as string,
      toolIds: getHarnessSubagentProfileConfig(profile)
        .allowedToolIds as readonly string[],
    })),
  ].filter((surface) => surface.toolIds.includes("run_pattern"));

describe("the runtime module a pattern author imports", () => {
  it("is named in the tool descriptions of every surface that can run a pattern", () => {
    const surfaces = surfacesThatCanRunPatterns();
    // A filtered list that filtered everything away would pass every
    // expectation below without testing one.
    expect(surfaces.map((surface) => surface.name)).toContain("pattern-author");
    for (const surface of surfaces) {
      const descriptions = surface.toolIds
        .map((toolId) => getBuiltinTool(toolId)?.descriptor.description ?? "")
        .join("\n");
      expect(
        descriptions.includes('from "commonfabric"'),
        `${surface.name} states the runtime module`,
      ).toBe(true);
    }
  });

  it("corrects a compile diagnostic that failed on a name for the product", () => {
    for (
      const guess of ["commontools", "common-tools", "@commontools/runner"]
    ) {
      const corrected = withRuntimeModuleCorrection(
        `Build failed: Could not resolve "${guess}"`,
      );
      expect(corrected).toContain(`"${guess}" does not exist`);
      expect(corrected).toContain('from "commonfabric"');
      // The diagnostic itself is what the author corrects against, so the
      // correction is added to it rather than substituted for it.
      expect(corrected).toContain(`Could not resolve "${guess}"`);
    }
  });

  it("names both specifiers when one source guessed twice", () => {
    const corrected = withRuntimeModuleCorrection(
      [
        'Could not resolve "@commontools/builder"',
        'Could not resolve "common-tools"',
      ].join("\n"),
    );
    expect(corrected).toContain(
      '"@commontools/builder" and "common-tools" do not exist',
    );
  });

  it("leaves a diagnostic about any other unresolved specifier alone", () => {
    const diagnostic = 'Could not resolve "./helpers.ts"';
    expect(withRuntimeModuleCorrection(diagnostic)).toEqual(diagnostic);
  });
});
