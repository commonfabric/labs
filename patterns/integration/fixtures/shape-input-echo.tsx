import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

// Fixture for the cell-flip shaping test (plan B). A computed reads a writable
// input cell; a renderer-input write to `n` wakes `doubled`, and that wake is
// what the cell-notification shaper defers.
interface Input {
  n: Default<number, 0>;
}
interface Output {
  [NAME]: string;
  [UI]: VNode;
  n: number;
  doubled: number;
}

const ShapeInputEcho = pattern<Input, Output>(({ n }) => {
  const doubled = computed(() => n * 2);
  return {
    [NAME]: "shape-input-echo",
    [UI]: <div>{doubled}</div>,
    n,
    doubled,
  };
});

export default ShapeInputEcho;
