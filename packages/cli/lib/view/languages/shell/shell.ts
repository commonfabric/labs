import "tree-sitter-bash/package.json" with { type: "json" };

import type { TreeSitterGrammar } from "../treesitter/adapter.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
(comment) @comment

[
  (string) (raw_string) (ansi_c_string) (translated_string)
  (heredoc_start) (heredoc_body) (heredoc_end)
] @string
(regex) @regex
(extglob_pattern) @regex
[(number) (file_descriptor)] @number

(function_definition name: (word) @functionName)
((command_name) @controlKeyword
  (#any-of? @controlKeyword "break" "continue" "exit" "return"))
(command_name) @callName
[(variable_name) (special_variable_name)] @propertyName

; The delimiters of a substitution or expansion hold a dollar sign, and a case
; pattern's parenthesis need not have a partner, so none of them are brackets
; that nest.
(case_item ["(" ")"] @punctuation)
(command_substitution ["$(" "\`" ")"] @punctuation)
(process_substitution ["<(" ">(" ")"] @punctuation)
(arithmetic_expansion ["$((" "$[" "))" "]"] @punctuation)
(expansion ["\${" "}"] @punctuation)
"$" @punctuation

["declare" "export" "function" "local" "readonly" "typeset"] @storageKeyword
[
  "case" "do" "done" "elif" "else" "esac" "fi" "for" "if" "in" "select" "then"
  "until" "while"
] @controlKeyword
["unset" "unsetenv"] @keyword

(test_operator) @operator
[
  "!" "!=" "%" "%=" "&&" "&=" "&>" "&>>" "*" "**" "**=" "*=" "+" "++" "+="
  "-" "--" "-=" "/" "/=" "<" "<&" "<&-" "<<" "<<-" "<<<" "<<=" "<=" "=" "=="
  "=~" ">" ">&" ">&-" ">=" ">>" ">>=" ">|" "^" "^=" "|" "|&" "|=" "||" "~"
  "-a" "-o" "?"
] @operator
(expansion [
  "#" "##" "%" "%%" ":" ":+" ":-" ":=" ":?" "/" "//" "/#" "/%" "," ",," "^"
  "^^" "@"
] @operator)

["(" ")" "((" "))" "[" "]" "[[" "]]" "{" "}"] @bracket
[";" ";;" ";&" ";;&" "&" "\`"] @punctuation
`;

/**
 * Bash and POSIX shell for the pager, on the shared Tree-sitter adapter: the
 * highlight query that names a token class for each piece of syntax, and the
 * rule that makes each function definition a structure entry. Loading,
 * coloring, incremental editing, and the structure walk are the adapter's.
 *
 * A heredoc's body is colored as a string, with the expansions an unquoted
 * delimiter allows colored inside it. No other language is guessed for it.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used, because its capture names are not the pager's token classes.
 */
export const shellGrammar: TreeSitterGrammar = {
  id: "bash",

  wasmUrl: () => import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  structureEntry(node) {
    if (node.type !== "function_definition") return undefined;
    const name = node.childForFieldName("name");
    return name === null ? undefined : {
      kind: "function",
      label: node.firstChild?.type === "function"
        ? `function ${name.text}`
        : `${name.text}()`,
      name: name.text,
      nameOffset: name.startIndex,
    };
  },
};
