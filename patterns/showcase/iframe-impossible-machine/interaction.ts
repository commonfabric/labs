/** Keeps embedded controls out of React Flow's node-selection lifecycle. */
export function stopNodeControlPropagation(
  event: Pick<Event, "stopPropagation">,
): void {
  event.stopPropagation();
}

/** Returns the event boundary for controls embedded in a React Flow node. */
export function nodeControlBoundaryProps() {
  return {
    className: "node-parameters nodrag nopan",
    onClick: stopNodeControlPropagation,
  } as const;
}

/** Locates a stable ID in an array whose existing entries never move. */
export function findAppendOnlyItem<T extends Readonly<{ id: string }>>(
  items: readonly T[],
  id: string,
): { index: number; item: T } | undefined {
  const index = items.findIndex((item) => item.id === id);
  return index < 0 ? undefined : { index, item: items[index]! };
}

/** Converts an unknown action failure into the UI's error value. */
export function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The minimal cell surface needed for a queued read-modify-write. */
export interface LatestValueCell<T> {
  pull(): Promise<T>;
  set(value: T): Promise<unknown>;
}

/** Applies an update to the authoritative value when its queue turn begins. */
export async function updateLatestValue<T>(
  cell: LatestValueCell<T>,
  update: (current: T) => T,
): Promise<void> {
  const current = await cell.pull();
  await cell.set(update(current));
}

/** State setters used by the serialized action runner. */
export interface ActionRunnerSetters {
  setGlobalPending(value: boolean): void;
  setActionError(value: Error | undefined): void;
  setBusyNodeCounts(
    update: (
      current: Readonly<Record<string, number>>,
    ) => Readonly<Record<string, number>>,
  ): void;
}

/** Serialized actions with node-local pending state for embedded controls. */
export interface ActionRunner {
  /** Runs a global action while reporting its pending state. */
  run(action: () => Promise<void>): Promise<boolean>;
  /** Runs a node-local action while reporting that node's pending state. */
  runNode(nodeId: string, action: () => Promise<void>): Promise<boolean>;
  /** Runs an ordered action without changing any pending indicator. */
  runQuiet(action: () => Promise<void>): Promise<boolean>;
}

/** Queues writes while keeping unrelated canvas controls interactive. */
export function createActionRunner(setters: ActionRunnerSetters): ActionRunner {
  let tail = Promise.resolve();

  function updateNodeBusyCount(nodeId: string, delta: 1 | -1): void {
    setters.setBusyNodeCounts((current) => {
      const count = (current[nodeId] ?? 0) + delta;
      const next = { ...current };
      if (count > 0) next[nodeId] = count;
      else delete next[nodeId];
      return next;
    });
  }

  function enqueue(
    action: () => Promise<void>,
    nodeId?: string,
    quiet = false,
  ): Promise<boolean> {
    if (nodeId !== undefined) updateNodeBusyCount(nodeId, 1);
    const next = tail.then(async () => {
      if (nodeId === undefined && !quiet) setters.setGlobalPending(true);
      try {
        await action();
        return true;
      } catch (cause) {
        setters.setActionError(errorFrom(cause));
        return false;
      } finally {
        if (nodeId === undefined && !quiet) setters.setGlobalPending(false);
      }
    });
    tail = next.then(() => undefined);
    return nodeId === undefined
      ? next
      : next.finally(() => updateNodeBusyCount(nodeId, -1));
  }

  return {
    run: (action) => enqueue(action),
    runNode: (nodeId, action) => enqueue(action, nodeId),
    runQuiet: (action) => enqueue(action, undefined, true),
  };
}

/** Ordering state for PerUser node-selection writes. */
export interface SelectionRequestTracker {
  reconcile(authoritativeSelection: string | null): void;
  request(
    nodeId: string,
    writeSelection: (nodeId: string) => Promise<unknown>,
  ): Promise<boolean>;
}

/** Keeps rapid node selections ordered without repeating the latest request. */
export function createSelectionRequestTracker(
  initialSelection: string | null,
): SelectionRequestTracker {
  let latestRequestedSelection = initialSelection;
  let latestRequestedSequence = 0;
  let latestSuccessfulSelection = initialSelection;
  let latestSuccessfulSequence = 0;
  let authoritativeSelection = initialSelection;
  let authoritativeRequestSequence = 0;
  let requestSequence = 0;
  let pendingCount = 0;
  let latestRequestedResult = Promise.resolve(true);

  return {
    reconcile(selection) {
      authoritativeSelection = selection;
      authoritativeRequestSequence = requestSequence;
      if (pendingCount === 0) {
        latestRequestedSelection = selection;
        latestSuccessfulSelection = selection;
        latestRequestedSequence = requestSequence;
        latestSuccessfulSequence = requestSequence;
        latestRequestedResult = Promise.resolve(true);
      }
    },
    request(nodeId, writeSelection) {
      if (latestRequestedSelection === nodeId) return latestRequestedResult;
      const sequence = ++requestSequence;
      latestRequestedSelection = nodeId;
      latestRequestedSequence = sequence;
      pendingCount++;
      const result = (async () => {
        let succeeded = false;
        try {
          succeeded = (await writeSelection(nodeId)) !== false;
          if (succeeded && sequence >= latestSuccessfulSequence) {
            latestSuccessfulSelection = nodeId;
            latestSuccessfulSequence = sequence;
          }
        } finally {
          pendingCount--;
          if (
            pendingCount === 0 &&
            authoritativeRequestSequence >= latestSuccessfulSequence
          ) {
            latestRequestedSelection = authoritativeSelection;
            latestSuccessfulSelection = authoritativeSelection;
            latestRequestedSequence = authoritativeRequestSequence;
            latestSuccessfulSequence = authoritativeRequestSequence;
            latestRequestedResult = Promise.resolve(true);
          } else if (!succeeded && sequence === latestRequestedSequence) {
            latestRequestedSelection = latestSuccessfulSelection;
            latestRequestedSequence = latestSuccessfulSequence;
            latestRequestedResult = Promise.resolve(true);
          }
        }
        return succeeded;
      })();
      latestRequestedResult = result;
      return result;
    },
  };
}
