import type { FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug";
import { toReportableState } from "./toReportableState.ts";
import { toReportableTag } from "./toReportableTag.ts";
import { ProblematicValue } from "./ProblematicValue.ts";
import { deepFreeze } from "@/deep-freeze.ts";

/**
 * Error thrown when a state cannot be decoded and the engine is not lenient.
 * The strict-mode counterpart of `ProblematicValue`: the same three facts --
 * the tag, the state at fault, and what is wrong with it -- disposed of by
 * throwing rather than by being returned in the result. Which of the two a
 * caller gets is settled by `lenient` alone.
 *
 * Carrying the state is the point. A bare `Error` reduces it to whatever the
 * message happens to quote, so a caller that wants to inspect what actually
 * arrived has to parse prose. `state` holds it in the same form
 * `ProblematicValue` would, via {@link toReportableState}.
 */
export class ProblematicStateError extends Error {
  /** Value for {@link #wireTypeTag}. */
  readonly #wireTypeTag: string;

  /** Value for {@link #state}. */
  readonly #state: FabricValue;

  /**
   * Constructs an instance.
   *
   * @param wireTypeTag - The tag the faulty data arrived under, of any type
   *   whatsoever; kept as-is if it is a string, and otherwise replaced by a
   *   debug rendering.
   * @param state - What was at fault, of any type whatsoever; rendered if it
   *   is not a `FabricValue`.
   * @param message - What is wrong with it.
   * @param options - Standard `Error` options, notably `cause`.
   */
  constructor(
    wireTypeTag: any,
    state: any,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "ProblematicStateError";
    this.#wireTypeTag = toReportableTag(wireTypeTag);
    this.#state = toReportableState(state);
  }

  /** The tag the faulty data arrived under. */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /** What was at fault, in reportable form. */
  get state(): FabricValue {
    return this.#state;
  }

  /**
   * Returns this error's three facts as a `ProblematicValue`: the same account
   * of the same failure, in the form that is returned rather than thrown.
   * Both classes normalize a tag and a state the same way, so a value from
   * here is comparable with one built directly.
   *
   * Deep-frozen unless `mutable`, because a decode returns one of these, and
   * what a decode returns is deep-frozen unless it was asked to be mutable.
   * Freezing here rather than at each call site is what keeps that from
   * depending on a caller remembering.
   */
  asProblematicValue(mutable = false): ProblematicValue {
    const result = new ProblematicValue(
      this.wireTypeTag,
      this.state,
      this.message,
    );
    return mutable ? result : deepFreeze(result);
  }

  //
  // Static members
  //

  /**
   * Returns an instance accounting for something a codec threw, which
   * JavaScript permits to be any value at all. An `Error` contributes its
   * message and is kept as `cause`, so nothing about it is lost to a caller
   * willing to look; anything else is rendered, there being no message to
   * take.
   *
   * Where `thrown` is already an instance bearing this same tag and state, it
   * is returned as it stands rather than wrapped.
   *
   * @param wireTypeTag - The tag the faulty data arrived under, of any type
   *   whatsoever; kept as-is if it is a string, and otherwise replaced by a
   *   debug rendering.
   * @param state - The state the codec was handed.
   * @param thrown - Whatever the codec threw.
   */
  static fromThrown(
    wireTypeTag: any,
    state: any,
    thrown: any,
  ): ProblematicStateError {
    const error = (thrown instanceof Error)
      ? thrown.message
      : toCompactDebugString(thrown);

    // Built first and compared against, rather than the fields being
    // normalized here to match. How a tag and a state are made reportable is
    // one class's business, and restating it here is a copy that can drift
    // from the one that matters. This path is already the failing one, so an
    // allocation that turns out to be discarded costs nothing worth counting.
    const problem = new ProblematicValue(wireTypeTag, state, error);

    if (
      (thrown instanceof ProblematicStateError) &&
      thrown.asProblematicValue().equals(problem)
    ) {
      // Already an account of this same failure. Wrapping it would say
      // nothing the original does not, at the cost of a `cause` chain a
      // reader has to walk to reach the message that matters.
      return thrown;
    }

    return new ProblematicStateError(
      problem.wireTypeTag,
      problem.state,
      error,
      { cause: thrown },
    );
  }
}
