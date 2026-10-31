import { internSchema } from "@commonfabric/data-model-schema";
import {
  type CellHandle,
  type CellRef,
  isCellHandle,
} from "@commonfabric/runtime-client";
import { css, html, nothing, PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { BaseElement } from "../../core/base-element.ts";
import {
  createArrayCellController,
  sameCellDoc,
} from "../../core/cell-controller.ts";

/**
 * One ranked suggestion, as a row of the list bound to `items` holds it. A row
 * is flat: references are links or null, and lists are JSON strings.
 */
export type SuggestionCard = {
  /** Stable identity of the suggestion. */
  id: string;
  /** Revision of the card, which a host re-checks before acting on a take. */
  card_revision?: string;
  title?: string;
  body?: string;
  /** Who suggested the card. */
  source?: string;
  /** Where the card is drawn inline, or null when it is drawn on no thing. */
  anchor?: CellHandle | null;
  /** The thing taking the card acts on. */
  act_target?: CellHandle | null;
  /** A JSON array of links to what the card is about, most important first. */
  about?: string;
  /** A JSON array of the card's tags. */
  tags?: string;
};

/** Detail of `cf-suggestion-take` and `cf-suggestion-seen`. */
export type SuggestionEventDetail = {
  id: string;
  card_revision?: string;
  /**
   * The card: the link to its row that the bound list holds, or the row
   * itself when `items` is a plain array.
   */
  card: CellHandle<SuggestionCard> | SuggestionCard;
};

/** A drawn card, with its position in the bound list. */
type DrawnCard = { card: SuggestionCard; index: number };

/** A reference a row holds, read as a cell, or null. */
const rowReferenceSchema = {
  anyOf: [{ type: "null" }, { type: "unknown", asCell: ["cell"] }],
} as const;

/** Reads each row's fields, with its references as cells. */
const suggestionRowsSchema = internSchema({
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      card_revision: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      source: { type: "string" },
      anchor: rowReferenceSchema,
      act_target: rowReferenceSchema,
      about: { type: "string" },
      tags: { type: "string" },
    },
  },
  default: [],
});

/** Reads each entry of the list as the link to its row. */
const suggestionRowLinksSchema = internSchema({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
});

/** Share of a card that must be on screen for it to count as shown. */
const VISIBLE_RATIO = 0.5;

/**
 * Minimum interval, in milliseconds, between visibility reports for one card.
 * 100 is the least the browser accepts when it tracks occlusion.
 */
const VISIBILITY_DELAY_MS = 100;

/**
 * How long, in milliseconds, a card must have been shown unobscured, as it is
 * drawn now, before a click on it takes it. A click already on its way when a
 * card appears, moves, or changes lands too soon to count.
 */
const MINIMUM_SHOWN_MS = 500;

/**
 * CFSuggestions - Draws the suggestion cards anchored at one thing
 *
 * Of the ranked cards in `items`, draws only those whose anchor is the cell
 * `about` names, in rank order and at a fixed size. A card's anchor is its
 * `anchor`; a card whose `anchor` is null is drawn on no thing. A card with no
 * `anchor` field, which has not been through intake, is anchored at the first
 * link of its `about`, else at its `act_target`. Anchors compare by the cell
 * each names, without following a cell that holds a link. With `tags` set,
 * only cards carrying at least one of those tags are drawn. A card without a
 * string `id` is not drawn, since neither event could say which card it means.
 *
 * The component performs no act. It announces a take and a showing, and the
 * host binds those events to whatever they should do. Both are custom events
 * the component dispatches, so a handler receives no gesture provenance with
 * them: the gate below decides whether one is dispatched at all.
 *
 * A card counts as shown while at least half of it is on screen. A take
 * counts only when it is a trusted click on a card's own take button while the
 * card is shown and, where the browser tracks occlusion, nothing is drawn over
 * it and no opacity, transform, or filter applies to it. A script's `click()`,
 * a dispatched event, and a click through an overlay that hides or disguises
 * the card are all refused. The browser reports visibility asynchronously, so
 * a card cannot be taken until it has been reported, and then only once it has
 * stayed takeable for half a second. A card drawn in other words or in another
 * place starts over, so a click aimed at one card cannot land on another
 * appearing, moved, or rewritten under it. Where the browser does not track
 * occlusion, being shown is enough.
 *
 * @element cf-suggestions
 *
 * @property {CellHandle<SuggestionCard[]> | SuggestionCard[]} items - The
 *   ranked cards, best first
 * @property {CellHandle} about - The thing whose cards to draw
 * @property {string[]} tags - Narrows the cards drawn to those carrying one
 *
 * @fires cf-suggestion-take - The person took a card:
 *   `{ id, card_revision, card }`
 * @fires cf-suggestion-seen - A card was first shown, once per card for the
 *   life of the element: `{ id, card_revision, card }`
 *
 * @example
 * <cf-suggestions .items=${ranked} .about=${piece}></cf-suggestions>
 */
export class CFSuggestions extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      :host([empty]) {
        display: none;
      }

      .cards {
        display: flex;
        flex-wrap: wrap;
        gap: var(--cf-suggestions-gap, var(--cf-spacing-2, 0.5rem));
      }

      .card {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: var(--cf-suggestions-card-width, 16rem);
        height: var(--cf-suggestions-card-height, 7rem);
        min-width: 10rem;
        min-height: 5rem;
        padding: var(--cf-spacing-3, 0.75rem);
        overflow: hidden;
        border: 1px solid var(--cf-theme-color-border, #e5e5e7);
        border-radius: var(--cf-theme-border-radius, 0.5rem);
        background: var(--cf-theme-color-surface, #ffffff);
        color: var(--cf-theme-color-text, #111827);
      }

      .title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .body {
        flex: 1;
        overflow: hidden;
        color: var(--cf-theme-color-text-secondary, #6b7280);
        font-size: 0.875rem;
      }

      /* The take button keeps its own type and colors, so a page cannot
        restyle it into something else. */
      .take {
        all: initial;
        align-self: flex-end;
        box-sizing: border-box;
        padding: 0.25rem 0.75rem;
        border: 1px solid #1f2937;
        border-radius: 0.375rem;
        background: #1f2937;
        color: #ffffff;
        font: 600 0.875rem/1.25 system-ui, sans-serif;
        cursor: pointer;
      }

      .take:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 2px;
      }
    `,
  ];

  @property({ attribute: false })
  accessor items: CellHandle<SuggestionCard[]> | SuggestionCard[] | undefined =
    undefined;

  @property({ attribute: false })
  accessor about: CellHandle | undefined = undefined;

  @property({ attribute: false })
  accessor tags: readonly string[] | undefined = undefined;

  #rows = createArrayCellController<SuggestionCard>(this, {
    timing: { strategy: "immediate" },
  });

  /** The same list, read as the link to each row, index for index. */
  #rowLinks = createArrayCellController<CellHandle<SuggestionCard>>(this, {
    timing: { strategy: "immediate" },
  });

  #observer: IntersectionObserver | undefined = undefined;

  /** The card each observed element draws, and how it drew it, by element. */
  #observed = new Map<
    Element,
    { id: string; look: string; since: DOMHighResTimeStamp }
  >();

  /** The cards the browser last reported shown. */
  #shown = new Set<string>();

  /** The cards the browser last reported shown and unobscured. */
  #takeable = new Map<string, DOMHighResTimeStamp>();

  #minimumShownMs = MINIMUM_SHOWN_MS;

  /** Waiting on the browser's next visibility report, for a test. */
  #reportWaiters: (() => void)[] = [];

  /** The cards already announced as seen. */
  #seen = new Set<string>();

  /**
   * Hands a test the drawn cards, the take handler, whether a card is takeable
   * once shown long enough, how long that is, and the browser's next
   * visibility report.
   */
  get accessForTestingOnly(): {
    readonly drawn: readonly SuggestionCard[];
    take(event: Event): void;
    isTakeable(id: string): boolean;
    nextReport(): Promise<void>;
    minimumShownMs: number;
  } {
    // deno-lint-ignore no-this-alias
    const component = this;
    return {
      get drawn() {
        return component.#drawn().map(({ card }) => card);
      },
      take: (event) => this.#take(event),
      isTakeable: (id) => this.#takeable.has(id),
      nextReport: () =>
        new Promise<void>((resolve) => this.#reportWaiters.push(resolve)),
      get minimumShownMs() {
        return component.#minimumShownMs;
      },
      set minimumShownMs(value) {
        component.#minimumShownMs = value;
      },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // A first connect observes the cards once they have rendered.
    if (this.hasUpdated) this.#observeCards();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#observed.clear();
    this.#shown.clear();
    this.#takeable.clear();
  }

  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("items")) {
      const items = this.items;
      if (isCellHandle(items)) {
        this.#rows.bind(items.asSchema(suggestionRowsSchema));
        this.#rowLinks.bind(items.asSchema(suggestionRowLinksSchema));
      } else {
        this.#rows.bind(items ?? []);
        this.#rowLinks.bind([]);
      }
    }
  }

  override updated(changed: PropertyValues): void {
    super.updated(changed);
    this.#observeCards();
  }

  override render() {
    const drawn = this.#drawn();
    // A slot with no cards takes no room where it sits inline.
    this.toggleAttribute("empty", drawn.length === 0);
    if (drawn.length === 0) return nothing;
    return html`
      <div class="cards" role="list">
        ${repeat(
          drawn,
          ({ card }) => card.id,
          ({ card }) =>
            html`
              <div class="card" role="listitem" data-card-id=${card.id}>
                <div class="title">${card.title ?? ""}</div>
                <div class="body">${card.body ?? ""}</div>
                <button
                  class="take"
                  type="button"
                  data-card-id=${card.id}
                  aria-label=${card.title ? `Take: ${card.title}` : "Take"}
                  @click=${this.#take}
                >
                  Take
                </button>
              </div>
            `,
        )}
      </div>
    `;
  }

  /** The cards anchored at `about` and carrying `tags`, in rank order. */
  #drawn(): DrawnCard[] {
    const about = this.about;
    if (!isCellHandle(about)) return [];
    const tags = this.tags;
    const drawn: DrawnCard[] = [];
    const ids = new Set<string>();
    const listSpace = isCellHandle(this.items) ? this.items.space() : undefined;
    const cards = this.#rows.getValue() ?? [];
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      if (typeof card?.id !== "string" || ids.has(card.id)) continue;
      if (!isAnchoredAt(card, about, listSpace)) continue;
      if (tags !== undefined) {
        const carried = parseJsonArray(card.tags);
        if (!tags.some((tag) => carried.includes(tag))) continue;
      }
      ids.add(card.id);
      drawn.push({ card, index });
    }
    return drawn;
  }

  /** The detail of an event about `drawn`. */
  #detail({ card, index }: DrawnCard): SuggestionEventDetail {
    const link = this.#rowLinks.getValue()?.[index];
    return {
      id: card.id,
      ...(card.card_revision !== undefined &&
        { card_revision: card.card_revision }),
      card: isCellHandle(link) ? link : card,
    };
  }

  /** Announces a take, when it is a trusted click on a visible card. */
  #take = (event: Event): void => {
    const button = event.currentTarget;
    if (
      typeof MouseEvent === "undefined" || !(event instanceof MouseEvent) ||
      !event.isTrusted || !(button instanceof HTMLElement) ||
      button.getRootNode() !== this.shadowRoot
    ) {
      return;
    }
    const id = button.dataset.cardId;
    const since = id === undefined ? undefined : this.#takeable.get(id);
    if (since === undefined || event.timeStamp - since < this.#minimumShownMs) {
      return;
    }
    const drawn = this.#drawn().find(({ card }) => card.id === id);
    if (!drawn) return;
    this.emit<SuggestionEventDetail>("cf-suggestion-take", this.#detail(drawn));
  };

  /**
   * Observes the cards drawn now, and forgets the ones no longer drawn. A card
   * drawn differently from when the browser last reported on it, in other
   * words or in another place, cannot be taken until the browser reports on it
   * again, so a click aimed at one card cannot land on another moved or
   * rewritten under it.
   */
  #observeCards(): void {
    const observer = this.#observer ??= this.#createObserver();
    if (!observer) return;
    const drawn = this.#drawn();
    const cards = new Map<Element, { id: string; look: string }>();
    const now = performance.now();
    for (
      const element of this.shadowRoot?.querySelectorAll<HTMLElement>(
        ".card",
      ) ?? []
    ) {
      const id = element.dataset.cardId;
      const position = drawn.findIndex(({ card }) => card.id === id);
      if (id === undefined || position < 0) continue;
      cards.set(element, { id, look: lookOf(drawn[position].card, position) });
    }
    for (const [element, { id, look }] of this.#observed) {
      if (cards.get(element)?.look === look) continue;
      observer.unobserve(element);
      this.#observed.delete(element);
      this.#shown.delete(id);
      this.#takeable.delete(id);
    }
    for (const [element, card] of cards) {
      if (this.#observed.has(element)) continue;
      this.#observed.set(element, { ...card, since: now });
      observer.observe(element);
    }
  }

  /** Builds the visibility observer, or none where the browser has none. */
  #createObserver(): IntersectionObserver | undefined {
    if (typeof IntersectionObserver === "undefined") return undefined;
    // `trackVisibility` and `delay` are not in every lib's
    // `IntersectionObserverInit`; a browser that does not know them ignores
    // them and leaves `isVisible` unset.
    const options = {
      threshold: VISIBLE_RATIO,
      trackVisibility: true,
      delay: VISIBILITY_DELAY_MS,
    } as IntersectionObserverInit;
    return new IntersectionObserver(
      (entries) => this.#onVisibility(entries),
      options,
    );
  }

  /** Records which cards are shown and takeable, and announces each first showing. */
  #onVisibility(entries: readonly IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const observed = this.#observed.get(entry.target);
      // A report the browser queued before this element was last observed
      // describes the card as it was drawn then.
      if (observed === undefined || entry.time < observed.since) continue;
      const { id } = observed;
      if (!isShownEntry(entry)) {
        this.#shown.delete(id);
        this.#takeable.delete(id);
        continue;
      }
      this.#shown.add(id);
      if (isUnobscuredEntry(entry)) {
        // The card has been takeable since its first unobscured report.
        if (!this.#takeable.has(id)) this.#takeable.set(id, entry.time);
      } else {
        this.#takeable.delete(id);
      }
      if (this.#seen.has(id)) continue;
      const drawn = this.#drawn().find(({ card }) => card.id === id);
      if (!drawn) continue;
      this.#seen.add(id);
      this.emit<SuggestionEventDetail>(
        "cf-suggestion-seen",
        this.#detail(drawn),
      );
    }
    for (const resolve of this.#reportWaiters.splice(0)) resolve();
  }
}

/**
 * Whether `card` is anchored at `about`: by its `anchor` when it has the field,
 * else by the first link of its `about`, else by its `act_target`. A link in
 * `about` with no space of its own is in the list's space, `listSpace`.
 */
function isAnchoredAt(
  card: SuggestionCard,
  about: CellHandle,
  listSpace: string | undefined,
): boolean {
  if (card.anchor !== undefined) {
    return isCellHandle(card.anchor) && sameCell(card.anchor.ref(), about);
  }
  const first = linkPayload(parseJsonArray(card.about)[0]);
  if (first) {
    const { id, space = listSpace, scope, path = [] } = first;
    return id !== undefined && space !== undefined &&
      sameCell(
        { id, space, scope, path } as Parameters<typeof sameCell>[0],
        about,
      );
  }
  return isCellHandle(card.act_target) &&
    sameCell(card.act_target.ref(), about);
}

/** The addressing fields of a sigil link, or undefined for anything else. */
function linkPayload(value: unknown):
  | { id?: string; space?: string; scope?: string; path?: string[] }
  | undefined {
  if (!isRecord(value)) return undefined;
  const envelope = value["/"];
  if (!isRecord(envelope)) return undefined;
  const payload = envelope["link@1"];
  if (!isRecord(payload)) return undefined;
  const { id, space, scope, path } = payload;
  if (id !== undefined && typeof id !== "string") return undefined;
  if (space !== undefined && typeof space !== "string") return undefined;
  if (scope !== undefined && typeof scope !== "string") return undefined;
  if (
    path !== undefined &&
    !(Array.isArray(path) && path.every((key) => typeof key === "string"))
  ) {
    return undefined;
  }
  return { id, space, scope, path };
}

/** The array a JSON string holds, or an empty one for anything else. */
function parseJsonArray(text: string | undefined): unknown[] {
  if (typeof text !== "string") return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a person looking at the card drawn at `position` would see, and what
 * taking it would act on.
 */
function lookOf(card: SuggestionCard, position: number): string {
  const target = card.act_target;
  return JSON.stringify([
    position,
    card.card_revision ?? null,
    card.title ?? null,
    card.body ?? null,
    isCellHandle(target) ? target.ref() : null,
  ]);
}

/** Whether `x` names the cell `b` does: space, entity, scope, and path. */
function sameCell(
  x: Pick<CellRef, "id" | "space" | "path"> & { scope?: string },
  b: CellHandle,
): boolean {
  const y = b.ref();
  // A link that names no scope is in the space scope.
  return sameCellDoc(
    { ...x, scope: x.scope ?? "space" } as CellRef,
    { ...y, scope: y.scope ?? "space" },
  );
}

/** Whether the browser reports enough of the entry's card on screen. */
function isShownEntry(entry: IntersectionObserverEntry): boolean {
  return entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
}

/**
 * Whether the browser reports nothing covering, fading, or transforming the
 * entry's card. A browser that does not track occlusion reports nothing, which
 * counts as unobscured.
 */
function isUnobscuredEntry(entry: IntersectionObserverEntry): boolean {
  const { isVisible } = entry as IntersectionObserverEntry & {
    isVisible?: boolean;
  };
  return isVisible !== false;
}
