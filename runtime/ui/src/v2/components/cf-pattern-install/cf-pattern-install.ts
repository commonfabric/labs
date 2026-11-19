import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/** The longest a shown name runs before it is cut short with an ellipsis. */
const MAX_NAME_LENGTH = 60;

/**
 * How many characters of each end of a long pattern id are shown when the
 * pattern has no title. Ids that share a prefix (a content hash's encoding
 * header) differ at the end, so both ends are shown.
 */
const SHOWN_ID_END_LENGTH = 8;

/**
 * Returns `text` as one line a person can read, with nothing in it that could
 * pass for the words around it. A name is written by whoever published the
 * pattern or named the loom, so it must not be able to reorder, hide or break
 * those words, or close the quotation it sits in and carry on as if it were
 * them. So: control and formatting characters (bidirectional overrides,
 * zero-width joiners, line breaks) become spaces; quotation marks of every
 * kind, opening and closing punctuation and quotation ornaments included,
 * become a plain apostrophe; a run of combining marks is cut to two;
 * whitespace collapses; and anything past `maxLength` (by default
 * {@link MAX_NAME_LENGTH}) is cut short with an ellipsis.
 */
export const plainName = (
  text: string | undefined,
  maxLength = MAX_NAME_LENGTH,
): string => {
  const flat = (text ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/["＂〃〝〞〟❛❜❝❞❟❠🙶🙷🙸\p{Pi}\p{Pf}]/gu, "'")
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  return chars.length > maxLength
    ? `${chars.slice(0, maxLength - 1).join("").trimEnd()}…`
    : flat;
};

/** What `cf-pattern-install` says it will do, as the parts it renders. */
export interface PatternInstallWording {
  /** The pattern's title, or its id when it has no title. */
  pattern: string;
  /** Who published the pattern; empty when unknown. */
  author: string;
  /** The loom the pattern goes onto; empty when unknown. */
  destination: string;
}

/**
 * Returns the parts of what `cf-pattern-install` says, from its inputs:
 * "Install “pattern” by author onto destination", where the author and the
 * destination are left out when unknown.
 */
export const installWording = (inputs: {
  patternTitle?: string;
  patternId?: string;
  author?: string;
  destinationName?: string;
}): PatternInstallWording => {
  const title = plainName(inputs.patternTitle);
  const id = [...plainName(inputs.patternId, Infinity)];
  const shownId = id.length > 2 * SHOWN_ID_END_LENGTH + 1
    ? `${id.slice(0, SHOWN_ID_END_LENGTH).join("")}…${
      id.slice(-SHOWN_ID_END_LENGTH).join("")
    }`
    : id.join("");
  return {
    pattern: title || (shownId ? `pattern ${shownId}` : "this pattern"),
    author: plainName(inputs.author),
    destination: plainName(inputs.destinationName),
  };
};

/** The sentence `cf-pattern-install` shows, as plain text. */
export const installSentence = (wording: PatternInstallWording): string =>
  [
    `Install “${wording.pattern}”`,
    wording.author ? ` by ${wording.author}` : "",
    wording.destination ? ` onto ${wording.destination}` : "",
  ].join("");

/**
 * CFPatternInstall - A button that installs one pattern onto one loom and
 * says so in its own words.
 *
 * A trusted surface pattern puts it where a tap must authorize an install,
 * the way `cf-submit-input` authorizes a create: the button's click is a real
 * (trusted) DOM gesture that reaches this host, where the pattern wires
 * `onClick` together with the surface's UI integrity (`data-ui-action` on the
 * host and `data-ui-pattern` / `data-ui-event-integrity` on an ancestor).
 *
 * What makes it trustworthy to show is that its words are its own. It renders
 * "Install “title” onto loom" from its inputs — the pattern's title (both
 * ends of its id when the title is missing or blank), optionally its author,
 * and the destination loom's name (left out when not given) — and takes no
 * free text for its button, so it always says it installs a named pattern
 * onto a named place. It does not know what its host's `onClick` does: the
 * trusted surface placing it is responsible for passing the title of the
 * pattern a tap installs and the name of the place it goes, taken from the
 * same source as the action (the pattern catalog's `GetItButton` takes the
 * title from the catalog's entry for the id it requests). Each name is
 * flattened to one
 * plain line (see {@link plainName}) and drawn in its own bounded chip, so it
 * cannot reorder, break or pass for the words around it.
 *
 * The button is a native `<button>`, so a person's Enter or Space on it is a
 * trusted click just as a pointer tap is. Only such a click on the enabled
 * button reaches the host's `onClick`. A listener the constructor adds on the
 * host, in the capture phase, sees every click on the element before the
 * host's own listeners do, including a click on the host's own box around the
 * button, and stops one that is scripted or synthetic (`isTrusted: false`),
 * that lands anywhere but the button, that comes while disabled, or that
 * repeats a tap still being handled. So one tap is one install request.
 *
 * @element cf-pattern-install
 *
 * @attr {string} pattern-id - The id of the pattern a tap installs; shown when
 *   it has no title
 * @attr {string} pattern-title - The pattern's title
 * @attr {string} author - Who published the pattern
 * @attr {string} destination-name - The name of the loom the pattern goes onto
 * @attr {boolean} disabled - Whether the button can be tapped
 */
export class CFPatternInstall extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        max-width: 100%;
      }

      button {
        max-width: 100%;
        font: inherit;
        font-family: var(--cf-theme-font-family, inherit);
        text-align: start;
        overflow-wrap: anywhere;
        cursor: pointer;
        padding: var(--cf-size-md-padding-v, 8px)
          var(--cf-size-md-padding-h, 12px);
        border: 1px solid transparent;
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        background: var(
          --cf-theme-color-primary,
          var(--cf-colors-primary-500, #4979fa)
        );
        color: var(--cf-theme-color-primary-foreground, #fff);
      }

      button:focus-visible {
        outline: 2px solid var(--cf-theme-color-accent, #fc856d);
        outline-offset: 2px;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .name {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        vertical-align: bottom;
        font-weight: 600;
        padding: 0 0.3em;
        border-radius: 0.25em;
        background: color-mix(in srgb, currentColor 18%, transparent);
      }
    `,
  ];

  static override properties = {
    patternId: { type: String, attribute: "pattern-id" },
    patternTitle: { type: String, attribute: "pattern-title" },
    author: { type: String },
    destinationName: { type: String, attribute: "destination-name" },
    disabled: { type: Boolean, reflect: true },
  };

  declare patternId: string;
  declare patternTitle: string;
  declare author: string;
  declare destinationName: string;
  declare disabled: boolean;

  /**
   * Whether a tap is being handled: set by a tap that reaches the host and
   * cleared once that click's dispatch is done, so a second tap in that window
   * does not reach the host as a second request.
   */
  private _installing = false;

  constructor() {
    super();
    this.patternId = "";
    this.patternTitle = "";
    this.author = "";
    this.destinationName = "";
    this.disabled = false;
    this.addEventListener("click", (event) => this._onClick(event), {
      capture: true,
    });
  }

  /** Whether a click's composed path runs through this element's button. */
  private _isButtonClick(event: Event): boolean {
    const button = this.shadowRoot?.querySelector("button");
    return button !== null && button !== undefined &&
      event.composedPath().includes(button);
  }

  /**
   * Sees every click on the element before the host's listeners do, and lets
   * through only a trusted click on the enabled button that is not a repeat of
   * one still being handled.
   */
  private _onClick(event: Event) {
    if (
      !event.isTrusted || this.disabled || this._installing ||
      !this._isButtonClick(event)
    ) {
      event.stopImmediatePropagation();
      return;
    }
    this._installing = true;
    // A timer runs after the click's dispatch, host listeners included, so the
    // flag covers exactly the tap being handled. The pattern's handler refuses
    // a second request while the first is open, and its answer disables the
    // button, so this guard need only cover the moment before that answer.
    setTimeout(() => {
      this._installing = false;
    }, 0);
  }

  override render() {
    const wording = installWording(this);
    const author = wording.author
      ? html`
        by <span class="name">${wording.author}</span>
      `
      : nothing;
    const destination = wording.destination
      ? html`
        onto <span class="name">${wording.destination}</span>
      `
      : nothing;
    return html`
      <button
        type="button"
        part="button"
        ?disabled="${this.disabled}"
        aria-label="${installSentence(wording)}"
      >
        Install “<span class="name">${wording
          .pattern}</span>”${author}${destination}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-pattern-install": CFPatternInstall;
  }
}
