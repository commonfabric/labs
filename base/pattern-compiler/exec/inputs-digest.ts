import type { InputsTable, PlanInputs, SlotBindings } from "./plan-write.ts";

/**
 * The most characters of text an instance of `InputsDigests` holds numbers
 * for in one generation.
 */
const HELD = 8_000_000;

/**
 * Names what the inputs of a place hold by a number that two sets of
 * inputs share exactly where they hold the same content, across the tables
 * of inputs of different transactions: an index of `InputsTable` stands
 * for a content in one table alone.
 *
 * The number is found from the content, each binding and each set of
 * inputs once for a table, so naming every record of a transaction is
 * work in the size of the table. The texts are held in two generations of
 * at most `HELD` characters each: a text that was not named while the
 * older generation filled is let go, and has another number when it is
 * named again. A number is used once, so two equal numbers always stand
 * for equal contents, and two equal contents can have two numbers.
 */
export class InputsDigests {
  /** The number of each content named in this generation, by its text. */
  #numbers = new Map<string, number>();

  /** The numbers of the generation before. */
  #before = new Map<string, number>();

  /** The characters of the texts of `#numbers`. */
  #held = 0;

  #next = 1;

  /** The table the numbers of `#inputs` and `#bindings` were found for. */
  #table: InputsTable | undefined;

  /** The number of each set of inputs of `#table`, by its index. */
  #inputs = new Map<number, number>();

  /** The number of each binding of `#table`, by its index. */
  #bindings = new Map<number, number>();

  /**
   * Returns the number of what the set of inputs at `index` of `table`
   * holds, with everything it names by index, for the element keys
   * `keys` of the record.
   */
  of(
    table: InputsTable,
    index: number,
    keys: readonly (readonly [number, string])[],
  ): number {
    if (table !== this.#table) {
      this.#table = table;
      this.#inputs = new Map();
      this.#bindings = new Map();
    }
    return this.#number(JSON.stringify([this.#inputsOf(table, index), keys]));
  }

  #number(text: string): number {
    let number = this.#numbers.get(text);
    if (number === undefined) {
      number = this.#before.get(text) ?? this.#next++;
      if (this.#held + text.length > HELD) {
        this.#before = this.#numbers;
        this.#numbers = new Map();
        this.#held = 0;
      }
      this.#numbers.set(text, number);
      this.#held += text.length;
    }
    return number;
  }

  #bindingsOf(table: InputsTable, slots: SlotBindings): [string, number][] {
    return Object.entries(slots).map(([slot, at]) => {
      let number = this.#bindings.get(at);
      if (number === undefined) {
        number = this.#number(`b${table.bindingText(at)}`);
        this.#bindings.set(at, number);
      }
      return [slot, number];
    });
  }

  #inputsOf(table: InputsTable, index: number): number {
    const known = this.#inputs.get(index);
    if (known !== undefined) return known;
    const place: PlanInputs = table.inputs[index];
    const number = this.#number(`i${
      JSON.stringify([
        this.#bindingsOf(table, place.slots),
        place.selections ?? null,
        Object.entries(place.picks ?? {}).map(([pick, chosen]) => [
          pick,
          chosen === null ? null : this.#bindingsOf(table, chosen.slots),
        ]),
        place.dynamic ?? null,
        Object.entries(place.outputs ?? {}).map(([output, at]) => [
          output,
          this.#inputsOf(table, at),
        ]),
        Object.entries(place.elements ?? {}).map(([collection, elements]) => [
          collection,
          "uniform" in elements
            ? this.#inputsOf(table, elements.uniform)
            : elements.groups.map(({ inputs, count }) => [
              this.#inputsOf(table, inputs),
              count,
            ]),
        ]),
      ])
    }`);
    this.#inputs.set(index, number);
    return number;
  }
}
