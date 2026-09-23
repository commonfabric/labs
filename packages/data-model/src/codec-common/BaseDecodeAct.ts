import { deepFreeze } from "@/deep-freeze.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type {
  NonterminalCodec,
  TerminalCodec,
} from "@/codec-interface/interface.ts";
import { debugStr, toCompactDebugString } from "@/value-debug";
import { isCodecTypeTag } from "./isCodecTypeTag.ts";
import { UnknownValue } from "./UnknownValue.ts";
import type { FabricValue } from "@/interface.ts";
import { BaseCodecAct } from "./BaseCodecAct.ts";
import { ProblematicStateError } from "./ProblematicStateError.ts";
import { ProblematicValue } from "./ProblematicValue.ts";

/**
 * The state of one act of decoding: what {@link BaseCodecAct} holds, plus how
 * this act reports wire data it finds malformed.
 *
 * An engine mints one of these per `decode()` call, through a factory its
 * subclass supplies. A format needing more -- a wire marker read off the
 * incoming envelope, say -- subclasses this and holds that alongside.
 *
 * The reporting members live here rather than on the engine because what they
 * settle is a property of the act: they run while a walk is in progress, and
 * every one of them is reached with the act already in hand.
 */
export abstract class BaseDecodeAct<Encoded, SerializedForm = Encoded>
  extends BaseCodecAct<Encoded> {
  //
  // Subclass contract
  //

  /**
   * Converts this format's serialized form into the tree this act decodes,
   * which is where a format checks that what it was handed is its own: a parse
   * step, an envelope check, or nothing at all.
   *
   * What arrives is data off a channel and is not to be assumed well-formed. A
   * form that is not this format's is refused by throwing
   * `ProblematicStateError`, which the engine's `decode()` settles through
   * {@link #settleThrown} -- so a lenient decode returns a `ProblematicValue`
   * for a syntactic fault, exactly as it does for a fault found further in.
   *
   * **Called exactly once per act, and before any of the walk.** An act may
   * therefore take what it needs of the serialized form here -- a marker read
   * off an envelope, say -- and {@link #decodeValue} will see it. An engine
   * adding an entry point of its own owes the same order rather than reaching
   * a conversion around this one.
   */
  abstract encodedFromSerializedForm(data: SerializedForm): Encoded;

  /**
   * Decodes a transport tree back into `FabricValue`s.
   *
   * Whether cycles are guarded at all is the format's decision, made by
   * whether this method enters a node: a format whose input it parses for
   * itself cannot be handed a cycle, so it enters none and this act's stack
   * of values in progress is never allocated.
   *
   * An implementation that does guard owes the act one thing: every object it
   * is about to descend through goes through {@link #enterOrReport} first, and
   * comes back out through {@link #leave} however the descent ends. That means
   * the tagged form as much as a container -- a format whose transport can
   * carry a graph can close a cycle through tagged nodes alone. Here rather
   * than in {@link #decodeTagged}, because this method is the one that visits
   * every node, and entering in both places would enter a state twice and
   * report a cycle that is not there.
   */
  abstract decodeValue(data: Encoded): FabricValue;

  //
  // Instance members
  //

  /**
   * Enters a node, and returns whether it was entered.
   *
   * Whether a format guards cycles at all is decided by whether its walk
   * calls this: a format whose input it parses for itself is handed a tree by
   * construction, so it never does, and its stack of values in progress is
   * never allocated. One handed a tree it did not build enters every node it
   * descends through.
   *
   * @returns `true` if the node was entered, `false` if it was already in
   *   progress -- which is a cycle, and the caller's to report.
   */
  enter(value: object): boolean {
    return this.tryEnter(value);
  }

  /**
   * Enters a container, reporting rather than entering if it is already in
   * progress.
   *
   * Reported rather than raised, unlike the encode side's refusal: a cycle
   * here arrived from a channel, and every malformation off a channel settles
   * against leniency. Raising unconditionally would also be the one refusal a
   * lenient decode could not contain.
   *
   * The report carries a rendering of the container rather than the container
   * itself, a cyclic graph being the one thing a `ProblematicValue` cannot
   * hold onto.
   *
   * @param value The container about to be walked.
   * @returns The report, or `null` if `value` was entered.
   * @throws If this act is not lenient.
   */
  enterOrReport(value: object): FabricValue | null {
    if (!this.enter(value)) {
      return this.reportMalformed(
        "",
        toCompactDebugString(value, { maxLength: 50 }),
        "circular reference in decoded data",
      );
    }

    return null;
  }

  /**
   * Settles a thrown value against leniency: strictly it re-raises, and
   * leniently a `ProblematicStateError` becomes a `ProblematicValue`.
   *
   * Only that one error type is settled. Anything else is somebody's bug
   * rather than a report about wire data, and is re-raised untouched -- so a
   * fault in the code doing the decoding does not come back to a caller
   * disguised as malformed input.
   *
   * A refusal of the serialized form itself arrives here too. Such a form is
   * data off a channel like any other, so being the wrong shape for this
   * format is a malformation of the same kind as a bad state inside a
   * well-formed one, and settles the same way.
   *
   * @throws Whatever it was given, if this act is not lenient or the throw was
   *   not a `ProblematicStateError`.
   */
  settleThrown(e: unknown): FabricValue {
    if (this.config.lenient && (e instanceof ProblematicStateError)) {
      // The error renders itself rather than being taken apart and rebuilt:
      // it already holds the three facts, normalized the way this class would
      // normalize them, and hands back a deep-frozen value.
      return e.asProblematicValue();
    }

    // Rethrown rather than rebuilt, strictly: the refusal already names its
    // tag and state, and re-raising it keeps whatever `cause` it carries.
    throw e;
  }

  /**
   * Reports wire data the engine itself found malformed, settled against
   * leniency: strictly it raises, and leniently it becomes a
   * `ProblematicValue` in the result.
   *
   * A codec rejecting a state it was handed goes through the same setting.
   * Which of the two noticed is an implementation detail of where a check
   * happens to live, so it does not decide what a caller sees; leniency does.
   *
   * @param wireTypeTag The tag the malformed data arrived under, or the
   *   meta-tag naming the structure at fault. Of any type whatsoever: what
   *   sits in tag position is wire data like any other, and a tag that is not
   *   a tag is among the faults reported here. `ProblematicValue` renders what
   *   it cannot keep.
   * @param state The data at fault, of any type whatsoever, preserved so that
   *   a lenient result round-trips. A format whose states are not
   *   `FabricValue`s hands one over as it stands; `ProblematicValue` renders
   *   what it cannot keep.
   * @param error What is wrong with it, phrased to stand on its own -- it is
   *   the whole of the message when this raises.
   * @throws If this act is not lenient.
   */
  reportMalformed(
    wireTypeTag: any,
    state: any,
    error: string,
  ): FabricValue {
    if (!this.config.lenient) {
      throw new ProblematicStateError(wireTypeTag, state, error);
    }

    return deepFreeze(new ProblematicValue(wireTypeTag, state, error));
  }

  /**
   * Reports a key this runtime reserves, found in wire data, settled against
   * leniency like any other malformation.
   *
   * The names are `__proto__` and `constructor`, and what makes them a
   * boundary concern is that the walks rebuild an object by assignment: the
   * first routes through an inherited setter on a host that has one, and both
   * are refused rather than silently reshaped.
   *
   * @param key The reserved key.
   * @param state The object it was found in, preserved so a lenient result
   *   round-trips.
   * @throws If this act is not lenient.
   */
  reportReservedKey(key: string, state: any): FabricValue {
    return this.reportMalformed(
      key,
      state,
      `object contains a key this runtime reserves: "${key}"`,
    );
  }

  /**
   * Decodes one tagged value, dispatching on the tag through the registry. A
   * subclass calls this once it has recognized a tagged form and taken off
   * whatever meta-tags this format defines for itself.
   *
   * The tag's syntax is checked here rather than by each caller: `tag` is
   * whatever a format found in tag position, of whatever type, and a subclass
   * is not expected to know what a tag may look like.
   *
   * Frozen-ness contract: every value returned from here is deep-frozen, so
   * callers do not each have to freeze, and a caller need not ask which arm
   * produced what it was handed.
   *
   * Three of the arms below walk the state again -- a nonterminal codec's, an
   * unknown tag's, and a malformed tag's -- and each runs that walk on this
   * act. Entering the state is not this method's business: it is {@link
   * #decodeValue} that visits every node of the tree, the tagged form included,
   * and entering there is what keeps one node from being entered twice.
   */
  decodeTagged(
    tag: any,
    rawState: Encoded,
  ): FabricValue {
    if (!isCodecTypeTag(tag)) {
      // Anything that is not a tag syntactically is an encoding error whatever
      // follows it, per Section 9 of the formal spec, and is reported rather
      // than preserved as an `UnknownValue`: that form exists to round-trip a
      // tag no codec claims, which presupposes a tag. Reported over the
      // decoded state, so that a lenient result carries what arrived.
      return this.reportMalformed(
        tag,
        this.decodeValue(rawState),
        debugStr`tagged value has a malformed tag: $quote${tag}`,
      );
    }

    const matched = this.registry.codecFromTag(tag);

    if (matched === undefined) {
      // A tag this registry does not carry, kept in the unknown form so that
      // it round-trips.
      return deepFreeze(new UnknownValue(tag, this.decodeValue(rawState)));
    }

    // A terminal codec takes the state exactly as it arrived; a nonterminal
    // one takes it expanded. The casts restate what `instanceof` just
    // established, which TypeScript drops on a generic class.
    const terminal = matched instanceof BaseTerminalCodec;
    const state = terminal ? rawState : this.decodeValue(rawState);

    let decoded: FabricValue;

    try {
      // Every state is offered to the codec before it is decoded, which is
      // what lets a `decode()` be written for the states its codec accepts
      // rather than for everything its format can carry. Inside the `try`
      // because a codec's own code runs here, and a predicate that throws is
      // a fault of the same kind as one thrown from the decoding.
      const accepted = terminal
        ? (matched as TerminalCodec<Encoded>).canDecode(rawState)
        : (matched as NonterminalCodec).canDecode(state as FabricValue);

      if (!accepted) {
        // Reported rather than raised, like every other malformation off a
        // channel: `reportMalformed()` is what settles it against leniency,
        // and strictly what it raises passes back out through the `catch`
        // below untouched.
        return this.reportMalformed(
          tag,
          state,
          "state is not one this codec decodes",
        );
      }

      decoded = terminal
        ? (matched as TerminalCodec<Encoded>).decode(tag, rawState, this.env)
        : (matched as NonterminalCodec).decode(
          tag,
          state as FabricValue,
          this.env,
        );
    } catch (e: any) {
      if (!this.config.lenient) {
        // Normalized rather than rethrown: what a codec throws is not
        // guaranteed to be an `Error`, let alone one naming the state it
        // choked on. `fromThrown()` returns one that does -- the thrown
        // value itself where it already qualifies, and otherwise a fresh one
        // holding it as `cause`.
        throw ProblematicStateError.fromThrown(tag, state, e);
      }

      // Report over the state the codec was actually handed, so that it says
      // what the codec choked on.
      return this.reportMalformed(
        tag,
        state,
        e instanceof Error ? e.message : String(e),
      );
    }

    if (
      !this.config.lenient && (decoded instanceof ProblematicValue) &&
      (matched.uniqueHandledClass !== ProblematicValue)
    ) {
      // Of the ways a codec reports a state it will not accept, two are
      // settled this late: throwing, caught above, and returning one of
      // these. Which it picks is the codec author's choice and says nothing
      // about what a caller wants. `lenient` is what says that, so this
      // instance settles both into the same answer: a strict decode fails,
      // whichever way the codec reported it.
      //
      // `ProblematicValue`'s own codec is exempt, because for that one a
      // `ProblematicValue` is the successful product rather than a refusal.
      // A payload under `Problematic@1` is a well-formed record of a past
      // failure, and reading one is not a failure of this decode; without the
      // exemption a strict reader could never read such a record back, which
      // is most of what preserving one is for.
      throw new ProblematicStateError(tag, decoded.state, decoded.error);
    }

    // A codec's `decode()` promises deep-frozen results rather than relying on
    // every caller to freeze. That covers the codec's own product -- a
    // `FabricPrimitive` is already frozen, making it an O(1) cache hit -- and
    // the lenient fallback above alike.
    return deepFreeze(decoded);
  }
}
