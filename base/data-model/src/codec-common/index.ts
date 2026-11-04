/**
 * This directory holds the codec system's active machinery: the registry that
 * indexes codecs, the lookup that finds a class's codec, the engine base, the
 * per-act encode and decode classes, and the two classes a fault produces. It
 * is also the package's public face for the codec system as a whole,
 * re-exporting the declarations in `codec-interface/` so that an outside caller
 * has one entry point rather than two.
 *
 * That convenience is for callers. A module inside this directory imports the
 * file it wants directly, which is what keeps a module that only needs to name
 * a codec from pulling the machinery in behind it, and is the point of the two
 * directories.
 *
 * Everything here is format-agnostic. Nothing in this directory knows which
 * wire format is in play, and a codec that exists because one particular format
 * cannot carry some type belongs with that format instead: `codec-json/` holds
 * the four that JSON needs.
 *
 * The one abstract base here is `BaseCodecEngine`, what an ENGINE extends, one
 * per wire format -- the thing that walks `FabricValue`s and drives their
 * codecs. What such a value itself extends is a different question with a
 * different answer, and lives in `fabric-bases/`.
 *
 * Besides it, the classes here are `UnknownValue` and `ProblematicValue`, which
 * exist only because a decode found a tag no codec claimed or went wrong
 * outright. A class a caller models data with belongs in `fabric-instances/` or
 * `fabric-primitives/` instead.
 */

export * from "@/codec-interface/index.ts";

export { codecOf } from "./codecOf.ts";
export { isCodecTypeTag } from "./isCodecTypeTag.ts";
export { CodecRegistry } from "./CodecRegistry.ts";
export { BaseCodecAct } from "./BaseCodecAct.ts";
export { BaseCodecEngine } from "./BaseCodecEngine.ts";
export type { CodecEngineConfig } from "./CodecEngineConfig.ts";
export { BaseDecodeAct } from "./BaseDecodeAct.ts";
export { BaseEncodeAct } from "./BaseEncodeAct.ts";

export { ProblematicStateError } from "./ProblematicStateError.ts";
export { ProblematicValue } from "./ProblematicValue.ts";
export { SymbolCodec } from "./SymbolCodec.ts";
export { toReportableState } from "./toReportableState.ts";
export { toReportableTag } from "./toReportableTag.ts";
export { UnknownValue } from "./UnknownValue.ts";
