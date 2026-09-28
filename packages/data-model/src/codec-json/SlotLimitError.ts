import { ProblematicStateError } from "@/codec-common";
import { excerptOf, type RootScalar, rootScalarOf } from "./text-scan.ts";

/**
 * Error thrown when a decode with a slot limit is handed text that stands for
 * more slots than the limit allows. Like every refusal of the serialized form,
 * a lenient decode settles it into a `ProblematicValue` instead.
 *
 * The error keeps the refused text, so that a caller answering it can still
 * read what the text said about itself -- the id of a request, say -- through
 * {@link #rootScalar}, without the rest of the text being parsed.
 */
export class SlotLimitError extends ProblematicStateError {
  readonly #slotLimit: number;

  readonly #jsonText: string;

  /**
   * Constructs an instance for a refusal under `slotLimit` of the JSON text
   * `jsonText`.
   */
  constructor(slotLimit: number, jsonText: string) {
    super(
      "",
      excerptOf(jsonText),
      `Encoded \`FabricValue\` stands for more than ${slotLimit} slots`,
    );
    this.name = "SlotLimitError";
    this.#slotLimit = slotLimit;
    this.#jsonText = jsonText;
  }

  /** The limit the text was refused under. */
  get slotLimit(): number {
    return this.#slotLimit;
  }

  /**
   * Returns the value of the member named `name` in the record at the root of
   * the refused text, if that value is a scalar, and `undefined` otherwise. It
   * costs one scan of the text, stepping over every other member unparsed.
   */
  rootScalar(name: string): RootScalar | undefined {
    return rootScalarOf(this.#jsonText, name);
  }
}
