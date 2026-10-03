/**
 * A live read of a piece's result or argument for the piece menu's panels.
 *
 * While the worker admits the cell's read, the read is the whole value. While
 * the worker refuses it, the read is each field the cell holds, read on its
 * own, so that the panel shows everything the display ceiling admits and
 * marks the fields it refuses, the way a render shows a placeholder where a
 * part of it is refused. One field the viewer may not see, such as a
 * credential, then hides that field rather than the whole piece. The worker
 * lists the fields (`CellHandle.fields()`), from the record rather than its
 * schema, which a host may hold only as a reference it cannot resolve.
 */

import {
  type Cancel,
  type CellHandle,
  type CellReadRefusal,
  CellReadRefusedError,
} from "@commonfabric/runtime-client";

/**
 * Stands in a displayed value for a field the worker refused, as `[stream]`
 * stands for a stream.
 */
export const HIDDEN_BY_POLICY: unique symbol = Symbol("hidden by policy");

/**
 * Stands in a displayed value for one the worker could not read, which is
 * not one that holds nothing.
 */
export const NOT_READ: unique symbol = Symbol("not read");

/** What a read holds: the value, or the refusal that stands in its place. */
type Read =
  | { readonly value: unknown }
  | { readonly refused: CellReadRefusal };

/** A field read on its own: what it holds, that it is refused, or nothing yet. */
type FieldRead = Read | { readonly pending: true };

/**
 * The worker's answer for the list of fields, asked for while the whole is
 * refused: refused, failed, that the cell holds no record, or the fields,
 * each read on its own.
 */
type FieldList = "refused" | "failed" | "no record" | Map<string, FieldRead>;

export class PanelRead {
  readonly #cell: CellHandle;
  readonly #onChange: () => void;
  #whole: Read | undefined;
  /** The last answer for the list of fields, while the whole is refused. */
  #list: FieldList | undefined;
  /** The open read of each listed field, by name. */
  readonly #fieldReads = new Map<string, Cancel>();
  /**
   * Advanced whenever a list is asked for and whenever the field reads
   * close, so that only the latest list is taken, and a list that arrives
   * after the whole was admitted again opens nothing.
   */
  #generation = 0;
  readonly #cancelWhole: Cancel;

  /**
   * Starts reading `cell`, calling `onChange` whenever what the read holds
   * changes: a value, a refusal, or a field read on its own.
   */
  constructor(cell: CellHandle, onChange: () => void) {
    this.#cell = cell;
    this.#onChange = onChange;
    this.#cancelWhole = cell.subscribe((value) => {
      this.#closeFields();
      this.#whole = { value };
      this.#onChange();
    }, {
      onRefused: (refused) => {
        this.#whole = { refused };
        void this.#openFields();
        this.#onChange();
      },
    });
  }

  /** The cell the panel reads. */
  get cell(): CellHandle {
    return this.#cell;
  }

  /** Whether anything has been heard of the cell yet. */
  get loaded(): boolean {
    return this.#whole !== undefined;
  }

  /** Whether the worker refuses the whole of the cell's read. */
  get refused(): boolean {
    return this.#whole !== undefined && "refused" in this.#whole;
  }

  /**
   * Whether the panel shows the cell field by field: the worker refuses the
   * whole and lists the fields of the record it holds.
   */
  get shownByField(): boolean {
    return this.refused && this.#list instanceof Map;
  }

  /**
   * Whether the panel has what it shows: the whole value, or, while the
   * whole is refused, the worker's answer for the list of fields.
   */
  get ready(): boolean {
    const whole = this.#whole;
    if (whole === undefined) return false;
    return "value" in whole || this.#list !== undefined;
  }

  /**
   * What the panel shows, once {@link ready}: the value, or, while the whole
   * is refused, an object of the fields, with `HIDDEN_BY_POLICY` at each
   * field the worker refuses. `HIDDEN_BY_POLICY` alone stands for the whole
   * where the worker refuses even the list of fields, or where the cell
   * holds no record to show field by field, and `NOT_READ` where the list
   * could not be read. `undefined` while not ready, which is never shown as
   * a record that holds nothing.
   */
  shown(): unknown {
    const whole = this.#whole;
    if (whole === undefined || !this.ready) return undefined;
    if ("value" in whole) return whole.value;
    const list = this.#list;
    if (list === "failed") return NOT_READ;
    if (!(list instanceof Map)) return HIDDEN_BY_POLICY;
    const shown: Record<string, unknown> = {};
    for (const [name, field] of list) {
      if ("pending" in field) continue;
      shown[name] = "refused" in field ? HIDDEN_BY_POLICY : field.value;
    }
    return shown;
  }

  /** Stops reading the cell and its fields. */
  cancel(): void {
    this.#cancelWhole();
    this.#closeFields();
  }

  /**
   * Asks the worker for the list of fields, as each refusal of the whole
   * does, since each stands for a change to the record: a field added or
   * removed while the whole is refused is listed or dropped. A field still
   * listed keeps the read it has.
   */
  async #openFields(): Promise<void> {
    const generation = ++this.#generation;
    let fields: Record<string, CellHandle<unknown>> | undefined;
    try {
      fields = await this.#cell.fields();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof CellReadRefusedError) {
        this.#setList("refused");
      } else {
        // Shown as not read; the next refusal of the whole asks again.
        console.error("[PanelRead] Listing the fields failed:", error);
        this.#setList("failed");
      }
      return;
    }
    if (generation !== this.#generation) return;
    if (fields === undefined) {
      this.#setList("no record");
      return;
    }
    const previous = this.#list instanceof Map ? this.#list : undefined;
    const list = new Map<string, FieldRead>();
    for (const name of Object.keys(fields)) {
      list.set(name, previous?.get(name) ?? { pending: true });
    }
    this.#setList(list);
    for (const [name, field] of Object.entries(fields)) {
      if (this.#fieldReads.has(name)) continue;
      const heard = (read: FieldRead) => {
        // Into the list shown now, which a later listing may have replaced
        // with one that still holds the field.
        const current = this.#list;
        if (current instanceof Map && current.has(name)) {
          current.set(name, read);
        }
        this.#onChange();
      };
      this.#fieldReads.set(
        name,
        field.subscribe((value) => heard({ value }), {
          onRefused: (refused) => heard({ refused }),
        }),
      );
    }
  }

  /**
   * Takes `list` as the answer for the list of fields, closing the read of
   * each field it no longer holds.
   */
  #setList(list: FieldList): void {
    for (const [name, cancel] of this.#fieldReads) {
      if (list instanceof Map && list.has(name)) continue;
      cancel();
      this.#fieldReads.delete(name);
    }
    this.#list = list;
    this.#onChange();
  }

  #closeFields(): void {
    this.#generation++;
    this.#list = undefined;
    for (const cancel of this.#fieldReads.values()) cancel();
    this.#fieldReads.clear();
  }
}
