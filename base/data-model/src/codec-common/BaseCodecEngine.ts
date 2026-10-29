import { type FabricValue } from "@/interface.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { type CodecRegistry } from "./CodecRegistry.ts";
import { BaseDecodeAct } from "./BaseDecodeAct.ts";
import { BaseEncodeAct } from "./BaseEncodeAct.ts";
import type { CodecEngineConfig } from "./CodecEngineConfig.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";

/**
 * Base class for a whole-value codec: the object that walks a `FabricValue`
 * into one wire format's transport tree and back. What lives here is the part
 * that consults the codec registry and acts on what it says; what a subclass
 * supplies is everything specific to how its format writes a container down.
 *
 * Four type parameters, of which a format states as many as it needs.
 *
 * The first two are about the wire, and are two because a format's transport
 * tree is not necessarily what crosses its public boundary. `Encoded` is the
 * tree the walk and the codecs work in; `SerializedForm` is what `encode()`
 * returns and `decode()` accepts. JSON's differ -- a `JsonCodecValue` tree,
 * reduced to a `string` by a stringify step -- and a format whose tree is what
 * crosses leaves the second to default to the first.
 *
 * The other two are the acts of encoding and decoding themselves, and default
 * to the base classes, so a format needing no more than the walk's own
 * bookkeeping names neither. A format that does -- one whose tagged form
 * carries a marker minted per call, say -- subclasses an act and binds it here.
 * Its overrides then receive the narrowed type by construction: the signatures
 * match exactly, so nothing needs a cast.
 *
 * The division is between what a format decides and what it must not:
 *
 * * A self-representing value is emitted as it stands, and a value matching no
 *   codec is either a container or an error.
 * * A terminal codec's state is final and a nonterminal codec's is walked again
 *   -- read off the codec's base class, on both sides of the trip.
 * * A tag comes from `tagForValue()` rather than from the value.
 * * An unrecognized tag becomes an `UnknownValue`, and one that is not a tag at
 *   all an error, per Section 9 of the formal spec.
 * * A codec's `decode()` result is deep-frozen, or built mutable, according to
 *   `mutable`, and a throw from one is re-raised or wrapped according to
 *   `lenient`.
 *
 * None of those is a property of a wire format, and every one of them is a
 * decision a walker could quietly get wrong: a state expanded when it should
 * have been passed through, or the reverse, surfaces far from the dispatch that
 * decided it, and where a state is a record of strings the two choices emit
 * byte-identical output. Holding them in one place is worth more than the lines
 * it saves.
 *
 * What a subclass owns is everything about containers, and that is where a
 * format is entitled to differ: whether keys are ordered, whether a key can
 * collide with the tag form and so needs escaping, and how an absent array
 * index is written down. A format that answers those differently is not varying
 * an implementation detail; it is being a different format.
 */
export abstract class BaseCodecEngine<
  Encoded,
  SerializedForm = Encoded,
  EncAct extends BaseEncodeAct<Encoded, SerializedForm> = BaseEncodeAct<
    Encoded,
    SerializedForm
  >,
  DecAct extends BaseDecodeAct<Encoded, SerializedForm> = BaseDecodeAct<
    Encoded,
    SerializedForm
  >,
> implements CodecEngineConfig<Encoded> {
  readonly #lenient: boolean;

  readonly #mutable: boolean;

  readonly #registry: CodecRegistry<Encoded>;

  /**
   * Constructs an instance. `options.registry` supplies the codecs this
   * instance encodes and decodes with, and so decides which classes it can
   * carry; there is no default, because which classes participate is a
   * question this class has no standing to answer. `options.lenient` makes a
   * failed `decode()` produce a `ProblematicValue` instead of throwing.
   * `options.mutable` makes `decode()` leave what it builds mutable.
   */
  constructor(
    options: {
      registry: CodecRegistry<Encoded>;
      lenient?: boolean;
      mutable?: boolean;
    },
  ) {
    this.#lenient = options.lenient ?? false;
    this.#mutable = options.mutable ?? false;
    this.#registry = options.registry;
  }

  //
  // Subclass contract
  //

  /**
   * Constructs one act of encoding, around the live environment the caller
   * gave. Called once per `encode()`, and the hook by which a format carries
   * more through its walk than the base class knows about.
   */
  protected abstract newEncodeAct(env: LiveEnvironment): EncAct;

  /**
   * Constructs one act of decoding, around the live environment the caller gave
   * and the form about to be decoded. Called once per `decode()`.
   *
   * `data` is here so that a format whose walk needs something carried in the
   * form itself -- a marker read off an envelope, say -- can take it now. It
   * **sniffs rather than validates**: this runs before anything has checked
   * that `data` is this format's at all, so an implementation reads defensively
   * and leaves the refusing to {@link #encodedFromSerializedForm}.
   */
  protected abstract newDecodeAct(
    env: LiveEnvironment,
    data: SerializedForm,
  ): DecAct;

  //
  // Instance members
  //

  /**
   * Whether a failed `decode()` produces a `ProblematicValue` instead of
   * throwing.
   */
  get lenient(): boolean {
    return this.#lenient;
  }

  /** Whether `decode()` leaves what it builds mutable. */
  get mutable(): boolean {
    return this.#mutable;
  }

  /** Registry consulted for per-type encoding and decoding. */
  get registry(): CodecRegistry<Encoded> {
    return this.#registry;
  }

  /**
   * Encodes a `FabricValue` into this format's serialized form, ready to cross
   * whatever boundary the format exists for.
   *
   * Whether the result identifies itself is the format's to decide, and there
   * are two questions behind that rather than one. A format may answer either,
   * both or neither.
   *
   * **What is this?** A form that is persisted, or that shares a channel with
   * values this system did not write, needs something a receiver can read to
   * tell one of these from anything else arriving. A form constructed, handed
   * straight to a transport and decoded on the far side has less use for it,
   * though a version still buys the receiver a refusal where the two ends
   * might be different builds.
   *
   * **Which parts of this are mine?** A format whose own containers are
   * shaped like containers a payload could hold has to separate the two, or a
   * receiver decodes the payload's data as the format's structure. JSON
   * escapes, reserving a key prefix and rewriting user data that collides
   * with it. A format riding a transport that preserves reference identity
   * can instead mark its own containers with an object the payload cannot
   * hold, and rewrite nothing.
   *
   * The second question is the one that does not go away on a private
   * channel: it is about a single value's own contents, not about what else
   * might arrive.
   *
   * `env` is what a codec would reach the running system through, and is
   * carried on the act this call mints. A caller that names none gets
   * `NULL_LIVE_ENVIRONMENT`, so a codec asking such an environment for a
   * cell fails by name rather than on `undefined`.
   *
   * **The input contract.** `value` must be a valid `FabricValue`, which is
   * the question `isValidFabricValue()` answers. Given one, this encodes, or
   * throws for one of the reasons below.
   * Given anything else, what checking happens is best-effort: nothing on
   * this path spends time on correct input in order to catch incorrect
   * input, so a non-member may encode, may encode to something wrong, or may
   * throw, and which of those it does is not promised. The same license
   * reaches a codec's `canEncode()` and `encode()`, both of which may take a
   * valid `FabricValue` as given.
   *
   * @throws If `value` holds something the format cannot carry: a
   *   `FabricSpecialObject` whose class no codec in the registry claims, a
   *   cycle, or an instance whose class a codec does claim but whose present
   *   state this format cannot write down. A value that is no `FabricValue` at
   *   all falls under the input contract above rather than here.
   */
  encode(
    value: FabricValue,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): SerializedForm {
    const act = this.newEncodeAct(env);

    return act.serializedFromEncoded(act.encodeValue(value));
  }

  /**
   * Decodes this format's serialized form back into a `FabricValue`.
   *
   * `env` supplies what decoding needs beyond the data itself,
   * chiefly the ability to resolve a cell reference.
   *
   * A codec rejects a state it will not accept in one of three ways: by
   * refusing it in `canDecode()`, which this instance asks before dispatching
   * any state, or from `decode()` by throwing or by returning a
   * `ProblematicValue`. Which one it picks is the codec author's business.
   * {@link #lenient} decides what a caller sees, settling all three into the
   * same answer: strictly, any form of rejection raises; leniently, any
   * becomes a `ProblematicValue` in the result.
   *
   * A tag no codec in the registry claims is a different matter, and becomes
   * an `UnknownValue` under both settings. That is not a rejection: it is how
   * a value survives a round trip through a reader that does not know the
   * type.
   *
   * The result is deep-frozen unless {@link #mutable}. A mutable decode
   * leaves mutable every container it builds and every value a codec builds
   * for it, a lenient `ProblematicValue` included; a value frozen by nature,
   * such as a `FabricPrimitive`, is frozen either way.
   *
   * @throws If `data` is not this format's serialized form -- which a format
   *   carrying a marker can tell from the marker alone, and one without can
   *   only tell from finding something it never emits -- or if a codec rejects
   *   a state and this instance is not lenient.
   */
  decode(
    data: SerializedForm,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): FabricValue {
    const act = this.newDecodeAct(env, data);

    try {
      return act.decodeValue(act.encodedFromSerializedForm(data));
    } catch (e) {
      return act.settleThrown(e);
    }
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
