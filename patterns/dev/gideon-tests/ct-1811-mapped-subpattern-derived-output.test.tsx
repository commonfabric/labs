/**
 * Regression test for CT-1811.
 *
 * A sub-pattern that exposes a derived-internal computed OUTPUT, nested as a
 * GRANDCHILD pattern node under a reactive `.map()` (parent.map -> Wrapper ->
 * Child), used to throw at bind time under the `cf test` harness:
 *   "Unknown derived internal cell with partial cause: <name>"
 *
 * Root cause: the harness evaluated the test bundle via
 * `Engine.compileAndEvaluateModules` WITHOUT registering the evaluated artifacts,
 * so anonymous map ops never got a content-addressed entry ref and fell back to
 * their embedded pattern graph -- whose nested output-alias `defer` levels are
 * decremented one step too far by the `getImmutableCell` round-trip, so a
 * grandchild derived-internal output resolved one instantiation level too early.
 * The deployed runtime (`patternFromEvaluation`) and the generated-patterns
 * harness (`compilePattern`) register on load, so it only reproduced under
 * `cf test`. Fix: the harness now calls `registerEvaluatedModules` after eval.
 *
 * No fetch is involved: the ticket's `fetchData` was incidental -- fetch just
 * happened to be how the original art sub-pattern acquired a derived-internal
 * output. ANY derived-internal computed output of a mapped grandchild trips it.
 *
 * The assertion must TRAVERSE the rendered UI: the bind (and thus the throw)
 * only happens once the `.map()` materializes its elements; a lazy assertion
 * that never reads the mapped output would not trigger it.
 */
import {
  assert,
  computed,
  NAME,
  pattern,
  TESTS,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const isRecord = (v: unknown): v is Record<PropertyKey, unknown> =>
  typeof v === "object" && v !== null;

const read = (v: unknown): unknown =>
  isRecord(v) && typeof v.get === "function" ? (v.get as () => unknown)() : v;

const asArray = (v: unknown): unknown[] => {
  const value = read(v);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = read(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...asArray(value.children),
  ];
};

// Collect leaf string/number values in the rendered tree. Walking the tree is
// what forces the map to materialize each element (instantiate Wrapper + Child).
const leafValues = (root: unknown, depth = 0): string[] => {
  if (depth > 40) return [];
  const value = read(root);
  const kids = childNodes(value);
  if (kids.length === 0) {
    return typeof value === "string" || typeof value === "number"
      ? [String(value)]
      : [];
  }
  const out: string[] = [];
  for (const k of kids) {
    for (const value of leafValues(k, depth + 1)) out.push(value);
  }
  return out;
};

interface ChildIn {
  n: number;
}
interface ChildOut {
  [NAME]: string;
  [UI]: VNode;
  doubled: number;
}

// The grandchild: exposes a derived-internal computed OUTPUT (`doubled`).
const Child = pattern<ChildIn, ChildOut>(({ n }) => {
  const doubled = computed(() => n * 2);
  return {
    [NAME]: "child",
    [UI]: <div>{doubled}</div>,
    doubled,
  };
});

interface WrapperIn {
  n: number;
}
interface WrapperOut {
  [NAME]: string;
  [UI]: VNode;
}

// The child pattern node nests Child, so Child is a GRANDCHILD of the map op.
const Wrapper = pattern<WrapperIn, WrapperOut>(({ n }) => ({
  [NAME]: "wrapper",
  [UI]: (
    <div>
      <Child n={n} />
    </div>
  ),
}));

export default pattern(() => {
  const items = new Writable<number[]>([1, 2, 3]);
  const ui = <div>{items.map((n) => <Wrapper n={n} />)}</div>;
  // Reading the rendered tree forces the map to materialize; each Child then
  // renders its derived-internal `doubled` output (2, 4, 6). Without the fix,
  // binding throws before any of this and the harness fails the run.
  const rendered = assert(() => {
    const values = leafValues(ui);
    return values.includes("2") && values.includes("4") &&
      values.includes("6");
  });
  return {
    [NAME]: "ct-1811-mapped-subpattern-derived-output",
    [UI]: ui,
    [TESTS]: [
      { assertion: rendered },
    ],
  };
});
