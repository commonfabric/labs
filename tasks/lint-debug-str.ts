/// <reference lib="deno.unstable" />

/**
 * A lint rule that checks the directives of a `debugStr` template.
 *
 * `debugStr` reads a directive such as `$quote,long` off the end of the text
 * before a substitution. The type checker does not see the text of a tagged
 * template, so a misspelled word compiles, and at run time the directive is
 * left in the message as text. A message composed by `debugStr` is mostly one
 * for an error, on a path a test may well never reach, so this rule is what
 * finds the misspelling. It reports a directive holding a word which is not
 * one a directive can hold, and one holding more than one of the size words.
 *
 * The rule recognizes the tag by its name, `debugStr`, called bare. A template
 * tagged through another name is beyond what one file's syntax tree shows. The
 * directive syntax and the vocabulary come from the modules `debugStr` itself
 * reads them from.
 */

import {
  DEBUG_STR_SIZE_WORDS,
  DEBUG_STR_WORDS,
} from "../packages/data-model/src/value-debug/interface.ts";
import { parseDebugStrDirective } from "../packages/data-model/src/value-debug/parseDebugStrDirective.ts";

/** The name the rule recognizes the tag by. */
const TAG_NAME = "debugStr";

/** The shape this rule reads off a node, on top of the type tag. */
interface TaggedTemplateNode {
  readonly tag: { readonly type: string; readonly name?: string };
  readonly quasi: {
    readonly quasis: readonly { readonly raw: string }[];
  };
}

/** Renders a list of words for a message, each as a code span. */
function quoteWords(words: readonly string[]): string {
  return words.map((word) => `\`${word}\``).join(", ");
}

/**
 * Returns what is wrong with the given words of a directive, or `undefined`
 * when nothing is.
 */
function problemWith(words: readonly string[]): string | undefined {
  const known: readonly string[] = DEBUG_STR_WORDS;
  const sizes: readonly string[] = DEBUG_STR_SIZE_WORDS;
  const unknown = words.filter((word) => !known.includes(word));
  const sized = words.filter((word) => sizes.includes(word));

  if (unknown.length !== 0) {
    return `A \`debugStr\` directive cannot hold ${quoteWords(unknown)}; ` +
      `the words it can hold are ${quoteWords(known)}. As written, the ` +
      "directive is left in the message as text. To keep it as text on " +
      "purpose, put a backslash before its dollar sign.";
  } else if (sized.length > 1) {
    return "A `debugStr` directive takes no more than one size word, and " +
      `this one holds ${quoteWords(sized)}.`;
  }

  return undefined;
}

export default {
  name: "cf-debug-str",
  rules: {
    "valid-directive": {
      create(context) {
        return {
          TaggedTemplateExpression(node) {
            const { tag, quasi } = node as unknown as TaggedTemplateNode;
            if ((tag.type !== "Identifier") || (tag.name !== TAG_NAME)) {
              return;
            }

            // The last template string has no substitution after it, so
            // nothing it ends in is a directive.
            for (const { raw } of quasi.quasis.slice(0, -1)) {
              const directive = parseDebugStrDirective(raw);
              const message = directive && problemWith(directive.words);
              if (message !== undefined) {
                context.report({ node, message });
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
