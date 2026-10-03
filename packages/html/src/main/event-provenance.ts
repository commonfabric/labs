export type EventProvenance = {
  origin: "dom";
  trusted: boolean;
  ui?: EventUiProvenance;
};

export type EventUiProvenance = {
  pattern?: string;
  eventIntegrity?: string[];
  uiContractDataset?: Record<string, string>;
};

type EventLike = Pick<Event, "isTrusted"> & {
  composedPath?: () => readonly unknown[];
};

const UI_CONTRACT_DATASET_KEYS = [
  "uiAction",
  "uiSurface",
  "uiRole",
  "uiDisclosureKind",
] as const;

/**
 * Returns the provenance of `event` as the listener bound on `boundNode`
 * receives it, or `undefined` when the browser did not mark the event trusted.
 *
 * The UI provenance is read from `boundNode` and the nodes above it, and never
 * from the nodes between `boundNode` and the event's target. So a trusted
 * surface's markers vouch for a click only to the handlers bound on the surface
 * or inside it: a listener on an ancestor outside the surface, which the same
 * click reaches as it bubbles, finds none of them on its own path. Without a
 * `boundNode`, the event carries no UI provenance.
 */
export const getEventProvenance = (
  event: EventLike,
  boundNode?: EventTarget,
): EventProvenance | undefined => {
  if (event.isTrusted) {
    const provenance: EventProvenance = {
      origin: "dom",
      trusted: true,
    };
    const ui = boundNode &&
      getEventUiProvenance(getBoundNodePath(event, boundNode));
    if (ui) {
      provenance.ui = ui;
    }
    return provenance;
  }
  return undefined;
};

export const getEventTargetDataset = (
  target?: EventTarget | null,
): Record<string, string> | undefined => readDataset(target);

const getEventUiContractDataset = (
  path: readonly unknown[],
): Record<string, string> | undefined => {
  for (const node of path) {
    const dataset = readDataset(node);
    const uiContractDataset = dataset && pickUiContractDataset(dataset);
    if (uiContractDataset) {
      return uiContractDataset;
    }
  }
  return undefined;
};

const getEventUiProvenance = (
  path: readonly unknown[],
): EventUiProvenance | undefined => {
  let pattern: string | undefined;
  const eventIntegrity = new Set<string>();
  const uiContractDataset = getEventUiContractDataset(path);
  for (const current of path) {
    const dataset = readDataset(current);
    if (dataset) {
      if (
        pattern === undefined &&
        "uiPattern" in dataset &&
        typeof dataset.uiPattern === "string"
      ) {
        pattern = dataset.uiPattern;
      }
      const labels = "uiEventIntegrity" in dataset &&
          typeof dataset.uiEventIntegrity === "string"
        ? splitIntegrityLabels(dataset.uiEventIntegrity)
        : undefined;
      if (labels) {
        labels.forEach((label) => eventIntegrity.add(label));
      }
    }
  }
  return pattern || eventIntegrity.size > 0 ||
      uiContractDataset !== undefined
    ? {
      ...(pattern ? { pattern } : {}),
      ...(eventIntegrity.size > 0
        ? { eventIntegrity: [...eventIntegrity] }
        : {}),
      ...(uiContractDataset ? { uiContractDataset } : {}),
    }
    : undefined;
};

/**
 * Returns `boundNode` and the nodes above it: the part of the event's composed
 * path that starts at `boundNode`, which crosses shadow boundaries as the event
 * does. When the composed path does not hold `boundNode`, returns the chain of
 * parent nodes from `boundNode` instead, which ends at the first shadow root it
 * reaches.
 */
const getBoundNodePath = (
  event: { composedPath?: () => readonly unknown[] },
  boundNode: EventTarget,
): readonly unknown[] => {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    const start = Array.isArray(path) ? path.indexOf(boundNode) : -1;
    if (start >= 0) {
      return path.slice(start);
    }
  }

  const path: unknown[] = [];
  let current: unknown = boundNode;
  while (current && typeof current === "object") {
    path.push(current);
    current = "parentNode" in current ? current.parentNode : undefined;
  }
  return path;
};

const readDataset = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || !("dataset" in value)) {
    return undefined;
  }
  const source = value.dataset;
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const dataset: Record<string, string> = {};
  for (const key in source) {
    dataset[key] = String((source as Record<string, unknown>)[key]);
  }
  return Object.keys(dataset).length > 0 ? dataset : undefined;
};

const pickUiContractDataset = (
  dataset: Record<string, string>,
): Record<string, string> | undefined => {
  const result: Record<string, string> = {};
  for (const key of UI_CONTRACT_DATASET_KEYS) {
    if (key in dataset) {
      result[key] = dataset[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const splitIntegrityLabels = (value: string): string[] | undefined => {
  const labels = value.split(/[\s,]+/).filter((label) => label.length > 0);
  return labels.length > 0 ? labels : undefined;
};
