import { isClosedResearchTask } from "./research/closed-task.ts";
import type { HarnessRunState } from "./run-state.ts";

/**
 * The kinds of work a task can call for. A task carries every tag that
 * applies, and each tag adds the orientation that kind of work needs:
 *
 * - `respond`: an answer from what the run already holds.
 * - `find`: a lookup, in the person's data or on the web.
 * - `act`: an operation in the person's application or on a web page.
 * - `pieces`: work on the pieces and patterns the run was handed.
 * - `author`: a pattern written from scratch.
 */
export const HARNESS_TASK_TAGS = [
  "respond",
  "find",
  "act",
  "pieces",
  "author",
] as const;

export type HarnessTaskTag = typeof HARNESS_TASK_TAGS[number];

/**
 * Where a task's work happens, besides what kind of work it is. A task
 * carries each domain the rule finds a positive sign of, and none when it
 * finds none: a question of general knowledge, or an operation in the
 * person's application, has no domain.
 *
 * - `fabric`: Common Fabric itself — the pieces and patterns the run holds or
 *   authors, the pattern index, and how the fabric works.
 * - `personal`: the person's own data — their calendar, mail, messages and
 *   the rest the host's retrieval reads.
 * - `web`: pages and facts on the public web.
 */
export const HARNESS_TASK_DOMAINS = ["fabric", "personal", "web"] as const;

export type HarnessTaskDomain = typeof HARNESS_TASK_DOMAINS[number];

/** How one part of a classification was chosen. */
export type HarnessClassificationPath =
  | "caller"
  | "rule"
  | "assumed"
  | "fallback";

/**
 * What a run's caller says about its task, each part in place of the
 * classifier's: the kinds of work it calls for, and where that work happens.
 * A part the caller leaves out is the classifier's to decide.
 */
export interface HarnessTaskShape {
  tags?: readonly HarnessTaskTag[];
  domains?: readonly HarnessTaskDomain[];
}

/**
 * The tags a root task was given before its first model turn, recorded in the
 * run state so a run report can say what orientation the run got and what
 * deciding it cost.
 */
export interface HarnessTaskClassification {
  type: "cf-harness.task-classification";
  version: 1;
  tags: HarnessTaskTag[];

  /**
   * What chose the tags: the run's caller, the keyword rule, the assumption
   * made when no rule applies, or the fallback of every tag when the
   * classifier failed.
   */
  path: HarnessClassificationPath;

  /**
   * Where the work happens; absent from a record written before tasks had
   * domains, which reads as every domain.
   */
  domains?: HarnessTaskDomain[];

  /**
   * What chose the domains: the caller, the rule, the assumption of none when
   * the rule found no sign of one, or every domain when the classifier failed.
   */
  domainsPath?: HarnessClassificationPath;

  /** Wall time the classification took. */
  durationMs: number;
}

/** What the classifier reads about a run besides the task text. */
export type TaskClassificationContext =
  & Pick<HarnessRunState, "patternRefs" | "skillRegistry" | "inputCells">
  & { browserHost?: boolean };

const NAVIGATE =
  /\b(?:take me to|go to|open|navigate to|switch to|bring up)\b.*\bloom\b|\b(?:open|go to|visit|navigate to)\s+https?:\/\//;
const ACT =
  /\b(?:deploy|add\b.*\bto (?:this|the|my|a) loom|move\b.*\b(?:panel|loom))\b/;
const WEB_ACT =
  /\b(?:buy|order|book|purchase|reserve|sign up|fill (?:in|out)|check ?out|browse)\b|\breservation\b/;
const QUESTION =
  /^(?:what|what's|whats|when|who|whom|whose|where|which|why|how|is|are|was|were|do|does|did|can|could|has|have)\b|\?\s*$/;
/** A request phrased as a question, which asks for an action, not an answer. */
const POLITE_REQUEST = /^(?:can|could|would|will) you\b/;
const LOOKUP =
  /\b(?:find|search|look (?:up|for)|list|show me|summari[sz]e|check|browse)\b/;
const EXPLICIT_LOOKUP = /\b(?:find|search|look (?:up|for))\b/;
const URL = /\bhttps?:\/\/\S+/;
const AUTHOR =
  /\b(?:make|build|write|create|author|code|design|generate)\b(?:\s+(?:me|us))?\s+(?:a|an|new|some)\b(?!\s+(?:new\s+)?(?:note|loom|reservation|booking|appointment|payment|call)\b)/;
const DEICTIC =
  /\b(?:it|this|these)\b(?!\s+(?:week|weekend|month|year|loom)\b)/;
/** A request to work a held piece through one of its verbs. */
const VERB = /\b(?:use|call|run|invoke)\b.*\bverbs?\b/;
/** A request to add something to a thing, other than a loom. */
const ADD_TO = /\badd\b.*\bto (?:the|this)\b(?!\s+loom\b)/;
/** The action verbs {@link ACT} and {@link WEB_ACT} read, standing alone. */
const ACTION_VERB =
  /\b(?:deploy|add|move|buy|order|book|purchase|reserve|sign up|fill|check ?out|browse)\b/;
/**
 * Signs of the person's own data: something of theirs (`my calendar`), their
 * own correspondence or meetings (`haven't I replied`, `emailed me`), one they
 * point at (`that email from`), or what is on a day of theirs. A bare noun such as
 * "calendar" or "email" is not one: it names a thing anyone may ask about.
 */
const PERSONAL =
  /\b(?:my|our)\s+(?:\w+\s+)?(?:calendar|schedule|meetings?|appointments?|e-?mails?|inbox|messages?|texts?|dms?|contacts?|notes?|files?|documents?|docs|photos?|tasks?|to-?dos?|week|day|weekend|plans?|people|friends|family|next)\b|\b(?:am i|have i|did i|haven't i|do i have|i've)\b.*\b(?:meet|meeting|replied|reply|emailed|messaged|texted|scheduled|booked)\b|\b(?:emailed|messaged|texted|called|wrote to|invited)\s+me\b|\b(?:that|this)\s+(?:e-?mail|message|text|invite|meeting|appointment)\b|^what'?s on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|this week|next week|the weekend)\b/;
/**
 * Signs of Common Fabric itself, beyond a held or authored piece: the system
 * by name, the pattern index, or a pattern named beside one of its parts or
 * a loom, in either order.
 */
const FABRIC =
  /\bcommon fabric\b|\bpattern index\b|\bpatterns?\b.*\b(?:cells?|pieces?|handlers?|verbs?|schemas?|loom|deploy)\b|\b(?:cells?|pieces?|handlers?|verbs?|schemas?|loom|deploy)\b.*\bpatterns?\b/;
/** Signs of the public web. */
const WEB =
  /\b(?:online|on the (?:web|internet)|websites?|web ?pages?|google|news|reviews?|weather|forecast)\b|\blatest\b.*\b(?:version|release|news)\b/;
/** A request to research or compare, which reads the web when nothing else. */
const RESEARCH =
  /^(?:research|compare)\b|\b(?:research|compare)\s+(?:the|into|on|about|how|what|whether)\b/;
const CONVERSATIONAL =
  /^(?:hi|hey|hello|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|got it)\b/;

/** Lowercased letter-and-number runs of `text`, in any script. */
const words = (text: string): string[] =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

/**
 * Whether `text` names a held piece: its whole name, or two adjacent words
 * of it, appear in the text. One shared word is not enough, since a name such
 * as "Packing List" holds words any request may use.
 */
const mentionsHeldPiece = (
  text: string,
  inputCells: TaskClassificationContext["inputCells"],
): boolean => {
  const spoken = ` ${words(text).join(" ")} `;
  return (inputCells ?? []).some((inputCell) => {
    const name = words(inputCell.name);
    const phrases = name.length === 1
      ? name
      : name.slice(1).map((word, index) => `${name[index]} ${word}`);
    return phrases.some((phrase) => spoken.includes(` ${phrase} `));
  });
};

/**
 * Tags a task by keyword alone, or answers `undefined` when no rule applies.
 * A task naming a held piece, or pointing at one, is about that piece: a
 * listing or question it asks is answered from the piece rather than looked
 * up elsewhere, unless it says to search. A task asking to use a verb, or to
 * add something to a thing other than a loom, while the run holds pieces,
 * acts on a held piece.
 * An attached pattern or an explicit marker adds `pieces` without taking
 * anything away.
 */
export const classifyTaskByRule = (
  task: string,
  context: TaskClassificationContext,
): Set<HarnessTaskTag> | undefined => {
  const text = task.trim().toLowerCase();
  const tags = new Set<HarnessTaskTag>();
  const holdsPieces = (context.inputCells?.length ?? 0) > 0;
  const pointsAtHeldPiece = holdsPieces &&
    (DEICTIC.test(text) || mentionsHeldPiece(text, context.inputCells));
  const worksHeldPiece = holdsPieces &&
    (VERB.test(text) || ADD_TO.test(text));
  if (
    pointsAtHeldPiece || worksHeldPiece || isClosedResearchTask(task, context)
  ) {
    tags.add("pieces");
  }
  if (worksHeldPiece) tags.add("act");
  if (NAVIGATE.test(text)) {
    tags.add("act");
    tags.add("find");
  }
  if (ACT.test(text) || (context.browserHost && WEB_ACT.test(text))) {
    tags.add("act");
  }
  const lookup = (QUESTION.test(text) && !POLITE_REQUEST.test(text)) ||
    LOOKUP.test(text) || URL.test(task);
  if (lookup && (!pointsAtHeldPiece || EXPLICIT_LOOKUP.test(text))) {
    tags.add("find");
  }
  if (AUTHOR.test(text)) tags.add("author");
  if (
    tags.size === 0 && CONVERSATIONAL.test(text) &&
    text.split(/\s+/).length <= 6
  ) {
    tags.add("respond");
  }
  return tags.size === 0 ? undefined : tags;
};

/**
 * The domains a task's work happens in, by keyword and by what the run holds.
 * Only a positive sign adds one: a task about a held or authored piece is in
 * the fabric, a URL or a web word puts it on the web, and a request to
 * research or compare reads the web when it names no other domain.
 */
export const classifyTaskDomains = (
  task: string,
  context: TaskClassificationContext,
  tags: ReadonlySet<HarnessTaskTag>,
): Set<HarnessTaskDomain> => {
  const text = task.trim().toLowerCase();
  const domains = new Set<HarnessTaskDomain>();
  const holdsPieces = (context.inputCells?.length ?? 0) > 0;
  if (
    tags.has("pieces") || tags.has("author") || FABRIC.test(text) ||
    (holdsPieces && /\bthis loom\b/.test(text))
  ) {
    domains.add("fabric");
  }
  if (PERSONAL.test(text)) domains.add("personal");
  if (
    URL.test(task) || WEB.test(text) ||
    (context.browserHost === true && WEB_ACT.test(text)) ||
    (domains.size === 0 && RESEARCH.test(text))
  ) {
    domains.add("web");
  }
  return domains;
};

/** The one-shot prompt the model classifies a task by. */
const modelPrompt = (task: string, context: TaskClassificationContext) => {
  const held = [
    ...(context.inputCells ?? []).map((inputCell) =>
      `piece "${inputCell.name}"`
    ),
    ...(context.patternRefs?.length
      ? [`${context.patternRefs.length} attached pattern(s)`]
      : []),
    ...(context.browserHost ? ["a web browser"] : []),
  ];
  return [
    "Tag this request to an agent with every kind of work it calls for:",
    "respond: answer directly from what is already known.",
    "find: look something up in the person's data or on the web.",
    "act: do something in the person's app (open, add, move) or on a web page.",
    "pieces: read or change a piece or pattern the agent was handed.",
    "author: write a new pattern or app from scratch.",
    "Answer with the tags only, comma-separated.",
    `The agent holds: ${held.length > 0 ? held.join(", ") : "nothing"}.`,
    `Request: ${task}`,
  ].join("\n");
};

/**
 * Tags a task by one call to a cheap model, or answers `undefined` when the
 * answer names no tag. A failed call rejects. A run never asks it; the
 * classification eval scores it against the rule.
 */
export const classifyTaskByModel = async (
  task: string,
  context: TaskClassificationContext,
  askModel: (prompt: string) => Promise<string>,
): Promise<Set<HarnessTaskTag> | undefined> => {
  const answer = await askModel(modelPrompt(task, context));
  const tags = new Set(
    HARNESS_TASK_TAGS.filter((tag) =>
      new RegExp(`\\b${tag}\\b`, "i").test(answer)
    ),
  );
  return tags.size === 0 ? undefined : tags;
};

/**
 * The tags a task gets when no rule applies: a lookup, about the held pieces
 * when the run holds any, and an action when the run has a browser and the
 * task names an action. A task the assumption misreads still reaches what it
 * needs, since the tool allow-list does not narrow; it only takes longer.
 */
const assumedTags = (
  task: string,
  context: TaskClassificationContext,
): Set<HarnessTaskTag> => {
  const tags = new Set<HarnessTaskTag>(["find"]);
  if ((context.inputCells?.length ?? 0) > 0) tags.add("pieces");
  if (context.browserHost && ACTION_VERB.test(task.toLowerCase())) {
    tags.add("act");
  }
  return tags;
};

/**
 * Tags a root task and names its domains. Each part the caller states is
 * taken as it stands; the rest is the classifier's: tags by rule when one
 * applies, otherwise by assumption, and domains by their signs, or none. A
 * classifier that throws gives the task every tag and every domain it was not
 * told, which is all the orientation the run would have had without
 * classification.
 */
export const classifyTask = (
  task: string,
  context: TaskClassificationContext,
  caller: HarnessTaskShape = {},
): HarnessTaskClassification => {
  const started = performance.now();
  const ordered = <T extends string>(
    all: readonly T[],
    chosen: Iterable<T>,
  ): T[] => {
    const set = new Set(chosen);
    return all.filter((value) => set.has(value));
  };
  const classified = (
    tags: { values: Iterable<HarnessTaskTag>; path: HarnessClassificationPath },
    domains: {
      values: Iterable<HarnessTaskDomain>;
      path: HarnessClassificationPath;
    },
  ): HarnessTaskClassification => ({
    type: "cf-harness.task-classification",
    version: 1,
    tags: ordered(HARNESS_TASK_TAGS, tags.values),
    path: tags.path,
    domains: ordered(HARNESS_TASK_DOMAINS, domains.values),
    domainsPath: domains.path,
    durationMs: Math.round(performance.now() - started),
  });
  try {
    const byRule = caller.tags === undefined
      ? classifyTaskByRule(task, context)
      : undefined;
    const tags = caller.tags !== undefined
      ? { values: caller.tags, path: "caller" as const }
      : byRule === undefined
      ? { values: assumedTags(task, context), path: "assumed" as const }
      : { values: byRule, path: "rule" as const };
    if (caller.domains !== undefined) {
      return classified(tags, { values: caller.domains, path: "caller" });
    }
    const domains = classifyTaskDomains(task, context, new Set(tags.values));
    return classified(tags, {
      values: domains,
      path: domains.size === 0 ? "assumed" : "rule",
    });
  } catch {
    return classified(
      caller.tags !== undefined
        ? { values: caller.tags, path: "caller" }
        : { values: HARNESS_TASK_TAGS, path: "fallback" },
      caller.domains !== undefined
        ? { values: caller.domains, path: "caller" }
        : { values: HARNESS_TASK_DOMAINS, path: "fallback" },
    );
  }
};
