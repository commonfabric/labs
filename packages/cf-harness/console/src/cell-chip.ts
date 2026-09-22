/**
 * The one way a cell is drawn.
 *
 * A cell shows up in an argument, in a flow node, in the handles a step holds —
 * and it has to look the same in each, or a reader cannot tell that two of them
 * are the same thing. So there is one element for it: the name it carries, and
 * on hover the handle, the address, the shape and the CFC atoms riding on it.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type {
  ConsoleCellLabelEntry,
  ConsoleCellLabels,
} from "../cell-labels.ts";

/** What a chip needs to know to draw a cell. */
export interface ConsoleCellFacts {
  token?: string;
  ref?: string;
  slug?: string;
  producedByStep?: number;

  /**
   * The atoms the sandbox's invocation context recorded on the arguments of
   * the call this sighting belongs to.
   */
  confidentiality?: readonly string[];

  /**
   * The integrity atoms that invocation context recorded on those arguments:
   * the prompt slot's influence.
   */
  integrity?: readonly string[];

  schema?: unknown;

  /** What the space stores for the cell itself, where the run read it. */
  labels?: ConsoleCellLabels;
}

/**
 * The label facts a chip draws, held apart.
 *
 * `onCall` and `onCallIntegrity` are what one call's invocation context
 * recorded, on its confidentiality and integrity axes; the rest is what the
 * space stores for the cell itself. They answer different questions — what a
 * sandbox saw crossing into a call, and what the cell is — so the card names
 * them apart and joins them into no single list.
 */
export interface ConsoleCellLabelView {
  onCall: readonly string[];

  /** The integrity atoms the call recorded, held apart from `onCall`. */
  onCallIntegrity: readonly string[];

  /** Every confidentiality atom the space holds at any path of the cell. */
  confidentiality: readonly string[];

  /** Every integrity atom the space holds at any path of the cell. */
  integrity: readonly string[];

  /**
   * Whether the space says a path of this cell was computed from what a
   * function read.
   *
   * This is the fact a confidentiality atom does not carry. A value's label
   * may be the join of the fields of the object it was reached through, so a
   * plain input reached through a labelled object holds an atom without having
   * been derived from anything confidential. A chip that read the atom as
   * taint reports that input as tainted; `derived`, and the provenance beside
   * it, is what separates a computed value from a carried one, and it is why
   * the two are separate chip states rather than degrees of one badge.
   */
  derived: boolean;

  /** The implementations the space names as producing the derived paths. */
  transformedBy: readonly string[];

  /** The paths the space labelled, so a card can read path by path. */
  paths: readonly ConsoleCellLabelEntry[];

  /** Whether this run's labels hold a record for this cell at all. */
  recorded: boolean;

  /**
   * The paths inside this cell nothing was read at, named. Each is a place
   * the reading declined to go — a link out of the space it opened, or a path
   * below the depth it descends to — so a path under one of them is unknown
   * while every other path of the cell was read.
   */
  unreadPaths: readonly (readonly string[])[];

  /**
   * Whether the reading of this cell stopped before it had finished. It says
   * less than a named unread path does: what was left was never enumerated,
   * so the entries are some of what the space holds and any path carrying no
   * entry is unknown rather than unlabelled.
   */
  unfinished: boolean;

  /**
   * Whether either of the two above holds. A card reads it as the licence to
   * say what the space holds: without it an empty entry list is the space
   * holding no label, and with it an empty entry list is a reading that did
   * not cover the cell.
   */
  partial: boolean;
}

/** The two facts, reduced to what the chip and its card draw. */
export const cellLabelView = (cell: ConsoleCellFacts): ConsoleCellLabelView => {
  const labels = cell.labels;
  const unreadPaths = labels?.unreadPaths ?? [];
  const unfinished = labels?.truncationReason !== undefined;
  return {
    onCall: cell.confidentiality ?? [],
    onCallIntegrity: cell.integrity ?? [],
    confidentiality: labels?.confidentiality ?? [],
    integrity: labels?.integrity ?? [],
    derived: labels?.derived ?? false,
    transformedBy: labels?.transformedBy ?? [],
    paths: labels?.entries ?? [],
    recorded: labels !== undefined,
    unreadPaths,
    unfinished,
    partial: unreadPaths.length > 0 || unfinished,
  };
};

/**
 * Whether the card may say the space holds no label for this cell.
 *
 * The one positive claim the card makes about the space, and the only state
 * entitled to make it: a reading that covered the whole of the cell and found
 * nothing. Every other state — a cell no reading recorded, one whose reading
 * stopped at a path, one whose reading ran out — knows less than that, and
 * saying it would turn what nobody established into what the space asserts.
 *
 * It is a conjunction, which is what makes it worth naming and pinning: a
 * later edit that drops one term widens the claim silently, and the card goes
 * on reading as though it had been established.
 */
export const spaceHoldsNoLabel = (view: ConsoleCellLabelView): boolean =>
  view.recorded && !view.partial &&
  view.confidentiality.length === 0 && view.integrity.length === 0;

/**
 * The classes the chip wears. `labelled` is an atom from either fact;
 * `derived` is the space saying the value was computed, which no count of
 * atoms establishes.
 */
export const cellChipClasses = (cell: ConsoleCellFacts): string => {
  const view = cellLabelView(cell);
  const labelled = view.onCall.length > 0 || view.onCallIntegrity.length > 0 ||
    view.confidentiality.length > 0 || view.integrity.length > 0;
  return ["cell", labelled ? "labelled" : "", view.derived ? "derived" : ""]
    .filter((name) => name !== "")
    .join(" ");
};

/**
 * What to call a cell. The name a person gave it wins, then the handle the
 * model held, then the address — most human-legible first, because that is
 * what makes two sightings of one cell recognisable as one cell.
 */
export const cellName = (cell: ConsoleCellFacts): string =>
  cell.slug ?? cell.token ?? cell.ref ?? "cell";

/** The shape a pattern declared, in as few characters as read as a shape. */
export const schemaSummary = (schema: unknown): string | undefined => {
  const record = isObjectOrArray(schema)
    ? schema as { type?: unknown; properties?: Record<string, unknown> }
    : undefined;
  if (record?.properties !== undefined) {
    const keys = Object.keys(record.properties);
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
  }
  return typeof record?.type === "string" ? record.type : undefined;
};

/** A path inside a cell, joined for showing; the cell itself names itself. */
const pathText = (path: readonly string[]): string =>
  path.length === 0 ? "(the cell)" : path.join("/");

/** Distinguishes one chip's card from another's, for `aria-describedby`. */
let cardSequence = 0;

export class ConsoleCell extends LitElement {
  static override properties = {
    cell: { attribute: false },
  };

  declare cell: ConsoleCellFacts | undefined;

  /**
   * The card's id, so the chip can name it as its description rather than
   * flattening the whole card into one label — a reader gets the handle, the
   * address and the atoms as the structure they are.
   */
  readonly #cardId = `cell-card-${++cardSequence}`;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /**
   * Places the card against the chip. It is fixed-position — an absolutely
   * placed one is clipped by whichever column is scrolling — so its
   * coordinates are the chip's own, in viewport space, nudged back inside the
   * window when the chip sits near an edge.
   */
  readonly #place = (): void => {
    const chip = this.querySelector(".cell") as HTMLElement | null;
    const card = this.querySelector(".cell-card") as HTMLElement | null;
    if (chip === null || card === null) {
      return;
    }
    const at = chip.getBoundingClientRect();
    // Width first, and before measuring. A maximum alone does not hold the
    // card inside a narrow window: CSS resolves a minimum over a maximum, so
    // the stylesheet's minimum has to come down with it.
    const available = Math.max(0, globalThis.innerWidth - 16);
    card.style.minWidth = "";
    const floor = parseFloat(globalThis.getComputedStyle(card).minWidth) || 0;
    card.style.maxWidth = `${available}px`;
    if (floor > available) {
      card.style.minWidth = `${available}px`;
    }
    card.style.left = "0";
    card.style.top = "0";
    const size = card.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(at.left, globalThis.innerWidth - size.width - 8),
    );
    const below = at.bottom + 6;
    const top = below + size.height > globalThis.innerHeight
      ? Math.max(8, at.top - size.height - 6)
      : below;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };

  /**
   * Follows the chip while the card is up. The card is fixed-position so a
   * scrolling column cannot clip it, which also means a column scrolling under
   * it leaves it behind — so it is placed again on any scroll, captured
   * because the column scrolls rather than the window.
   */
  readonly #follow = (): void => {
    if (this.#showing) {
      this.#place();
    }
  };

  #showing = false;

  /**
   * Whether the pointer is over the chip. Hover and focus each keep the card up
   * on their own — `:hover, :focus-within` is an or — so tracking stops only
   * when neither is left. Closing on `mouseleave` alone strands a card the
   * keyboard is still holding open.
   */
  #hovered = false;

  /** Whether focus is inside the chip, which holds the card up the same way. */
  #focused = false;

  #open(by: "hover" | "focus"): void {
    if (by === "hover") {
      this.#hovered = true;
    } else {
      this.#focused = true;
    }
    if (!this.#showing) {
      this.#showing = true;
      globalThis.addEventListener("scroll", this.#follow, true);
      globalThis.addEventListener("resize", this.#follow);
    }
    this.#place();
  }

  #close(by?: "hover" | "focus"): void {
    if (by === "hover") {
      this.#hovered = false;
    } else if (by === "focus") {
      this.#focused = false;
    } else {
      this.#hovered = false;
      this.#focused = false;
    }
    if (this.#hovered || this.#focused) {
      return;
    }
    this.#showing = false;
    globalThis.removeEventListener("scroll", this.#follow, true);
    globalThis.removeEventListener("resize", this.#follow);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#close();
  }

  /**
   * The labels, as the two facts they are: what the invocation context of one
   * call recorded, and what the space holds for the cell. The second reads
   * path by path, because a cell labelled at one field and not at another is
   * two different things to a reader and one blurred thing to a badge.
   *
   * Only a cell read whole says what the space holds. A reading that covered
   * part of the cell says no label was read for it — the same words as a cell
   * the run's labels name nowhere, because it is the same claim — and the
   * `reading` row beneath says which part it missed and what a path with no
   * entry means under it.
   */
  #labels(view: ConsoleCellLabelView): TemplateResult {
    return html`
      <span class="cell-row">
        <span class="cell-label">cfc</span>
        <span class="label-atoms" title="atoms recorded on this call">
          ${view.onCall.length === 0 && view.onCallIntegrity.length === 0
            ? html`<span class="cell-none">no atom on this call</span>`
            : html`
              ${view.onCall.map((name) =>
                html`<span class="atom conf">${name}</span>`
              )}
              ${view.onCallIntegrity.map((name) =>
                html`<span class="atom integ">${name}</span>`
              )}
            `}
        </span>
      </span>
      <span class="cell-row">
        <span class="cell-label">space</span>
        <span class="label-atoms" title="what the space holds for this cell">
          ${!view.recorded
            ? html`<span class="cell-none">
              no label read for this cell; the map heads with what this run read
            </span>`
            : spaceHoldsNoLabel(view)
            ? html`<span class="cell-none">
              the space holds no label for this cell
            </span>`
            : view.confidentiality.length === 0 && view.integrity.length === 0
            ? html`<span class="cell-none">no label read for this cell</span>`
            : html`
              ${view.confidentiality.map((name) =>
                html`<span class="atom conf">${name}</span>`
              )}
              ${view.integrity.map((name) =>
                html`<span class="atom integ">${name}</span>`
              )}
            `}
        </span>
      </span>
      <!--
        A partial reading is stated whether or not the cell carries atoms, and
        the cell that carries them is the one that needs it most: atoms read as
        an answer, so a reader who sees them stops asking. A cell showing
        nothing at least invites the question of why; a cell showing something
        invites none, and the labels it shows are some of what the space holds
        rather than all of it.
      -->
      ${!view.partial ? nothing : html`
        <span class="cell-row">
          <span class="cell-label">reading</span>
          <span class="cell-reading">
            ${view.unreadPaths.length === 0 ? nothing : html`
              <span>
                read but for ${view.unreadPaths.map(pathText).join(", ")} —
                a path under one of those is unknown, and every other one was
                read
              </span>
            `}
            ${!view.unfinished ? nothing : html`
              <span>
                did not finish — these are some of the labels the space holds,
                and a path with no entry is unknown
              </span>
            `}
          </span>
        </span>
      `}
      ${view.paths.length === 0 ? nothing : html`
        <span class="cell-row">
          <span class="cell-label">derived</span>
          ${view.derived
            ? html`<span class="cell-derived">
              computed from what a function read
            </span>`
            : html`<span class="cell-none">
              carried, not computed from a read
            </span>`}
        </span>
      `}
      ${view.transformedBy.length === 0 ? nothing : html`
        <span class="cell-row">
          <span class="cell-label">transformed by</span>
          <span class="cell-mono cell-wrap">
            ${view.transformedBy.join(", ")}
          </span>
        </span>
      `}
      ${view.paths.length === 0 ? nothing : html`
        <span class="cell-row">
          <span class="cell-label">paths</span>
          <span class="cell-paths">
            ${view.paths.map((entry) =>
              html`
                <span class="cell-path">
                  <span class="label-path">${pathText(entry.path)}</span>
                  ${entry.origin === undefined
                    ? nothing
                    : html`<span class="path-origin">${entry.origin}</span>`}
                  <span class="label-atoms">
                    ${entry.confidentiality.map((name) =>
                      html`<span class="atom conf">${name}</span>`
                    )}
                    ${entry.integrity.map((name) =>
                      html`<span class="atom integ">${name}</span>`
                    )}
                  </span>
                </span>
              `
            )}
          </span>
        </span>
      `}
    `;
  }

  protected override render(): TemplateResult | typeof nothing {
    const cell = this.cell;
    if (cell === undefined) {
      return nothing;
    }
    const shape = schemaSummary(cell.schema);
    const view = cellLabelView(cell);
    return html`
      <span
        class=${cellChipClasses(cell)}
        tabindex="0"
        aria-describedby=${this.#cardId}
        @mouseenter=${() => this.#open("hover")}
        @mouseleave=${() => this.#close("hover")}
        @focusin=${() => this.#open("focus")}
        @focusout=${() => this.#close("focus")}
      >
        <span class="cell-dot"></span>
        <span class="cell-name">${cellName(cell)}</span>
        ${view.onCall.length + view.onCallIntegrity.length === 0
          ? nothing
          : html`<span class="cell-atoms">${
            view.onCall.length +
            view.onCallIntegrity.length
          }</span>`}
        <span class="cell-card" id=${this.#cardId} role="tooltip">
          ${cell.slug === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">name</span>
              <span>${cell.slug}</span>
            </span>
          `}
          ${cell.token === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">handle</span>
              <span class="cell-mono">${cell.token}</span>
            </span>
          `}
          ${cell.ref === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">address</span>
              <span class="cell-mono cell-wrap">${cell.ref}</span>
            </span>
          `}
          ${shape === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">shape</span>
              <span class="cell-mono">${shape}</span>
            </span>
          `}
          ${this.#labels(view)}
          ${cell.producedByStep === undefined ? nothing : html`
            <span class="cell-row">
              <span class="cell-label">from</span>
              <span>step ${cell.producedByStep}</span>
            </span>
          `}
        </span>
      </span>
    `;
  }
}

customElements.define("console-cell", ConsoleCell);
