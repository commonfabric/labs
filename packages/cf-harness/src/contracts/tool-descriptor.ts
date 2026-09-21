import type { JSONSchema } from "@commonfabric/api";

export type BuiltinToolId =
  | "bash"
  | "browser"
  | "read_file"
  | "view_image"
  | "web_fetch"
  | "read_skill_resource"
  | "run_skill_script"
  | "edit_file"
  | "write_file"
  | "delegate_task"
  | "run_pattern"
  | "revise_piece"
  | "read_piece_source"
  | "assign_slug"
  | "describe_handle"
  | "finish_task"
  | "search_patterns"
  | "record_feedback"
  | "search_skills"
  | "acquire_skill"
  | "research"
  | "loom_compose"
  | "loom_inspect"
  | "loom_authoring_context"
  | "loom_search"
  | "loom_page_discover"
  | "loom_page_inspect"
  | "loom_page_read"
  | "loom_people"
  | "loom_calendar_list"
  | "loom_context"
  | "loom_profile";

export const DEFAULT_PARENT_TOOL_IDS = [
  "bash",
  "read_file",
  "view_image",
  "read_skill_resource",
  "edit_file",
  "write_file",
  "delegate_task",
  "describe_handle",
  "finish_task",
] as const satisfies readonly BuiltinToolId[];

/**
 * The tools that exist only over a fabric session. They join the tool surface
 * exactly when the run can build one; without it each is absent rather than
 * present-but-failing, even when an explicit allowlist names it.
 */
const FABRIC_SESSION_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["run_pattern", "assign_slug", "acquire_skill"] as const,
);

/**
 * The two tools that read and replace a piece's source. They need a fabric
 * session like the set above, and unlike it they are not parent tools.
 */
const PIECE_SOURCE_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["read_piece_source", "revise_piece"] as const,
);

/**
 * Tools no parent surface may offer, whatever its backing and whoever asks.
 *
 * Source enters the context that revises a piece and no other: a parent that
 * could read a piece's source would hold program text its own return boundary
 * exists to keep out of it. Leaving these out of
 * {@link parentToolIdsForBacking} is not enough on its own, because a parent
 * surface can also be named explicitly — by `--allow-tool`, or by an
 * interactive client's policy — and such a list is validated against the tools
 * this build defines. So every surface that lets a caller name a parent's
 * tools subtracts this set, and that is the whole of what keeps the two off a
 * parent: a tool added here is refused by name at each of those surfaces
 * rather than silently absent from one of them.
 */
export const SUBAGENT_ONLY_TOOL_IDS: ReadonlySet<BuiltinToolId> =
  PIECE_SOURCE_TOOL_IDS;

/** Whether `toolId` is one a parent surface may never offer. */
export const isSubagentOnlyToolId = (toolId: string): boolean =>
  SUBAGENT_ONLY_TOOL_IDS.has(toolId as BuiltinToolId);

/**
 * The tools that exist only over the pattern index, gated on the same terms
 * as the fabric-session ones.
 */
const PATTERN_INDEX_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["search_patterns", "record_feedback"] as const,
);

/**
 * The tool gated on at least one trusted research source. A run with neither
 * corpus nor pattern index has nothing for its private loop to investigate.
 */
const RESEARCH_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["research"] as const,
);

/** The metadata-only tool gated on configured skills.sh discovery. */
const SKILLS_SH_SEARCH_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["search_skills"] as const,
);

/** The pinned acquisition tool gated separately from discovery. */
const SKILLS_SH_ACQUISITION_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["acquire_skill"] as const,
);

/**
 * The tool that exists only over a skill registry. A run given no skills root
 * scans no registry, so `read_skill_resource` would answer
 * `skill_registry_missing` on every call — absent rather than
 * present-but-failing, so a model does not spend turns discovering a tool it
 * was never backed to use.
 */
const SKILL_REGISTRY_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["read_skill_resource"] as const,
);

/**
 * The tool two different backings can supply, and which is absent only when
 * neither does.
 *
 * A registry script needs the skills root that scanned it. An acquired script
 * needs no registry at all: its bytes came from a pinned commit and sit where
 * the run that holds the skill's handle mounts them. A child given an acquired
 * skill in a run with no skills root is backed to run its script, and
 * withholding the tool from it would hand it a mounted skill it could not
 * execute.
 */
const SKILL_SCRIPT_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set(
  ["run_skill_script"] as const,
);

/** Tools backed only by an explicitly configured host Loom transport. */
export const LOOM_AUTHORING_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set([
  "loom_compose",
  "loom_inspect",
  "loom_authoring_context",
]);

/**
 * The read-only Loom tools, backed only by an explicitly configured host
 * Loom retrieval transport. Gated apart from the authoring three: a host may
 * let a run read Loom without letting it compose collections, and the other
 * way round.
 */
export const LOOM_RETRIEVAL_TOOL_IDS: ReadonlySet<BuiltinToolId> = new Set([
  "loom_search",
  "loom_page_discover",
  "loom_page_inspect",
  "loom_page_read",
  "loom_people",
  "loom_calendar_list",
  "loom_context",
  "loom_profile",
]);

/** What a run can back the gated tools with. */
export interface HarnessToolBackingAvailability {
  fabricSessionAvailable: boolean;
  patternIndexAvailable: boolean;
  skillsShSearchAvailable: boolean;
  skillsShAcquisitionAvailable: boolean;
  skillRegistryAvailable: boolean;

  /**
   * Whether this run holds a skill it acquired scripts for. The second backing
   * `run_skill_script` has, independent of any registry: absent, the tool
   * rests on the skills root alone.
   */
  acquiredSkillsAvailable?: boolean;

  docsCorpusAvailable: boolean;

  /** Whether the operator configured host Loom authoring for this run. */
  loomAuthoringAvailable?: boolean;

  /** Whether the operator configured host Loom retrieval for this run. */
  loomRetrievalAvailable?: boolean;
}

/** The gated tools this run cannot back, and so does not offer. */
export const withheldToolIds = (
  availability: HarnessToolBackingAvailability,
): ReadonlySet<BuiltinToolId> =>
  new Set([
    ...(availability.fabricSessionAvailable ? [] : FABRIC_SESSION_TOOL_IDS),
    ...(availability.fabricSessionAvailable ? [] : PIECE_SOURCE_TOOL_IDS),
    ...(availability.patternIndexAvailable ? [] : PATTERN_INDEX_TOOL_IDS),
    ...(availability.skillsShSearchAvailable ? [] : SKILLS_SH_SEARCH_TOOL_IDS),
    ...(availability.skillsShAcquisitionAvailable
      ? []
      : SKILLS_SH_ACQUISITION_TOOL_IDS),
    ...(availability.skillRegistryAvailable ? [] : SKILL_REGISTRY_TOOL_IDS),
    ...(availability.skillRegistryAvailable ||
        availability.acquiredSkillsAvailable
      ? []
      : SKILL_SCRIPT_TOOL_IDS),
    ...(availability.docsCorpusAvailable || availability.patternIndexAvailable
      ? []
      : RESEARCH_TOOL_IDS),
    ...(availability.loomAuthoringAvailable ? [] : LOOM_AUTHORING_TOOL_IDS),
    ...(availability.loomRetrievalAvailable ? [] : LOOM_RETRIEVAL_TOOL_IDS),
  ]);

/**
 * The parent tool surface a run offers when nothing narrows it: the default
 * tools plus every gated tool this run's backing supports.
 *
 * This is the one derivation of "which tools does a session have", and every
 * surface that needs the answer asks here. A surface that computed its own
 * list would go stale the next time a gated tool is added — which is how a
 * console session ended up unable to acquire a skill its own registry
 * configuration had already backed.
 */
export const parentToolIdsForBacking = (
  availability: HarnessToolBackingAvailability,
): readonly BuiltinToolId[] => {
  const withheld = withheldToolIds(availability);
  return [
    ...DEFAULT_PARENT_TOOL_IDS,
    ...(availability.fabricSessionAvailable ? FABRIC_SESSION_TOOL_IDS : []),
    ...(availability.patternIndexAvailable ? PATTERN_INDEX_TOOL_IDS : []),
    ...(availability.skillsShSearchAvailable ? SKILLS_SH_SEARCH_TOOL_IDS : []),
    ...(availability.skillsShAcquisitionAvailable
      ? SKILLS_SH_ACQUISITION_TOOL_IDS
      : []),
    ...(availability.docsCorpusAvailable || availability.patternIndexAvailable
      ? RESEARCH_TOOL_IDS
      : []),
    ...(availability.loomAuthoringAvailable ? LOOM_AUTHORING_TOOL_IDS : []),
    ...(availability.loomRetrievalAvailable ? LOOM_RETRIEVAL_TOOL_IDS : []),
  ].filter((toolId, index, ids) =>
    !withheld.has(toolId) && ids.indexOf(toolId) === index
  );
};

export type HarnessToolEffectClass = "read" | "write" | "side-effect";

/** A function tool descriptor accepted by the harness model transports. */
export interface HarnessModelToolDescriptor {
  /** Function name sent to the model. */
  toolId: string;

  /** Short display name for operator-facing surfaces. */
  title: string;

  /** Instructions that tell the model when and how to call the tool. */
  description: string;

  /** Whether invoking the tool only reads or can change external state. */
  effectClass: HarnessToolEffectClass;

  /** JSON Schema for the function arguments. */
  inputSchema: JSONSchema;

  /** JSON Schema for the function result, when one is declared. */
  outputSchema?: JSONSchema;

  /** Search and presentation labels for the tool. */
  tags?: readonly string[];
}

/** A registered harness builtin, whose id participates in run policy. */
export interface HarnessToolDescriptor extends HarnessModelToolDescriptor {
  /** Stable builtin id used by policy, transcripts, and the registry. */
  toolId: BuiltinToolId;
}
