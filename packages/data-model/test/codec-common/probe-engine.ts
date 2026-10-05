// A minimal wire format, existing only so that `BaseCodecEngine` can be tested
// as itself.
//
// Going through `JsonCodecEngine` would test the base and JSON's container
// handling together, and for the question these fixtures exist to answer --
// what a terminal codec's state does that a nonterminal one's does not -- JSON
// is nearly blind: where a state is a record of strings, a walk that descends
// into it and one that passes it through emit the same bytes. This format's
// tagged form is a class instead, so "walked" and "not walked" are visibly
// different things.

import type { FabricValue } from "@";
import {
  BaseCodecEngine,
  BaseDecodeAct,
  BaseEncodeAct,
  BaseNonterminalCodec,
  BaseTerminalCodec,
  type CodecForFormat,
  CodecRegistry,
  type LiveEnvironment,
  ProblematicValue,
  type WireFormat,
} from "@/codec-common";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * This format's tagged form. A class, so that it cannot be mistaken for a
 * `FabricValue` -- which is what lets a test see whether a state was walked.
 */
export class Tagged {
  readonly #tag: string;
  readonly #state: ProbeValue;

  constructor(tag: string, state: ProbeValue) {
    this.#tag = tag;
    this.#state = state;
    Object.freeze(this);
  }

  /** The wire type tag. */
  get tag(): string {
    return this.#tag;
  }

  /** The state carried under it. */
  get state(): ProbeValue {
    return this.#state;
  }
}

/** This format's transport tree. */
export type ProbeValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | Marker
  | Tagged
  | readonly ProbeValue[]
  | { readonly [key: string]: ProbeValue };

/** The value the two host codecs nest inside their state. */
export const NESTED = 7n;

/**
 * Codec for {@link NESTED}, whose whole purpose is to sit inside another
 * codec's state. Its input, encoded and decoded forms are three different
 * values, so a test can tell which of them it is looking at.
 */
export class XCodec extends BaseTerminalCodec<ProbeValue> {
  constructor() {
    super("X@1", undefined);
  }

  override canEncode(value: FabricValue): boolean {
    return value === NESTED;
  }

  encode(_value: FabricValue): ProbeValue {
    return "encoded-X";
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return true;
  }

  decode(
    _typeTag: string,
    _state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    return "decoded-X";
  }
}

/** The value the terminal host codec claims. */
export const TERMINAL_HOST = 1;

/** The value the nonterminal host codec claims, whose state is identical. */
export const NONTERMINAL_HOST = "N";

/** What a host codec was handed, recorded so a test can assert on it. */
export type HostRecord = {
  /** States passed to `encode()`. */
  encoded: FabricValue[];

  /** States passed to `decode()`. */
  decoded: unknown[];
};

/** Builds a fresh, empty record. */
export function newRecord(): HostRecord {
  return { encoded: [], decoded: [] };
}

/**
 * Terminal codec whose state holds a value another codec could encode. Being
 * terminal, that nested value is the engine's business to leave alone.
 */
export class TerminalHostCodec extends BaseTerminalCodec<ProbeValue> {
  readonly #record: HostRecord;

  constructor(record: HostRecord) {
    super("T@1", undefined);
    this.#record = record;
  }

  /** What this codec has been handed. */
  get record(): HostRecord {
    return this.#record;
  }

  override canEncode(value: FabricValue): boolean {
    return value === TERMINAL_HOST;
  }

  encode(value: FabricValue): ProbeValue {
    this.#record.encoded.push(value);
    return { inner: NESTED };
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return true;
  }

  decode(
    _typeTag: string,
    state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    this.#record.decoded.push(state);
    return TERMINAL_HOST;
  }
}

/**
 * Nonterminal counterpart to {@link TerminalHostCodec}, returning the very
 * same state. Everything the two do differently is the engine's doing.
 */
export class NonterminalHostCodec extends BaseNonterminalCodec {
  readonly #record: HostRecord;

  constructor(record: HostRecord) {
    super("N@1", undefined);
    this.#record = record;
  }

  /** What this codec has been handed. */
  get record(): HostRecord {
    return this.#record;
  }

  override canEncode(value: FabricValue): boolean {
    return value === NONTERMINAL_HOST;
  }

  encode(value: FabricValue): FabricValue {
    this.#record.encoded.push(value);
    return { inner: NESTED };
  }

  canDecode(_state: FabricValue): _state is FabricValue {
    return true;
  }

  decode(
    _typeTag: string,
    state: FabricValue,
    _env: LiveEnvironment,
  ): FabricValue {
    this.#record.decoded.push(state);
    return NONTERMINAL_HOST;
  }
}

/**
 * Codec that rejects a state by THROWING. Reachable by tag only: nothing
 * encodes to it, since what it exists to exercise is the decode side.
 */
export class ThrowingCodec extends BaseTerminalCodec<ProbeValue> {
  constructor() {
    super("Throws@1", undefined);
  }

  override canEncode(_value: FabricValue): boolean {
    return false;
  }

  encode(_value: FabricValue): ProbeValue {
    throw new Error("Shouldn't happen: this codec never encodes.");
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return true;
  }

  decode(
    _typeTag: string,
    _state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    throw new Error("rejected by throwing");
  }
}

/**
 * Codec that rejects a state by RETURNING a `ProblematicValue`, which is the
 * other way the spec sanctions. Its counterpart above returns nothing and
 * throws; the engine is what makes the two indistinguishable to a caller.
 */
export class RejectingCodec extends BaseTerminalCodec<ProbeValue> {
  constructor() {
    super("Rejects@1", undefined);
  }

  override canEncode(_value: FabricValue): boolean {
    return false;
  }

  encode(_value: FabricValue): ProbeValue {
    throw new Error("Shouldn't happen: this codec never encodes.");
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return true;
  }

  decode(
    typeTag: string,
    state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    return new ProblematicValue(
      typeTag,
      state as FabricValue,
      "rejected by returning",
    );
  }
}

/**
 * Codec that rejects a state by REFUSING it in `canDecode()`, which is the
 * third way. Reachable by tag only: nothing encodes to it, since what it
 * exists to exercise is the decode side.
 */
export class RefusingCodec extends BaseTerminalCodec<ProbeValue> {
  constructor() {
    super("Refuses@1", undefined);
  }

  override canEncode(_value: FabricValue): boolean {
    return false;
  }

  encode(_value: FabricValue): ProbeValue {
    throw new Error("Shouldn't happen: this codec never encodes.");
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return false;
  }

  decode(
    _typeTag: string,
    _state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    throw new Error("Shouldn't happen: nothing gets past `canDecode()`.");
  }
}

/**
 * A value that is an OBJECT and is claimed by a codec. The primitive-keyed
 * codecs above cannot stand in for it: the engine's cycle bookkeeping only
 * engages for an object, so nothing else reaches it.
 */
export class Marker {
  readonly #note: string;

  constructor(note: string = "m") {
    this.#note = note;
    Object.freeze(this);
  }

  /** A label, so that two markers can be told apart. */
  get note(): string {
    return this.#note;
  }
}

/**
 * Codec for {@link Marker}, reached by class rather than by primitive type.
 * Its `decode()` returns a MUTABLE nested object on purpose: every other codec
 * here returns a primitive, which is deep-frozen whatever the engine does, and
 * so cannot witness the freeze the engine promises.
 */
export class MarkerCodec extends BaseTerminalCodec<ProbeValue> {
  constructor() {
    super("M@1", Marker as unknown as new (...args: never[]) => object);
  }

  encode(_value: FabricValue): ProbeValue {
    return "m";
  }

  canDecode(_state: ProbeValue): _state is ProbeValue {
    return true;
  }

  decode(
    _typeTag: string,
    _state: ProbeValue,
    _env: LiveEnvironment,
  ): FabricValue {
    return { deep: { n: 1 } };
  }
}

/**
 * One act of encoding in the probe format, whose transport tree is what
 * crosses: there is nothing to convert on the way out. Its containers do the
 * least a container can do, so that what a test observes is the base class and
 * not this.
 */
export class ProbeEncodeAct extends BaseEncodeAct<ProbeValue> {
  /** @inheritDoc */
  override serializedFromEncoded(encoded: ProbeValue): ProbeValue {
    return encoded;
  }

  /** @inheritDoc */
  protected override wrapTag(tag: string, state: ProbeValue): ProbeValue {
    return new Tagged(tag, state);
  }

  /** @inheritDoc */
  protected override encodeArray(value: readonly FabricValue[]): ProbeValue {
    this.enter(value);
    try {
      return value.map((v) => this.encodeValue(v));
    } finally {
      this.leave(value);
    }
  }

  /** @inheritDoc */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
  ): ProbeValue {
    this.enter(value);
    try {
      const result: Record<string, ProbeValue> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.encodeValue(v);
      }
      return result;
    } finally {
      this.leave(value);
    }
  }
}

/**
 * One act of decoding in the probe format.
 *
 * Cycles are guarded, unlike the JSON format's: this format's transport is the
 * tree itself, so a caller can hand `decode()` a graph with a cycle in it, and
 * the guard is what refuses one.
 */
export class ProbeDecodeAct extends BaseDecodeAct<ProbeValue> {
  /**
   * @inheritDoc
   *
   * The tree is what arrives, so there is nothing to convert and nothing this
   * format can tell is not its own: any value at all is a candidate.
   */
  override encodedFromSerializedForm(data: ProbeValue): ProbeValue {
    return data;
  }

  /** @inheritDoc */
  override decodeValue(data: ProbeValue): FabricValue {
    if (!isObjectOrArray(data)) {
      return data as FabricValue;
    }

    // Every object node goes through the guard, the tagged form included: this
    // format's transport is the tree itself, so a `Tagged` can hold a
    // reference back to a node above it with no container in between.
    const cycle = this.enterOrReport(data);
    if (cycle !== null) {
      return cycle;
    }

    try {
      if (data instanceof Tagged) {
        return this.decodeTagged(data.tag, data.state);
      } else if (Array.isArray(data)) {
        return data.map((d) => this.decodeValue(d));
      }

      const result: Record<string, FabricValue> = {};
      for (const [k, v] of Object.entries(data)) {
        result[k] = this.decodeValue(v as ProbeValue);
      }
      return result;
    } finally {
      this.leave(data);
    }
  }
}

/**
 * The engine, which is its configuration and the two act factories: everything
 * a test observes about a walk belongs to the acts above.
 */
export class ProbeEngine extends BaseCodecEngine<
  ProbeValue,
  ProbeValue,
  ProbeEncodeAct,
  ProbeDecodeAct
> {
  /** @inheritDoc */
  protected override newEncodeAct(env: LiveEnvironment): ProbeEncodeAct {
    return new ProbeEncodeAct(this, env);
  }

  /** @inheritDoc */
  protected override newDecodeAct(
    env: LiveEnvironment,
    _data: ProbeValue,
  ): ProbeDecodeAct {
    return new ProbeDecodeAct(this, env);
  }
}

/** The primitive types the probe registry makes self-representing. */
const SELF_REP_TYPE_NAMES = [
  "null",
  "boolean",
  "number",
  "string",
  "bigint",
] as const;

/** One of {@link SELF_REP_TYPE_NAMES}. */
type SelfRepTypeName = typeof SELF_REP_TYPE_NAMES[number];

/**
 * This format, as a `CodecRegistry` needs one. Its symbol is its own: nothing
 * binds a codec under it, since every codec here is registered directly.
 */
const PROBE_FORMAT: WireFormat<ProbeValue> = Object.freeze({
  codecSymbol: Symbol("test.probeFormatCodec"),
});

/**
 * Builds an engine over a registry carrying the three codecs above, plus the
 * self-representing primitives a walk needs to get anywhere, less any that
 * `omitSelfRep` names.
 */
export function newProbeEngine(
  options?: {
    lenient?: boolean;
    record?: HostRecord;
    extraCodecs?: readonly CodecForFormat<ProbeValue>[];
    omitSelfRep?: readonly SelfRepTypeName[];
  },
): {
  engine: ProbeEngine;
  record: HostRecord;
  registry: CodecRegistry<ProbeValue>;
} {
  const record = options?.record ?? newRecord();
  const registry = new CodecRegistry<ProbeValue>(PROBE_FORMAT);

  // Registered by primitive type, which is how `codecFromValue()` reaches a
  // codec for a value that is not an instance of a class it names. Each claims
  // exactly one value of its type, so every other value of that type falls
  // through to self-representation below -- which the registry tries second.
  registry.registerPrimitive("bigint", new XCodec());
  registry.registerPrimitive("number", new TerminalHostCodec(record));
  registry.registerPrimitive("string", new NonterminalHostCodec(record));
  registry.register(new MarkerCodec());
  registry.register(new ThrowingCodec());
  registry.register(new RejectingCodec());
  registry.register(new RefusingCodec());
  for (const t of SELF_REP_TYPE_NAMES) {
    if (!options?.omitSelfRep?.includes(t)) {
      registry.registerSelfRep(t);
    }
  }
  for (const codec of options?.extraCodecs ?? []) {
    registry.register(codec);
  }
  Object.freeze(registry);

  return {
    registry,
    engine: new ProbeEngine({ registry, lenient: options?.lenient ?? false }),
    record,
  };
}
