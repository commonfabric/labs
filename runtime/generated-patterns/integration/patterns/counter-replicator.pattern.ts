import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
  type Writable,
} from "commonfabric";

interface ReplicatorArgs {
  seeds: Default<number[], []>;
}

interface AdjustReplicaContext {
  values: Cell<number[]>;
  index: Cell<number>;
}

const adjustReplica = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustReplicaContext,
  ) => {
    const requested = context.index.get() ?? 0;
    const values = context.values.get();
    const list = Array.isArray(values) ? values : [];
    if (requested < 0 || requested >= list.length) return;

    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target: Cell<number> = context.values.key(requested);
    const current = target.get() ?? 0;
    target.set(current + amount);
  },
);

const buildReplicas = lift<{ seeds: Writable<number[]> }>(({ seeds }) => {
  const raw = seeds.get();
  const list = Array.isArray(raw) ? raw : [];

  return list.map((item, index) => {
    const value = typeof item === "number" && Number.isFinite(item) ? item : 0;
    const name = `Replica ${index + 1}`;
    return {
      index,
      name,
      value,
      label: `${name}: ${value}`,
      controls: {
        increment: adjustReplica({
          values: seeds,
          index: cell(index),
        }),
      },
    };
  });
});

const liftCount = lift((items: unknown[] | undefined) => {
  return Array.isArray(items) ? items.length : 0;
});

// `value` is read as a number, so it is declared as one: `unknown` is the
// declaration for a reference nobody reads through.
const liftTotal = lift((items: { value: number }[] | undefined) => {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, entry: any) => {
    const value = typeof entry?.value === "number" ? entry.value : 0;
    return sum + value;
  }, 0);
});

export const counterReplicator = pattern<ReplicatorArgs>(
  ({ seeds }) => {
    const replicas = buildReplicas({ seeds });

    const count = liftCount(replicas);

    const total = liftTotal(replicas);

    const summary = str`Replicas ${count} total ${total}`;

    return {
      seeds,
      replicas,
      count,
      total,
      summary,
    };
  },
);

export default counterReplicator;
