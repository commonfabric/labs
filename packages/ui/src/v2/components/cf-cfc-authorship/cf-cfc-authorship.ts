import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  authorClaimLabel,
  type AuthorshipObservation,
  type CfcAuthorshipState,
  observeAuthorship,
} from "@commonfabric/runtime-client";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import { initialsForName } from "../cf-avatar/index.ts";

/**
 * What the badge shows: the state its labels decide, or `loading` while a
 * label it reads has not loaded yet.
 */
export type CfcAuthorshipBadgeState = CfcAuthorshipState | "loading";

const DEFAULT_AUTHORSHIP_KIND = "authored-by";

/** What an observation watches, and the options it decides by. */
interface ObservedSources {
  readonly value: unknown;
  readonly author: unknown;
  readonly kind: string;
  readonly authorName: string | undefined;
}

/** Whether `a` and `b` name the same sources and options. */
const sameSources = (
  a: ObservedSources | undefined,
  b: ObservedSources,
): boolean =>
  a !== undefined && Object.is(a.value, b.value) &&
  Object.is(a.author, b.author) && a.kind === b.kind &&
  a.authorName === b.authorName;

const primitiveToString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

/**
 * Shows trusted authorship state for a bound CFC-labeled content cell.
 *
 * The component certifies a bound `value` against the bound author claim. It
 * cannot inspect arbitrary slotted DOM: callers should slot the UI block that
 * renders the same bound value and author claim so the badge and rendered
 * content remain adjacent.
 *
 * The labels are read and decided by `observeAuthorship()` from
 * `@commonfabric/runtime-client`, while the element is connected. Until the
 * value's label and the author's have loaded, the badge is neutral: it reads
 * `loading`, with no warning. It reads `unknown` only once both have loaded and
 * establish no authorship.
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
 * @attr {string} kind - Integrity object kind, `authored-by` (the default) or
 *   `represents-principal`; any other kind never verifies.
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

      .authorship.loading .state {
        color: var(--cf-theme-color-text-muted, hsl(220, 10%, 44%));
        font-weight: 400;
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

  #value: unknown = undefined;
  #author: unknown = undefined;

  /** Ends the running observation; unset while none runs. */
  #cancelObservation: (() => void) | undefined;

  /**
   * What the latest observation watches. It outlives a disconnection, so
   * that an element moved within the document keeps its verdict while it
   * observes the same sources again.
   */
  #sources: ObservedSources | undefined;

  /** What the latest observation last reported; unset until it reports. */
  #observation: AuthorshipObservation | undefined;

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
    return this.#value;
  }

  set value(next: unknown) {
    const previous = this.#value;
    this.#value = next;
    this.requestUpdate("value", previous);
    if (!Object.is(previous, next)) this.#observe();
  }

  get author(): unknown {
    return this.#author;
  }

  set author(next: unknown) {
    const previous = this.#author;
    this.#author = next;
    this.requestUpdate("author", previous);
    if (!Object.is(previous, next)) this.#observe();
  }

  /**
   * What the badge shows: `loading` until the value's label and the author's
   * have both loaded, and after that the state they decide, `verified`
   * lowered to `unverified` when text integrity is required and the renderer
   * blocked the content's text. So `unknown` means that the loaded labels
   * establish no authorship, never that they have yet to arrive.
   */
  get authorshipState(): CfcAuthorshipBadgeState {
    const observation = this.#observation;
    if (observation === undefined) {
      return "loading";
    }
    if (
      observation.state === "verified" &&
      this.verifyTextIntegrity &&
      this.textIntegrityState === "blocked"
    ) {
      return "unverified";
    }
    return observation.state;
  }

  /** Who the author claim names, once the labels have loaded. */
  get authorClaim(): unknown {
    return this.#observation?.authorClaim;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#observe();
  }

  override disconnectedCallback() {
    this.#cancelObservation?.();
    this.#cancelObservation = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: Map<PropertyKey, unknown>) {
    super.willUpdate(changedProperties);
    if (!sameSources(this.#sources, this.#currentSources)) this.#observe();
  }

  /** What an observation started now would watch and decide by. */
  get #currentSources(): ObservedSources {
    return {
      value: this.#value,
      author: this.#author,
      kind: this.kind ?? DEFAULT_AUTHORSHIP_KIND,
      authorName: primitiveToString(this.authorName),
    };
  }

  /**
   * Starts an observation of the current sources, in place of the running
   * one, while the element is connected. A change of sources forgets the
   * verdict, so the badge reads `loading` until the new observation reports.
   */
  #observe(): void {
    this.#cancelObservation?.();
    this.#cancelObservation = undefined;
    const sources = this.#currentSources;
    if (
      !sameSources(this.#sources, sources) && this.#observation !== undefined
    ) {
      this.#observation = undefined;
      this.requestUpdate();
    }
    this.#sources = sources;
    if (!this.isConnected) return;
    this.#cancelObservation = observeAuthorship(
      sources.value,
      sources.author,
      (observation) => {
        this.#observation = observation;
        const previous = this.cfcLabel;
        this.cfcLabel = observation.cfcLabel;
        this.requestUpdate("cfcLabel", previous);
        this.requestUpdate();
      },
      { kind: sources.kind, authorName: sources.authorName },
    );
  }

  private renderAvatar(state: CfcAuthorshipBadgeState) {
    if (state === "loading") {
      return html`
        <span class="status-dot" part="status-dot" aria-hidden="true"></span>
      `;
    }
    if (state !== "verified") {
      return html`
        <span class="status-dot" part="status-dot" aria-hidden="true">!</span>
      `;
    }

    const authorName = authorClaimLabel(this.authorClaim);
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
    const claimLabel = authorClaimLabel(this.authorClaim);
    const authorLabel = state === "verified"
      ? claimLabel ?? "unknown author"
      : state === "loading"
      ? claimLabel ?? primitiveToString(this.authorName) ?? ""
      : claimLabel ?? primitiveToString(this.authorName) ?? "unknown author";
    const stateLabel = state === "verified"
      ? "Verified author"
      : state === "unverified"
      ? "Unverified author"
      : state === "loading"
      ? "Checking author"
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
