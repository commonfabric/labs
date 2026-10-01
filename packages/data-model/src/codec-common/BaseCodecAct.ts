import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";

import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import type { CodecEngineConfig } from "./CodecEngineConfig.ts";
import type { CodecRegistry } from "./CodecRegistry.ts";

/**
 * What one act of encoding or decoding holds, whether it encodes or decodes:
 * the configuration of the engine that minted it, the live environment the
 * caller supplied, and the values whose walk is in progress.
 *
 * An engine mints one of these per call to a public entry point, through a
 * factory its subclass supplies. Per call rather than per engine, because an
 * engine may be re-entered: a codec can reach back through a public entry
 * point while a walk is already running, and state held on the engine would
 * be shared between the two.
 *
 * The environment is held here rather than threaded beside the act through
 * every walk method, because every such method needs both. An engine whose
 * caller named no environment passes the null one, which fails by name when
 * asked for a cell.
 *
 * What each subclass adds is its own discipline for entering a value, the
 * two differing in what a repeat visit means. See {@link #tryEnter}.
 */
export abstract class BaseCodecAct<Encoded> {
  readonly #config: CodecEngineConfig<Encoded>;

  readonly #env: LiveEnvironment;

  /**
   * The values whose walk is in progress, or `undefined` before the first one
   * is entered.
   */
  #seen: IndexTrackingStack<object> | undefined;

  /** Constructs an instance. */
  constructor(config: CodecEngineConfig<Encoded>, env: LiveEnvironment) {
    this.#config = config;
    this.#env = env;
  }

  //
  // Instance members
  //

  /** The live environment this act was given. */
  get env(): LiveEnvironment {
    return this.#env;
  }

  /**
   * Leaves the given value, its walk being finished. It has to be the value
   * most recently entered, entering and leaving nesting strictly, which is
   * what the subclass contract asks of an implementation.
   *
   * @throws If the value is not the one most recently entered.
   */
  leave(value: object): void {
    this.#seen?.popExpect(value);
  }

  /** The configuration of the engine that minted this act. */
  protected get config(): CodecEngineConfig<Encoded> {
    return this.#config;
  }

  /**
   * The codecs this act encodes or decodes with. Named here as well as on the
   * configuration because the walk consults it constantly.
   */
  protected get registry(): CodecRegistry<Encoded> {
    return this.#config.registry;
  }

  /**
   * Enters a value, and returns whether it was entered. What a repeat visit
   * means is up to the caller, so each subclass wraps this with its own
   * reading: encoding refuses a cycle outright, where decoding reports one.
   *
   * The stack behind this is created here rather than in the constructor, so
   * that walking a lone self-representing value -- much the commonest case,
   * and the one where a fixed cost shows up most -- allocates nothing beyond
   * the act itself.
   *
   * @returns `true` if `value` was entered, `false` if it was already in
   *   progress.
   */
  protected tryEnter(value: object): boolean {
    const seen = this.#seen ??= new IndexTrackingStack<object>();

    if (seen.has(value)) {
      return false;
    }

    seen.push(value);
    return true;
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
