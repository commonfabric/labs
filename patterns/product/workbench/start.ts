/**
 * Starting a session from a workbench: the harness and checkout pickers over
 * the connector's index, the connector `start` command as its queue holds
 * it, the guard the Start control and its handler share, and taking a start
 * back before the connector claims it.
 *
 * A start goes out through a queue the connector's host binds to one
 * handler the workbench's own module exports, and that handler is the
 * queue's only writer, so withdrawing a start goes through the same handler.
 */

import { Default, lift, Writable } from "commonfabric";

import {
  type CheckoutOption,
  type CommandValue,
  dropStart,
  type SessionIndexView,
  type SessionStart,
  type ShownHarness,
  type StartableSourcesView,
} from "./sessions.ts";

//
// Pickers
//

/** The connector's sources whose driver can start a session, as picker
 * options; Claude sources first, then the harnesses the piece is told to
 * show without a source behind them. A configured source that cannot start
 * (the Codex and ACP drivers today) is not offered, since a start through it
 * would queue a command the connector refuses. */
export const sourceOptionsOf = lift((
  { index, shown }: {
    index?: StartableSourcesView;
    shown?: ShownHarness[] | Default<[]>;
  },
): CheckoutOption[] => {
  // Read where the row is live: a field of an input element is read at the
  // element, not on a copy passed along.
  const startable = (index?.sources ?? []).flatMap((source) =>
    source?.id && source.capabilities?.startSession === true
      ? [{ id: source.id, driver: source.driver }]
      : []
  );
  const configured = startable
    .toSorted((a, b) =>
      (a.driver === "claude-agent-sdk" ? 0 : 1) -
      (b.driver === "claude-agent-sdk" ? 0 : 1)
    )
    .map((source) => ({
      label: `${source.id}  (${source.driver})`,
      value: source.id,
    }));
  const known = new Set(configured.map((option) => option.value));
  const extra = (shown ?? [])
    .filter((harness) => harness.id && !known.has(harness.id))
    .map((harness) => ({
      label: `${harness.id}  (${harness.driver}, not on this Mac)`,
      value: harness.id,
    }));
  return [...configured, ...extra];
});

/** Checkouts the connector discovered, as picker options. */
export const checkoutOptionsOf = lift((
  { index }: { index?: SessionIndexView },
): CheckoutOption[] =>
  (index?.checkouts ?? []).flatMap((c) =>
    c?.root
      ? [{
        label: c.branch ? `${c.root}  (${c.branch})` : c.root,
        value: c.root,
      }]
      : []
  )
);

/** The ids of the sources the connector runs whose driver can start a
 * session, for the start's own check. */
export const configuredSourcesOf = lift((
  { index }: { index?: StartableSourcesView },
): string[] =>
  (index?.sources ?? []).flatMap((source) =>
    source?.id && source.capabilities?.startSession === true ? [source.id] : []
  )
);

/** The ids of the sources whose driver can open a started session in the
 * Claude Code desktop app on this Mac (`capabilities.surfaces` names
 * `desktop`), for the start's own check. Read where the row is live. */
export const desktopSourcesOf = lift((
  { index }: { index?: StartableSourcesView },
): string[] =>
  (index?.sources ?? []).flatMap((source) =>
    source?.id && source.capabilities?.startSession === true &&
      (source.capabilities.surfaces ?? []).includes("desktop")
      ? [source.id]
      : []
  )
);

//
// The start
//

/** The source a start goes through: the picked one, else the first offered,
 * and only when it is one that can start; "" otherwise. */
export const startSourceOf = (
  picked: string,
  options: readonly CheckoutOption[],
  startable: readonly string[],
): string => {
  const sourceId = (picked || options[0]?.value || "").trim();
  return startable.includes(sourceId) ? sourceId : "";
};

/** What a start needs, as the Start control and its handler both see it. */
export interface StartPreconditions {
  ownerDid: string;
  picked: string;
  options: readonly CheckoutOption[];
  startable: readonly string[];
  kickoff: string;
  /** Whether there is a subject to start from, for a workbench whose
   * subject can be missing; absent means there always is one. */
  hasSubject?: boolean;
  /** The title of a start for this subject the index has not confirmed, or
   * "" when there is none: one start at a time per subject, so a second
   * click while the first is on its way starts nothing. */
  pending?: string;
  /** Where the start runs: "desktop" opens Claude Code on this Mac, which
   * only a source in `desktopCapable` can do; anything else runs the first
   * turn through the connector. */
  surface?: string;
  desktopCapable?: readonly string[];
}

/** Why Start would send nothing, or "" when it would send. The one
 * predicate behind the disabled control, its caption, and the handler's own
 * refusal, so the three cannot drift apart. */
export const startBlockerReason = (
  {
    ownerDid,
    picked,
    options,
    startable,
    kickoff,
    hasSubject,
    pending,
    surface,
    desktopCapable,
  }: StartPreconditions,
): string => {
  if (hasSubject === false) return "No workstream to start from.";
  if (!ownerDid) {
    return "No session index is linked, so there is no connector to start through.";
  }
  if (startable.length === 0) {
    return "No harness the connector runs here can start a session.";
  }
  if (!startSourceOf(picked, options, startable)) {
    const sourceId = (picked || options[0]?.value || "").trim();
    return `${sourceId} is not a harness this Mac runs; pick one that is.`;
  }
  if (surface?.trim() === "desktop") {
    const sourceId = startSourceOf(picked, options, startable);
    if (!(desktopCapable ?? []).includes(sourceId)) {
      return `${sourceId} cannot open a session in Claude Code on this Mac; pick a harness that can, or start headlessly.`;
    }
  }
  if (!kickoff.trim()) return "Write a prompt to start from.";
  if (pending?.trim()) {
    return `Starting "${pending.trim()}"; it shows as starting until the connector confirms it. Withdraw it there to start another.`;
  }
  return "";
};

/** `startBlockerReason` as a lift, for the control and the caption. The
 * callback is written at the call, as the module verifier asks. */
export const startBlockerOf = lift((
  preconditions: StartPreconditions,
): string => startBlockerReason(preconditions));

/**
 * The title of the first start for a subject that the index has not yet
 * confirmed, or "" when there is none. Without a `workstreamId` every
 * unconfirmed start counts, which is the topic workbench's case (one
 * subject); with one, only the starts made for that workstream. The title is
 * read where the row is live.
 */
export const pendingStartOf = lift((
  { starting, workstreamId }: {
    starting: SessionStart[];
    workstreamId?: string;
  },
): string => {
  for (const start of starting) {
    if (workstreamId === undefined || start.workstreamId === workstreamId) {
      return start.title || "(untitled session)";
    }
  }
  return "";
});

/** A version 4 UUID, which is the shape a Claude session id must have. */
export const mintSessionId = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

/** A connector `start` command, JSON-encoded as its queue holds it, and the
 * id it carries. The connector normalizes a command's source id on receipt
 * (`connector/src/commands.ts`, `parseCommand`); the envelope carries it
 * normalized all the same, as the debug view's does, so the two spellings
 * of this envelope agree. */
export const startCommandValue = (
  {
    ownerDid,
    idPrefix,
    sourceId,
    nativeSessionId,
    text,
    cwd,
    title,
    mode,
    surface,
  }: {
    ownerDid: string;
    idPrefix: string;
    sourceId: string;
    nativeSessionId: string;
    text: string;
    cwd: string;
    title: string;
    mode?: string;
    /** "desktop" opens Claude Code on this Mac with the prompt ready to
     * send instead of running the first turn through the connector. */
    surface?: string;
  },
): { id: string; value: CommandValue } => {
  const createdAt = new Date().toISOString();
  const id = `${idPrefix}:${createdAt}:${nativeSessionId.slice(0, 8)}`;
  return {
    id,
    value: JSON.stringify({
      schema: "commonfabric.agent-connector.command",
      ownerDid,
      id,
      createdAt,
      sourceId: sourceId.trim().toLowerCase(),
      nativeSessionId,
      type: "start",
      payload: {
        text,
        ...(cwd ? { cwd } : {}),
        ...(title ? { title } : {}),
        ...(mode ? { mode } : {}),
        ...(surface ? { surface } : {}),
      },
    }),
  };
};

/** The id a queued command carries, or "" for a value that is not one. */
const commandIdOf = (value: CommandValue): string => {
  try {
    const command: unknown = JSON.parse(value);
    return typeof command === "object" && command !== null &&
        "id" in command && typeof command.id === "string"
      ? command.id
      : "";
  } catch {
    return "";
  }
};

/**
 * Takes a start back: the command leaves the queue and the start's record is
 * dropped. The queue entry is the JSON the start pushed, removed by value,
 * which the queue's mergeable operations support for a plain string. A
 * command the connector has already claimed runs regardless, since the
 * connector's ledger holds its id and the removal only shortens the queue;
 * its session then shows in the rail unattached. Nothing here can tell the
 * two apart, which is why the control's caption says both.
 */
export const withdrawStart = (
  commands: Writable<CommandValue[] | Default<[]>>,
  starts: Writable<SessionStart[] | Default<[]>>,
  commandId: string,
): void => {
  for (const value of commands.get()) {
    if (commandIdOf(value) === commandId) commands.removeByValue(value);
  }
  const start = starts.get().find((s) => s.commandId === commandId);
  if (start) dropStart(starts, start.sourceId, start.nativeSessionId);
};
