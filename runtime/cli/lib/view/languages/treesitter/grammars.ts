import type { TreeSitterGrammar } from "./adapter.ts";
import { cGrammar, cppGrammar } from "../c-family/c-family.ts";
import { cssGrammar } from "../css/css.ts";
import { goGrammar } from "../go/go.ts";
import { hclGrammar } from "../hcl/hcl.ts";
import { htmlGrammar } from "../html/html.ts";
import { kotlinGrammar } from "../kotlin/kotlin.ts";
import { pythonGrammar } from "../python/python.ts";
import { rustGrammar } from "../rust/rust.ts";
import { shellGrammar } from "../shell/shell.ts";
import { starlarkGrammar } from "../starlark/starlark.ts";
import { swiftGrammar } from "../swift/swift.ts";
import { tomlGrammar } from "../toml/toml.ts";

/**
 * Every Tree-sitter grammar the pager can load. The pager itself loads a
 * grammar through the language that uses it. The binary build reads this list
 * to embed only the compiled parser from each grammar's package, which also
 * ships generated C source and native builds that the pager never reads.
 */
export const treeSitterGrammars: readonly TreeSitterGrammar[] = [
  cGrammar,
  cppGrammar,
  cssGrammar,
  goGrammar,
  hclGrammar,
  htmlGrammar,
  kotlinGrammar,
  pythonGrammar,
  rustGrammar,
  shellGrammar,
  starlarkGrammar,
  swiftGrammar,
  tomlGrammar,
];
