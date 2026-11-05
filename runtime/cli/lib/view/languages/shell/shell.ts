import "tree-sitter-bash/package.json" with { type: "json" };

import type { SyntaxNode, TreeSitterGrammar } from "../treesitter/adapter.ts";

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
 * The grammar reads a comment to the end of its line. A comment inside a
 * backtick command substitution ends at the backtick that closes the
 * substitution, as it does in the shell, and the code after it is colored as
 * code, where the parse pairs the backticks before the comment as the shell
 * does. Where it does not, as when the grammar reads two substitutions on one
 * line as one, the comment runs to the end of its line. Inside `$(…)` that is
 * not itself inside backticks, a comment runs to the end of its line, as it
 * does in the shell.
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

  // A backtick substitution runs to the next unescaped backtick, whatever it
  // holds, so a comment inside one ends at the first unescaped backtick in it.
  shortComments: {
    next(root, source, from) {
      // The comments that hold an unescaped backtick, each ending at the
      // first. The walk enters only the nodes that hold one of them.
      const pending = root.descendantsOfType("comment", from).flatMap(
        (comment) => {
          const [backtick] = unescapedBackticks(comment.text);
          return backtick === undefined ? [] : [{
            start: comment.startIndex,
            end: comment.startIndex + backtick,
          }];
        },
      );
      let waiting = 0;
      const errors = new Map<number, number[]>();
      const stack = [enter(root)];
      while (stack.length > 0) {
        const place = stack[stack.length - 1];
        const child = place.children[place.next++];
        if (child === undefined) {
          stack.pop();
          continue;
        }
        const previous = place.previous;
        place.previous = child;
        if (child.endIndex <= from.index) continue;
        while (
          waiting < pending.length && pending[waiting].start < child.startIndex
        ) {
          waiting++;
        }
        const comment = pending[waiting];
        if (comment === undefined) return undefined;
        if (comment.start >= child.endIndex) continue;
        if (child.type !== "comment") {
          if (child.childCount > 0) stack.push(enter(child, place));
        } else {
          const inside = insideBackticks(
            child,
            place,
            previous,
            source,
            errors,
          );
          if (inside !== false) return inside ? comment : undefined;
        }
      }
      return undefined;
    },
  },
};

/** A node the walk for short comments is inside, and what it has passed. */
interface Place {
  readonly children: SyntaxNode[];

  /** The index of the next child to visit. */
  next: number;

  /** The child visited last. */
  previous: SyntaxNode | undefined;

  /** The node, when it is an error. */
  readonly error: SyntaxNode | undefined;

  /** The innermost backtick substitution the node is, or is inside. */
  readonly substitution: SyntaxNode | undefined;

  /** Whether that substitution is inside another backtick substitution. */
  readonly nested: boolean;

  /** Whether that substitution is inside an error. */
  readonly unpaired: boolean;

  /** Whether the node is, or is inside, an error. */
  readonly inError: boolean;
}

function enter(node: SyntaxNode, outer?: Place): Place {
  const children = node.children;
  const error = node.type === "ERROR" ? node : undefined;
  const opens = node.type === "command_substitution" &&
    children[0]?.type === "`";
  return {
    children,
    next: 0,
    previous: undefined,
    error,
    substitution: opens ? node : outer?.substitution,
    nested: opens ? outer?.substitution !== undefined : outer?.nested ?? false,
    unpaired: opens ? outer?.inError ?? false : outer?.unpaired ?? false,
    inError: error !== undefined || (outer?.inError ?? false),
  };
}

/**
 * Whether the parse puts `comment`, a child of `place` that follows
 * `previous`, inside a backtick substitution that the shell would also put it
 * in: true when it does, false when it puts the comment outside any, and
 * undefined when it puts it in one that the shell would not, so that what
 * follows cannot be trusted either. The parse's substitution must open at the
 * last unescaped backtick before the comment and be inside neither another
 * backtick substitution nor an error; or an error must leave it open.
 *
 * The parser pairs the backticks of an error with nothing. The shell pairs
 * backticks in turn, so an error, holding the comment or just before it, that
 * holds an odd number of backticks before the comment, at any depth, leaves
 * the last of them open. That backtick is trusted only on the comment's own
 * line. `errors` holds the offsets of each error's backticks, by node id, as
 * they are found.
 */
function insideBackticks(
  comment: SyntaxNode,
  place: Place,
  previous: SyntaxNode | undefined,
  source: string,
  errors: Map<number, number[]>,
): boolean | undefined {
  // Whether the backtick at `offset` is the last unescaped one before the
  // comment.
  const lastBefore = (offset: number) =>
    unescapedBackticks(source.slice(offset + 1, comment.startIndex)).length ===
      0;
  if (place.substitution !== undefined) {
    if (place.unpaired) return false;
    // The shell would end an outer substitution at the inner one's backtick.
    if (place.nested) return undefined;
    return lastBefore(place.substitution.startIndex) ? true : undefined;
  }
  const error = place.error ??
    (previous?.type === "ERROR" ? previous : undefined);
  if (error === undefined) return false;
  let offsets = errors.get(error.id);
  if (offsets === undefined) {
    offsets = error.descendantsOfType("`").map((backtick) =>
      backtick.startIndex
    );
    errors.set(error.id, offsets);
  }
  const before = backticksBefore(offsets, comment.startIndex);
  if (before % 2 === 0) return false;
  const last = offsets[before - 1];
  return lastBefore(last) &&
    !/[\r\n]/.test(source.slice(last, comment.startIndex));
}

/** The offsets of the backticks in `text` that no backslash escapes. */
function unescapedBackticks(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") offsets.push(i);
  }
  return offsets;
}

/** How many of `offsets`, which are in increasing order, come before
 * `offset`. */
function backticksBefore(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
