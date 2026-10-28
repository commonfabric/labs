import type { HarnessRunDepth } from "./contracts/run-depth.ts";
import type {
  HarnessTaskClassification,
  HarnessTaskDomain,
  HarnessTaskTag,
} from "./task-classification.ts";

/**
 * The parts of a run's prompt that only some kinds of work call for. Every
 * other part is sent to every run. `PROMPT_SECTION_AUDIENCE` says what each one
 * is and who gets it.
 */
export const PROMPT_SECTIONS = [
  "opening-research",
  "research-guidance",
  "given",
  "findable",
  "code-work",
  "verification",
  "skill-by-id",
  "delegation",
  "browser-host-parent",
  "piece-targeting",
  "held-pieces",
  "may-hold-pieces",
  "revision-verification",
  "weaver-commands",
  "author-tools",
  "research-tools",
  "pieces-tools",
  "resolve-piece-tools",
  "loom-commands-tools",
  "loom-retrieval-tools",
  "fast-reply",
  "personal-exhaustive",
  "web-research",
  "material-bar",
  "critique",
] as const;

export type PromptSection = typeof PROMPT_SECTIONS[number];

/**
 * Which runs a section is sent to. A run gets the section when its task
 * carries any tag in `anyOf` (any tag at all, when `anyOf` is absent) and none
 * in `noneOf`, is in any domain in `domains` (any, when absent), and its depth
 * is one of `depth` (any, when absent). A task that was never classified
 * passes the tag and domain conditions unless `unclassified` is false: such a
 * run carries all of its orientation, but not the blocks that stand in for
 * piece targeting. The depth conditions hold for every run.
 */
export interface SectionAudience {
  readonly anyOf?: readonly HarnessTaskTag[];
  readonly noneOf?: readonly HarnessTaskTag[];
  readonly domains?: readonly HarnessTaskDomain[];
  readonly unclassified?: false;
  readonly depth?: readonly HarnessRunDepth[];
}

/** What decides which sections a run is sent. */
export interface RunShape {
  /** The task's tags; absent when it was never classified. */
  readonly tags?: ReadonlySet<HarnessTaskTag>;

  /**
   * The task's domains; absent when it was never classified, or classified
   * before tasks had domains, which passes every domain condition.
   */
  readonly domains?: ReadonlySet<HarnessTaskDomain>;
  readonly depth: HarnessRunDepth;
}

/**
 * The runs each section reaches, in one place. A section with a list of
 * audiences reaches a run any one of them does.
 */
export const PROMPT_SECTION_AUDIENCE: Readonly<
  Record<PromptSection, SectionAudience | readonly SectionAudience[]>
> = {
  // The opening research pass a fresh task gets before its first turn, and
  // what that pass is. It reads Common Fabric's docs, pattern index and
  // source, so beyond authoring it serves a deep run about the fabric.
  "opening-research": [
    { anyOf: ["author"] },
    { domains: ["fabric"], depth: ["deep"] },
  ],
  "research-guidance": { anyOf: ["author"] },
  // Inspect held pieces, grants and retained research before asking.
  given: { anyOf: ["pieces", "find"] },
  // Not given does not mean absent; search the pattern index.
  findable: { anyOf: ["find", "author"] },
  // The work framed as code to read and repair; running verification and
  // repairing what it reports; acquiring a skill named by an exact id.
  "code-work": { anyOf: ["pieces", "author"] },
  verification: { anyOf: ["author"] },
  "skill-by-id": { anyOf: ["pieces", "author"] },
  // Declaring a child's return shape and reading what comes back.
  delegation: { anyOf: ["act", "pieces", "author"] },
  // Web work split into small steps, one browser child each.
  "browser-host-parent": { anyOf: ["act"] },
  // Full piece targeting, and the blocks that stand in for it: how to work on
  // the held pieces, or that the run may hold some.
  "piece-targeting": { anyOf: ["author"] },
  "held-pieces": { anyOf: ["pieces"], unclassified: false },
  "may-hold-pieces": { noneOf: ["pieces"], unclassified: false },
  // Comparing a revision's effect before and after.
  "revision-verification": { anyOf: ["author"] },
  // The Weaver's commands, which read as well as change the application.
  "weaver-commands": { anyOf: ["find", "act"] },
  // Tool guidance: writing and running patterns, building on research,
  // reading and acting on held handles, resolving a named piece (authoring
  // reads that inside piece targeting), the host's commands and retrieval.
  "author-tools": { anyOf: ["author"] },
  "research-tools": { anyOf: ["author", "find", "pieces"] },
  "pieces-tools": { anyOf: ["pieces"] },
  "resolve-piece-tools": {
    anyOf: ["find", "act", "pieces"],
    noneOf: ["author"],
  },
  "loom-commands-tools": { anyOf: ["find", "act"] },
  "loom-retrieval-tools": { anyOf: ["find", "act"] },
  // How far to take the work (`strategy.ts`): a quick run answers directly or
  // takes the shortest path that does what was asked; a deep run searches the
  // person's data exhaustively or reads several independent web sources, where
  // its domains say, holds what it leaves to a bar, and reads its result back
  // before it finishes.
  "fast-reply": { depth: ["quick"] },
  "personal-exhaustive": { domains: ["personal"], depth: ["deep"] },
  "web-research": { domains: ["web"], depth: ["deep"] },
  "material-bar": { depth: ["deep"] },
  critique: { depth: ["deep"] },
};

/** Whether one audience takes in a run of `shape`. */
const reaches = (audience: SectionAudience, shape: RunShape): boolean => {
  const { tags, depth } = shape;
  if (audience.depth !== undefined && !audience.depth.includes(depth)) {
    return false;
  }
  if (tags === undefined) return audience.unclassified !== false;
  const has = (tag: HarnessTaskTag) => tags.has(tag);
  const { domains } = shape;
  return (audience.anyOf === undefined || audience.anyOf.some(has)) &&
    !(audience.noneOf ?? []).some(has) &&
    (audience.domains === undefined || domains === undefined ||
      audience.domains.some((domain) => domains.has(domain)));
};

/** Whether a run of `shape` is sent `section`. */
export const sendsSection = (
  section: PromptSection,
  shape: RunShape,
): boolean => {
  const audience = PROMPT_SECTION_AUDIENCE[section];
  const alternatives = "length" in audience ? audience : [audience];
  return alternatives.some((one) => reaches(one, shape));
};

/**
 * The shape a run of `depth` has after its recorded classification: its tags
 * and domains, or neither when it was never classified.
 */
export const classifiedShape = (
  classification:
    | Pick<HarnessTaskClassification, "tags" | "domains">
    | undefined,
  depth: HarnessRunDepth,
): RunShape => ({
  ...(classification !== undefined
    ? {
      tags: new Set(classification.tags),
      ...(classification.domains !== undefined
        ? { domains: new Set(classification.domains) }
        : {}),
    }
    : {}),
  depth,
});
