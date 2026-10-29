/** Cancel functions are zero-argument functions that perform cleanup */
export type Cancel = () => void;

export type AddCancel = (cancel: Cancel | undefined | null) => void;

export type DeferredCancelOwnership = {
  cancel: Cancel;
  isCancelled: () => boolean;

  /** Records the exact cancel installed by this attempt; returns cancellation. */
  markInstalled: (installedCancel: Cancel | undefined) => boolean;
};

/** Is value a cancel function? */
export const isCancel = (value: unknown): value is Cancel => {
  return typeof value === "function" && value.length === 0;
};

/** A cancellable is a type that may have a cancel property */
export type Cancellable = {
  cancel?: Cancel;
};

/** Cancel a cancellable */
export const cancel = (cancellable: Cancellable) => {
  cancellable.cancel?.();
};

/**
 * Create a cancel function that can gather and manage other
 * cancel functions.
 * Cancellation is latched: repeated cancellation is a no-op, and cleanup
 * added after cancellation runs immediately.
 * @returns a pair of cancel function and a function to add cancel to group.
 * @example
 * const [cancel, addCancel] = useCancelGroup();
 * addCancel(cancel1);
 * addCancel(cancel2);
 * cancel(); // Cancels all in group
 */
export const useCancelGroup = (): [Cancel, AddCancel] => {
  const cancels = new Set<Cancel>();
  let cancelled = false;

  /** Cancel all cancel functions in the group */
  const cancelAll = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;

    const errors: unknown[] = [];
    try {
      for (const cancel of cancels) {
        try {
          cancel();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      cancels.clear();
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple cancellation cleanups failed");
    }
  };

  /** Add a cancel function to the group */
  const addCancel = (cancel: Cancel | undefined | null) => {
    if (cancel == null) {
      return;
    }
    if (cancelled) {
      cancel();
      return;
    }
    cancels.add(cancel);
  };

  return [cancelAll, addCancel];
};

/**
 * Own a cancel registration that will be installed later. Cancellation before
 * installation tombstones the pending work; cancellation afterwards invokes
 * the supplied exact-registration cleanup at most once.
 */
export const useDeferredCancelOwnership = (
  cancelInstalled: (installedCancel: Cancel) => void,
): DeferredCancelOwnership => {
  let cancelled = false;
  let installedCancel: Cancel | undefined;
  let stopped = false;
  const cancel = () => {
    cancelled = true;
    if (installedCancel === undefined || stopped) return;
    stopped = true;
    cancelInstalled(installedCancel);
  };

  return {
    cancel,
    isCancelled: () => cancelled,
    markInstalled: (registration) => {
      installedCancel = registration;
      // Installation can re-enter arbitrary owner code. If cancellation
      // happened during that synchronous window, finish the hand-off now.
      if (cancelled) cancel();
      return cancelled;
    },
  };
};

export const noOp = () => {};
