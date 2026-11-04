// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Fixture: value bindings inside a plain-array `.map()` callback.
 *
 * A plain-array callback in a pattern body runs during pattern build, so each
 * of these bindings is a pattern-body binding and lowers to its own
 * per-iteration lift. The central one is `marker`: a bare comparison bound to
 * a name and read further down as the condition of a JSX ternary.
 *
 * `textContent` in the shared vnode helpers maps a boolean to "", so every
 * probe renders a distinct string in both branches and the test can tell the
 * two apart.
 */

import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const INDICES = [0, 1, 2];
const SEPARATORS = ["-", "+"];

export interface Input {
  letters: Writable<string[] | Default<[]>>;
  selection: Writable<string | Default<"">>;
  visible: Writable<number | Default<0>>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  selectC: Stream<void>;
  renameLast: Stream<void>;
}

export default pattern<Input, Output>(({ letters, selection, visible }) => {
  const items = letters.get();
  const target = selection.get();

  const selectC = action(() => {
    selection.set("c");
  });
  const renameLast = action(() => {
    letters.set(["a", "b", "z"]);
  });

  return {
    [NAME]: "Plain-array callback locals",
    [UI]: (
      <div>
        {INDICES.map((idx) => {
          // A bare comparison bound to a name, read further down as the
          // condition of a JSX ternary.
          const marker = items?.[idx] === target;
          // The same comparison with the ternary inside the binding.
          const inlineOptional = items?.[idx] === target ? "match" : "miss";
          const inlineIndexed = items[idx] === target ? "match" : "miss";
          // The comparison behind an explicit computed().
          const wrapped = computed(() => items[idx] === target);
          // A unary over the comparison, bound then read as a condition.
          const negated = !(items?.[idx] === target);
          // A comparison against an eager read of a writable.
          const display = idx < visible.get() ? "flex" : "none";
          // A falsy fallback over a dynamic element access.
          const label = items[idx] || "(none)";
          return (
            <div>
              <span id={`marker-${idx}`}>{marker ? "here" : "away"}</span>
              <span id={`inline-optional-${idx}`}>{inlineOptional}</span>
              <span id={`inline-indexed-${idx}`}>{inlineIndexed}</span>
              <span id={`wrapped-${idx}`}>{wrapped ? "here" : "away"}</span>
              <span id={`negated-${idx}`}>{negated ? "off" : "on"}</span>
              <span id={`display-${idx}`}>{display}</span>
              <span id={`label-${idx}`}>{label}</span>
            </div>
          );
        })}
        {SEPARATORS.map((sep) => {
          // An eager read of a cell inside the callback; the binding site
          // carries it into a per-separator lift.
          const joined = letters.get().join(sep);
          return <span id={`joined-${sep}`}>{joined}</span>;
        })}
      </div>
    ),
    selectC,
    renameLast,
  };
});
