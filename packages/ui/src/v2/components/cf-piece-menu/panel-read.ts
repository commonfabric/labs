/**
 * A live read of a piece's result or argument for the piece menu's panels.
 *
 * While the worker admits the cell's read, the read is the whole value. While
 * the worker refuses it, the read is each field the cell's schema declares,
 * read on its own, so that the panel shows everything the display ceiling
 * admits and marks the fields it refuses, the way a render shows a placeholder
 * where a part of it is refused. One field the viewer may not see, such as a
 * credential, then hides that field rather than the whole piece. Fields the
 * schema does not declare cannot be named without reading the value, and are
 * not shown.
 */

import type {
  Cancel,
  CellHandle,
  CellReadRefusal,
  JSONSchema,
} from "@commonfabric/runtime-client";
import { isObjectNotArray } from "@commonfabric/utils/types";

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

/** The properties `schema` declares, by name. */
export function declaredProperties(
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> {
  if (!isObjectNotArray(schema)) return {};
  const properties = schema.properties;
  return isObjectNotArray(properties)
    ? properties as Record<string, JSONSchema>
    : {};
}

export class PanelRead {
  readonly #cell: CellHandle;
  readonly #onChange: () => void;
  #whole: Read | undefined;
  #fields = new Map<string, FieldRead>();
  #cancelFields: Cancel[] = [];
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
        this.#openFields();
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
   * object of the declared fields read so far, with `HIDDEN_BY_POLICY` at
   * each field the worker refuses.
   */
  shown(): unknown {
    const whole = this.#whole;
    if (whole === undefined) return undefined;
    if ("value" in whole) return whole.value;
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

  #openFields(): void {
    if (this.#cancelFields.length > 0) return;
    const parent = this.#cell.asSchema<Record<string, unknown>>({
      type: "object",
    });
    for (
      const [name, fragment] of Object.entries(
        declaredProperties(this.#cell.ref().schema),
      )
    ) {
      // Addressed at the field, so that the read is decided on the field's
      // labels, not on those of the whole document the cell starts from.
      const field = parent.key(name).asSchema(fragment);
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
  }

  #closeFields(): void {
    for (const cancel of this.#cancelFields) cancel();
    this.#cancelFields = [];
    this.#fields = new Map();
  }
}
