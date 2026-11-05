import { type Cell, Default, handler, pattern, str } from "commonfabric";

const childIncrement = handler(
  (
    event: { amount?: number },
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const spawnedChild = pattern<{ value: Default<number, 0> }, SpawnedChildState>(
  ({ value }) => {
    return {
      value,
      label: str`Child value ${value}`,
      increment: childIncrement({ value }),
    };
  },
);

type SpawnedChildState = {
  value: number;
  label: string;
  increment: { amount?: number };
};

interface HandlerSpawnArgs {
  children: Default<SpawnedChildState[], []>;
}

const spawnChild = handler(
  (
    event: { seed?: number },
    context: { children: Cell<SpawnedChildState[]> },
  ) => {
    const seed = typeof event?.seed === "number" ? event.seed : 0;
    const child = spawnedChild({ value: seed });
    context.children.push(child);
  },
);

export const counterWithHandlerSpawn = pattern<HandlerSpawnArgs>(
  ({ children }) => {
    return {
      children,
      spawn: spawnChild({ children }),
    };
  },
);

export default counterWithHandlerSpawn;
