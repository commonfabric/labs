import { type RunShape, sendsSection } from "./prompt-sections.ts";

/**
 * How far to take the work and when it is done, as the run's depth and
 * domains call for. A `standard` run gets none of it.
 */

const FAST_REPLY_GUIDANCE =
  "Do the requested work, including the result its destination requires. Stop when the evidence answers the task and any requested changes are verified, or when a refusal establishes that no authorised route can complete it. Use the refusal's machine code: permission refusals are final; repair bad arguments or use another authorised source for an unsupported reader. Report what remains unknown without claiming the task is complete.";

const PERSONAL_EXHAUSTIVE_GUIDANCE =
  "Search every source of the person's own data that could hold the answer, and vary the wording: names, senders, dates, and the words they would have used. Stop when another search stops turning up anything new, not after a fixed number of tries. Absence holds only for what you searched: an unavailable or failed source is unknown, not empty, so name only the sources you actually read, and any you tried and could not.";

const WEB_RESEARCH_GUIDANCE =
  "Read several independent sources, primary ones first, rather than answering from memory, and cite only those you read.";

const MATERIAL_GUIDANCE =
  "Material you leave must be worth opening on its own: substance and a judgement, not a list of links, a shortlist without reasons, or an empty scaffold. One strong piece beats several thin ones.";

const CRITIQUE_GUIDANCE =
  "Before you finish, read your result as the person will: does it answer what was asked, does every claim rest on something you read, and what is still missing? Fix what you can, then say plainly what you could not.";

/** The strategy paragraphs a run of `shape` is sent, in order. */
export const strategyGuidance = (shape: RunShape): string[] => [
  ...(sendsSection("fast-reply", shape) ? [FAST_REPLY_GUIDANCE] : []),
  ...(sendsSection("personal-exhaustive", shape)
    ? [PERSONAL_EXHAUSTIVE_GUIDANCE]
    : []),
  ...(sendsSection("web-research", shape) ? [WEB_RESEARCH_GUIDANCE] : []),
  ...(sendsSection("material-bar", shape) ? [MATERIAL_GUIDANCE] : []),
  ...(sendsSection("critique", shape) ? [CRITIQUE_GUIDANCE] : []),
];
