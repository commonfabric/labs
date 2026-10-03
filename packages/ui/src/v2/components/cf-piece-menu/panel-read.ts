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
  /** Whether a list of fields has been asked for and not yet answered. */
  #listing = false;
  #cancelFields: Cancel[] = [];
  /**
   * Advanced whenever the field reads open or close, so that a list that
   * arrives after the whole was admitted again opens nothing.
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

  async #openFields(): Promise<void> {
    if (this.#listing || this.#list instanceof Map) return;
    const generation = ++this.#generation;
    this.#listing = true;
    let fields: Record<string, CellHandle<unknown>> | undefined;
    try {
      fields = await this.#cell.fields();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#listing = false;
      if (error instanceof CellReadRefusedError) {
        this.#list = "refused";
      } else {
        // Shown as not read; the next refusal of the whole asks again.
        console.error("[PanelRead] Listing the fields failed:", error);
        this.#list = "failed";
      }
      this.#onChange();
      return;
    }
    if (generation !== this.#generation) return;
    this.#listing = false;
    if (fields === undefined) {
      this.#list = "no record";
      this.#onChange();
      return;
    }
    const list = new Map<string, FieldRead>();
    this.#list = list;
    for (const [name, field] of Object.entries(fields)) {
      list.set(name, { pending: true });
      this.#cancelFields.push(field.subscribe((value) => {
        list.set(name, { value });
        this.#onChange();
      }, {
        onRefused: (refused) => {
          list.set(name, { refused });
          this.#onChange();
        },
      }));
    }
    this.#onChange();
  }

  #closeFields(): void {
    this.#generation++;
    this.#list = undefined;
    this.#listing = false;
    for (const cancel of this.#cancelFields) cancel();
    this.#cancelFields = [];
  }
}
