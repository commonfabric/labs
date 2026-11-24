import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";
import { callsNamed, collect, parseModule } from "./transformed-ast.ts";

/** True when a `<receiver>.key(...)` call reads the exact segment path. */
function hasKeyPath(root: ts.Node, receiver: string, ...segments: string[]) {
  return callsNamed(root, "key").some((call) => {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const base = callee.expression;
    if (!ts.isIdentifier(base) || base.text !== receiver) return false;
    if (call.arguments.length !== segments.length) return false;
    return call.arguments.every((arg, index) =>
      ts.isStringLiteralLike(arg) && arg.text === segments[index]
    );
  });
}

/** Every call whose callee is `<object>.<name>(...)` with `object` as base. */
function memberCalls(
  root: ts.Node,
  object: string,
  name: string,
): ts.CallExpression[] {
  return callsNamed(root, name).filter((call) => {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === object;
  });
}

Deno.test(
  "Transform guards: nested block shadowing does not leak opaque alias roots",
  async () => {
    const source = `import { pattern } from "commonfabric";
const p = pattern((input: { user: { name: string }; value: { foo: number } }) => {
  const value = { foo: 1 };
  {
    const value = input.user;
    void value.name;
  }
  return <div>{value.foo}</div>;
});
`;

    const output = await transformSource(source);
    const root = parseModule(output);

    // The inner block's `value` aliases input.user, so it lowers to key reads;
    // the outer `value` is a plain object and its `.foo` read stays structural.
    assert(hasKeyPath(root, "input", "user"));
    assert(hasKeyPath(root, "value", "name"));
    assert(!hasKeyPath(root, "value", "foo"));
    const plainFooReads = collect(root, ts.isPropertyAccessExpression).filter(
      (access) =>
        access.name.text === "foo" && ts.isIdentifier(access.expression) &&
        access.expression.text === "value",
    );
    assertEquals(plainFooReads.length, 1);
  },
);

Deno.test(
  "Transform guards: plain callback parameter map is not rewritten in pattern",
  async () => {
    const source = `import { pattern } from "commonfabric";
const p = pattern((input: { ok: boolean }) => {
  const out = ((arr: number[]) => arr.map((x) => x + 1))([1, 2]);
  return <div>{out.length}</div>;
});
`;

    const output = await transformSource(source);
    const root = parseModule(output);

    assertEquals(memberCalls(root, "arr", "map").length, 1);
    assertEquals(callsNamed(root, "mapWithPattern").length, 0);
  },
);

Deno.test(
  "Transform guards: rewritten mapWithPattern callback uses key(...) canonicalization",
  async () => {
    const source = `import { pattern } from "commonfabric";
const p = pattern((input: { list: Array<{ name: string; age: number }> }) => <div>{input.list.map(({ name }) => <span>{name}</span>)}</div>);
`;

    const output = await transformSource(source);
    const root = parseModule(output);

    assertEquals(callsNamed(root, "mapWithPattern").length, 1);
    assert(hasKeyPath(root, "__cf_pattern_input", "element", "name"));
  },
);

Deno.test(
  "Transform guards: state property names that collide with method names still lower to key() access",
  async () => {
    for (
      const { property, extraAssert } of [
        {
          property: "filter",
          extraAssert: (root: ts.Node) =>
            assertEquals(callsNamed(root, "filterWithPattern").length, 0),
        },
        { property: "map", extraAssert: (_root: ts.Node) => {} },
        { property: "set", extraAssert: (_root: ts.Node) => {} },
      ]
    ) {
      const source = `import { pattern, UI } from "commonfabric";
interface State { ${property}: string; items?: string[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.${property}}</div>,
}));
`;
      const output = await transformSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const root = parseModule(output);
      assert(hasKeyPath(root, "state", property));
      extraAssert(root);
    }
  },
);

Deno.test(
  "Transform guards: numeric element-access receiver keys use canonical numeric values",
  async () => {
    const source = `import { pattern } from "commonfabric";
interface Item { name: string }
interface Group { items: Item[] }
const p = pattern((input: { groups: Group[] }) =>
  input.groups[1e2].items.map((item) => item.name)
);
`;

    const output = await transformSource(source);
    const root = parseModule(output);

    // The 1e2 element index canonicalizes to the string key "100".
    assert(hasKeyPath(root, "input", "groups", "100", "items"));
    assertEquals(callsNamed(root, "mapWithPattern").length, 1);
    const keyArgs = callsNamed(root, "key").flatMap((call) =>
      call.arguments.filter(ts.isStringLiteralLike).map((arg) => arg.text)
    );
    assertEquals(keyArgs.includes("1e2"), false);
  },
);

Deno.test(
  "Transform guards: unsupported reactive array find() does not lower to findWithPattern",
  async () => {
    const source = `import { pattern, UI } from "commonfabric";
interface Item { id: number; name: string }
interface State { items: Item[] }
const p = pattern<State>((state) => ({
  [UI]: <div>{state.items.find((item) => item.id === 1)?.name}</div>,
}));
`;

    const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
    const root = parseModule(output);

    assertEquals(callsNamed(root, "find").length, 1);
    assertEquals(callsNamed(root, "findWithPattern").length, 0);
  },
);

Deno.test(
  "Transform guards: aliased get-result callbacks inside computed stay plain",
  async () => {
    const source = `import { computed, pattern, UI } from "commonfabric";

interface Habit {
  name: string;
}

interface HabitLog {
  habitName: string;
  date: string;
  completed: boolean;
}

interface Input {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
}

export default pattern<Input>(({ habits, logs, todayDate }) => {
  return {
    [UI]: <div>{habits.map((habit) => {
      const doneToday = computed(() => {
        const logList = logs.get();
        return logList.some(
          (log) =>
            log.habitName === habit.name &&
            log.date === todayDate &&
            log.completed,
        );
      });
      return <span>{doneToday ? "yes" : "no"}</span>;
    })}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    // The get-result alias keeps its `.get()` and its `.some()` predicate stays
    // a plain arrow: the transformer wraps no `when(...)` around it.
    assertEquals(memberCalls(root, "logs", "get").length, 1);
    const someCalls = memberCalls(root, "logList", "some");
    assertEquals(someCalls.length, 1);
    const predicate = someCalls[0]!.arguments[0]!;
    assert(ts.isArrowFunction(predicate));
    assertEquals(callsNamed(root, "when").length, 0);
  },
);

Deno.test(
  "Transform guards: ternary branch derive absorbs inner arithmetic instead of nesting",
  async () => {
    const source = `import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
  discount: number;
  threshold: number;
}

export default pattern<State>((state) => ({
  [UI]: (
    <div>
      {state.items.map((item) => (
        <div>
          {item.price > state.threshold
            ? item.price * (1 - state.discount)
            : item.price}
        </div>
      ))}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    // After CT-1615 Phase 1, synthesized derives lower to lift-applied:
    //   __cfHelpers.lift<...>(cb)(input)
    // The predicate lift and the discount-arithmetic lift make exactly two.
    const root = parseModule(output);
    assertEquals(callsNamed(root, "lift").length, 2);
    const multiplies = collect(root, ts.isBinaryExpression).filter((node) =>
      node.operatorToken.kind === ts.SyntaxKind.AsteriskToken
    );
    // The arithmetic sits inside a lift body verbatim, and its left operand
    // stays `item.price` rather than nesting another lift call.
    const priceMultiply = multiplies.find((node) =>
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "price"
    );
    assert(priceMultiply, "expected an `item.price * (...)` multiplication");
    assertEquals(callsNamed(priceMultiply, "lift").length, 0);
  },
);

Deno.test(
  "Transform guards: ifElse predicate binary is not treated as a pattern-owned branch",
  async () => {
    const source = `import { ifElse, pattern, UI } from "commonfabric";

interface Field {
  name: string;
  validationIssue?: { message: string };
}

export default pattern<{ fields: Field[] }>((state) => ({
  [UI]: (
    <div>
      {state.fields.map((field) => (
        <div>
          {ifElse(
            field.validationIssue !== undefined,
            <span>{field.validationIssue?.message}</span>,
            null,
          )}
        </div>
      ))}
    </div>
  ),
}));
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    assert(callsNamed(root, "ifElse").length >= 1);
    // The predicate `field.validationIssue !== undefined` lowers into a lift
    // arrow whose body is that inequality, not a pattern-owned branch.
    const predicateArrows = collect(root, ts.isArrowFunction).filter((arrow) =>
      ts.isBinaryExpression(arrow.body) &&
      arrow.body.operatorToken.kind ===
        ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isPropertyAccessExpression(arrow.body.left) &&
      arrow.body.left.name.text === "validationIssue"
    );
    assertEquals(predicateArrows.length, 1);
  },
);

Deno.test(
  "Transform guards: helper-owned non-cell get() calls are not force-wrapped",
  async () => {
    const source = `import { ifElse, pattern, UI } from "commonfabric";

interface State {
  show: boolean;
  selected: string;
}

class Lookup {
  get(key: string): string | undefined {
    return key.toUpperCase();
  }
}

export default pattern<State>((state) => {
  const lookup = new Lookup();
  return {
    [UI]: <div>{ifElse(state.show, lookup.get(state.selected), "missing")}</div>,
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    // The non-cell `lookup.get(...)` stays a plain method call: the transformer
    // wraps no computed/derive around it.
    assertEquals(memberCalls(root, "lookup", "get").length, 1);
    assertEquals(callsNamed(root, "computed").length, 0);
    assertEquals(callsNamed(root, "derive").length, 0);
  },
);

Deno.test(
  "Transform guards: helper-owned child key references stay structural",
  async () => {
    const source =
      `import { Cell, Default, handler, lift, pattern, Stream } from "commonfabric";

const childIncrement = handler(
  (event: { amount?: number } | undefined, context: { value: Cell<number> }) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

const forward = handler(
  (_event: unknown, context: { increment: Stream<{ amount?: number }> }) => {
    context.increment.send({ amount: 1 });
  },
);

const childCounter = pattern<{ value: Default<number, 0> }>(({ value }) => ({
  value,
  increment: childIncrement({ value }),
}));

const sum = lift((input: { left: number; right: number }) => input.left + input.right);

export default pattern<{ left: Default<number, 0>; right: Default<number, 0> }>(
  ({ left, right }) => {
    const leftChild = childCounter({ value: left });
    const rightChild = childCounter({ value: right });

    return {
      total: sum({
        left: leftChild.key("value"),
        right: rightChild.key("value"),
      }),
      forward: forward({ increment: rightChild.key("increment") }),
    };
  },
);
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });

    const root = parseModule(output);

    // The child cell and stream references stay structural key reads; none is
    // wrapped in a computed inside the helper-owned argument objects.
    assert(hasKeyPath(root, "leftChild", "value"));
    assert(hasKeyPath(root, "rightChild", "value"));
    assert(hasKeyPath(root, "rightChild", "increment"));
    assertEquals(callsNamed(root, "computed").length, 0);
  },
);

Deno.test(
  "Transform guards: ordinary helper calls with child key references stay structural",
  async () => {
    const source =
      `import { Cell, Default, handler, pattern, type Stream } from "commonfabric";

const asIncrementStream = (
  ref: Stream<{ amount?: number }>,
): Stream<{ amount?: number }> => ref;

const childIncrement = handler(
  (_event: { amount?: number } | undefined, _context: { value: Cell<number> }) => {},
);

const bubbleToChild = handler(
  (_event: unknown, context: { childIncrement: Stream<{ amount?: number }> }) => {
    context.childIncrement.send({ amount: 1 });
  },
);

const childCounter = pattern<{ value: Default<number, 0> }>(({ value }) => ({
  value,
  increment: childIncrement({ value }),
}));

export default pattern<{ child: Default<number, 0> }>(({ child }) => {
  const childState = childCounter({ value: child });
  return {
    bubbleToChild: bubbleToChild({
      childIncrement: asIncrementStream(childState.key("increment")),
    }),
  };
});
`;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    // The ordinary helper call `asIncrementStream(...)` receives the structural
    // key read directly, not a computed/derive-wrapped value.
    const wrapperCalls = callsNamed(root, "asIncrementStream");
    assertEquals(wrapperCalls.length, 1);
    const arg = wrapperCalls[0]!.arguments[0]!;
    assert(ts.isCallExpression(arg));
    assert(hasKeyPath(arg, "childState", "increment"));
    assertEquals(callsNamed(root, "computed").length, 0);
    assertEquals(callsNamed(root, "derive").length, 0);
  },
);
