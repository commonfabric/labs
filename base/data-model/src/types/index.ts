/**
 * The runtime type questions asked of a value: which tag names what it
 * already is, whether a `FabricValue` may be read by name as some shape,
 * whether an `unknown` belongs to the `FabricValue` type at all, and the
 * refusal of a `FabricInstance` where a walk cannot admit one.
 */

export * from "./interface.ts";
export * from "./narrowing.ts";
export * from "./refuseFabricInstance.ts";
export * from "./tag-of.ts";
export * from "./tags.ts";
export * from "./validation.ts";
