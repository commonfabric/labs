/**
 * What a person writes on the board through the Topics browser, as the
 * browser keeps it: drafts, kept until they are saved, and pending writes,
 * kept from the moment one is asked for until it is known to have landed.
 *
 * A write is made under an invocation minted with the version of the
 * draft it saves, so that naming the invocation again settles it rather
 * than writing twice, and so that two browsers saving the same version
 * write it once. A write is
 * given up as certainly not made only when its first attempt failed before
 * it was dispatched; a later attempt may be settling an earlier one that
 * landed, so it keeps the write pending whatever it reports.
 *
 * Everything here is in the {@link Saved} state the browser remembers
 * between runs, and saved through the host whenever it changes. Each
 * change to a draft or a pending write stamps it later than any version of
 * it before, and one thrown away is remembered by its key and the stamp of
 * the version thrown away, so that merging what another browser saved
 * leaves out every version this one threw away, and nothing newer.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import type {
  Draft,
  Dropped,
  Pending,
  Saved,
  WriteOutcome,
  WriteRequest,
} from "./browser.ts";

/** What the person is told of a write as it goes. */
export type Told =
  | { kind: "note"; text: string; error: boolean }
  | { kind: "unsettled"; invocation: string; text: string };

/** The drafts and pending writes of a browser. */
export class Writes {
  readonly #saved: Saved;
  readonly #write: (
    request: WriteRequest,
    agentName: string,
    invocation: string,
  ) => Promise<WriteOutcome>;
  readonly #save: (saved: Saved) => void;
  readonly #persisted: () => Promise<void>;
  readonly #now: () => number;
  readonly #tell: (told: Told) => void;
  readonly #inFlight = new Set<string>();
  #queue: Promise<void> = Promise.resolve();

  /**
   * The drafts and pending writes `saved` holds, made through `write`,
   * saved through `save`, whose saves `persisted` waits for, at times `now`
   * reads, telling the person how each write goes through `tell`.
   */
  constructor(options: {
    saved: Saved;
    write: (
      request: WriteRequest,
      agentName: string,
      invocation: string,
    ) => Promise<WriteOutcome>;
    save: (saved: Saved) => void;
    persisted: () => Promise<void>;
    now: () => number;
    tell: (told: Told) => void;
  }) {
    this.#saved = options.saved;
    this.#write = options.write;
    this.#save = options.save;
    this.#persisted = options.persisted;
    this.#now = options.now;
    this.#tell = options.tell;
  }

  /** How many writes are under way. */
  get busy(): number {
    return this.#inFlight.size;
  }

  /** The draft `key` names: `comment:42`, `body:42`, `new`. */
  draft(key: string): Draft | undefined {
    return this.#saved.drafts[key];
  }

  /**
   * Keeps `fields` as the draft `key` names, begun from `base`, a version
   * to be written under `invocation`, or under one of its own; keeping the
   * version already kept changes nothing.
   */
  keepDraft(
    key: string,
    fields: string[],
    base: string,
    invocation = `topics-${crypto.randomUUID()}`,
  ): void {
    const kept = this.#saved.drafts[key];
    if (
      kept !== undefined && kept.base === base &&
      kept.fields.length === fields.length &&
      kept.fields.every((field, index) => field === fields[index])
    ) return;
    this.#saved.drafts[key] = {
      fields,
      base,
      invocation,
      at: this.#stamp(key, kept?.at),
    };
    this.#save(this.#saved);
  }

  /** Throws away the draft `key` names. */
  dropDraft(key: string): void {
    const draft = this.#saved.drafts[key];
    if (draft === undefined) return;
    delete this.#saved.drafts[key];
    this.#drop(key, draft.at);
    this.#save(this.#saved);
  }

  /** Every pending write, by its invocation. */
  pending(): [string, Pending][] {
    return Object.entries(this.#saved.pending);
  }

  /** The pending write saving the draft `key` names, if one does. */
  pendingFor(key: string): [string, Pending] | undefined {
    return this.pending().find(([, pending]) => pending.draft?.key === key);
  }

  /** Whether the pending write `invocation` names is under way here. */
  inFlight(invocation: string): boolean {
    return this.#inFlight.has(invocation);
  }

  /**
   * Makes `request`, signed as `agentName`, after any write already under
   * way, under the invocation of the version of the draft `key` names that
   * it saves, which becomes part of the pending write, or under one of its
   * own.
   */
  write(request: WriteRequest, agentName: string, key?: string): void {
    const draft = key === undefined ? undefined : this.#saved.drafts[key];
    const invocation = draft?.invocation ?? `topics-${crypto.randomUUID()}`;
    this.#saved.pending[invocation] = {
      request,
      agentName,
      attempts: 0,
      // Later than an attempt of it that failed and gave its draft back.
      at: this.#stamp(invocation),
      ...(key === undefined || draft === undefined
        ? {}
        : { draft: { key, fields: draft.fields, base: draft.base } }),
    };
    if (key !== undefined) this.dropDraft(key);
    this.#save(this.#saved);
    this.send(invocation);
  }

  /**
   * Makes the pending write `invocation` names, after any write already
   * under way, as the invocation it was asked for under: once, however
   * many times it is sent.
   */
  send(invocation: string): void {
    const pending = this.#saved.pending[invocation];
    if (pending === undefined || this.#inFlight.has(invocation)) return;
    // Counted before it is made, so that a run that stops meanwhile leaves
    // a write the next run knows may have been made.
    pending.attempts += 1;
    pending.at = this.#stamp(invocation, pending.at);
    this.#save(this.#saved);
    this.#inFlight.add(invocation);
    this.#tell({
      kind: "note",
      text: `Writing: ${describe(pending.request)}…`,
      error: false,
    });
    this.#queue = this.#queue.then(async () => {
      let outcome: WriteOutcome | undefined;
      try {
        // It is made only once it is saved as pending, so that a run that
        // stops while it is made knows of it.
        await this.#persisted();
      } catch (error) {
        outcome = {
          result: "failed",
          message: `It could not be saved first: ${describeFailure(error)}`,
        };
      }
      try {
        outcome ??= await this.#write(
          pending.request,
          pending.agentName,
          invocation,
        );
      } catch (error) {
        outcome = { result: "unsettled", message: describeFailure(error) };
      }
      this.#inFlight.delete(invocation);
      this.#landed(invocation, outcome);
    }).catch((error) =>
      this.#tell({ kind: "note", text: describeFailure(error), error: true })
    );
  }

  /** Forgets the pending write `invocation` names, landed or not. */
  forget(invocation: string): void {
    const pending = this.#saved.pending[invocation];
    if (pending === undefined) return;
    delete this.#saved.pending[invocation];
    this.#drop(invocation, pending.at);
    this.#save(this.#saved);
  }

  /**
   * Waits for the writes under way, or until `abandon` settles, and
   * returns what is still pending, in words.
   */
  async finish(abandon: Promise<void>): Promise<string[]> {
    let abandoned = false;
    abandon.then(() => abandoned = true);
    // A write sent while waiting is waited for too.
    while (!abandoned) {
      const queue = this.#queue;
      await Promise.race([queue, abandon]);
      if (queue === this.#queue) break;
    }
    return this.pending().map(([, pending]) => describe(pending.request));
  }

  /** Records how an attempt at the pending write `invocation` names went. */
  #landed(invocation: string, outcome: WriteOutcome): void {
    const pending = this.#saved.pending[invocation];
    if (pending === undefined) {
      // Another browser settled it, or threw it away, meanwhile.
      if (outcome.result === "written") {
        this.#tell({ kind: "note", text: outcome.report, error: false });
      }
      return;
    }
    const what = describe(pending.request);
    switch (outcome.result) {
      case "written":
        this.forget(invocation);
        this.#tell({ kind: "note", text: outcome.report, error: false });
        return;
      case "unconfirmed":
        // It was made, and reads back otherwise than it was made.
        this.forget(invocation);
        this.#tell({
          kind: "note",
          text: `${capitalize(what)} landed, but ${firstLine(outcome.message)}`,
          error: true,
        });
        return;
      case "failed":
        // Counted as the write stands now, since another browser may have
        // made an attempt of its own meanwhile.
        if (pending.attempts === 1) {
          // It was never made, so its text is a draft again, to be written
          // under the same invocation, unless a newer draft has taken its
          // place.
          this.forget(invocation);
          const draft = pending.draft;
          const newer = draft !== undefined &&
            this.draft(draft.key) !== undefined;
          if (draft !== undefined && !newer) {
            this.keepDraft(draft.key, draft.fields, draft.base, invocation);
          }
          this.#tell({
            kind: "note",
            text: `Could not finish ${what}: ${firstLine(outcome.message)}` +
              (draft === undefined
                ? ""
                : newer
                ? " A newer draft of it is kept."
                : " Your draft is kept."),
            error: true,
          });
          return;
        }
        // An earlier attempt may have landed, so it is still to settle.
        break;
      case "unsettled":
        break;
    }
    pending.failure = outcome.message;
    pending.at = this.#stamp(invocation, pending.at);
    this.#save(this.#saved);
    this.#tell({
      kind: "unsettled",
      invocation,
      text: `${capitalize(what)} may not have finished; ` +
        "File ▸ Unfinished writes settles it.",
    });
  }

  /**
   * The stamp of what `key` names, last stamped `previous`, changing now:
   * now, or later than its previous version and any version of it thrown
   * away, so that it is never taken for one of them.
   */
  #stamp(key: string, previous = -Infinity): number {
    return Math.max(
      this.#now(),
      previous + 1,
      (this.#saved.dropped[key]?.at ?? -Infinity) + 1,
    );
  }

  /** Remembers the version of what `key` names stamped `at` as thrown away. */
  #drop(key: string, at: number): void {
    const dropped: Dropped = this.#saved.dropped[key] ?? { at, when: 0 };
    this.#saved.dropped[key] = {
      at: Math.max(at, dropped.at),
      when: this.#now(),
    };
  }
}

/**
 * `ours` merged into `theirs`, what another browser saved to the same
 * file since: the earliest start, the latest reading of each Topic, and of
 * each draft and pending write the newer of the two, ours where they
 * tie, unless either threw away that version of it or a newer one. Our
 * settings win, but for a name to sign with that only theirs has.
 */
export function mergeSaved(theirs: Saved, ours: Saved): Saved {
  // A name is never taken back once given, so either one's is kept.
  const agentName = ours.agentName ?? theirs.agentName;
  const dropped = { ...theirs.dropped };
  for (const [key, entry] of Object.entries(ours.dropped)) {
    const other = dropped[key];
    dropped[key] = other === undefined ? entry : {
      at: Math.max(entry.at, other.at),
      when: Math.max(entry.when, other.when),
    };
  }
  const seen = { ...theirs.seen };
  for (const [number, at] of Object.entries(ours.seen)) {
    seen[number] = Math.max(at, seen[number] ?? 0);
  }
  const newest = <T extends { at: number }>(
    a: Record<string, T>,
    b: Record<string, T>,
  ): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      // Ours comes first, so that it wins a tie: it is the newer save.
      const kept = [b[key], a[key]].filter((entry): entry is T =>
        entry !== undefined && entry.at > (dropped[key]?.at ?? -Infinity)
      );
      const [pick] = kept.sort((x, y) => y.at - x.at);
      if (pick !== undefined) out[key] = pick;
    }
    return out;
  };
  return {
    since: Math.min(theirs.since, ours.since),
    seen,
    drafts: newest(theirs.drafts, ours.drafts),
    pending: newest(theirs.pending, ours.pending),
    dropped,
    ...(agentName === undefined ? {} : { agentName }),
    hideSettled: ours.hideSettled,
  };
}

/** What a write is, in a few words. */
export function describe(request: WriteRequest): string {
  switch (request.verb) {
    case "new":
      return "filing a new Topic";
    case "comment":
      return `commenting on top/${request.topic}`;
    case "body":
      return `replacing the body of top/${request.topic}`;
    case "title":
      return `renaming top/${request.topic}`;
    case "link":
      return `linking from top/${request.topic}`;
    case "unlink":
      return `taking back a link of top/${request.topic}`;
    case "mention":
      return `top/${request.topic} mentioning top/${request.other}`;
    case "unmention":
      return `top/${request.topic} no longer mentioning top/${request.other}`;
  }
}

/** The first line of `text` that says something. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** `text` with its first letter capitalized. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
