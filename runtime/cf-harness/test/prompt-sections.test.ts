import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { HARNESS_RUN_DEPTHS } from "../src/contracts/run-depth.ts";
import {
  PROMPT_SECTIONS,
  type PromptSection,
  type RunShape,
  sendsSection,
} from "../src/prompt-sections.ts";
import {
  HARNESS_TASK_DOMAINS,
  HARNESS_TASK_TAGS,
  type HarnessTaskDomain,
  type HarnessTaskTag,
} from "../src/task-classification.ts";

/** Every subset of `all`, the empty one among them. */
const subsets = <T>(all: readonly T[]): ReadonlySet<T>[] =>
  Array.from(
    { length: 2 ** all.length },
    (_, mask) => new Set(all.filter((_, i) => mask & (1 << i))),
  );

const TAG_SETS: ReadonlySet<HarnessTaskTag>[] = subsets(HARNESS_TASK_TAGS);
const DOMAIN_SETS: ReadonlySet<HarnessTaskDomain>[] = subsets(
  HARNESS_TASK_DOMAINS,
);

/** Every classified run: each tag set in each set of domains at each depth. */
const CLASSIFIED: RunShape[] = TAG_SETS.flatMap((tags) =>
  DOMAIN_SETS.flatMap((domains) =>
    HARNESS_RUN_DEPTHS.map((depth) => ({ tags, domains, depth }))
  )
);

describe("prompt sections", () => {
  it("sends a standard run that was never classified every section but the stand-ins for piece targeting and those for another depth", () => {
    const otherDepth = [
      "fast-reply",
      "personal-exhaustive",
      "web-research",
      "material-bar",
      "critique",
    ];
    expect(
      PROMPT_SECTIONS.filter((section) =>
        sendsSection(section, { depth: "standard" })
      ),
    ).toEqual(
      PROMPT_SECTIONS.filter((section) =>
        section !== "held-pieces" && section !== "may-hold-pieces" &&
        !otherDepth.includes(section)
      ),
    );
  });

  it("sends every classified run exactly one stand-in for piece targeting", () => {
    for (const shape of CLASSIFIED) {
      expect([
        sendsSection("held-pieces", shape),
        sendsSection("may-hold-pieces", shape),
      ].filter(Boolean)).toHaveLength(1);
    }
  });

  it("never sends resolving a named piece twice: an author task reads it inside piece targeting", () => {
    for (const shape of CLASSIFIED) {
      expect(
        sendsSection("resolve-piece-tools", shape) &&
          sendsSection("piece-targeting", shape),
      ).toBe(false);
    }
  });

  it("gives the opening research pass to an author task, and to a deep run in the fabric, and to no other", () => {
    for (const shape of CLASSIFIED) {
      expect(sendsSection("opening-research", shape)).toBe(
        shape.tags?.has("author") === true ||
          (shape.depth === "deep" && shape.domains?.has("fabric") === true),
      );
    }
  });

  it("reads a classification recorded before tasks had domains as in every domain", () => {
    expect(
      sendsSection("opening-research", {
        tags: new Set<HarnessTaskTag>(["find"]),
        depth: "deep",
      }),
    ).toBe(true);
  });

  it("sends a standard run no strategy section, a quick run only the fast reply, and a deep run the rest where its domains call for them", () => {
    for (const shape of CLASSIFIED) {
      const deep = shape.depth === "deep";
      expect(sendsSection("fast-reply", shape)).toBe(shape.depth === "quick");
      expect(sendsSection("personal-exhaustive", shape)).toBe(
        deep && shape.domains?.has("personal") === true,
      );
      expect(sendsSection("web-research", shape)).toBe(
        deep && shape.domains?.has("web") === true,
      );
      expect(sendsSection("material-bar", shape)).toBe(deep);
      expect(sendsSection("critique", shape)).toBe(deep);
    }
  });

  it("sends a deep run that was never classified the deep sections for every domain, as it does the fabric's opening research", () => {
    const sections: PromptSection[] = [
      "personal-exhaustive",
      "web-research",
      "material-bar",
      "critique",
    ];
    const deepStrategy = (shape: RunShape) =>
      sections.filter((section) => sendsSection(section, shape));

    // Unknown domains pass every domain condition, as for opening research.
    expect(deepStrategy({ depth: "deep" })).toEqual([
      "personal-exhaustive",
      "web-research",
      "material-bar",
      "critique",
    ]);
    expect(sendsSection("opening-research", { depth: "deep" })).toBe(true);
    // A classification that found no domain is known, and gets neither.
    expect(
      deepStrategy({
        tags: new Set<HarnessTaskTag>(["find"]),
        domains: new Set<HarnessTaskDomain>(),
        depth: "deep",
      }),
    ).toEqual(["material-bar", "critique"]);
  });
});
