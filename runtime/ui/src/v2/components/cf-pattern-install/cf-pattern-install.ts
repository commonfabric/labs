import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-button/cf-button.ts";

/** The longest a shown name runs before it is cut short with an ellipsis. */
const MAX_NAME_LENGTH = 60;

/** How much of a pattern id is shown when the pattern has no title. */
const SHOWN_ID_LENGTH = 12;

/**
 * Returns `text` as one line a person can read: control and formatting
 * characters (bidirectional overrides, zero-width joiners, line breaks)
 * removed, runs of whitespace collapsed, and anything past
 * {@link MAX_NAME_LENGTH} cut short with an ellipsis. A name is written by
 * whoever published the pattern or named the loom, so it must not be able to
 * reorder, hide or break the words around it.
 */
export const plainName = (text: string | undefined): string => {
  const flat = (text ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  return chars.length > MAX_NAME_LENGTH
    ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join("").trimEnd()}…`
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
  const id = plainName(inputs.patternId);
  const shownId = id.length > SHOWN_ID_LENGTH
    ? `${id.slice(0, SHOWN_ID_LENGTH)}…`
    : id;
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
 * (trusted) DOM gesture that bubbles to this host, where the pattern wires
 * `onClick` together with the surface's UI integrity (`data-ui-action` on the
 * host and `data-ui-pattern` / `data-ui-event-integrity` on an ancestor).
 *
 * What makes it trustworthy to show is that its words are its own. It renders
 * "Install “title” onto loom" from its inputs — the pattern's title (its id
 * when it has none), optionally its author, and the destination loom's name
 * (left out when not given) — and takes no free text for its button. A pattern
 * placing it can choose which pattern and which loom it names, but not make it
 * say something other than what a tap does. Each name is flattened to one
 * plain line (see {@link plainName}) so it cannot reorder or break the
 * surrounding words.
 *
 * Only a trusted click on the button reaches the host. A scripted `click()` or
 * a synthetic event is `isTrusted: false`; it is stopped at the shadow boundary
 * here, and would carry no UI integrity even if it were not. Clicks while
 * disabled, clicks on the space around the button, and a second click before
 * the first has been handled are stopped too, so one tap is one install
 * request.
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

      cf-button {
        max-width: 100%;
      }

      .sentence {
        white-space: normal;
        overflow-wrap: anywhere;
        text-align: start;
      }

      .name {
        font-weight: 600;
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
  }

  /** Whether a click's composed path runs through the button. */
  private _isButtonClick(event: Event): boolean {
    return event.composedPath().some((node) =>
      (node as Element | undefined)?.tagName === "CF-BUTTON"
    );
  }

  /**
   * Handles every click inside the component, and lets through to the host
   * only a trusted click on the enabled button that is not a repeat of one
   * still being handled.
   */
  private _onClick(event: Event) {
    if (
      !event.isTrusted || this.disabled || this._installing ||
      !this._isButtonClick(event)
    ) {
      event.stopPropagation();
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
      <div @click="${this._onClick}">
        <cf-button
          type="button"
          ?disabled="${this.disabled}"
          aria-label="${installSentence(wording)}"
          part="button"
        >
          <span
            class="sentence">Install “<span class="name">${wording
              .pattern}</span>”${author}${destination}</span>
        </cf-button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-pattern-install": CFPatternInstall;
  }
}
