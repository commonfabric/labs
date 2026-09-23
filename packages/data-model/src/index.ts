export { fabricAwareEqual, valueEqual } from "@/comparison";

export {
  deepFreeze,
  isDeepFrozen,
  isValidDeepFrozenFabricValue,
} from "./deep-freeze.ts";

export * from "./interface.ts";

export {
  convertibleJsFromFabricValue,
  fabricFromConvertibleJsValue,
  isValidFabricConvertibleJsValue,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromConvertibleJsObjectElseUndefined,
  shallowFabricFromConvertibleJsValue,
} from "./convertible-js.ts";

export {
  cloneForMutation,
  CloneForMutationError,
  type CloneForMutationErrorKind,
  type CloneForMutationOptions,
  type CloneForMutationResult,
  cloneIfNecessary,
  type CloneOptions,
  cloneWithoutValueAtPath,
  cloneWithValueAtPath,
  shallowMutableClone,
} from "./value-clone.ts";

// Not `@/value-debug`, which names late-bound forwarders: the package should
// export the renderers themselves, and naming them here is what loads them.
export {
  debugStr,
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
  toLongQuotedDebugString,
  toShortQuotedDebugString,
  toStructuredDebugValue,
} from "@/value-debug/index.ts";

export {
  getFrozenObjectHashCacheHits,
  hashOf,
  hashStringOf,
  taggedHashStringOf,
} from "./value-hash.ts";

export * from "@/types";
