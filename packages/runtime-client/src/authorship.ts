/**
 * Whether a value was written by the author it claims, as a host reads it
 * through the cell handles a render binds: `observeAuthorship()`, which
 * watches a value cell and an author cell and reports a verdict once both of
 * their labels have loaded, and the rules it decides by. `cf-cfc-authorship`
 * draws its badge from it, and a host that draws no Lit component can call it
 * directly.
 */

import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  authorPrincipalCandidates,
  PRINCIPAL_CLAIM_KINDS,
  principalClaimEntries,
  principalClaimSubject,
  representsPrincipalSubject,
} from "@commonfabric/runner/cfc/represents-principal";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  type CellHandleRead,
  CellReadRefusedError,
  type CellSubscribeOptions,
} from "./cell-handle.ts";

/**
 * Whether the value's label says the claimed author wrote it: `verified`
 * when it does, `unverified` when it names some other author, and `unknown`
 * when it establishes no authorship at all.
 */
export type CfcAuthorshipState = "verified" | "unverified" | "unknown";

/** What `observeAuthorship()` reports each time it decides. */
export interface AuthorshipObservation {
  /** The verdict. */
  readonly state: CfcAuthorshipState;

  /** The value's label, as read. */
  readonly cfcLabel: CfcLabelView | undefined;

  /**
   * Who the author cell claims wrote the value: the principal its label
   * names, as `{ subject, name? }`, else the cell's own value. An author
   * given as a plain value rather than a cell is its own claim.
   */
  readonly authorClaim: unknown;
}

/** How `observeAuthorship()` decides. */
export interface ObserveAuthorshipOptions {
  /**
   * The integrity kind that says who wrote the value, `authored-by` (the
   * default) or `represents-principal`; any other kind never verifies.
   */
  readonly kind?: string;

  /**
   * A display name for a principal claim whose author cell holds none. It
   * decides nothing.
   */
  readonly authorName?: string;
}

type CfcLabelQueryableValue = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

type CfcLabelResolvableValue = {
  resolveAsCell(): Promise<CfcLabelQueryableValue>;
};

type CfcLabelSubscribableValue = {
  subscribe(
    callback: (value: unknown, cfcLabel?: CfcLabelView | undefined) => void,
    options: CellSubscribeOptions,
  ): () => void;

  /** Asks the worker for the value, as a `CellHandle` does. */
  sync?(): Promise<unknown>;

  /** What the last read gave, as a `CellHandle` reports it. */
  lastRead?(): CellHandleRead<unknown>;
};

type CfcReadableClaimValue = {
  get?(): unknown;
  sync?(): Promise<unknown>;
  resolveAsCell?(): Promise<unknown> | unknown;
};

const DEFAULT_AUTHORSHIP_KIND = "authored-by";
const AUTHOR_FIELDS = [
  "subject",
  "author",
  "authorId",
  "sender",
  "senderId",
  "user",
  "userId",
  "id",
] as const;
const AUTHOR_DISPLAY_FIELDS = [
  "name",
  "displayName",
  "fullName",
  "label",
  "username",
] as const;

const hasLabelQuery = (value: unknown): value is CfcLabelQueryableValue =>
  isObjectOrArray(value) &&
  "getCfcLabel" in value &&
  typeof (value as { getCfcLabel?: unknown }).getCfcLabel === "function";

const hasLabelSubscription = (
  value: unknown,
): value is CfcLabelSubscribableValue =>
  isObjectOrArray(value) &&
  "subscribe" in value &&
  typeof (value as { subscribe?: unknown }).subscribe === "function";

const hasLabelResolution = (
  value: unknown,
): value is CfcLabelResolvableValue =>
  isObjectOrArray(value) &&
  "resolveAsCell" in value &&
  typeof (value as { resolveAsCell?: unknown }).resolveAsCell === "function";

const hasReadableClaim = (
  value: unknown,
): value is CfcReadableClaimValue =>
  isObjectOrArray(value) &&
  (typeof (value as { get?: unknown }).get === "function" ||
    typeof (value as { sync?: unknown }).sync === "function");

/**
 * The subject a claim of `kind` names, read as every check here reads it:
 * `principalClaimSubject` for a kind in `PRINCIPAL_CLAIM_KINDS`, and for
 * `represents-principal` only a well-formed DID, as
 * `representsPrincipalSubject` requires. The runtime refuses a
 * pattern-authored claim of those kinds in any spelling that names someone
 * else and guards no other kind, so an atom of any other kind names nobody.
 */
const authorshipClaimSubject = (
  atom: unknown,
  kind: string,
): string | undefined => {
  if (!PRINCIPAL_CLAIM_KINDS.has(kind)) return undefined;
  return kind === "represents-principal"
    ? representsPrincipalSubject(atom)
    : principalClaimSubject(atom, kind);
};

/**
 * The root entries of `view` an authorship claim is read from: those
 * `principalClaimEntries` names, at the root alone. An entry a link carried
 * (`followRef`) describes the linked document, so it does not stand in for
 * reading that document's own label.
 */
const rootEntries = (view: CfcLabelView | undefined) =>
  principalClaimEntries(view).filter((entry) => entry.path.length === 0);

const labelHasRootIntegrityKind = (
  view: CfcLabelView,
  kind: string,
): boolean => hasAuthorshipIntegrity(rootEntries(view), kind);

const mergeLabelViews = (
  ...views: Array<CfcLabelView | undefined>
): CfcLabelView | undefined => {
  const entries: CfcLabelView["entries"] = [];
  const seen = new Set<string>();
  for (const view of views) {
    if (view === undefined) {
      continue;
    }
    for (const entry of view.entries) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.length === 0 ? undefined : { version: 1, entries };
};

const isConcreteAuthorClaim = (value: unknown): boolean => {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (!isObjectNotArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return AUTHOR_FIELDS.some((field) => {
    const fieldValue = record[field];
    return typeof fieldValue === "string" ||
      typeof fieldValue === "number" ||
      typeof fieldValue === "boolean";
  });
};

const readClaimValue = async (
  value: CfcReadableClaimValue,
): Promise<unknown> => {
  const readCandidate = async (candidate: unknown): Promise<unknown> => {
    if (!hasReadableClaim(candidate)) {
      return isConcreteAuthorClaim(candidate) ? candidate : undefined;
    }

    const beforeSync = candidate.get?.();
    if (beforeSync !== undefined) {
      return beforeSync;
    }

    const synced = typeof candidate.sync === "function"
      ? await candidate.sync()
      : undefined;
    if (synced !== undefined && synced !== candidate) {
      const syncedClaim = await readCandidate(synced);
      if (syncedClaim !== undefined) {
        return syncedClaim;
      }
    }

    return candidate.get?.();
  };

  const directClaim = await readCandidate(value);
  if (directClaim !== undefined) {
    return directClaim;
  }

  if (typeof value.resolveAsCell === "function") {
    const resolved = await value.resolveAsCell();
    return await readCandidate(resolved);
  }

  return undefined;
};

interface LabelViewResult {
  readonly view: CfcLabelView | undefined;

  /**
   * The resolved cell whose label the fallback `resolveAsCell()` path read and
   * got nothing back from, when that cell can be subscribed to. `getCfcLabel`
   * is a non-blocking store read, so an empty result means either that the
   * resolved cell's document is not loaded yet or that it carries no label,
   * and the caller watches this cell to find out which.
   */
  readonly unloadedCell: CfcLabelSubscribableValue | undefined;
}

/** A source whose resolved cell's label an observation can watch. */
type LabelSource = "value" | "author";

/** A watch on a resolved cell whose label read as missing. */
interface LabelWatch {
  /**
   * Which cell is watched: the key `cellTargetKey()` gives it, or the cell
   * object itself when it has no `ref()`.
   */
  readonly target: unknown;

  /** Whether an update has delivered the cell's value, so it has loaded. */
  loaded: boolean;

  /** Ends the subscription; unset until the subscription call returns. */
  cancel: (() => void) | undefined;
}

/**
 * Whether `cell` reports that a read of it has been answered, even with
 * nothing: a `CellHandle` tells an unread handle from a cell that holds
 * nothing through `lastRead()`. A cell that reports nothing of the kind has
 * not.
 */
const hasBeenRead = (cell: CfcLabelSubscribableValue): boolean => {
  const read = cell.lastRead?.();
  return read !== undefined && !("unread" in read);
};

/**
 * The space, id and path of the cell `value` refers to, joined into one
 * string, when it exposes a `ref()`; `undefined` otherwise.
 */
const cellTargetKey = (value: unknown): string | undefined => {
  const ref = (value as { ref?: () => unknown }).ref?.();
  if (!isObjectNotArray(ref)) {
    return undefined;
  }
  const { space, id, path } = ref as Record<string, unknown>;
  return JSON.stringify([space, id, path]);
};

const readLabelView = async (
  value: unknown,
  requiredRootIntegrityKind?: string,
): Promise<LabelViewResult> => {
  let direct: CfcLabelView | undefined;
  if (hasLabelQuery(value)) {
    direct = await value.getCfcLabel();
  }

  if (
    direct !== undefined && requiredRootIntegrityKind !== undefined &&
    labelHasRootIntegrityKind(direct, requiredRootIntegrityKind)
  ) {
    return { view: direct, unloadedCell: undefined };
  }

  let resolvedLabel: CfcLabelView | undefined;
  let unloadedCell: CfcLabelSubscribableValue | undefined;
  if (hasLabelResolution(value)) {
    const resolved = await value.resolveAsCell();
    if (hasLabelQuery(resolved)) {
      resolvedLabel = await resolved.getCfcLabel();
      if (resolvedLabel === undefined && hasLabelSubscription(resolved)) {
        unloadedCell = resolved;
      }
    }
  }

  return { view: mergeLabelViews(direct, resolvedLabel), unloadedCell };
};

const primitiveToString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

const objectField = (
  value: Record<string, unknown>,
  field: string,
): string | undefined => primitiveToString(value[field]);

const objectStringFields = (
  value: unknown,
  fields: readonly string[],
): string[] => {
  if (!isObjectNotArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  return fields.flatMap((field) => {
    const fieldValue = objectField(record, field);
    return fieldValue === undefined ? [] : [fieldValue];
  });
};

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const authorIdsForClaim = (author: unknown): string[] => {
  const primitive = primitiveToString(author);
  if (primitive !== undefined) {
    return [primitive];
  }
  return uniqueStrings(objectStringFields(author, AUTHOR_FIELDS));
};

const authorDisplayName = (author: unknown): string | undefined =>
  objectStringFields(author, AUTHOR_DISPLAY_FIELDS)[0];

/**
 * How to name the author `claim` names: its display name, else the first id
 * it gives; `undefined` when it gives neither.
 */
export const authorClaimLabel = (claim: unknown): string | undefined =>
  authorDisplayName(claim) ?? authorIdsForClaim(claim)[0];

const principalAuthorClaim = (
  subject: string | undefined,
  displayName: string | undefined,
): unknown | undefined => {
  if (subject === undefined) {
    return undefined;
  }
  return {
    subject,
    ...(displayName !== undefined ? { name: displayName } : {}),
  };
};

/**
 * Whether `atom` says its value was written by the author `author` claims:
 * the subject `authorshipClaimSubject` reads from it is one of the claim's
 * author ids.
 */
export const integrityAtomMatchesAuthor = (
  atom: unknown,
  author: unknown,
  kind: string = DEFAULT_AUTHORSHIP_KIND,
): boolean => {
  const subject = authorshipClaimSubject(atom, kind);
  return subject !== undefined && authorIdsForClaim(author).includes(subject);
};

const hasAuthorshipIntegrity = (
  entries: ReturnType<typeof rootEntries>,
  kind: string,
): boolean =>
  entries.some((entry) =>
    (entry.label.integrity ?? []).some((atom) =>
      authorshipClaimSubject(atom, kind) !== undefined
    )
  );

/**
 * The verdict `view`, a value's label, gives on whether `author` wrote the
 * value: `verified` when a root integrity atom of `kind` names one of the
 * claim's ids, `unverified` when such atoms name only others, and `unknown`
 * when there is no label, no claimed id, or no such atom.
 */
export const authorshipStateForLabel = (
  view: CfcLabelView | undefined,
  author: unknown,
  kind: string = DEFAULT_AUTHORSHIP_KIND,
): CfcAuthorshipState => {
  if (!view || authorIdsForClaim(author).length === 0) {
    return "unknown";
  }

  const entries = rootEntries(view);
  for (const entry of entries) {
    const integrity = entry.label.integrity;
    if (!Array.isArray(integrity)) {
      continue;
    }
    if (
      integrity.some((atom) => integrityAtomMatchesAuthor(atom, author, kind))
    ) {
      return "verified";
    }
  }

  return hasAuthorshipIntegrity(entries, kind) ? "unverified" : "unknown";
};

/**
 * Watches `value` and `author` and calls `onState` with an
 * `AuthorshipObservation`, whose `state` is the verdict, once both of their
 * labels have loaded, and again after each later read of either
 * one, whether or not the verdict changed. Before both have loaded it calls
 * nothing, so a verdict of `unknown` means the loaded labels establish no
 * authorship, never that they have yet to arrive. Returns a function that
 * ends every subscription the observation holds; `onState` is not called
 * after it.
 *
 * `value` is the content whose authorship is in question and `author` the
 * claim, each usually a `CellHandle` as a render binds one (`$value` and
 * `$author` on `cf-cfc-authorship`). Either may also be a plain value, which
 * has no label to load. A label counts as loaded once a read of it has
 * finished with nothing left waiting: the value's own label, or that of the
 * cell it resolves to, is read; when the resolved cell's label reads as
 * missing, the observation watches that cell and reads again once an update
 * or a read of it shows it has loaded, and a read that still finds none then
 * is final. A source the worker refuses carries no attestation, so its
 * refusal ends the wait, and the verdict is reached without that label, as
 * for one that is absent. A read that fails for any other reason decides
 * nothing, and no verdict is reported while it stands.
 */
export const observeAuthorship = (
  value: unknown,
  author: unknown,
  onState: (observation: AuthorshipObservation) => void,
  options: ObserveAuthorshipOptions = {},
): () => void => {
  const observation = new AuthorshipObservationState(
    value,
    author,
    onState,
    options.kind ?? DEFAULT_AUTHORSHIP_KIND,
    options.authorName,
  );
  observation.start();
  return () => observation.cancel();
};

/** One observation `observeAuthorship()` runs, until it is cancelled. */
class AuthorshipObservationState {
  #value: unknown;
  #author: unknown;
  #onState: (observation: AuthorshipObservation) => void;
  #kind: string;
  #authorName: string | undefined;
  #cancelled = false;
  #labelRequestId = 0;
  #authorRequestId = 0;
  #cfcLabel: CfcLabelView | undefined = undefined;
  #authorClaim: unknown = undefined;
  #unsubscribeValue: (() => void) | undefined;
  #unsubscribeAuthor: (() => void) | undefined;

  /** The watch on each source's resolved cell while its label reads as missing. */
  #labelWatches: Record<LabelSource, LabelWatch | undefined> = {
    value: undefined,
    author: undefined,
  };

  /**
   * Whether each source's label has yet to load: cleared by a read of it that
   * leaves no watch waiting on its resolved cell, or by the worker refusing
   * it.
   */
  #labelPending: Record<LabelSource, boolean> = {
    value: true,
    author: true,
  };

  /**
   * Constructs an instance which observes `value` and `author`, deciding by
   * `kind`, and reports to `onState`.
   */
  constructor(
    value: unknown,
    author: unknown,
    onState: (observation: AuthorshipObservation) => void,
    kind: string,
    authorName: string | undefined,
  ) {
    this.#value = value;
    this.#author = author;
    this.#onState = onState;
    this.#kind = kind;
    this.#authorName = authorName;
  }

  /** Subscribes to both sources and starts the first read of each. */
  start(): void {
    this.#observeValue();
    this.#observeAuthor();
  }

  /** Ends every subscription, and every report. */
  cancel(): void {
    this.#cancelled = true;
    this.#unsubscribeValue?.();
    this.#unsubscribeValue = undefined;
    this.#unsubscribeAuthor?.();
    this.#unsubscribeAuthor = undefined;
    this.#endLabelWatch("value");
    this.#endLabelWatch("author");
  }

  #observeValue(): void {
    const value = this.#value;
    if (!hasLabelSubscription(value)) {
      void this.#refreshLabel();
      return;
    }

    // includeCfcLabel makes the worker read this cell's label (and that of
    // the document its path resolves to) on the sink's tracked tx, so a
    // label-only change re-fires this subscription and `#refreshLabel()`
    // re-reads the new label. The first delivery is synchronous, and starts
    // the first read.
    this.#unsubscribeValue = value.subscribe(() => {
      void this.#refreshLabel();
    }, {
      includeCfcLabel: true,
      // A value the worker will not show carries no attestation here, and
      // none is read for it: the watch on the cell it resolved to ends too. A
      // later readable value starts one again.
      onRefused: () => {
        this.#labelRequestId++;
        this.#cfcLabel = undefined;
        this.#endLabelWatch("value");
        this.#settleLabel("value");
      },
    });
  }

  #observeAuthor(): void {
    const author = this.#author;
    if (hasLabelSubscription(author)) {
      this.#unsubscribeAuthor = author.subscribe((claim) => {
        if (hasLabelQuery(author) || hasLabelResolution(author)) {
          void this.#refreshAuthorClaim();
          return;
        }
        this.#authorClaim = claim;
        this.#report();
      }, {
        includeCfcLabel: true,
        // An author the worker will not show makes no claim here, and the
        // watch on the cell it resolved to ends.
        onRefused: () => {
          this.#authorRequestId++;
          this.#authorClaim = undefined;
          this.#endLabelWatch("author");
          this.#settleLabel("author");
        },
      });
    }
    void this.#refreshAuthorClaim();
  }

  /** Reads the value's label, and records it if no later read has started. */
  async #refreshLabel(): Promise<void> {
    const requestId = ++this.#labelRequestId;
    let result: LabelViewResult;
    try {
      result = await readLabelView(this.#value, this.#kind);
    } catch (error) {
      if (this.#cancelled || requestId !== this.#labelRequestId) return;
      if (error instanceof CellReadRefusedError) {
        // A refused read carries no attestation, as a refused subscription
        // does.
        result = { view: undefined, unloadedCell: undefined };
      } else {
        // Any other failure, such as a disposal race cancelling the read,
        // decides nothing: the label is unread again, so no verdict is
        // reported on what an earlier read of it found.
        this.#labelPending.value = true;
        return;
      }
    }
    if (this.#cancelled || requestId !== this.#labelRequestId) return;
    this.#cfcLabel = result.view;
    this.#watchUnloadedLabel(
      "value",
      result.unloadedCell,
      () => void this.#refreshLabel(),
    );
    this.#settleLabel("value");
  }

  /** Reads the author's claim, and records it if no later read has started. */
  async #refreshAuthorClaim(): Promise<void> {
    const requestId = ++this.#authorRequestId;
    const author = this.#author;
    const canReadAuthor = hasReadableClaim(author);
    if (
      !canReadAuthor && !hasLabelQuery(author) &&
      !hasLabelResolution(author)
    ) {
      this.#authorClaim = author;
      this.#endLabelWatch("author");
      this.#settleLabel("author");
      return;
    }

    let authorClaim: unknown;
    let unloadedCell: CfcLabelSubscribableValue | undefined;
    try {
      const valueClaim = canReadAuthor
        ? await readClaimValue(author)
        : undefined;
      const profile = await readLabelView(author, "represents-principal");
      unloadedCell = profile.unloadedCell;
      const candidates = authorPrincipalCandidates(profile.view);
      // A label naming more than one principal names none, and the claim's
      // own value does not stand in for it.
      authorClaim = candidates.length > 1 ? undefined : principalAuthorClaim(
        candidates[0],
        authorDisplayName(valueClaim) ?? this.#authorName,
      ) ?? valueClaim;
    } catch (error) {
      if (this.#cancelled || requestId !== this.#authorRequestId) return;
      if (!(error instanceof CellReadRefusedError)) {
        // As for the value's label: a failure other than a refusal decides
        // nothing, and the claim is unread again.
        this.#labelPending.author = true;
        return;
      }
      // A refused author makes no claim, as a refused subscription does.
      authorClaim = undefined;
      unloadedCell = undefined;
    }

    if (this.#cancelled || requestId !== this.#authorRequestId) return;
    this.#authorClaim = authorClaim;
    this.#watchUnloadedLabel(
      "author",
      unloadedCell,
      () => void this.#refreshAuthorClaim(),
    );
    this.#settleLabel("author");
  }

  /**
   * Watches `unloadedCell`, the cell `source` resolves to, whose label read as
   * missing, and runs `refresh` when an update shows the cell has loaded or
   * carries its label. A label read through `resolveAsCell()` is a one-time
   * store read, and the observation's own subscriptions are on the value and
   * the author, not on the cells they resolve to, so nothing else would re-run
   * the read when that cell's document loads.
   *
   * An update carries a label only when this is the first subscription on the
   * cell's backend key (the connection lets the first subscriber decide), so a
   * value arriving without one does not show the cell has none. Instead it
   * marks the cell loaded and runs `refresh`, whose store read does see the
   * label; a read that still finds none once the cell has loaded ends the
   * watch. The watch ends too when a read finds the label, when `source`
   * resolves to a different cell or to none, when the worker refuses the
   * watched cell's read, or `source`'s own, and when the observation is
   * cancelled.
   */
  #watchUnloadedLabel(
    source: LabelSource,
    unloadedCell: CfcLabelSubscribableValue | undefined,
    refresh: () => void,
  ): void {
    if (unloadedCell === undefined) {
      this.#endLabelWatch(source);
      return;
    }
    const target = cellTargetKey(unloadedCell) ?? unloadedCell;
    const current = this.#labelWatches[source];
    if (current !== undefined && Object.is(current.target, target)) {
      if (current.loaded) {
        this.#endLabelWatch(source);
      }
      return;
    }
    this.#endLabelWatch(source);

    const watch: LabelWatch = { target, loaded: false, cancel: undefined };
    this.#labelWatches[source] = watch;
    const cancel = unloadedCell.subscribe((value, cfcLabel) => {
      if (this.#labelWatches[source] !== watch) {
        return;
      }
      if (
        cfcLabel !== undefined || value !== undefined ||
        hasBeenRead(unloadedCell)
      ) {
        watch.loaded = true;
        refresh();
      }
    }, {
      includeCfcLabel: true,
      // A refused cell loads nothing the host may read, so the watch ends,
      // and the label it waited on has loaded with nothing in it.
      onRefused: () => {
        if (this.#labelWatches[source] !== watch) return;
        this.#endLabelWatch(source);
        this.#settleLabel(source);
      },
    });
    // The first delivery is synchronous, and may already have ended the watch.
    if (this.#labelWatches[source] === watch) {
      watch.cancel = cancel;
    } else {
      cancel();
      return;
    }
    // The connection delivers no update for a cell that holds nothing, so a
    // cell holding nothing would stay unread, and the watch waiting, for
    // good. A read answers it whatever it holds, and its answer reaches the
    // subscription above. A refusal of the read reaches `onRefused`.
    unloadedCell.sync?.().catch(() => {});
  }

  /** Ends the watch on `source`'s resolved cell, if there is one. */
  #endLabelWatch(source: LabelSource): void {
    const watch = this.#labelWatches[source];
    this.#labelWatches[source] = undefined;
    watch?.cancel?.();
  }

  /**
   * Records that a read of `source` has finished, its label loaded unless a
   * watch is still waiting on the cell it resolves to, and reports.
   */
  #settleLabel(source: LabelSource): void {
    this.#labelPending[source] = this.#labelWatches[source] !== undefined;
    this.#report();
  }

  /** Calls `onState` with the verdict, once both labels have loaded. */
  #report(): void {
    if (
      this.#cancelled || this.#labelPending.value || this.#labelPending.author
    ) {
      return;
    }
    this.#onState({
      state: authorshipStateForLabel(
        this.#cfcLabel,
        this.#authorClaim,
        this.#kind,
      ),
      cfcLabel: this.#cfcLabel,
      authorClaim: this.#authorClaim,
    });
  }
}
