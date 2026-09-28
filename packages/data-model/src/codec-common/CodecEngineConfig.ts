import type { CodecRegistry } from "./CodecRegistry.ts";

/**
 * What an act of encoding or decoding reads off the engine that minted it:
 * the settings an engine holds for its whole lifetime, as against the state
 * one act carries for the length of a single call.
 *
 * An act is constructed around one of these rather than around the engine
 * itself. That keeps what an act may read to a named contract instead of the
 * engine's whole surface, and it keeps the two modules independent of each
 * other: an act never imports an engine. `BaseCodecEngine` satisfies this
 * interface, so an engine hands over itself.
 */
export interface CodecEngineConfig<Encoded> {
  /**
   * Whether a decode that fails produces a `ProblematicValue` instead of
   * throwing.
   */
  readonly lenient: boolean;

  /**
   * Whether a decode leaves what it builds mutable. When `false`, a decode's
   * result is deep-frozen; when `true`, every container the decode builds and
   * every value a codec builds for it is left mutable, and only values frozen
   * by nature -- a `FabricPrimitive`, say -- are frozen.
   */
  readonly mutable: boolean;

  /**
   * The codecs this engine encodes and decodes with, and so which classes it
   * can carry.
   */
  readonly registry: CodecRegistry<Encoded>;
}
