/**
 * A watch: a subscription on one cell that outlives the view that opened it,
 * and the line each of its settled changes writes above the prompt.
 *
 * Two things live here and they are the same thing seen from either end. What
 * a watch *is* is a session object (decision 28,
 * `docs/plans/shuttle/README.md`) — armed by `watch`, listed by `watches`,
 * disarmed by `unwatch`, and unaffected by the lens that opened it closing.
 * What a watch *does* is turn each settled change into one line naming the
 * cell that changed. It says that the cell moved rather than what it moved
 * to: reading the value out is `get`'s, and watching it move is the lens's.
 *
 * Nothing here subscribes. The subscription is `sinkCellValue`
 * (`lib/piece.ts`), which is where the guard-plus-`idle()` settling lives, and
 * a watch is handed the cancel it hands back. So every case drives the whole
 * of this with no connection: a settle is a call, and what a change writes is
 * a value.
 */

import { fabricAwareEqual } from "@commonfabric/data-model";
import { unicodeWidth } from "@std/cli/unicode-width";

import type { Announce } from "./announce.ts";
import { oneLine } from "./listing.ts";
import { wrapped } from "./page.ts";
import { labelForPlace, type PiecePlace, referenceForPlace } from "./place.ts";
import type { RecordEntry } from "./record.ts";

/** The cell a watch is armed on. */
interface WatchTarget {
  /** Where the reference resolved, which is the cell itself. */
  readonly place: PiecePlace;

  /**
   * The piece's arguments cell rather than its result, which `#argument`
   * selects on the operand that armed the watch.
   */
  readonly input: boolean;
}

/**
 * A watch armed on one cell.
 *
 * It holds what the cell last settled at, so that what it reports is a change
 * rather than a settle. That value is this object's and not the sink's: the
 * sink fires once on registration with what the cell already holds, and that
 * first settle is the baseline rather than a change — a watch that reported it
 * would announce a change nobody made every time one was armed.
 */
export class ArmedWatch {
  #target: WatchTarget;
  #label: string;
  #report: Announce;
  #columns: () => number;
  #cancel: (() => void) | undefined;
  #disarmed = false;
  #settled = false;
  #value: unknown;

  /**
   * Constructs an instance watching `target`, writing its changes through
   * `report` and fitting each line to what `columns` says the screen is.
   *
   * The width is a function rather than a number for the reason every other
   * screen measurement in shuttle is one: a change arrives long after the line
   * that armed the watch, and the window may have been resized in between.
   */
  constructor(
    target: WatchTarget,
    report: Announce,
    columns: () => number,
  ) {
    this.#target = target;
    this.#label = labelForPlace(target.place, target.input);
    this.#report = report;
    this.#columns = columns;
  }

  /**
   * What names this watch to a reader: the cell it watches, written the short
   * way the prompt writes the place it stands at, and carrying the suffix
   * where the cell is the piece's arguments rather than its result.
   *
   * That suffix is what makes the name as fine-grained as the watch is. Two
   * watches on one piece's two cells are two watches, so a name that named
   * only the place would list them as one line twice, and every line either
   * wrote would open the same way.
   */
  get label(): string {
    return this.#label;
  }

  /**
   * What names this watch to shuttle: the complete reference of the cell it
   * watches, and which of the piece's two cells that is.
   *
   * It is the cell rather than the operand that armed the watch, so two
   * spellings of one cell are one watch and a second `watch` on either is
   * refused rather than doubling every line the first one writes.
   */
  get key(): string {
    return referenceForPlace(this.#target.place, this.#target.input);
  }

  /** Whether it is still armed. */
  get armed(): boolean {
    return !this.#disarmed;
  }

  /**
   * Takes `cancel` as what stops the subscription, and stops it at once where
   * the watch was disarmed while it was being armed.
   *
   * The two-step is what the subscription's own shape asks for: arming is a
   * read, so the cancel exists only once that read has come back, and a line
   * cancelled in between is a line whose watch must not go on firing.
   */
  holding(cancel: () => void): void {
    if (this.#disarmed) {
      cancel();
      return;
    }
    this.#cancel = cancel;
  }

  /**
   * Records that the cell settled at `value`, writing a line where that is a
   * change from what it last held.
   *
   * The first settle writes nothing and is the baseline. Every settle after it
   * is compared against the one before, so a settle the runtime made for
   * reasons of its own — a recomputation landing on the value already there —
   * writes nothing either. That is what makes this a report of a change rather
   * than a report of a settle, and it is the whole of what the line claims.
   *
   * The comparison is {@link fabricAwareEqual} rather than a structural one: a
   * `FabricSpecialObject` keeps its state in private fields and has no
   * enumerable own properties, so comparing by those reads two distinct
   * `FabricBytes` as equal and a cell whose bytes changed would report
   * nothing. What is compared is the whole value, the cell being what a watch
   * is armed on.
   */
  settled(value: unknown): void {
    if (this.#disarmed) return;
    const before = this.#value;
    const first = !this.#settled;
    this.#settled = true;
    this.#value = value;
    if (first || fabricAwareEqual(before, value)) return;
    this.#report(eventLine(this.#label, this.#columns()));
  }

  /**
   * Stops the subscription, after which nothing this watch is told is
   * reported.
   *
   * Disarming twice cancels once and is otherwise the same as disarming once,
   * so a watch disarmed by hand and then again by a run ending needs no test
   * in front of it.
   */
  disarm(): void {
    this.#disarmed = true;
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
  }
}

/**
 * The watches dimension of the ambient record, as `where` prints it
 * (`record.ts`): what each armed watch is armed on, and the word for none.
 *
 * It names them rather than counting them, because what a person asks `where`
 * is what this process is doing and a count says only how much of it. The
 * names are the same short form the prompt carries, so a watch reads the same
 * way here, in the `watches` listing, and on every line it writes.
 */
export function watchEntries(
  armed: readonly ArmedWatch[],
): readonly RecordEntry[] {
  return [{
    label: "watches",
    value: armed.length === 0
      ? "none"
      : armed.map((watch) => oneLine(watch.label)).join(", "),
  }];
}

/**
 * The line a watch called `label` writes when the cell it watches changed,
 * fitted to a terminal `columns` wide.
 *
 * It says that the cell changed and not what it changed to. What a reader is
 * owed above a prompt is that something moved and which cell moved, so that
 * they can go and look; reading the value out is `get`'s, and watching it as
 * it moves is what the lens is for.
 *
 * The label is fitted rather than the line allowed to wrap, because a line
 * written above a prompt that wrapped would push the prompt down a row each
 * time one arrived, and the transcript is append-only.
 */
export function eventLine(label: string, columns: number): string {
  const opening = "watch ";
  const closing = ": changed";
  const room = columns - unicodeWidth(opening) - unicodeWidth(closing);
  return `${opening}${fitted(oneLine(label), room)}${closing}`;
}

/**
 * Helper for {@link eventLine}, which is as much of `text` as `room` columns
 * hold, and nothing where they hold none.
 *
 * The cut is by display width and at a character boundary, which is
 * {@link wrapped}'s — the one traversal every width in shuttle is measured by,
 * so a double-width character costs this line what it costs a row.
 */
function fitted(text: string, room: number): string {
  return room <= 0 || text === "" ? "" : wrapped([text], room)[0] ?? "";
}
