import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

interface CounterInput {
  value?: Writable<number | Default<0>>;
}

export interface CounterOutput {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}

// ===== Module-scope handler =====
// Use module-scope handlers when the same handler needs to be reused across
// multiple pattern instances or bound to different values. The handler is
// defined once and can be bound to different contexts.
//
// handler<Event, Context> - Event is what .send() receives, Context is bound state

const increment = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.increment(1);
  },
);

// ===== Helper functions =====

function ordinal(n: number): string {
  const num = n ?? 0;
  if (num % 10 === 1 && num % 100 !== 11) return `${num}st`;
  if (num % 10 === 2 && num % 100 !== 12) return `${num}nd`;
  if (num % 10 === 3 && num % 100 !== 13) return `${num}rd`;
  return `${num}th`;
}

// ===== Pattern =====

const Counter = pattern<CounterInput, CounterOutput>(({ value }) => {
  // Bind the module-scope handler with its required context
  const boundIncrement = increment({ value });

  // Pattern-body action (PREFERRED approach for single-use handlers)
  // When an action only needs to work with this pattern's state, use action()
  // which closes over the pattern's values directly. This is simpler and clearer
  // than defining a reusable handler when you don't need reusability.
  const decrement = action(() => {
    value.increment(-1);
  });

  // Computed values
  const displayName = computed(() => `Counter: ${value.get()}`);
  const ordinalDisplay = computed(() => ordinal(value.get()));

  return {
    [NAME]: displayName,
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={4}>Simple Counter</cf-heading>
        </cf-vstack>

        <cf-vstack gap="3" style="padding: 2rem; align-items: center;">
          <div
            style={{
              fontSize: "3rem",
              fontWeight: "bold",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>

          <div
            id="counter-result"
            style={{ color: "var(--cf-colors-gray-500)" }}
          >
            Counter is the {ordinalDisplay} number
          </div>

          <cf-hstack gap="2">
            {/* onClick can take a Stream directly - runtime calls .send() */}
            <cf-button
              id="counter-decrement"
              variant="secondary"
              onClick={decrement}
            >
              - Decrement
            </cf-button>
            {/* onClick can also take a function that calls .send() explicitly */}
            <cf-button
              id="counter-increment"
              variant="primary"
              onClick={() => boundIncrement.send()}
            >
              + Increment
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-screen>
    ),
    value,
    // Both approaches can be exported and tested via the `cf` CLI
    // and with automated pattern tests. See counter.test.tsx.
    increment: boundIncrement, // Module-scope handler, bound in pattern
    decrement, // Pattern-body action, closes over value directly
  };
});

// ===== Pattern as JSX Element =====
// Patterns can be rendered as JSX elements directly. This is useful when
// composing patterns or creating wrapper views. Since value is optional with
// a Default, we don't need to pass it.

const _CounterView = pattern<void, { [UI]: VNode }>(() => {
  return {
    [UI]: <Counter />,
  };
});

export default Counter;
