import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Fixture for the cf-render handler-child test. The parent's body instantiates
// no child; a handler creates each one and keeps it in a list, and the parent
// shows each through `cf-render`. Starting the parent therefore starts no
// child, so a child computes in a runtime only if something there starts it.

interface ChildInput {
  n: Default<number, 1>;
}
interface ChildOutput {
  [NAME]: string;
  [UI]: VNode;
  n: number;
  doubled: number;
}

const Child = pattern<ChildInput, ChildOutput>(({ n }) => {
  const doubled = computed(() => n * 2);
  return {
    [NAME]: "handler child",
    [UI]: <span id="child-doubled">doubled {doubled}</span>,
    n,
    doubled,
  };
});

interface ParentInput {
  children: Writable<ChildOutput[] | Default<[]>>;
}
interface ParentOutput {
  [NAME]: string;
  [UI]: VNode;
  children: ChildOutput[];
  addChild: unknown;
}

const addChild = handler<unknown, { children: Writable<ChildOutput[]> }>(
  (_, { children }) => {
    children.push(Child({ n: 1 }));
  },
);

export default pattern<ParentInput, ParentOutput>(({ children }) => {
  return {
    [NAME]: "handler child parent",
    [UI]: (
      <div>
        {children.map((child) => <cf-render $cell={child} />)}
      </div>
    ),
    children,
    addChild: addChild({ children }),
  };
});
