/**
 * Which suggestion cards `cf-suggestions` draws, and how it reads what the
 * browser reports about each one. Kept apart from the element so that plain
 * Deno tests reach it.
 */

import {
  type CellHandle,
  type CellRef,
  isCellHandle,
} from "@commonfabric/runtime-client";

import { sameCellDoc } from "../../core/cell-controller.ts";

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

/** A drawn card, with its position in the bound list. */
export type DrawnCard = { card: SuggestionCard; index: number };

/** Share of a card that must be on screen for it to count as shown. */
export const VISIBLE_RATIO = 0.5;

/**
 * The cards of `cards` to draw at `about`, in rank order, each with its
 * position in the list. A card is drawn when it has a string id not already
 * drawn, is anchored at `about`, and, when `tags` is given, carries one of
 * them. `listSpace` is the space of the list the cards came from.
 */
export function drawnCards(
  cards: readonly SuggestionCard[],
  about: unknown,
  tags: readonly string[] | undefined,
  listSpace: string | undefined,
): DrawnCard[] {
  if (!isCellHandle(about)) return [];
  const drawn: DrawnCard[] = [];
  const ids = new Set<string>();
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
export function lookOf(card: SuggestionCard, position: number): string {
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
export function isShownEntry(entry: IntersectionObserverEntry): boolean {
  return entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
}

/**
 * Whether the browser reports nothing covering, fading, or transforming the
 * entry's card. A browser that does not track occlusion reports nothing, which
 * counts as unobscured.
 */
export function isUnobscuredEntry(entry: IntersectionObserverEntry): boolean {
  const { isVisible } = entry as IntersectionObserverEntry & {
    isVisible?: boolean;
  };
  return isVisible !== false;
}
