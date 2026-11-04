import { stripJsTrivia } from "./compiled-js-parser.ts";

/**
 * Canonical TypeScript interop helper recognition, shared by the per-module
 * ESM verifier: the compiler emits these helpers inline in each module that
 * uses default/namespace imports or re-exports, and the verifier must accept
 * exactly the canonical forms (and nothing else).
 */

const ALLOWED_TSLIB_HELPERS = new Set([
  "__createBinding",
  "__exportStar",
  "__importDefault",
  "__setModuleDefault",
]);

const IDENT = String.raw`([A-Za-z_$][\w$]*)`;
const CANONICAL_CREATE_BINDING_PATTERN = new RegExp(
  String
    .raw`^var__createBinding=\(this&&this\.__createBinding\)\|\|\(Object\.create\?\(function\(${IDENT},${IDENT},${IDENT},${IDENT}\)\{if\(\4===undefined\)\4=\3;var${IDENT}=Object\.getOwnPropertyDescriptor\(\2,\3\);if\(!\5\|\|\("get"in\5\?!\2\.__esModule:\5\.writable\|\|\5\.configurable\)\)\{\5=\{enumerable:true,get:function\(\)\{return\2\[\3\];\}\};\}Object\.defineProperty\(\1,\4,\5\);\}\):\(function\(\1,\2,\3,\4\)\{if\(\4===undefined\)\4=\3;\1\[\4\]=\2\[\3\];\}\)\);?$`,
);
const CANONICAL_EXPORT_STAR_PATTERNS = [
  new RegExp(
    String
      .raw`^var__exportStar=\(this&&this\.__exportStar\)\|\|function\(${IDENT},${IDENT}\)\{for\(var${IDENT}in\1\)if\(\3!==("default"|'default')&&!Object\.prototype\.hasOwnProperty\.call\(\2,\3\)\)__createBinding\(\2,\1,\3\);\};?$`,
  ),
  new RegExp(
    String
      .raw`^var__exportStar=function\(${IDENT},${IDENT}\)\{for\(var${IDENT}in\1\)if\(\3!==("default"|'default')&&!Object\.prototype\.hasOwnProperty\.call\(\2,\3\)\)__createBinding\(\2,\1,\3\);\};?$`,
  ),
];
const CANONICAL_SET_MODULE_DEFAULT_PATTERN = new RegExp(
  String
    .raw`^var__setModuleDefault=\(this&&this\.__setModuleDefault\)\|\|\(Object\.create\?\(function\(${IDENT},${IDENT}\)\{Object\.defineProperty\(\1,"default",\{enumerable:true,value:\2\}\);\}\):function\(\1,\2\)\{\1\["default"\]=\2;\}\);?$`,
);

/**
 * True when `normalized` (a `normalizeExact`-normalized statement) is one of the
 * canonical TypeScript interop helper declarations the compiler emits
 * (`__importDefault`, `__createBinding`, `__exportStar`, `__setModuleDefault`).
 */
export function isAllowedTsLibHelperDeclaration(normalized: string): boolean {
  const match = normalized.match(/^var([A-Za-z_$][\w$]*)=/);
  if (!match || !ALLOWED_TSLIB_HELPERS.has(match[1])) {
    return false;
  }

  switch (match[1]) {
    case "__importDefault":
      return /^var__importDefault=\(this&&this\.__importDefault\)\|\|function\(\w+\)\{return\(\w+&&\w+\.__esModule\)\?\w+:\{"default":\w+\};\};?$/
        .test(normalized);
    case "__createBinding":
      return CANONICAL_CREATE_BINDING_PATTERN.test(normalized);
    case "__exportStar":
      return CANONICAL_EXPORT_STAR_PATTERNS.some((pattern) =>
        pattern.test(normalized)
      );
    case "__setModuleDefault":
      return CANONICAL_SET_MODULE_DEFAULT_PATTERN.test(normalized);
    default:
      return false;
  }
}

export function normalizeExact(
  source: string,
  start = 0,
  end = source.length,
): string {
  return stripJsTrivia(source, start, end).replace(/\s+/g, "");
}
