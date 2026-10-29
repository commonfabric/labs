import { installDebugRenderers } from "@/value-debug-internal.ts";

import { debugStr } from "./debugStr.ts";
import {
  toCompactDebugString,
  toIndentedDebugString,
  toLongQuotedDebugString,
  toShortQuotedDebugString,
  toStructuredDebugValue,
} from "./impl.ts";
import { toDebugKindString } from "./toDebugKindString.ts";

export { debugStr } from "./debugStr.ts";
export * from "./impl.ts";
export { toDebugKindString } from "./toDebugKindString.ts";

// Loading this module is what makes the renderers reachable through
// `value-debug-internal.ts`, which is how the rest of the package reaches them.
installDebugRenderers({
  debugStr,
  toCompactDebugString,
  toDebugKindString,
  toIndentedDebugString,
  toLongQuotedDebugString,
  toShortQuotedDebugString,
  toStructuredDebugValue,
});
