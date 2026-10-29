import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface RouteInput {
  id?: string;
  label?: string;
  capacity?: number;
}

interface RouteDefinition {
  id: string;
  label: string;
  capacity: number;
}

interface ShipmentInput {
  id?: string;
  route?: string;
  weight?: number;
}

interface ShipmentRecord {
  id: string;
  route: string;
  weight: number;
}

interface LogisticsRoutingArgs {
  routes: Default<RouteInput[], typeof defaultRoutes>;
  shipments: Default<ShipmentInput[], typeof defaultShipments>;
}

interface RouteLoadMetric {
  route: string;
  label: string;
  capacity: number;
  used: number;
  remaining: number;
  utilization: number;
  isOverCapacity: boolean;
}

interface AssignmentEvent {
  shipment?: string;
  targetRoute?: string;
}

interface AssignmentSnapshot {
  sequence: number;
  shipment: string;
  from: string;
  to: string;
  load: number;
  capacity: number;
  remaining: number;
  status: "moved" | "blocked";
}

const defaultRoutes: RouteDefinition[] = [
  { id: "NORTH", label: "North Loop", capacity: 18 },
  { id: "EAST", label: "East Express", capacity: 12 },
  { id: "SOUTH", label: "South Freight", capacity: 16 },
];

const defaultShipments: ShipmentRecord[] = [
  { id: "PKG-100", route: "NORTH", weight: 5 },
  { id: "PKG-101", route: "NORTH", weight: 4 },
  { id: "PKG-200", route: "EAST", weight: 3 },
  { id: "PKG-201", route: "EAST", weight: 2 },
  { id: "PKG-300", route: "SOUTH", weight: 5 },
  { id: "PKG-301", route: "SOUTH", weight: 6 },
];

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeRouteId = (value: unknown, fallback: string): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed.toUpperCase();
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback.toUpperCase();
  }
  return null;
};

const sanitizeCapacity = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const ensureUniqueId = (value: string, used: Set<string>): string => {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeRoutes = (value: unknown): RouteDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultRoutes);
  }
  const used = new Set<string>();
  const sanitized: RouteDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as RouteInput | undefined;
    const fallback = defaultRoutes[index] ?? defaultRoutes[0];
    const label = sanitizeLabel(entry?.label, fallback.label);
    const rawId = sanitizeRouteId(entry?.id ?? entry?.label, fallback.id);
    if (!rawId) continue;
    const id = ensureUniqueId(rawId, used);
    const capacity = sanitizeCapacity(entry?.capacity, fallback.capacity);
    sanitized.push({ id, label, capacity });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultRoutes);
  }
  return sanitized;
};

const sanitizeShipmentId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
};

const sanitizeWeight = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.round(Math.max(value, 0) * 100) / 100;
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const resolveRouteId = (
  routes: readonly RouteDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const candidate = trimmed.toUpperCase();
  const byId = routes.find((route) => route.id === candidate);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byLabel = routes.find((route) =>
    route.label.toLowerCase() === normalized
  );
  return byLabel?.id ?? null;
};

const sanitizeShipments = (
  value: unknown,
  routes: readonly RouteDefinition[],
): ShipmentRecord[] => {
  const source = Array.isArray(value)
    ? value as ShipmentInput[]
    : defaultShipments;
  if (routes.length === 0) {
    return [];
  }
  const capacities = new Map<string, number>();
  const used = new Map<string, number>();
  for (const route of routes) {
    capacities.set(route.id, route.capacity);
    used.set(route.id, 0);
  }
  const sanitized: ShipmentRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const entry = source[index];
    const fallback = defaultShipments[index] ?? defaultShipments[0];
    const id = sanitizeShipmentId(entry?.id) ?? fallback.id;
    if (seen.has(id)) continue;
    const routeId = resolveRouteId(routes, entry?.route) ?? fallback.route;
    if (!capacities.has(routeId)) continue;
    const weight = sanitizeWeight(entry?.weight, fallback.weight);
    const current = used.get(routeId) ?? 0;
    const limit = capacities.get(routeId) ?? 0;
    if (current + weight > limit) continue;
    used.set(routeId, current + weight);
    sanitized.push({ id, route: routeId, weight });
    seen.add(id);
  }
  if (sanitized.length === 0) {
    const fallback: ShipmentRecord[] = [];
    const remaining = new Map(capacities);
    for (const entry of defaultShipments) {
      const id = entry.id;
      if (seen.has(id)) continue;
      for (const route of routes) {
        const limit = remaining.get(route.id) ?? 0;
        if (limit >= entry.weight) {
          remaining.set(route.id, limit - entry.weight);
          fallback.push({
            id,
            route: route.id,
            weight: entry.weight,
          });
          seen.add(id);
          break;
        }
      }
    }
    fallback.sort((left, right) => left.id.localeCompare(right.id));
    return fallback;
  }
  sanitized.sort((left, right) => left.id.localeCompare(right.id));
  return sanitized;
};

const roundRatio = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const computeLoadMetrics = (
  routes: readonly RouteDefinition[],
  shipments: readonly ShipmentRecord[],
): RouteLoadMetric[] => {
  const loads = new Map<string, number>();
  for (const route of routes) {
    loads.set(route.id, 0);
  }
  for (const shipment of shipments) {
    const current = loads.get(shipment.route) ?? 0;
    loads.set(shipment.route, current + shipment.weight);
  }
  return routes.map((route) => {
    const used = loads.get(route.id) ?? 0;
    const remaining = route.capacity - used;
    return {
      route: route.id,
      label: route.label,
      capacity: route.capacity,
      used,
      remaining: remaining > 0 ? roundRatio(remaining) : 0,
      utilization: route.capacity > 0 ? roundRatio(used / route.capacity) : 0,
      isOverCapacity: used > route.capacity,
    };
  });
};

// Module-scope lift definitions
const liftSanitizeRoutes = lift(sanitizeRoutes);

const liftBaseShipments = lift((input: {
  entries: ShipmentInput[] | undefined;
  routeList: RouteDefinition[];
}) => sanitizeShipments(input.entries, input.routeList));

const liftAssignmentList = lift((input: {
  stored: ShipmentRecord[];
  base: ShipmentRecord[];
}) => {
  const stored = Array.isArray(input.stored) ? input.stored : [];
  if (stored.length > 0) {
    return stored.map((entry) => ({ ...entry }));
  }
  const base = Array.isArray(input.base) ? input.base : [];
  return base.map((entry) => ({ ...entry }));
});

const liftLoadMetrics = lift((input: {
  routeList: RouteDefinition[];
  shipmentsList: ShipmentRecord[];
}) => computeLoadMetrics(input.routeList, input.shipmentsList));

const liftAvailableRoutes = lift((entries: RouteLoadMetric[]) => {
  return entries
    .filter((entry) => entry.remaining > 0)
    .map((entry) => entry.route)
    .sort();
});

const liftOverloaded = lift((entries: RouteLoadMetric[]) => {
  return entries
    .filter((entry) => entry.isOverCapacity)
    .map((entry) => entry.route)
    .sort();
});

const liftShipmentCount = lift((entries: ShipmentRecord[]) => entries.length);
const liftRouteCount = lift((entries: RouteDefinition[]) => entries.length);
const liftOverloadedCount = lift((entries: string[]) => entries.length);

const liftHistoryView = lift((entries: string[] | undefined) => {
  return Array.isArray(entries) ? [...entries] : [];
});

const liftLastActionView = lift((value: string | undefined) => {
  return typeof value === "string" && value.length > 0 ? value : "initialized";
});

const reassignShipment = handler(
  (
    event: AssignmentEvent | undefined,
    context: {
      shipments: Cell<ShipmentRecord[]>;
      baseShipments: Cell<ShipmentRecord[]>;
      routes: Cell<RouteDefinition[]>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const routes = context.routes.get() ?? [];
    if (routes.length === 0) return;

    const shipmentId = sanitizeShipmentId(event?.shipment);
    const targetRoute = resolveRouteId(routes, event?.targetRoute);
    if (!shipmentId || !targetRoute) return;

    const stored = context.shipments.get();
    const base = context.baseShipments.get();
    const existing = Array.isArray(stored) && stored.length > 0
      ? stored.map((entry) => ({ ...entry }))
      : Array.isArray(base)
      ? base.map((entry) => ({ ...entry }))
      : [];

    const index = existing.findIndex((entry) => entry.id === shipmentId);
    if (index === -1) return;

    const record = existing[index];
    if (record.route === targetRoute) {
      return;
    }

    const capacityMap = new Map<string, number>();
    const usage = new Map<string, number>();
    for (const route of routes) {
      capacityMap.set(route.id, route.capacity);
      usage.set(route.id, 0);
    }
    for (let i = 0; i < existing.length; i++) {
      if (i === index) continue;
      const entry = existing[i];
      usage.set(entry.route, (usage.get(entry.route) ?? 0) + entry.weight);
    }
    const targetCapacity = capacityMap.get(targetRoute) ?? 0;
    const currentLoad = usage.get(targetRoute) ?? 0;
    if (currentLoad + record.weight > targetCapacity) {
      const message =
        `Blocked move of ${shipmentId} to ${targetRoute}; capacity ${targetCapacity}`;
      const log = context.history.get();
      context.history.set([...(Array.isArray(log) ? log : []), message]);
      context.lastAction.set(message);
      const sequence = (context.sequence.get() ?? 0) + 1;
      context.sequence.set(sequence);
      return;
    }

    const updated = existing.map((entry, position) => {
      if (position !== index) return { ...entry };
      return { id: entry.id, route: targetRoute, weight: entry.weight };
    });
    updated.sort((left, right) => left.id.localeCompare(right.id));
    context.shipments.set(updated);

    const message =
      `Moved ${shipmentId} from ${record.route} to ${targetRoute}`;
    const log = context.history.get();
    context.history.set([...(Array.isArray(log) ? log : []), message]);
    context.lastAction.set(message);
    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

export const logisticsRouting = pattern<LogisticsRoutingArgs>(
  ({ routes, shipments }) => {
    const routesList = liftSanitizeRoutes(routes);
    const baseShipments = liftBaseShipments({
      entries: shipments,
      routeList: routesList,
    });

    const shipmentStore = cell<ShipmentRecord[]>([]);

    const assignmentList = liftAssignmentList({
      stored: shipmentStore,
      base: baseShipments,
    });

    const loadMetrics = liftLoadMetrics({
      routeList: routesList,
      shipmentsList: assignmentList,
    });

    const availableRoutes = liftAvailableRoutes(loadMetrics);
    const overloaded = liftOverloaded(loadMetrics);

    const shipmentCount = liftShipmentCount(assignmentList);
    const routeCount = liftRouteCount(routesList);
    const overloadedCount = liftOverloadedCount(overloaded);

    const status =
      str`${shipmentCount} shipments across ${routeCount} routes; overloaded ${overloadedCount}`;

    const history = cell<string[]>([]);
    const lastAction = cell("initialized");
    const sequence = cell(0);

    const historyView = liftHistoryView(history);
    const lastActionView = liftLastActionView(lastAction);

    const assignShipment = reassignShipment({
      shipments: shipmentStore,
      baseShipments,
      routes: routesList,
      history,
      lastAction,
      sequence,
    });

    return {
      routes: routesList,
      shipments: assignmentList,
      loadMetrics,
      availableRoutes,
      overloadedRoutes: overloaded,
      status,
      history: historyView,
      lastAction: lastActionView,
      assignShipment,
    };
  },
);

export type { RouteDefinition, RouteLoadMetric, ShipmentRecord };

export default logisticsRouting;
