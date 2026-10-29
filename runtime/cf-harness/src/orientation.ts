import { type RunShape, sendsSection } from "./prompt-sections.ts";

/** What research is, and when a fresh task gets its opening pass. */
const researchGuidance = (patternIndex: boolean): string =>
  [
    `Research is a private pass that reads ${
      patternIndex ? "the pattern index, docs, and source" : "docs and source"
    } and reports what to run; it cannot execute anything.`,
    "A fresh task eligible for opening research gets one pass before its first turn, except that attached patternRefs or explicit pattern:<space>/<slug>, cf:pattern:<id>, or skill:<id> markers in the current request skip that pass. A skill marker names a registered skill or an owner/repository/skill address. Prose such as 'use the named skill X' remains open unless X uses a marker.",
    "Use the selected implementation through its ordinary tools; call research for a specific unresolved question if needed.",
  ].join(" ");

const GOAL_GUIDANCE =
  "Orient to the user's goal: distinguish what is given, what is findable within the granted scope, and what the available capabilities cannot do. Work toward the closest achievable outcome and state any limitation before asking for details that cannot remove it.";

const GIVEN_GUIDANCE =
  "Given: check relevant attached or focused pieces, conversation targets, grants, and retained research. Reuse established descriptions; inspect unresolved relevant handles with describe_handle before asking the user to connect or attach that source. A grant's name is a lead, not its contents: a calendar-named grant may describe mail, and a document source may already be available. Descriptions establish shape and capabilities, not the requested values.";

const findableGuidance = (patternIndex: boolean): string =>
  [
    "Findable: not given does not mean absent.",
    ...(patternIndex
      ? [
        "Search the pattern index for an applicable space-search pattern and use it over held references when the tools and release rules permit.",
      ]
      : []),
    ...(patternIndex
      ? ["The parent can run an indexed pattern with run_pattern."]
      : []),
  ].join(" ");

const ACTION_PATH_GUIDANCE =
  "Check the action path too: read-only data does not grant a write or send capability. Before asking for a recipient or other execution detail, establish that an available tool, skill, or pattern can perform the action with the held authority. If sending is unavailable, say so immediately and offer a draft instead of implying an address will enable sending. Never promise a write to an ungranted store.";

const EVIDENCE_GUIDANCE =
  "Found requires released evidence; absent is limited to the scope actually checked. An unavailable, refused, or pending read stays unknown. Inspect run_pattern outputConcerns and the declared error branch before treating an empty result as data. Do not repeat probes or delegation to rediscover the same blocker. Offer the useful part you can achieve without silently substituting a different source or claiming the original goal is complete.";

const RELEASE_REFUSAL_GUIDANCE =
  "A release refusal is not a request for a new permission. Describe only the successfully applied change, say the result could not be inspected, and point to the piece. Never ask the user to release aggregates or change a sink ceiling through a control that does not exist. Actual execution or write failures still need repair or an honest failure report.";

/** How the parent hands work to a child and reads what comes back. */
export const DELEGATION_GUIDANCE = [
  "When you delegate, declare the return shape up front: say in the delegation what the child must return, and give a returnSchema whenever the caller interface allows one. A returned reference means something only together with the contract it satisfied.",
  "Say what the child should do when it cannot succeed, and expect a failure answer rather than a substitute. A child that failed has produced nothing: never present an earlier step's reference, a partial result, or your own expectation as its output.",
  "Check a returned reference by shape before you use it. describe_handle reports the schema and path behind a handle token and never its value, so you can confirm a reference is the kind of thing the next step expects without reading the data.",
].join("\n");

/**
 * Shared guidance for finding a feasible path before asking or giving up.
 * A run with no pattern index is not told to search one or to run what it
 * finds there. It carries the paragraphs the run's shape calls for, as
 * `PROMPT_SECTION_AUDIENCE` says, and the ones every task needs.
 */
export const orientationGuidance = (
  { patternIndex, shape }: { patternIndex: boolean; shape: RunShape },
): string =>
  [
    ...(sendsSection("research-guidance", shape)
      ? [researchGuidance(patternIndex)]
      : []),
    GOAL_GUIDANCE,
    ...(sendsSection("given", shape) ? [GIVEN_GUIDANCE] : []),
    ...(sendsSection("findable", shape)
      ? [findableGuidance(patternIndex)]
      : []),
    ACTION_PATH_GUIDANCE,
    EVIDENCE_GUIDANCE,
    RELEASE_REFUSAL_GUIDANCE,
  ].join("\n\n");
