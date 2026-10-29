import {
  isTrustedBuilder,
  isTrustedDataHelper,
  TRUSTED_BUILDERS,
  TRUSTED_DATA_HELPERS,
} from "@commonfabric/utils/sandbox-contract";

export {
  isTrustedBuilder,
  isTrustedDataHelper,
  TRUSTED_BUILDERS,
  TRUSTED_DATA_HELPERS,
};

export const SAFE_GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Headers",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Request",
  "RegExp",
  "Response",
  "Set",
  "String",
  "Symbol",
  "TextDecoder",
  "TextEncoder",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone",
  "undefined",
]);

export const TOP_LEVEL_CALL_RESULT_ERROR =
  "Top-level call results must be wrapped in __cf_data() in SES mode";
