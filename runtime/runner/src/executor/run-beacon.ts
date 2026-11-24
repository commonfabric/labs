/**
 * A serving worker's run beacon (serving-loop.md §2, "The watchdog"): three
 * slots of memory that a serving worker's thread shares with the thread that
 * holds its pool. The worker's schedulers write them around every action run,
 * and the pool reads them on its watchdog timer, so the pool knows which run
 * holds a silent worker's thread, and for how long, without a message from the
 * worker, which a thread a run holds cannot send.
 *
 * - `epoch` counts the starts and ends of runs, so it is odd while a run's body
 *   holds the thread. A body that returns a promise has let go of the thread
 *   once it returns, and the epoch is even from then on.
 * - `run` holds the number the worker gave the run when it started.
 * - `reads` counts the reads the live run has made at the read sites
 *   (`read-stats.ts`). A count that moves is a run doing work, and one that
 *   does not is a run in a loop of its own, or a thread that has stopped.
 *
 * The worker numbers an action the first time it runs it, and posts what the
 * number stands for once (`RunBeacon`'s `report`). A post per run would make
 * every run a message, and the watchdog takes any message from a worker for a
 * sign of life. A served handler's run for an event gets a number of its own,
 * posted as it starts, since the event is what the pool acts on when it ends
 * the worker. Only the outermost of runs started inside one another is marked:
 * it is the one that holds the thread.
 */

import type { MemorySpace } from "../storage/interface.ts";
import { countReadsInto } from "../read-stats.ts";
import { getSchedulerActionName } from "../scheduler/diagnostics.ts";
import type {
  Action,
  EventHandler,
  TelemetryAnnotations,
} from "../scheduler/types.ts";

/** Index of the slot counting run starts and ends. */
const EPOCH = 0;

/** Index of the slot holding the live run's number. */
const RUN = 1;

/** Index of the slot counting the live run's reads. */
const READS = 2;

/** How many slots a beacon has. */
const SLOTS = 3;

/** The durable stream entry a served handler's run handles. */
export type RunEvent = {
  /** The stream's sidecar document. */
  readonly sidecarId: string;

  /** The entry's event. */
  readonly eventId: string;

  /** The entry's arrival position, `0` for a seq-less entry. */
  readonly seq: number;
};

/** What a number on a beacon stands for, as the worker posts it. */
export type RunIdentity = {
  /** The number the beacon's `run` slot holds while the run is live. */
  readonly run: number;

  /** The space whose serving runtime runs it. */
  readonly space: MemorySpace;

  /**
   * The scheduler's id for the action, which the serving loop's action costs
   * (`action-costs.ts`) key the action's row by.
   */
  readonly action: string;

  /** The action's module or pattern name, where it carries one. */
  readonly name?: string;

  /** The root of the piece the action belongs to, where it is known. */
  readonly piece?: string;

  /** For a served handler's run, the event it handles. */
  readonly event?: RunEvent;
};

/** One reading of a beacon whose run is live. */
export type RunBeaconReading = {
  /** The `epoch` slot, which names this run among every run of the worker. */
  readonly epoch: number;

  /** The run's number, which the worker's {@link RunIdentity} explains. */
  readonly run: number;

  /** The reads the run has made so far. */
  readonly reads: number;
};

/** What a serving runtime's scheduler marks on its worker's beacon. */
export type SpaceRunBeacon = {
  /**
   * Runs `body`, the body of a run of `action`, marking the beacon while it
   * holds the thread. `actionId` is the scheduler's id for the action.
   * `event` is the stream entry a served handler's run handles.
   */
  readonly hold: <T>(
    action: Action | EventHandler,
    actionId: string,
    body: () => T,
    event?: RunEvent,
  ) => T;
};

/** Allocates the memory of one beacon, which a worker's init carries. */
export function newRunBeaconBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(SLOTS * Int32Array.BYTES_PER_ELEMENT);
}

/**
 * Returns what `buffer` shows of the run whose body holds the worker's thread,
 * or `undefined` while no run's body does.
 *
 * The worker's thread runs on while the slots are read, so the run whose epoch
 * the reading took can end, and another start and write its number, before the
 * reading takes the number. The epoch is read again after the other slots, and
 * a reading whose epoch moved is discarded, as a reading of no run, rather
 * than pairing one run's epoch with another's number.
 */
export function readRunBeacon(
  buffer: SharedArrayBuffer,
): RunBeaconReading | undefined {
  const slots = new Int32Array(buffer);
  const epoch = Atomics.load(slots, EPOCH);
  if ((epoch & 1) === 0) return undefined;
  const run = Atomics.load(slots, RUN);
  const reads = Atomics.load(slots, READS);
  if (Atomics.load(slots, EPOCH) !== epoch) return undefined;
  return { epoch, run, reads };
}

/**
 * The worker's side of a beacon, which every serving runtime of the worker
 * marks through a {@link SpaceRunBeacon} of its space. It numbers each action
 * once, and each served handler's run for an event, and posts what a number
 * stands for through `report` before the run's body starts.
 */
export class RunBeacon {
  readonly #slots: Int32Array;
  readonly #report: (identity: RunIdentity) => void;

  /** The numbers given to actions, by action. */
  readonly #numbers = new WeakMap<Action | EventHandler, number>();

  /** How many marked runs are on the thread's stack. */
  #depth = 0;

  /** The last number given. */
  #last = 0;

  /**
   * Constructs an instance which marks `buffer`, as a worker's init carries
   * it, and posts what each number stands for through `report`.
   */
  constructor(
    buffer: SharedArrayBuffer,
    report: (identity: RunIdentity) => void,
  ) {
    this.#slots = new Int32Array(buffer);
    this.#report = report;
  }

  /**
   * The start and end of a run's body as `forSpace()` marks them, which a
   * stand-in worker drives one at a time to hold a run open across a test's
   * clock steps.
   */
  get accessForTestingOnly(): {
    enter(
      space: MemorySpace,
      action: Action | EventHandler,
      actionId: string,
      event?: RunEvent,
    ): void;
    leave(): void;
  } {
    return {
      enter: (space, action, actionId, event) =>
        this.#enter(space, action, actionId, event),
      leave: () => this.#leave(),
    };
  }

  /**
   * Has every read site of this realm count into the beacon's `reads` slot,
   * and returns the function that stops the count. A worker's beacon counts
   * for as long as the worker lives.
   */
  countReads(): () => void {
    countReadsInto(this.#slots, READS);
    return () => countReadsInto(undefined, READS);
  }

  /** Returns what the serving runtime of `space` marks the beacon through. */
  forSpace(space: MemorySpace): SpaceRunBeacon {
    return {
      hold: (action, actionId, body, event) => {
        this.#enter(space, action, actionId, event);
        try {
          return body();
        } finally {
          this.#leave();
        }
      },
    };
  }

  /**
   * Helper for `forSpace()`, which marks the start of a run's body: the run's
   * number first, posting what it stands for if it is new, then the epoch,
   * which makes the number the live run's for a reader. A post that throws
   * leaves the beacon as it was.
   */
  #enter(
    space: MemorySpace,
    action: Action | EventHandler,
    actionId: string,
    event: RunEvent | undefined,
  ): void {
    if (this.#depth > 0) {
      this.#depth += 1;
      return;
    }
    let run = event === undefined ? this.#numbers.get(action) : undefined;
    if (run === undefined) {
      run = ++this.#last;
      if (event === undefined) this.#numbers.set(action, run);
      const name = getSchedulerActionName(action);
      const piece = (action as Partial<TelemetryAnnotations>)
        .schedulerObservationIdentity?.pieceRootId;
      this.#report({
        run,
        space,
        action: actionId,
        ...(name === undefined ? {} : { name }),
        ...(piece === undefined ? {} : { piece }),
        ...(event === undefined ? {} : { event }),
      });
    }
    this.#depth = 1;
    this.#slots[READS] = 0;
    Atomics.store(this.#slots, RUN, run);
    Atomics.add(this.#slots, EPOCH, 1);
  }

  /** Helper for `forSpace()`, which marks the end of a run's body. */
  #leave(): void {
    if (this.#depth === 0 || --this.#depth > 0) return;
    Atomics.add(this.#slots, EPOCH, 1);
  }
}
