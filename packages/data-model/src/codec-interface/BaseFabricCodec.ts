import type { Constructor } from "@commonfabric/utils/types";
import type { FabricValuePlus } from "@/interface.ts";
import type { FabricCodec, LiveEnvironment } from "./interface.ts";

/**
 * Base class for `FabricCodec` which provides commonly-needed functionality:
 * the matching members, and a `tagForValue()` that returns the codec's one
 * recognized tag.
 *
 * It is abstract in `encode()`, `canDecode()` and `decode()` and, deliberately,
 * in identity: extend {@link BaseNonterminalCodec} or {@link BaseTerminalCodec}
 * rather than this directly. Those two are what tell the codec system whether a
 * state is more work for the walker or the walker's final answer, a difference
 * no signature can carry -- and extending one of them fixes the `PlusType` and
 * `Encoded` domains in the same stroke, so the declaration and its consequence
 * cannot drift apart. Both are as {@link FabricCodec} describes them.
 *
 * `State` is as {@link FabricCodec} describes it. Declaring it is how a
 * subclass writes down what it works over.
 */
export abstract class BaseFabricCodec<
  PlusType,
  Encoded,
  State extends Encoded = Encoded,
> implements FabricCodec<PlusType, Encoded, State> {
  #recognizedTypeTag: string | undefined;
  #uniqueHandledClass: Constructor | undefined;

  /** Constructs an instance. */
  constructor(
    /**
     * The wire type tag this codec recognizes, or `undefined` for a codec with
     * no single tag.
     */
    recognizedTypeTag: string | undefined,
    /**
     * The unique class (constructor function), if any, whose _direct_ instances
     * this instance handles.
     */
    uniqueHandledClass: Constructor | undefined,
  ) {
    this.#recognizedTypeTag = recognizedTypeTag;
    this.#uniqueHandledClass = uniqueHandledClass;
  }

  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract canDecode(state: Encoded): state is State;

  /** @inheritDoc */
  abstract decode(
    typeTag: string,
    state: State,
    env: LiveEnvironment,
    mutable?: boolean,
  ): FabricValuePlus<PlusType>;

  /** @inheritDoc */
  abstract encode(
    value: FabricValuePlus<PlusType>,
    env: LiveEnvironment,
  ): State;

  //
  // Instance members
  //

  /** @inheritDoc */
  get uniqueHandledClass(): Constructor | undefined {
    return this.#uniqueHandledClass;
  }

  /** @inheritDoc */
  get recognizedTypeTag(): string | undefined {
    return this.#recognizedTypeTag;
  }

  /** @inheritDoc */
  canEncode(value: FabricValuePlus<PlusType>): boolean {
    const cls = this.#uniqueHandledClass;

    return (cls !== undefined) && (value instanceof cls);
  }

  /**
   * @inheritDoc
   *
   * Returns this codec's {@link #recognizedTypeTag}. A codec with no recognized
   * tag (whose instances carry per-instance tags) must override this.
   */
  tagForValue(_value: FabricValuePlus<PlusType>): string {
    if (this.#recognizedTypeTag === undefined) {
      throw new Error(
        "Shouldn't happen: codec has no recognized tag; `tagForValue()` must " +
          "be overridden.",
      );
    }
    return this.#recognizedTypeTag;
  }
}
