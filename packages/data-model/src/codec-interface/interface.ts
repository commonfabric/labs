/**
 * The codec layer's contracts, written without naming any wire format: what a
 * codec is, the two things its state can mean to a walker, and what an
 * encode or a decode carries alongside the data.
 *
 * The distinction running through all of it is that a codec's type does not
 * say what its state is for. Every codec has the same members whatever domain
 * it works in, and the domains overlap, so which kind a codec is has to be
 * declared by the base class it extends rather than inferred from its
 * signature. Everything downstream -- what a registry will accept, how a
 * walker dispatches -- reads that declaration.
 */

import type { Constructor } from "@commonfabric/utils/types";

import type { FabricInstance, FabricValuePlus } from "@/interface.ts";

/**
 * Well-known symbol for binding the getter
 * `FabricClassWithNonterminalCodec[CODEC]`.
 */
export const CODEC: unique symbol = Symbol("data-model.codec");

/**
 * Well-known symbol for binding the static getter `[JSON_CODEC]` on a
 * `FabricPrimitive` class.
 *
 * No interface declares that obligation, and none can: {@link CodecRegistry}
 * reads a per-format codec through a symbol _variable_, so it must type a
 * class as `Partial<Record<symbol, ...>>`, which no fixed-symbol interface
 * satisfies. The obligation is enforced when a registry is built instead --
 * `registerClass()` throws for a class supplying no codec for the format in
 * play. {@link FabricClassWithNonterminalCodec} can exist only because
 * {@link CODEC} is statically known.
 *
 * A `FabricPrimitive`'s codec is bound per wire format, not once for all of
 * them, because these classes are where the formats disagree. `FabricBytes`
 * encodes to a base64url string, which is JSON's answer and nobody else's: a
 * format that carries bytes natively wants a different codec, or none, and
 * says so by looking up a different symbol.
 *
 * What differs can be the _kind_ of codec and not merely the state it
 * produces, which is why the binding is per format rather than a property of
 * the class. `FabricRegExp` expands into a record of strings under JSON,
 * which has no pattern type of its own to terminate into.
 *
 * That is what separates these from a `FabricInstance`'s codec, bound to the
 * generic `[CODEC]`: an instance's codec only expands an instance into other
 * `FabricValue`s and leaves every terminal decision to whatever walks the
 * result, so one binding serves every format.
 */
export const JSON_CODEC: unique symbol = Symbol("data-model.jsonCodec");

/**
 * Well-known symbol for binding the static getter `[REALM_CODEC]` on a
 * `FabricPrimitive` class.
 *
 * The realm-crossing counterpart to {@link JSON_CODEC}, and the reason that
 * one is bound per format rather than once. Structured cloning carries bytes
 * and `bigint` as themselves, so a class built on either has an answer here
 * that JSON cannot express: `FabricBytes` terminates into an `ArrayBuffer`
 * rather than base64url text, and both epoch types into a `bigint` rather
 * than a base64url encoding of one.
 *
 * A class binding a format-neutral `[CODEC]` needs nothing here. Every
 * `FabricInstance` is in that position, its codec expanding an instance into
 * other `FabricValue`s and leaving every terminal decision to whatever walks
 * the result.
 */
export const REALM_CODEC: unique symbol = Symbol("data-model.realmCodec");

/**
 * Interface for codecs (encoder-decoder objects). These are objects which can
 * extract "essential state" out of values (objects per se or otherwise) and
 * also take such "essential state" and produce values that are equivalent (in
 * a context-dependent sense) to the values that state was extracted from.
 *
 * `PlusType` is what the values this codec works on may hold beyond
 * `FabricValue`: the value side of every member is `FabricValuePlus<PlusType>`,
 * so a codec at `never` works over `FabricValue` exactly. `Encoded` is the
 * domain that essential state lives in. Every codec has the same shape
 * whatever those two are -- the same matching members, the same pair of
 * transformations -- and they are the only things that vary. {@link
 * NonterminalCodec} and {@link TerminalCodec} name the two ways the pair is
 * instantiated in practice, and are where the consequences are written down.
 *
 * The domain does not by itself say what the codec system should do with a
 * state, and it cannot: the domains overlap, in that an all-string record
 * satisfies `FabricValue` and JSON's value type alike. That is settled instead
 * by which base class a codec extends, which is where it stays: a registry
 * refuses a codec extending neither and otherwise stores it unaltered, and a
 * walker reads the class when it dispatches.
 */
export interface FabricCodec<PlusType, Encoded> {
  /**
   * The unique _direct_ class of instances, if any, that is associated with the
   * format this instance encodes. The codec system uses this to make a quick
   * determination about value compatibility before calling {@link #canEncode}
   * to confirm.
   */
  get uniqueHandledClass(): Constructor | undefined;

  /**
   * The unique wire format tag that is associated with the format this instance
   * decodes from, or `undefined` for a codec with no single tag. When defined,
   * the codec system uses it to mark state produced by {@link #encode} and (by
   * default) routes state so marked back to this instance (or an equivalent)
   * for decoding; a codec with no tag is not registered for tag-based decode
   * dispatch.
   */
  get recognizedTypeTag(): string | undefined;

  /**
   * Returns `true` if this handler can encode the state of the given value.
   *
   * May take `value` as a valid `FabricValuePlus<PlusType>`; see
   * `BaseCodecEngine.encode()` for the input contract that makes that safe to
   * assume.
   */
  canEncode(value: FabricValuePlus<PlusType>): boolean;

  /**
   * Returns `true` if the given state is one this codec knows how to decode:
   * the decode side's counterpart to {@link #canEncode}, answering the same
   * kind of question about whether a value is in the domain this codec works
   * over.
   *
   * What belongs here is what is cheap to ask and not already asked by the
   * decoding: the state's type, the presence and types of the parts a decode
   * reads, membership in a fixed set of literals. What does not belong is a
   * check whose only implementation is the decode itself. Whether a string is
   * valid base64 is answered by decoding it, so asking here costs that work
   * twice; {@link #decode} keeps such a question and is where a state failing
   * it is refused.
   *
   * An implementation states this as a type predicate over its own state type,
   * which is what lets its {@link #decode} declare that same type and read the
   * state's parts without re-checking them. See {@link BaseFabricCodec}.
   *
   * Called on every state before {@link #decode} sees it, so an implementation
   * of the latter may take the check as done.
   */
  canDecode(state: Encoded): boolean;

  /**
   * Returns the wire type tag to use when encoding the given value. Only ever
   * called on a value for which {@link #canEncode} has returned `true`. Unlike
   * {@link #recognizedTypeTag} -- the codec's single recognized tag, if it has
   * one -- this is the concrete tag for a _specific_ value; a codec whose
   * instances each carry their own per-instance tag reads it from the value.
   */
  tagForValue(value: FabricValuePlus<PlusType>): string;

  /**
   * Decodes a value from the given essential state, which is (alleged /
   * supposed) to be a value that was produced by an earlier call to {@link
   * #encode} on a compatible class to this one. The result is expected to be a
   * _shallow_ decoding; the codec system handles recursively converting `state`
   * contents as necessary.
   *
   * The given `typeTag` is what was associated with the given `state` and does
   * not necessarily correspond to {@link #recognizedTypeTag} (depending on how
   * an instance of this class got hooked up).
   *
   * Only ever called on a state for which {@link #canDecode} has returned
   * `true`, which is the decode side's counterpart to the way {@link
   * #canEncode} precedes {@link #encode}. That is what lets an implementation
   * declare the narrower state type it actually decodes and read its parts as
   * such. `state` is the whole of `Encoded` here because this interface is what
   * a registry holds, and the codecs in one agree on nothing narrower.
   *
   * A `state` need not come from {@link #encode}, so an implementation which
   * keeps a container from `state` as part of the value it builds may do so
   * only when that container is frozen and the value is to be frozen. Anything
   * else it keeps, it copies.
   */
  decode(
    typeTag: string,
    state: Encoded,
    env: LiveEnvironment,
  ): FabricValuePlus<PlusType>;

  /**
   * Encodes the given value, returning its essential state. This is only ever
   * called after {@link #canEncode} has confirmed that `value` is encodable by
   * this instance. The result is expected to be a _shallow_ encoding; the
   * codec system handles recursion as necessary.
   *
   * Two things an implementation may take as given: that `value` is a valid
   * `FabricValuePlus<PlusType>`, and that this instance's own {@link
   * #canEncode} has returned `true` for it. Re-checking either is work spent
   * on input that is correct by contract; see `BaseCodecEngine.encode()`.
   *
   * `env` is what a codec reaches the running system through, the same one
   * {@link #decode} is handed.
   *
   * The result is a snapshot of `value`: it represents `value`'s internal
   * state as frozen data, and its external references as themselves, with
   * their frozenness left as it is. This holds whether or not `value` is
   * itself frozen. A mutable value's internal state is copied into the result,
   * never frozen in place, and a result may be cached so long as it is dropped
   * when the value changes. A value whose state effectively is an external
   * reference may return that reference as itself, frozen or not; so a caller
   * must not freeze a result in place, or otherwise change it.
   */
  encode(value: FabricValuePlus<PlusType>, env: LiveEnvironment): Encoded;
}

/**
 * A codec whose essential state is **nonterminal**: it is itself made of
 * `FabricValuePlus<PlusType>`s, which the walker goes on to expand in turn.
 * The sense is the one formal grammars give the word -- a state that arrives
 * here is not an answer but something that must be rewritten further before it
 * is one.
 *
 * Instantiating {@link FabricCodec} with its state domain equal to its value
 * domain is what says so: a state of that type is exactly what the walker
 * takes as input, so handing it one is handing it more work of the kind it
 * already does. A codec of this kind therefore settles nothing about how those
 * values are ultimately written down, and one instance serves every wire
 * format.
 *
 * `PlusType` is what the instances this codec exposes may hold, and its state
 * holds the same. At `never`, the default, both sides are `FabricValue`, which
 * is the one kind a wire format's registry takes. At any other `PlusType` the
 * codec exposes an instance's contents, that type included, to a walker that
 * admits it, and has no wire form.
 *
 * `FabricError` is the clearest case. Its state carries `cause` and every
 * `extraEntries()` pair, so it can hold arbitrary nested values -- including
 * other instances -- and only the walker can know what to do with them.
 */
export type NonterminalCodec<PlusType = never> = FabricCodec<
  PlusType,
  FabricValuePlus<PlusType>
>;

/**
 * A codec whose essential state is **terminal**: it is already in the domain of
 * one particular wire format, and the walker passes it through rather than
 * expanding it further.
 *
 * Instantiating {@link FabricCodec} at a format's own value type is what says
 * so. Such a codec is bound to that one format, and a class needing one
 * supplies a separate instance per format it participates in.
 *
 * `FabricBytes` is the clearest case: JSON's codec produces a base64url string,
 * where a format that carries bytes natively wants the bytes themselves, and no
 * one codec can answer both.
 *
 * The difference between the two kinds is not in the shape of a codec -- both
 * have the same members -- but in what its state means to the walker. A class
 * declares which it is by the base class it extends, and that declaration is
 * the only record of it.
 *
 * `Encoded` ranges over the wire formats' own value types. `FabricValue` is not
 * among them, and instantiating at it is unsound; see {@link
 * BaseTerminalCodec}.
 *
 * The value side is at `never`: a wire format carries `FabricValue`s, and a
 * value holding anything beyond those has no wire form to terminate into.
 */
export type TerminalCodec<Encoded> = FabricCodec<never, Encoded>;

/**
 * A codec usable for the wire format whose value type is `Encoded`: either
 * kind serves. A terminal codec serves that format alone, a nonterminal one
 * serves every format, and both are "for" this one. This is what a mixed
 * roster holds, what {@link CodecRegistry} stores, and what it hands back.
 *
 * Writing the union out is unavoidable. {@link FabricCodec} is covariant in
 * `Encoded`: its members are methods, whose parameters TypeScript compares
 * bivariantly, so the return position of `encode()` is what decides, and a
 * codec is assignable to an instantiation at a wider `Encoded` and to none at
 * a narrower one. `FabricValue` is a subtype of no format's value type, so a
 * `NonterminalCodec` is assignable to no format's instantiation, and the two
 * arms have to be named separately.
 *
 * The nonterminal arm is at `never`, the one `PlusType` with a wire form. That
 * is a claim about what a registry holds, not a check on what a class binds:
 * {@link CodecRegistry} reads a class's `[CODEC]` through a cast, so a codec at
 * another `PlusType` registers as this type, and what refuses its state is the
 * encode walk, which finds a value no codec claims.
 */
export type CodecForFormat<Encoded> =
  | NonterminalCodec
  | TerminalCodec<Encoded>;

/**
 * A wire format, as {@link CodecRegistry} needs to know one: the type its
 * encoded states live in, and the symbol under which a class binds its codec
 * for this format.
 *
 * The two travel together because they name the same format, and a registry
 * given one of each separately could be given a mismatched pair. `Encoded`
 * appears in no member, so a descriptor is written with its type stated rather
 * than inferred from its contents.
 *
 * The symbol arrives as data rather than being known here, which is what keeps
 * this module from naming any particular format.
 */
export interface WireFormat<Encoded> {
  /**
   * Symbol under which a class binds the codec it supplies for this format.
   * Consulted only when the class binds no format-neutral `[CODEC]`, which
   * wins where a class has both.
   */
  readonly codecSymbol: symbol;
}

/**
 * Interface for classes that provide a `NonterminalCodec` which is guaranteed
 * to operate on instances of the class. Binding here is the claim that one
 * codec serves every wire format. A class the formats want to treat
 * differently -- in the state produced, in the kind of codec, or both -- binds
 * one per format under that format's own symbol instead.
 *
 * `PlusType` is the class's own: a class whose instances are
 * `FabricInstancePlus<PlusType>` binds its codec at that same `PlusType`, so
 * that the state the codec exposes is typed for what the instances hold.
 * `codecOf()` types its result on that agreement and does not check it.
 */
export interface FabricClassWithNonterminalCodec<PlusType = never> {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): NonterminalCodec<PlusType>;
}

/**
 * The minimal interface that codec `encode()` and `decode()` implementations
 * may depend on: what a codec needs of the live system around it, and nothing
 * more. This package names what it requires rather than the classes that
 * happen to supply it, so a client brings its own. `BaseLiveEnvironment` is
 * the base to build one on, and `NullLiveEnvironment` covers a caller that
 * expects to need no cell. See Section 2.5 of the formal spec.
 */
export interface LiveEnvironment {
  /**
   * Resolves a cell reference, for a type that needs to intern or look up an
   * existing instance during decoding.
   */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  /**
   * Signals whether a decode call should produce a deep-frozen result: `true`
   * means the decoded value should be deep-frozen, `false` means a mutable
   * result is acceptable. Same contract as `frozen` passed to
   * `cloneIfNecessary()` (see `value-clone.ts`): `shouldDeepFreeze === true`
   * corresponds to `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every live environment declares it, and gets it
   * for free by extending `BaseLiveEnvironment`, which centralizes the getter;
   * the `cloneIfNecessary`-style `true` default lives there.
   *
   * Enforcement: a decode deep-freezes its result, and a codec that builds a
   * value cheaper when it may stay thawed reads this to decide, producing a
   * deep-frozen result when it is `true`.
   */
  get shouldDeepFreeze(): boolean;
}
