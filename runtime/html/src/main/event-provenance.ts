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

type EventLike = Pick<Event, "isTrusted" | "target"> & {
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
 * The UI provenance is read from `boundNode` and the nodes above it, never from
 * the nodes between `boundNode` and the event's target, and there is none when
 * one of those nodes carries `data-ui-pattern`. So a click vouches only for the
 * handlers bound on or inside the innermost trusted surface it lands in: a
 * listener above that surface gets no UI provenance, even one on an element
 * carrying markers of its own. There is none either when `boundNode` is not on
 * the event's path, or without a `boundNode`.
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
    const path = boundNode && getBoundNodePath(event, boundNode);
    const ui = path && getEventUiProvenance(path);
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
 * Returns `boundNode` and the nodes above it on the event's path, or
 * `undefined` when `boundNode` is not on the path or a node between it and the
 * event's target carries `data-ui-pattern`.
 */
const getBoundNodePath = (
  event: EventLike,
  boundNode: EventTarget,
): readonly unknown[] | undefined => {
  const path = getEventPath(event);
  const start = path.indexOf(boundNode);
  if (start < 0 || path.slice(0, start).some(carriesUiPattern)) {
    return undefined;
  }
  return path.slice(start);
};

/**
 * Returns the event's path from its target up: its composed path, which
 * crosses shadow boundaries as the event does, or else the chain of parent
 * nodes from its target, which ends at the first shadow root it reaches.
 */
const getEventPath = (event: EventLike): readonly unknown[] => {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    if (Array.isArray(path) && path.length > 0) {
      return path;
    }
  }

  const path: unknown[] = [];
  let current: unknown = event.target;
  while (current && typeof current === "object") {
    path.push(current);
    current = "parentNode" in current ? current.parentNode : undefined;
  }
  return path;
};

const carriesUiPattern = (node: unknown): boolean => {
  const dataset = readDataset(node);
  return dataset !== undefined && "uiPattern" in dataset;
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
