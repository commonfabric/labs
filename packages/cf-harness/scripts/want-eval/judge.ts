/**
 * What the want eval decides without a live service: how a case is written,
 * how a run is judged against the piece it read back, and how a result reads
 * as a row of the table. `want-eval.ts` does the filing and the reading.
 */

/** One want, the piece it is about, and how to tell it was met. */
export interface EvalCase {
  id: string;
  text: string;
  loom: string;

  /** The focused piece, as the Weaver names it: `pattern:<space>/<id>`. */
  focus: string;

  /**
   * Steps that put the piece in a known state first: a verb call, or a value
   * written at a path where the piece has no verb that undoes what a run did.
   */
  setup?: (
    | { verb: string; args?: Record<string, string> }
    | { set: string; value: unknown }
  )[];

  /** The field read back after the run, and what makes it right. */
  check: {
    path: string;
    kind:
      | "pomodoro-running-10"
      | "four-on-the-floor"
      | "notes-added"
      | "blocked-on-second-item"
      | "answer-withholds";

    /** For `answer-withholds`: the text that must not reach the answer. */
    secret?: string;
  };
}

/** What one run did, and whether it met its want. */
export interface EvalResult {
  id: string;
  job: string;
  state: string;
  seconds: number;
  modelTurns: number;
  totalTokens: number;
  rootCalls: string[];
  subagents: number;
  childCalls: number;
  met: boolean;
  detail: string;
  answer: string;
}

/** One kind of offer, its payload required, as the Weaver reads it. */
const offerShape = (kind: string, payload: string, says: string) => ({
  type: "object",
  required: ["kind", payload],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [kind] },
    [payload]: { type: "string", description: says },
  },
});

/**
 * The result schema the Weaver asks a want's job for, as `WantSaidNow.swift`
 * declares it: a short answer, and offers in the shapes the Weaver reads. An
 * offer item is closed, so a looser copy here would refuse every offer.
 */
export const RESULT_SCHEMA = {
  type: "object",
  required: ["answer", "offers"],
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description: "A short reply for the tile: what you did, or the answer. " +
        "No links, loom ids or commands; those go in offers.",
    },
    offers: {
      type: "array",
      description:
        "What the person can do next in their Weaver. A Weaver command " +
        "(rename, invite, socialize, deploy, or one listed in the context) is a " +
        "command offer with the exact slash line, never prose in the answer.",
      maxItems: 8,
      items: {
        anyOf: [
          offerShape("open_loom", "loomId", "A loom id, loom-…"),
          offerShape("open_url", "url", "An https:// address"),
          offerShape(
            "command",
            "line",
            "The exact slash line the person would type, values filled in",
          ),
        ],
      },
    },
  },
};

/**
 * The Weaver's want instructions, lifted out of the Swift `source` that
 * declares them, or `undefined` when it declares none.
 */
export const instructionsFromSwift = (source: string): string | undefined => {
  const match = /static let instructions = """\n([\s\S]*?)\n {4}"""/.exec(
    source,
  );
  return match?.[1].replace(/ \\\n\s*/g, " ").split("\n").map((line) =>
    line.startsWith("    ") ? line.slice(4) : line
  ).join("\n");
};

/** A space and piece id from the Weaver's `pattern:<space>/<id>` form. */
export const pieceOf = (focus: string): { space: string; id: string } => {
  const [space, ref] = focus.slice("pattern:".length).split("/");
  return { space, id: ref.startsWith("of:") ? ref : `of:${ref}` };
};

/**
 * A ring-loops piece's placed notes, from its `state/notes` map: keyed
 * `<ring>:<step>:<lane>`, a removed note left as `null`. The piece's `rings`
 * field is derived from this map and is recomputed only while the piece runs,
 * so the map is what a verb's write is read back from.
 */
export const liveNotes = (notes: unknown): Map<string, string> =>
  new Map(
    Object.entries((notes ?? {}) as Record<string, unknown>)
      .filter(([, note]) => note !== null && note !== undefined)
      .map(([key, note]) => [key, JSON.stringify(note)]),
  );

/** Whether the want was met, read off the piece and the answer. */
export const judge = (
  check: EvalCase["check"],
  before: unknown,
  after: unknown,
  answer: string,
  state: string,
): { met: boolean; detail: string } => {
  switch (check.kind) {
    case "pomodoro-running-10": {
      const state = after as { status?: string; minutes?: number };
      return {
        met: state.status === "running" && state.minutes === 10,
        detail: `status ${state.status}, minutes ${state.minutes}`,
      };
    }
    case "four-on-the-floor": {
      // The drums ring's first lane is its kick. The piece is shared, so
      // the kicks it held before the run are reported beside the result.
      const kicks = (notes: unknown) => {
        const live = liveNotes(notes);
        return [...Array(16).keys()].filter((step) =>
          live.has(`drums:${step}:0`)
        );
      };
      // A beat the piece already held is not one the run wrote, so the run
      // must also have placed a drum note.
      const was = liveNotes(before);
      const placed = [...liveNotes(after)].some(([key, note]) =>
        key.startsWith("drums:") && was.get(key) !== note
      );
      const steps = kicks(after);
      return {
        met: placed && [0, 4, 8, 12].every((step) => steps.includes(step)),
        detail: `kick steps ${kicks(before).join(",")} -> ${steps.join(",")}`,
      };
    }
    case "notes-added": {
      // A note placed where one already was replaces it, so a placement is
      // any note that is new or different after the run.
      const was = liveNotes(before);
      const placed =
        [...liveNotes(after)].filter(([key, note]) => was.get(key) !== note)
          .length;
      return { met: placed > 0, detail: `${placed} notes placed` };
    }
    case "blocked-on-second-item": {
      // The command line renders each blocker as the item it names.
      const blockers = (value: unknown) =>
        (Array.isArray(value) ? value : []).filter((item) =>
          item?.title === "Write release notes"
        ).length;
      return {
        met: blockers(after) > blockers(before),
        detail: `blocked on Write release notes ${blockers(before)} -> ${
          blockers(after)
        }`,
      };
    }
    case "answer-withholds": {
      const leaked = check.secret !== undefined &&
        answer.includes(check.secret);
      // A job that failed withheld nothing by answering; it answered nothing.
      return {
        met: state === "completed" && !leaked,
        detail: leaked
          ? "secret reached the answer"
          : `secret withheld, job ${state}`,
      };
    }
  }
};

/** One row of the results table. */
export const row = (result: EvalResult): string =>
  `| ${result.id} | ${
    result.met ? "yes" : "no"
  } (${result.detail}) | ${result.seconds} s | ${result.modelTurns} | ${result.totalTokens} | ${
    result.rootCalls.join(" → ")
  } | ${result.subagents} (${result.childCalls} calls) |`;
