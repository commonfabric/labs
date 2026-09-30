import type { TreeSitterGrammar } from "./adapter.ts";
import { kotlinGrammar } from "../kotlin/kotlin.ts";
import { pythonGrammar } from "../python/python.ts";
import { shellGrammar } from "../shell/shell.ts";
import { swiftGrammar } from "../swift/swift.ts";
import { tomlGrammar } from "../toml/toml.ts";

/**
 * Every Tree-sitter grammar the pager can load. The pager itself loads a
 * grammar through the language that uses it. The binary build reads this list
 * to embed only the compiled parser from each grammar's package, which also
 * ships generated C source and native builds that the pager never reads.
 */
export const treeSitterGrammars: readonly TreeSitterGrammar[] = [
  kotlinGrammar,
  pythonGrammar,
  shellGrammar,
  swiftGrammar,
  tomlGrammar,
];
