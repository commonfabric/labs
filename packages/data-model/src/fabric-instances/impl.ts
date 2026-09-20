/**
 * The set of concrete instance classes, and what ranges over it and can be
 * derived from it. The set is written out by hand, once, and adding an
 * instance class means editing this file.
 */

import type { Constructor } from "@commonfabric/utils/types";

import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import type { FabricClassWithNonterminalCodec } from "@/codec-interface/interface.ts";

import { FabricError } from "./FabricError.ts";
import { FabricLink } from "./FabricLink.ts";
import { FabricMap } from "./FabricMap.ts";
import { FabricSet } from "./FabricSet.ts";

/**
 * A concrete instance class as this roster holds one: a class, and one binding
 * a format-neutral `[CODEC]`. The second half is what a roster of primitives
 * cannot claim, their codecs being bound per format.
 */
type InstanceCodecClass = Constructor & FabricClassWithNonterminalCodec;

/**
 * The concrete instance classes whose instances are available over the wire,
 * each via its static `[CODEC]`. This is the curated source of truth for which
 * instance types participate in encoding.
 *
 * `UnknownValue` and `ProblematicValue` are included too, and their codecs
 * differ from each other. `UnknownValue`'s has no preferred wire tag -- the
 * encode path uses `tagForValue()` to read each instance's preserved
 * per-instance tag -- and it is not tag-routed on decode, an unrecognized tag
 * being wrapped by the engine rather than decoded via a codec.
 * `ProblematicValue`'s is ordinary in both respects: it declares
 * `Problematic@1` and is tag-routed like any other, the preserved tag riding
 * inside its state because it need not be a tag at all.
 *
 * Returned frozen so callers cannot mutate the shared list.
 */
export function codecClasses(): readonly InstanceCodecClass[] {
  return CODEC_CLASSES;
}

/**
 * The concrete instance classes, each under its own name. This is what ranges
 * over the classes by name without listing them.
 *
 * Returned frozen so callers cannot mutate the shared record.
 */
export function fabricInstanceClassesByName(): FabricInstanceClassesByName {
  return CLASSES_BY_NAME;
}

// The one place the set of classes is written out. The names are property
// keys, which a minifier that renames bindings leaves alone, where a class's
// own `.name` follows its renamed binding.
const CLASSES_BY_NAME = Object.freeze({
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
  ProblematicValue,
  UnknownValue,
});

/** The concrete instance classes keyed by name. */
export type FabricInstanceClassesByName = typeof CLASSES_BY_NAME;

/**
 * One of the concrete instance classes, as a class rather than an instance of
 * one.
 */
export type FabricInstanceClass =
  FabricInstanceClassesByName[keyof FabricInstanceClassesByName];

const CODEC_CLASSES: readonly InstanceCodecClass[] = Object.freeze(
  Object.values(CLASSES_BY_NAME),
);
