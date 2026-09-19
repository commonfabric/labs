// Loaded for its effect, and before anything else here: it installs the debug
// renderers, which the package's modules reach through
// `value-debug-internal.ts`.
import "@/value-debug/index.ts";

export {
  REALM_FORMAT,
  REALM_FORMAT_VERSION,
  type RealmCodecValue,
  type RealmEncodedValue,
  type RealmFormatMarker,
  type RealmTaggedValue,
} from "./interface.ts";

export { createBaseRealmRegistry } from "./createBaseRealmRegistry.ts";
export { RealmCodecEngine } from "./RealmCodecEngine.ts";
