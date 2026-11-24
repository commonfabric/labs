/**
 * TRANSFORM REPRO: wrapped element-binding reads keep partial-key inputs
 *
 * Wrappers around the element identifier (parens, non-null assertion, `as`
 * type assertion) should not block the analyzer or the capture-tree parser
 * from recognizing `entry.name` as a fine-grained reactive dependency. The
 * lift-applied computation's inputs should use the nested partial-key shape
 *   { entry: { name: entry.key("name") } }
 * not a flat fallback like `_entry__name: entry.key("name")` (which is
 * what the parser produced before `parseCaptureExpression` started
 * unwrapping wrappers — the dependency was still captured, but in a less
 * structured shape that downstream readers don't expect).
 */

import { pattern, UI, type VNode } from "commonfabric";

type Entry = { name: string };

interface Input {
  entries: Entry[];
  prefix: string;
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ entries, prefix }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        // Parenthesized: (entry).name
        const a = (entry).name === prefix;
        // Non-null asserted: entry!.name
        const b = entry!.name === prefix;
        // 'as' asserted: (entry as Entry).name
        const c = (entry as Entry).name === prefix;
        return (
          <span data-a={a} data-b={b} data-c={c}>{entry.name}</span>
        );
      })}
    </div>
  ),
}));
