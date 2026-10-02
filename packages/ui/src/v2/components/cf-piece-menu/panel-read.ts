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

/** What a read holds: the value, or the refusal that stands in its place. */
type Read =
  | { readonly value: unknown }
  | { readonly refused: CellReadRefusal };

/** A field read on its own: what it holds, that it is refused, or nothing yet. */
type FieldRead = Read | { readonly pending: true };

export class PanelRead {
  readonly #cell: CellHandle;
  readonly #onChange: () => void;
  #whole: Read | undefined;
  #fields = new Map<string, FieldRead>();
  #cancelFields: Cancel[] = [];
  /** Whether the worker refused even the list of fields. */
  #listRefused = false;
  /**
   * Advanced whenever the field reads open or close, so that a list that
   * arrives after the whole was admitted again opens nothing.
   */
  #generation = 0;
  #listing = false;
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
   * What the panel shows: the value, or, while the whole is refused, an
   * object of the fields read so far, with `HIDDEN_BY_POLICY` at each field
   * the worker refuses, or `HIDDEN_BY_POLICY` alone where the worker refuses
   * even the list of fields.
   */
  shown(): unknown {
    const whole = this.#whole;
    if (whole === undefined) return undefined;
    if ("value" in whole) return whole.value;
    if (this.#listRefused) return HIDDEN_BY_POLICY;
    const shown: Record<string, unknown> = {};
    for (const [name, field] of this.#fields) {
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
    if (this.#listing || this.#cancelFields.length > 0) return;
    const generation = ++this.#generation;
    this.#listing = true;
    let fields: Record<string, CellHandle<unknown>>;
    try {
      fields = await this.#cell.fields();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#listing = false;
      if (!(error instanceof CellReadRefusedError)) {
        // Shown as nothing listed yet, as a field list a read failed to
        // make; the next refusal of the whole asks again.
        console.error("[PanelRead] Listing the fields failed:", error);
        return;
      }
      this.#listRefused = true;
      this.#onChange();
      return;
    }
    if (generation !== this.#generation) return;
    this.#listing = false;
    for (const [name, field] of Object.entries(fields)) {
      this.#fields.set(name, { pending: true });
      this.#cancelFields.push(field.subscribe((value) => {
        this.#fields.set(name, { value });
        this.#onChange();
      }, {
        onRefused: (refused) => {
          this.#fields.set(name, { refused });
          this.#onChange();
        },
      }));
    }
    this.#onChange();
  }

  #closeFields(): void {
    this.#generation++;
    this.#listing = false;
    this.#listRefused = false;
    for (const cancel of this.#cancelFields) cancel();
    this.#cancelFields = [];
    this.#fields = new Map();
  }
}
