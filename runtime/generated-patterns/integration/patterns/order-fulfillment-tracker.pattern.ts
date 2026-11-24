import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const fulfillmentStatuses = [
  "pending",
  "picking",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
] as const;

type FulfillmentStatus = typeof fulfillmentStatuses[number];

type FulfillmentStatusCounts = Record<FulfillmentStatus, number>;

interface OrderInput {
  id?: string;
  customer?: string;
  items?: number;
  status?: string;
}

interface OrderRecord {
  id: string;
  customer: string;
  items: number;
  status: FulfillmentStatus;
}

interface OrderSnapshot {
  id: string;
  customer: string;
  items: number;
  status: FulfillmentStatus;
  statusLabel: string;
}

interface FulfillmentBucket {
  status: FulfillmentStatus;
  label: string;
  count: number;
  orders: OrderSnapshot[];
}

interface OrderFulfillmentTrackerArgs {
  orders: Default<OrderInput[], typeof defaultOrders>;
}

interface AdvanceFulfillmentEvent {
  orderId?: string;
  targetStatus?: string;
}

interface CancelOrderEvent {
  orderId?: string;
}

interface ReopenOrderEvent {
  orderId?: string;
}

interface StatusChange {
  order: OrderRecord;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
}

interface StatusChangeEntry {
  sequence: number;
  orderId: string;
  customer: string;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
  message: string;
}

interface FulfillmentHandlerContext {
  orders: Cell<OrderInput[]>;
  history: Cell<StatusChangeEntry[]>;
}

const statusLabels: Record<FulfillmentStatus, string> = {
  pending: "Pending",
  picking: "Picking",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const fulfillmentStatusSet = new Set<FulfillmentStatus>(fulfillmentStatuses);

const inFlightStatuses = new Set<FulfillmentStatus>([
  "pending",
  "picking",
  "packed",
  "shipped",
]);

const fulfillmentFlow: readonly FulfillmentStatus[] = [
  "pending",
  "picking",
  "packed",
  "shipped",
  "delivered",
];

const defaultOrders: OrderRecord[] = [
  { id: "ORD-1001", customer: "Acme Labs", items: 4, status: "pending" },
  {
    id: "ORD-1002",
    customer: "Northwind",
    items: 2,
    status: "picking",
  },
  { id: "ORD-1003", customer: "Globex", items: 6, status: "packed" },
  { id: "ORD-1004", customer: "Initech", items: 3, status: "shipped" },
];

const fallbackOrderId = (index: number): string => {
  const value = (index + 1).toString().padStart(4, "0");
  return `ORD-${value}`;
};

const toOrderId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
};

const sanitizeOrderId = (value: unknown, index: number): string =>
  toOrderId(value) ?? fallbackOrderId(index);

const sanitizeCustomer = (value: unknown, index: number): string => {
  if (typeof value !== "string") return `Customer ${index + 1}`;
  const trimmed = value.trim();
  return trimmed ? trimmed : `Customer ${index + 1}`;
};

const sanitizeItems = (value: unknown): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 1;
  const integerValue = Math.floor(numberValue);
  return integerValue > 0 ? integerValue : 1;
};

const sanitizeStatus = (
  value: unknown,
  fallback: FulfillmentStatus,
): FulfillmentStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (fulfillmentStatusSet.has(normalized as FulfillmentStatus)) {
    return normalized as FulfillmentStatus;
  }
  return fallback;
};

const sanitizeOrder = (
  input: OrderInput | null | undefined,
  index: number,
): OrderRecord => {
  const id = sanitizeOrderId(input?.id, index);
  const customer = sanitizeCustomer(input?.customer, index);
  const items = sanitizeItems(input?.items);
  const status = sanitizeStatus(input?.status, "pending");
  return { id, customer, items, status };
};

const cloneOrders = (entries: readonly OrderRecord[]): OrderRecord[] =>
  entries.map((entry) => ({ ...entry }));

const sanitizeOrderList = (
  value: readonly OrderInput[] | undefined | null,
): OrderRecord[] => {
  if (!Array.isArray(value)) {
    return cloneOrders(defaultOrders);
  }
  const sanitized = value.map((entry, index) => sanitizeOrder(entry, index));
  sanitized.sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const unique: OrderRecord[] = [];
  for (const entry of sanitized) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique.length > 0 ? unique : cloneOrders(defaultOrders);
};

const toOrderInputs = (records: readonly OrderRecord[]): OrderInput[] =>
  records.map((record) => ({
    id: record.id,
    customer: record.customer,
    items: record.items,
    status: record.status,
  }));

const createEmptyCounts = (): FulfillmentStatusCounts => {
  const counts: Partial<FulfillmentStatusCounts> = {};
  for (const status of fulfillmentStatuses) counts[status] = 0;
  return counts as FulfillmentStatusCounts;
};

const nextStatus = (status: FulfillmentStatus): FulfillmentStatus => {
  const index = fulfillmentFlow.indexOf(status);
  if (index === -1 || index === fulfillmentFlow.length - 1) return status;
  return fulfillmentFlow[index + 1];
};

const toSnapshot = (record: OrderRecord): OrderSnapshot => ({
  id: record.id,
  customer: record.customer,
  items: record.items,
  status: record.status,
  statusLabel: statusLabels[record.status],
});

const formatStatusChange = (change: StatusChange): string =>
  `${change.order.id} moved from ${statusLabels[change.from]} to ` +
  `${statusLabels[change.to]}`;

const recordStatusChange = (
  history: Cell<StatusChangeEntry[]>,
  change: StatusChange,
) => {
  const existing = history.get();
  const list = Array.isArray(existing) ? existing : [];
  const entry: StatusChangeEntry = {
    sequence: list.length + 1,
    orderId: change.order.id,
    customer: change.order.customer,
    from: change.from,
    to: change.to,
    message: formatStatusChange(change),
  };
  history.set([...list, entry]);
};

const applyStatusChange = (
  list: OrderRecord[],
  orderId: string,
  resolveStatus: (order: OrderRecord) => FulfillmentStatus | null,
): { list: OrderRecord[]; change: StatusChange | null } => {
  const index = list.findIndex((entry) => entry.id === orderId);
  if (index === -1) return { list, change: null };
  const current = list[index];
  const status = resolveStatus(current);
  if (!status || status === current.status) return { list, change: null };
  const updated = cloneOrders(list);
  updated[index] = { ...current, status };
  return {
    list: updated,
    change: { order: updated[index], from: current.status, to: status },
  };
};

const advanceFulfillment = handler<
  AdvanceFulfillmentEvent,
  FulfillmentHandlerContext
>((event, context) => {
  const orderId = toOrderId(event.orderId);
  if (!orderId) return;
  const current = sanitizeOrderList(context.orders.get());
  const result = applyStatusChange(current, orderId, (order) => {
    if (typeof event.targetStatus === "string") {
      return sanitizeStatus(event.targetStatus, order.status);
    }
    return nextStatus(order.status);
  });
  if (!result.change) return;
  context.orders.set(toOrderInputs(result.list));
  recordStatusChange(context.history, result.change);
});

const cancelOrder = handler<CancelOrderEvent, FulfillmentHandlerContext>(
  (event, context) => {
    const orderId = toOrderId(event.orderId);
    if (!orderId) return;
    const current = sanitizeOrderList(context.orders.get());
    const result = applyStatusChange(current, orderId, (order) => {
      if (order.status === "delivered" || order.status === "cancelled") {
        return null;
      }
      return "cancelled";
    });
    if (!result.change) return;
    context.orders.set(toOrderInputs(result.list));
    recordStatusChange(context.history, result.change);
  },
);

const reopenOrder = handler<ReopenOrderEvent, FulfillmentHandlerContext>(
  (event, context) => {
    const orderId = toOrderId(event.orderId);
    if (!orderId) return;
    const current = sanitizeOrderList(context.orders.get());
    const result = applyStatusChange(current, orderId, (order) => {
      if (order.status !== "cancelled") return null;
      return "pending";
    });
    if (!result.change) return;
    context.orders.set(toOrderInputs(result.list));
    recordStatusChange(context.history, result.change);
  },
);

// Module-scope lift definitions
const liftSanitizeOrderList = lift(sanitizeOrderList);

const liftStatusCounts = lift(
  (entries: OrderRecord[]): FulfillmentStatusCounts => {
    const counts = createEmptyCounts();
    for (const entry of entries) counts[entry.status] += 1;
    return counts;
  },
);

const liftTotalOrders = lift((counts: FulfillmentStatusCounts) => {
  let total = 0;
  for (const status of fulfillmentStatuses) total += counts[status];
  return total;
});

const liftActiveOrders = lift((counts: FulfillmentStatusCounts) => {
  let total = 0;
  for (const status of inFlightStatuses) total += counts[status];
  return total;
});

const liftQueueSummary = lift((counts: FulfillmentStatusCounts) =>
  `Pending ${counts.pending}, Picking ${counts.picking}, ` +
  `Packed ${counts.packed}, Shipped ${counts.shipped}`
);

const liftStatusBuckets = lift(
  (entries: OrderRecord[]): FulfillmentBucket[] => {
    const buckets = fulfillmentStatuses.map((status) => ({
      status,
      label: statusLabels[status],
      count: 0,
      orders: [] as OrderSnapshot[],
    }));
    const lookup = new Map<FulfillmentStatus, FulfillmentBucket>();
    for (const bucket of buckets) lookup.set(bucket.status, bucket);
    for (const entry of entries) {
      const bucket = lookup.get(entry.status);
      if (!bucket) continue;
      bucket.count += 1;
      bucket.orders.push(toSnapshot(entry));
    }
    for (const bucket of buckets) {
      bucket.orders.sort((left, right) => left.id.localeCompare(right.id));
    }
    return buckets;
  },
);

const liftInFlightOrderIds = lift((entries: OrderRecord[]) =>
  entries
    .filter((entry) => inFlightStatuses.has(entry.status))
    .map((entry) => entry.id)
);

const liftTransitionHistory = lift((entries: StatusChangeEntry[]) =>
  entries.map((entry) => ({
    sequence: entry.sequence,
    orderId: entry.orderId,
    customer: entry.customer,
    from: statusLabels[entry.from],
    to: statusLabels[entry.to],
    message: entry.message,
  }))
);

const liftTransitionMessages = lift((entries: StatusChangeEntry[]) =>
  entries.map((entry) => entry.message)
);

export const orderFulfillmentTracker = pattern<OrderFulfillmentTrackerArgs>(
  ({ orders }) => {
    const transitionLog = cell<StatusChangeEntry[]>([]);

    const ordersView = liftSanitizeOrderList(orders);
    const statusCounts = liftStatusCounts(ordersView);
    const totalOrders = liftTotalOrders(statusCounts);
    const activeOrders = liftActiveOrders(statusCounts);
    const queueSummary = liftQueueSummary(statusCounts);

    const progressLabel =
      str`${activeOrders} active / ${totalOrders} total orders`;

    const statusBuckets = liftStatusBuckets(ordersView);
    const inFlightOrderIds = liftInFlightOrderIds(ordersView);
    const transitionHistory = liftTransitionHistory(transitionLog);
    const transitionMessages = liftTransitionMessages(transitionLog);

    return {
      orders,
      ordersView,
      statusCounts,
      statusBuckets,
      inFlightOrderIds,
      queueSummary,
      progressLabel,
      transitionHistory,
      transitionMessages,
      advanceFulfillment: advanceFulfillment({
        orders,
        history: transitionLog,
      }),
      cancelOrder: cancelOrder({ orders, history: transitionLog }),
      reopenOrder: reopenOrder({ orders, history: transitionLog }),
    };
  },
);

export type {
  FulfillmentBucket,
  FulfillmentStatus,
  FulfillmentStatusCounts,
  OrderFulfillmentTrackerArgs,
  OrderInput,
  OrderRecord,
  OrderSnapshot,
  StatusChangeEntry,
};

export default orderFulfillmentTracker;
