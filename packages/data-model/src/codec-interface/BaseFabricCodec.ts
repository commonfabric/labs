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
 * `State` is the codec's own state type, a subtype of the format-wide
 * `Encoded`: what `encode()` emits, what `canDecode()` narrows to, and the only
 * thing `decode()` is handed. Declaring it is how a subclass writes down what
 * it works over, and one declaration serving all three members is what says the
 * three agree. A codec that genuinely works over the whole of `Encoded` leaves
 * it at the default.
 *
 * `decode()` taking `State` rests on the walker asking {@link #canDecode} of
 * every state before dispatching one here, which is what makes the narrower
 * parameter true rather than merely declared.
 */
export abstract class BaseFabricCodec<
  PlusType,
  Encoded,
  State extends Encoded = Encoded,
> implements FabricCodec<PlusType, Encoded> {
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

  /**
   * @inheritDoc
   *
   * Stated as a type predicate over `State`, which is what makes the check
   * pay: the narrowing carries across to {@link #decode}, which then reads the
   * state's parts as the types this method just established them to be.
   */
  abstract canDecode(state: Encoded): state is State;

  /**
   * @inheritDoc
   *
   * Narrowed to `State`, this codec having been asked {@link #canDecode} of
   * the state first.
   */
  abstract decode(
    typeTag: string,
    state: State,
    env: LiveEnvironment,
    mutable?: boolean,
  ): FabricValuePlus<PlusType>;

  /**
   * @inheritDoc
   *
   * What this codec emits is what it takes back: `State` is the same type
   * {@link #canDecode} narrows to and {@link #decode} is handed.
   */
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
