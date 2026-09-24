import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import { authorPrincipalCandidates } from "../../core/cfc-label.ts";
import { initialsForName } from "../cf-avatar/index.ts";

export type CfcAuthorshipState = "verified" | "unverified" | "unknown";

type CfcLabelQueryableValue = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

type CfcLabelResolvableValue = {
  resolveAsCell(): Promise<CfcLabelQueryableValue>;
};

type CfcLabelSubscribableValue = {
  subscribe(
    callback: (value: unknown, cfcLabel?: CfcLabelView | undefined) => void,
    options?: { includeCfcLabel?: boolean },
  ): () => void;
};

type CfcReadableClaimValue = {
  get?(): unknown;
  sync?(): Promise<unknown>;
  resolveAsCell?(): Promise<unknown> | unknown;
};

const DEFAULT_AUTHORSHIP_KIND = "authored-by";
// Poll cadence for re-reading a label whose resolved cell wasn't loaded yet.
// Mirrors cf-cfc-label's retry-on-undefined; bounded so a resolved cell that
// genuinely never carries a label stops retrying.
const LABEL_RETRY_INTERVAL_MS = 100;
const MAX_LABEL_RETRY_COUNT = 100;
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

const labelHasRootIntegrityKind = (
  view: CfcLabelView,
  kind: string,
): boolean =>
  view.entries.some((entry) =>
    entry.path.length === 0 &&
    (entry.label.integrity ?? []).some((atom) => {
      if (typeof atom === "string") {
        return atom.startsWith(`${kind}:`);
      }
      if (!isObjectNotArray(atom)) {
        return false;
      }
      return (atom as Record<string, unknown>).kind === kind;
    })
  );

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
   * True when the fallback `resolveAsCell()` path read a resolved cell's label
   * and got nothing back. `getCfcLabel` is a pure, non-blocking store read, so
   * an empty result means the resolved cell's doc is not loaded yet. This
   * component subscribes to `value`/`author`, NOT to that internally-resolved
   * cell, so its load would not re-trigger this read — the caller retries until
   * it lands (same liveness contract cf-cfc-label gets from its undefined-retry).
   */
  readonly pendingResolution: boolean;
}

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
    return { view: direct, pendingResolution: false };
  }

  let resolvedLabel: CfcLabelView | undefined;
  let pendingResolution = false;
  if (hasLabelResolution(value)) {
    const resolved = await value.resolveAsCell();
    if (hasLabelQuery(resolved)) {
      resolvedLabel = await resolved.getCfcLabel();
      pendingResolution = resolvedLabel === undefined;
    }
  }

  return { view: mergeLabelViews(direct, resolvedLabel), pendingResolution };
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

const primaryAuthorId = (author: unknown): string | undefined =>
  authorIdsForClaim(author)[0];

const authorDisplayName = (author: unknown): string | undefined =>
  objectStringFields(author, AUTHOR_DISPLAY_FIELDS)[0];

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

export const integrityAtomMatchesAuthor = (
  atom: unknown,
  author: unknown,
  kind: string = DEFAULT_AUTHORSHIP_KIND,
): boolean => {
  const authorIds = authorIdsForClaim(author);
  if (authorIds.length === 0) {
    return false;
  }

  if (typeof atom === "string") {
    return authorIds.some((authorId) => atom === `${kind}:${authorId}`);
  }

  if (!isObjectNotArray(atom)) {
    return false;
  }

  const atomRecord = atom as Record<string, unknown>;
  if (objectField(atomRecord, "kind") !== kind) {
    return false;
  }

  return AUTHOR_FIELDS.some((field) => {
    const atomAuthor = objectField(atomRecord, field);
    return atomAuthor !== undefined && authorIds.includes(atomAuthor);
  });
};

const rootEntries = (view: CfcLabelView) =>
  view.entries.filter((entry) => entry.path.length === 0);

const hasAuthorshipIntegrity = (
  entries: ReturnType<typeof rootEntries>,
  kind: string,
): boolean =>
  entries.some((entry) =>
    (entry.label.integrity ?? []).some((atom) =>
      typeof atom === "string"
        ? atom.startsWith(`${kind}:`)
        : isObjectNotArray(atom) &&
          objectField(atom as Record<string, unknown>, "kind") === kind
    )
  );

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
 * Shows trusted authorship state for a bound CFC-labeled content cell.
 *
 * The component certifies a bound `value` against the bound author claim. It
 * cannot inspect arbitrary slotted DOM: callers should slot the UI block that
 * renders the same bound value and author claim so the badge and rendered
 * content remain adjacent.
 *
 * @element cf-cfc-authorship
 *
 * @prop {unknown} value - Usually supplied via `$value`; queried for CFC label IPC.
 * @prop {unknown} author - Claimed author id/object, or a `$author`-bound claim cell.
 * @prop {unknown} authorName - Optional untrusted display fallback.
 * @prop {unknown} avatar - Optional avatar image URL shown only when verified.
 * @prop {boolean} verifyTextIntegrity - Require visible descendant text to
 *   match the authorship claim.
 * @prop {boolean} allowLiteralText - Allow literal descendant text under text
 *   integrity verification.
 * @prop {"ok"|"blocked"} textIntegrityState - Renderer-reported descendant text
 *   integrity state.
 * @attr {string} kind - Integrity object kind; defaults to `authored-by`.
 */
export class CFCFCAuthorship extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        color: var(--cf-theme-color-text, hsl(220, 14%, 12%));
        font-size: 0.875rem;
      }

      .authorship {
        display: grid;
        grid-template-columns: minmax(0, auto) minmax(0, 1fr);
        gap: 0.75rem;
        align-items: start;
      }

      :host([badge-placement="end"]) .authorship,
      :host([data-badge-placement="end"]) .authorship {
        grid-template-columns: minmax(0, 1fr) minmax(0, auto);
      }

      .badge {
        display: inline-grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.5rem;
        align-items: center;
        min-width: 10rem;
        padding: 0.5rem 0.625rem;
        border-radius: 999px;
        border: 1px solid var(--cf-theme-color-border, hsl(220, 14%, 86%));
        background: var(--cf-theme-color-surface, hsl(220, 20%, 98%));
      }

      :host([badge-placement="end"]) .badge,
      :host([data-badge-placement="end"]) .badge {
        grid-column: 2;
        grid-row: 1;
        grid-template-columns: minmax(0, 1fr) auto;
      }

      :host([badge-placement="end"]) .avatar,
      :host([badge-placement="end"]) .status-dot,
      :host([data-badge-placement="end"]) .avatar,
      :host([data-badge-placement="end"]) .status-dot {
        grid-column: 2;
      }

      :host([badge-placement="end"]) .label,
      :host([data-badge-placement="end"]) .label {
        grid-column: 1;
        grid-row: 1;
        text-align: right;
      }

      .authorship.verified .badge {
        border-color: var(--cf-authorship-verified-border, hsl(155, 48%, 58%));
        background: var(--cf-authorship-verified-bg, hsl(151, 58%, 95%));
      }

      .authorship.unverified .badge {
        border-color: var(--cf-authorship-unverified-border, hsl(24, 82%, 64%));
        background: var(--cf-authorship-unverified-bg, hsl(34, 100%, 96%));
      }

      .authorship.unknown .badge {
        border-color: var(--cf-theme-color-border, hsl(220, 14%, 86%));
        background: var(--cf-theme-color-muted, hsl(220, 18%, 96%));
      }

      .avatar,
      .status-dot {
        display: inline-grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        border-radius: 999px;
        overflow: hidden;
      }

      .avatar {
        color: var(--cf-authorship-avatar-text, hsl(155, 65%, 16%));
        background: var(--cf-authorship-avatar-bg, hsl(155, 55%, 84%));
        font-weight: 700;
        letter-spacing: 0.02em;
      }

      .avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .status-dot {
        border: 1px dashed var(--cf-theme-color-border, hsl(220, 14%, 72%));
        color: var(--cf-theme-color-text-muted, hsl(220, 10%, 44%));
        font-weight: 700;
      }

      .label {
        display: grid;
        min-width: 0;
        line-height: 1.25;
      }

      .state {
        font-weight: 700;
      }

      .author {
        color: var(--cf-theme-color-text-muted, hsl(220, 10%, 44%));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .content {
        min-width: 0;
      }

      :host([badge-placement="end"]) .content,
      :host([data-badge-placement="end"]) .content {
        grid-column: 1;
        grid-row: 1;
      }
    `,
  ];

  static override properties = {
    value: { attribute: false },
    cfcLabel: { attribute: false },
    author: { attribute: false },
    authorName: { attribute: false },
    avatar: { attribute: false },
    badgePlacement: {
      type: String,
      attribute: "badge-placement",
      reflect: true,
    },
    kind: { type: String },
    verifyTextIntegrity: {
      type: Boolean,
      attribute: "verify-text-integrity",
    },
    allowLiteralText: {
      type: Boolean,
      attribute: "allow-literal-text",
    },
    textIntegrityState: {
      type: String,
      attribute: "text-integrity-state",
      reflect: true,
    },
  };

  declare cfcLabel: CfcLabelView | undefined;
  declare authorName: unknown;
  declare avatar: unknown;
  declare badgePlacement: "start" | "end";
  declare kind: string | undefined;
  declare verifyTextIntegrity: boolean;
  declare allowLiteralText: boolean;
  declare textIntegrityState: "ok" | "blocked";

  private _labelRequestId = 0;
  private _authorRequestId = 0;
  private _value: unknown = undefined;
  private _author: unknown = undefined;
  private _authorClaim: unknown = undefined;
  private _observedValue: unknown = undefined;
  private _observedAuthor: unknown = undefined;
  private _unsubscribeValue: (() => void) | undefined;
  private _unsubscribeAuthor: (() => void) | undefined;
  private _labelRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  private _labelRetryCount = 0;
  private _valueResolutionPending = false;
  private _authorResolutionPending = false;

  constructor() {
    super();
    this.cfcLabel = undefined;
    this.authorName = undefined;
    this.avatar = undefined;
    this.badgePlacement = "start";
    this.kind = DEFAULT_AUTHORSHIP_KIND;
    this.verifyTextIntegrity = false;
    this.allowLiteralText = false;
    this.textIntegrityState = "ok";
  }

  get value(): unknown {
    return this._value;
  }

  set value(next: unknown) {
    const previous = this._value;
    this._value = next;
    this.requestUpdate("value", previous);
    this.refreshForCurrentValue();
  }

  get author(): unknown {
    return this._author;
  }

  set author(next: unknown) {
    const previous = this._author;
    this._author = next;
    this.requestUpdate("author", previous);
    this.refreshForCurrentAuthor();
  }

  get authorshipState(): CfcAuthorshipState {
    const labelState = authorshipStateForLabel(
      this.cfcLabel,
      this.authorClaim,
      this.kind ?? DEFAULT_AUTHORSHIP_KIND,
    );
    if (
      labelState === "verified" &&
      this.verifyTextIntegrity &&
      this.textIntegrityState === "blocked"
    ) {
      return "unverified";
    }
    return labelState;
  }

  get authorClaim(): unknown {
    return hasReadableClaim(this.author) || hasLabelQuery(this.author) ||
        hasLabelResolution(this.author)
      ? this._authorClaim
      : this.author;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.refreshForCurrentValue();
    this.refreshForCurrentAuthor();
  }

  override disconnectedCallback() {
    this.clearValueSubscription();
    this.clearAuthorSubscription();
    this.clearLabelRetry();
    super.disconnectedCallback();
  }

  protected override firstUpdated(
    changedProperties: Map<PropertyKey, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this.refreshForCurrentValue();
    this.refreshForCurrentAuthor();
  }

  private refreshForCurrentValue(): void {
    const hasSubscription = this.observeValue(this.value);
    if (!hasSubscription) {
      void this.refreshLabel();
    }
  }

  private refreshForCurrentAuthor(): void {
    this.observeAuthor(this.author);
    void this.refreshAuthorClaim();
  }

  private observeValue(value: unknown): boolean {
    if (Object.is(value, this._observedValue)) {
      return this._unsubscribeValue !== undefined;
    }

    this.clearValueSubscription();
    this._observedValue = value;
    // New value → fresh retry budget for its (possibly cold) resolved label.
    this._labelRetryCount = 0;

    if (!hasLabelSubscription(value)) {
      return false;
    }

    // includeCfcLabel makes the worker read this cell's label (and its
    // one-hop link target's) on the sink's tracked tx, so a label-only change
    // re-fires this subscription and refreshLabel re-reads the new label — the
    // resolved-cell label is now reactive, not just polled.
    this._unsubscribeValue = value.subscribe(() => {
      void this.refreshLabel();
    }, { includeCfcLabel: true });
    return true;
  }

  private clearValueSubscription(): void {
    this._unsubscribeValue?.();
    this._unsubscribeValue = undefined;
    this._observedValue = undefined;
  }

  private observeAuthor(author: unknown): boolean {
    if (Object.is(author, this._observedAuthor)) {
      return this._unsubscribeAuthor !== undefined;
    }

    this.clearAuthorSubscription();
    this._observedAuthor = author;
    // New author → fresh retry budget for its (possibly cold) resolved label.
    this._labelRetryCount = 0;

    if (!hasLabelSubscription(author)) {
      return false;
    }

    this._unsubscribeAuthor = author.subscribe((claim) => {
      if (hasLabelQuery(author) || hasLabelResolution(author)) {
        void this.refreshAuthorClaim();
        return;
      }
      const previous = this._authorClaim;
      this._authorClaim = claim;
      this.requestUpdate("author", previous);
    }, { includeCfcLabel: true });
    return true;
  }

  private clearAuthorSubscription(): void {
    this._unsubscribeAuthor?.();
    this._unsubscribeAuthor = undefined;
    this._observedAuthor = undefined;
  }

  async refreshLabel(): Promise<void> {
    const requestId = ++this._labelRequestId;
    let view: typeof this.cfcLabel;
    let pendingResolution: boolean;
    try {
      ({ view, pendingResolution } = await readLabelView(
        this.value,
        this.kind ?? DEFAULT_AUTHORSHIP_KIND,
      ));
    } catch {
      // This runs fire-and-forget (void this.refreshLabel()). A disposal race
      // (logout, runtime swap) cancels the read; leave the label as-is rather
      // than leaking an unhandled rejection — matching refreshAuthorClaim.
      return;
    }
    if (requestId === this._labelRequestId) {
      const previous = this.cfcLabel;
      this.cfcLabel = view;
      this.requestUpdate("cfcLabel", previous);
      this._valueResolutionPending = pendingResolution;
      this.reconcileLabelRetry();
    }
  }

  async refreshAuthorClaim(): Promise<void> {
    const requestId = ++this._authorRequestId;
    const author = this.author;
    const canReadAuthor = hasReadableClaim(author);
    if (
      !canReadAuthor && !hasLabelQuery(author) &&
      !hasLabelResolution(author)
    ) {
      const previous = this._authorClaim;
      this._authorClaim = undefined;
      this.requestUpdate("author", previous);
      this._authorResolutionPending = false;
      this.reconcileLabelRetry();
      return;
    }

    let authorClaim: unknown;
    let pendingResolution = false;
    try {
      const valueClaim = canReadAuthor
        ? await readClaimValue(author)
        : undefined;
      const profile = await readLabelView(author, "represents-principal");
      pendingResolution = profile.pendingResolution;
      const candidates = authorPrincipalCandidates(profile.view);
      // A label naming more than one principal names none, and the claim's
      // own value does not stand in for it.
      authorClaim = candidates.length > 1 ? undefined : principalAuthorClaim(
        candidates[0],
        authorDisplayName(valueClaim) ?? primitiveToString(this.authorName),
      ) ?? valueClaim;
    } catch {
      authorClaim = undefined;
    }

    if (requestId === this._authorRequestId) {
      const previous = this._authorClaim;
      this._authorClaim = authorClaim;
      this.requestUpdate("author", previous);
      this._authorResolutionPending = pendingResolution;
      this.reconcileLabelRetry();
    }
  }

  /**
   * Re-reads the label(s) while a resolved cell's doc is still loading. The
   * resolved cell is queried one-shot inside `readLabelView()` and is not
   * subscribed to, so without this poll a cold linked/bound-prop author would
   * stay unverified until an unrelated `value`/`author` change happened to
   * re-run the read. Bounded by `MAX_LABEL_RETRY_COUNT`.
   */
  private reconcileLabelRetry(): void {
    if (this._valueResolutionPending || this._authorResolutionPending) {
      this.scheduleLabelRetry();
    } else {
      this.clearLabelRetry();
      this._labelRetryCount = 0;
    }
  }

  private scheduleLabelRetry(): void {
    if (
      !this.isConnected ||
      this._labelRetryTimeout !== undefined ||
      this._labelRetryCount >= MAX_LABEL_RETRY_COUNT
    ) {
      return;
    }
    this._labelRetryTimeout = setTimeout(() => {
      this._labelRetryTimeout = undefined;
      if (!this.isConnected) return;
      this._labelRetryCount += 1;
      void this.refreshLabel();
      void this.refreshAuthorClaim();
    }, LABEL_RETRY_INTERVAL_MS);
  }

  private clearLabelRetry(): void {
    if (this._labelRetryTimeout !== undefined) {
      clearTimeout(this._labelRetryTimeout);
      this._labelRetryTimeout = undefined;
    }
  }

  private renderAvatar(state: CfcAuthorshipState) {
    if (state !== "verified") {
      return html`
        <span class="status-dot" part="status-dot" aria-hidden="true">!</span>
      `;
    }

    const authorName = authorDisplayName(this.authorClaim) ??
      primaryAuthorId(this.authorClaim);
    const avatar = primitiveToString(this.avatar);
    return html`
      <span
        class="avatar"
        part="avatar"
        data-cfc-authorship-avatar
        aria-hidden="true"
      >
        ${avatar
          ? html`
            <img src="${avatar}" alt="" />
          `
          : initialsForName(authorName)}
      </span>
    `;
  }

  override render() {
    const state = this.authorshipState;
    const claimLabel = authorDisplayName(this.authorClaim) ??
      primaryAuthorId(this.authorClaim);
    const authorLabel = state === "verified"
      ? claimLabel ?? "unknown author"
      : claimLabel ?? primitiveToString(this.authorName) ?? "unknown author";
    const stateLabel = state === "verified"
      ? "Verified author"
      : state === "unverified"
      ? "Unverified author"
      : "Unknown author";

    return html`
      <section
        class="authorship ${state}"
        part="root"
        data-cfc-authorship-state="${state}"
        data-cfc-text-integrity-state="${this.textIntegrityState}"
      >
        <div class="badge" part="badge">
          ${this.renderAvatar(state)}
          <span class="label" part="label">
            <span class="state" part="state">${stateLabel}</span>
            <span class="author" part="author">${authorLabel}</span>
          </span>
        </div>
        <div class="content" part="content">
          <slot></slot>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-cfc-authorship": CFCFCAuthorship;
  }
}
