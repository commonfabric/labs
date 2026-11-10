/**
 * The principal a value's own cell represents, and whom a value represents,
 * as a host reads them through the cell handles a render binds:
 * `observeWrittenPrincipal()`, which watches a cell and the cell a write to it
 * lands in, with its label, and reports the value with the principal its own
 * cell represents, by the rule `cfc/written-principal.ts` in the runner
 * states; and `observeRepresentedPrincipal()`, which reports the principal a
 * value's label names, as a profile's owner is read. `cf-profile-badge`
 * decides a profile's face from the first, and a host that draws no Lit
 * component, such as one that shows a profile's face, composes the two.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  isWrittenProfileName,
  ownerPrincipalFromLabel,
  soleRepresentedPrincipal,
} from "@commonfabric/runner/cfc/represents-principal";
import { addressKey, type JSONSchema } from "@commonfabric/runner/shared";
import { isOwnValueCell } from "@commonfabric/runner/cfc/written-principal";

import type { CellHandle } from "./cell-handle.ts";

/**
 * The part of a value whose label `observeRepresentedPrincipal()` reads: its
 * `name`, which says which of the label's claims count.
 */
const NAME_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

/**
 * Watches `cell` and reports to `onPrincipal` the one principal its label
 * names as the one its value represents, read as `cf-profile-badge` reads the
 * principal its seal shows (`ownerPrincipalFromLabel()`), until the returned
 * function is called: for a profile, whose profile it is. A value holding a
 * written `name` is read by the claims on its root and its `name`, and any
 * other by every claim its label holds. `undefined` when the label names no
 * single principal, for a cell the worker refuses, and while the label the
 * handle holds is not the one the worker read with its value, as after a
 * write through the handle.
 */
export const observeRepresentedPrincipal = (
  cell: CellHandle<unknown>,
  onPrincipal: (principal: string | undefined) => void,
): () => void =>
  cell.asSchema<{ name?: string }>(NAME_SCHEMA).subscribe(
    (value, label, delivery) =>
      onPrincipal(
        delivery?.cfcLabelCurrent === true
          ? ownerPrincipalFromLabel(
            label,
            isWrittenProfileName(
              isObjectNotArray(value) ? value.name : undefined,
            ),
          )
          : undefined,
      ),
    { includeCfcLabel: true, onRefused: () => onPrincipal(undefined) },
  );

/** What `observeWrittenPrincipal()` reports each time it decides. */
export type WrittenValue<T> = {
  /** The value, when it is the whole of the cell a write to it lands in. */
  readonly value: T | undefined;
  /** The principal the value's own cell represents, if its label names one. */
  readonly principal: string | undefined;
};

/**
 * Watches `cell` and reports to `onWritten` its value and the principal its
 * own cell represents, until the returned function is called:
 * principal the label of the cell a write to `cell` lands in names, when the
 * value is the whole of that cell and no link stored there leads elsewhere.
 * When it is not, it reports neither value nor principal.
 *
 * Each time `cell` delivers the label the worker read with its value, the
 * cell is resolved again, both to where a write to it lands and to where its
 * links lead, in one read, so that a relinked cell is watched where it then
 * resolves. A
 * resolve that a later one overtakes is dropped, and one that fails reports
 * nothing until a later one succeeds. Nothing is reported until the cell
 * resolves to one that holds no value of its own, or the cell holding the
 * value has delivered the label the worker read with it and a resolve begun
 * after that delivery has found the same cell. The value and the label are
 * read together, in one delivery. A cell the worker refuses carries no
 * attestation, so it reports neither, and so does a cell holding a value
 * whose label the worker has not yet read, as after a write through its
 * handle, until the worker delivers the label again.
 */
export const observeWrittenPrincipal = <T>(
  cell: CellHandle<T>,
  onWritten: (written: WrittenValue<T>) => void,
): () => void => {
  const observation = new WrittenPrincipalObservation(cell, onWritten);
  observation.start();
  return () => observation.cancel();
};

/**
 * A watch on the cell holding a value: which resolve set it up, which
 * document it is, as its `addressKey()`, or `""` when the value is not the
 * whole of its own cell, what it last delivered, and how to end it. It is
 * `confirmed` once a resolve begun after its first current delivery found the
 * same cell again, so that a cell that had not loaded when it was first
 * resolved, and so could not yet show a link stored in it, is not taken for
 * the value's own cell on that alone.
 */
type ValueWatch<T> = {
  sequence: number;
  readonly cell: string;
  written: WrittenValue<T>;
  delivered: boolean;
  confirmed: boolean;
  unsubscribe: () => void;
};

/** What a cell holding no value of its own reports. */
const NOTHING_WRITTEN = { value: undefined, principal: undefined } as const;

/** One observation `observeWrittenPrincipal()` runs, until it is cancelled. */
class WrittenPrincipalObservation<T> {
  #cell: CellHandle<T>;
  #onWritten: (written: WrittenValue<T>) => void;
  #watch: ValueWatch<T> | undefined = undefined;
  /** How many resolves have started. */
  #sequence = 0;
  #unsubscribe: (() => void) | undefined = undefined;
  #cancelled = false;

  constructor(
    cell: CellHandle<T>,
    onWritten: (written: WrittenValue<T>) => void,
  ) {
    this.#cell = cell;
    this.#onWritten = onWritten;
  }

  /**
   * Starts the watch on the cell. A delivery that does not carry the label
   * the worker read with the value, as the first synchronous one of a cell
   * not yet loaded does not, decides nothing.
   */
  start(): void {
    this.#unsubscribe = this.#cell.subscribe((_value, _label, delivery) => {
      if (delivery?.cfcLabelCurrent === true) void this.#resolve();
    }, {
      includeCfcLabel: true,
      onRefused: () => {
        this.#sequence++;
        this.#end();
        this.#onWritten(NOTHING_WRITTEN);
      },
    });
  }

  /** Ends every watch, and every report. */
  cancel(): void {
    this.#cancelled = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#end();
  }

  /** Ends the watch on the cell holding the value. */
  #end(): void {
    this.#watch?.unsubscribe();
    this.#watch = undefined;
  }

  /**
   * Resolves the cell to where a write to it lands and to where its links
   * lead, and watches the cell holding its value, with its label, when the
   * value is the whole of that cell, or watches nothing otherwise. A watch on
   * the same cell is kept, and confirmed when it has delivered. A resolve that
   * a later one overtakes is dropped, and one that fails changes nothing.
   */
  async #resolve(): Promise<void> {
    const sequence = ++this.#sequence;
    const delivered = this.#watch?.delivered === true;
    const resolved = await this.#cell.resolveAsCellWithWriteTarget().catch(
      (e) => {
        if (!this.#cancelled && !this.#cell.runtime().signal.aborted) {
          console.error(
            "observeWrittenPrincipal: cannot resolve the cell, so nothing is " +
              "reported until it resolves",
            e,
          );
        }
        return undefined;
      },
    );
    if (
      resolved === undefined || this.#cancelled ||
      this.#sequence !== sequence
    ) {
      return;
    }
    const { writeTarget: written, cell: target } = resolved;
    const key = isOwnValueCell(written.ref(), target.ref())
      ? addressKey(target.ref())
      : "";
    const current = this.#watch;
    if (current !== undefined && current.cell === key && key !== "") {
      current.sequence = sequence;
      current.confirmed ||= delivered;
      this.#report();
      return;
    }
    current?.unsubscribe();
    // The first delivery is synchronous, so the watch is in place before the
    // subscription starts.
    const watch: ValueWatch<T> = {
      sequence,
      cell: key,
      written: NOTHING_WRITTEN,
      delivered: key === "",
      confirmed: key === "",
      unsubscribe: () => {},
    };
    this.#watch = watch;
    if (key === "") {
      this.#report();
      return;
    }
    watch.unsubscribe = target.subscribe(
      (value, label, delivery) => {
        if (delivery?.cfcLabelCurrent === true) {
          this.#delivered(watch, {
            value,
            principal: soleRepresentedPrincipal(label),
          });
        } else {
          this.#stale(watch);
        }
      },
      {
        includeCfcLabel: true,
        onRefused: () => this.#delivered(watch, NOTHING_WRITTEN),
      },
    );
  }

  /**
   * Records what the cell `watch` watches delivered, and resolves the cell
   * again, which confirms the watch if it still resolves to that cell.
   */
  #delivered(watch: ValueWatch<T>, written: WrittenValue<T>): void {
    if (this.#watch !== watch) return;
    watch.written = written;
    watch.delivered = true;
    void this.#resolve();
    this.#report();
  }

  /**
   * Forgets what the cell `watch` watches last delivered, once the label its
   * handle holds is no longer the one the worker read with its value, and
   * reports neither value nor principal if it had reported them. Resolves
   * begun before are dropped, so the watch is confirmed again only by one
   * begun after the worker next delivers the label.
   */
  #stale(watch: ValueWatch<T>): void {
    if (this.#watch !== watch || !watch.delivered) return;
    const reported = watch.confirmed && watch.sequence === this.#sequence;
    watch.written = NOTHING_WRITTEN;
    watch.delivered = false;
    watch.confirmed = false;
    watch.sequence = ++this.#sequence;
    if (reported) this.#onWritten(NOTHING_WRITTEN);
  }

  /**
   * Reports what the watch last delivered, once it is the one the latest
   * resolve set up and it is confirmed.
   */
  #report(): void {
    const watch = this.#watch;
    if (
      this.#cancelled || watch === undefined || !watch.confirmed ||
      watch.sequence !== this.#sequence
    ) {
      return;
    }
    this.#onWritten(watch.written);
  }
}
