import { CodecRegistry, SymbolCodec } from "@/codec-common";
import { REALM_FORMAT, type RealmCodecValue } from "./interface.ts";

/**
 * Creates a registry holding this format's determination about JavaScript's
 * primitive types, and nothing else. It registers no fabric class, so a
 * registry from here encodes no `FabricSpecialObject` and decodes every fabric
 * wire tag to an `UnknownValue`; registering the classes that participate is a
 * caller's job.
 *
 * Where JSON has to tag four of the seven primitive types, this format tags
 * one. Structured cloning carries `bigint`, `undefined`, and the special
 * numbers (`-0`, `NaN`, `±Infinity`) as themselves, so each of those is
 * self-representing here; only `symbol` needs an encoding, cloning having
 * refused it.
 *
 * `number` is therefore registered one way rather than JSON's two: there is no
 * special-number codec to try first, the whole of the type being its own wire
 * form.
 *
 * The result is frozen, so add classes with `CodecRegistry.extend()` rather
 * than by registering onto it.
 */
export function createBaseRealmRegistry(): CodecRegistry<RealmCodecValue> {
  const registry = new CodecRegistry<RealmCodecValue>(REALM_FORMAT);

  // The one JS primitive that needs a tagged encoding, registered by `typeof`.
  registry.registerPrimitive(
    "symbol",
    new SymbolCodec<RealmCodecValue>((key) => key),
  );

  // Self-representing primitives: emitted as-is, being their own wire form.
  registry.registerSelfRep("null");
  registry.registerSelfRep("undefined");
  registry.registerSelfRep("boolean");
  registry.registerSelfRep("number");
  registry.registerSelfRep("bigint");
  registry.registerSelfRep("string");

  Object.freeze(registry);
  return registry;
}
