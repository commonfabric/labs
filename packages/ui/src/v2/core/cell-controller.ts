import { ReactiveController, ReactiveControllerHost } from "lit";
import {
  CellHandle,
  type CellRef,
  isCellHandle,
  type JSONSchema,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  InputTimingController,
  type InputTimingOptions,
} from "./input-timing-controller.ts";

/**
 * Configuration options for CellController
 */
export interface CellControllerOptions<T> {
  /**
   * Input timing strategy configuration
   */
  timing?: InputTimingOptions;

  /**
   * Custom getter function for extracting values from CellHandle<T> | T
   * Defaults to standard Cell.get() or direct value access
   */
  getValue?: (value: CellHandle<T> | T) => Readonly<T>;

  /**
   * Custom setter function for updating CellHandle<T> | T values
   * Defaults to standard transaction-based Cell.set() or direct assignment
   */
  setValue?: (value: CellHandle<T> | T, newValue: T, oldValue: T) => void;

  /**
   * Custom change handler called when value changes
   * Use this for component-specific logic like custom events or validation
   */
  onChange?: (newValue: T, oldValue: T) => void;

  /**
   * Whether to trigger host.requestUpdate() on Cell changes
   * Defaults to true
   */
  triggerUpdate?: boolean;
}

/**
 * A reactive controller that manages CellHandle<T> | T integration for Lit components.
 * Handles subscription lifecycle, transaction management, and timing strategies.
 *
 * This controller eliminates boilerplate code by providing a unified interface
 * for components that need to work with both plain values and reactive Cells.
 *
 * @example Basic usage:
 * ```typescript
 * class MyComponent extends BaseElement {
 *   @property() value: Cell<string> | string = "";
 *
 *   private cellController = new CellController<string>(this, {
 *     timing: { strategy: "debounce", delay: 300 },
 *     onChange: (newValue, oldValue) => {
 *       this.emit("value-changed", { value: newValue, oldValue });
 *     }
 *   });
 *
 *   private handleInput(event: Event) {
 *     const input = event.target as HTMLInputElement;
 *     this.cellController.setValue(input.value);
 *   }
 *
 *   override render() {
 *     return html`<input .value="${this.cellController.getValue()}" @input="${this.handleInput}">`;
 *   }
 * }
 * ```
 *
 * @example With timing controller integration:
 * ```typescript
 * class MyInput extends BaseElement {
 *   private cellController = new CellController<string>(this, {
 *     timing: { strategy: "blur" }
 *   });
 *
 *   private handleFocus() {
 *     this.cellController.onFocus();
 *   }
 *
 *   private handleBlur() {
 *     this.cellController.onBlur();
 *   }
 * }
 * ```
 */
export class CellController<T> implements ReactiveController {
  private host: ReactiveControllerHost;
  private options: Required<CellControllerOptions<T>>;
  private _currentValue: CellHandle<T> | T | undefined;
  private _cellUnsubscribe: (() => void) | null = null;
  private _inputTiming?: InputTimingController;

  /**
   * Pending-local-edit tracking (early-boot wipe guard)
   * A locally-edited value that bound state has not yet confirmed. While set,
   * it wins over stale bound state in getValue(), so a re-render cannot
   * repaint a pre-write snapshot over what the user just typed. Released when
   * the echo confirms it (a delivery equal to the edit), when a post-settle
   * delivery supersedes it, or when the binding moves to a different cell.
   */
  private _localEdit: { value: T } | undefined;

  /** Number of in-flight cell writes started by the default setter. */
  private _inFlightWrites = 0;

  /**
   * Re-entrancy marker: a subscription delivery firing synchronously from our
   * own optimistic set() (as opposed to a backend push). A local echo must not
   * release the edit — only durable/bound state catching up may.
   */
  private _applyingLocalWrite = false;

  /**
   * All writes settled but bound state never converged (e.g. a rebind swapped
   * in a pre-write snapshot first): deliveries are FIFO, so the next one
   * reflects post-write state and is authoritative.
   */
  private _settledAwaitingRelease = false;

  /**
   * Last authoritative user-visible value. Survives same-cell rebinds so a
   * replacement handle that has not hydrated yet (get() still undefined)
   * does not repaint emptiness over it.
   */
  private _lastKnownValue: T | undefined;

  /**
   * Whether the current subscription has received a real (asynchronous)
   * delivery. subscribe()'s synchronous initial callback merely echoes the
   * handle's local cache — for a freshly minted rebound handle that is
   * "no information yet", NOT an authoritative undefined. Once any real
   * delivery arrives, an undefined value is an authoritative clear and must
   * repaint (it may not be masked by _lastKnownValue).
   */
  private _bindingHydrated = false;

  /** True only while subscribe() runs its synchronous initial callback. */
  private _subscribeEcho = false;

  /**
   * Bumped when binding to a different persistent cell, so settle callbacks
   * from writes against a previous binding cannot release the new one.
   */
  private _bindEpoch = 0;

  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<T> = {},
  ) {
    this.host = host;
    this.options = {
      timing: options.timing || { strategy: "debounce", delay: 300 },
      getValue: options.getValue || this.defaultGetValue.bind(this),
      setValue: options.setValue || this.defaultSetValue.bind(this),
      onChange: options.onChange || (() => {}),
      triggerUpdate: options.triggerUpdate ?? true,
    };

    // Create timing controller if timing options are provided
    if (this.options.timing) {
      this._inputTiming = new InputTimingController(host, this.options.timing);
    }

    host.addController(this);
  }

  /**
   * Set the current value reference and set up subscriptions
   */
  bind(value: CellHandle<T> | T, schema?: JSONSchema): void {
    if (
      this._currentValue !== value &&
      !(this._currentValue instanceof CellHandle &&
        this._currentValue.equals(value))
    ) {
      // equals() compares cfcLabelView, so early-boot CFC settling hands us a
      // *fresh* handle for the same persistent cell (with a stale or
      // not-yet-hydrated snapshot). Local-edit continuity must follow the
      // persistent cell, not the handle: keep the tracking across a same-cell
      // rebind, drop it when the binding moves to a different cell.
      const samePersistentCell = this._currentValue instanceof CellHandle &&
        value instanceof CellHandle &&
        sameCellDoc(this._currentValue.ref(), value.ref());
      if (!samePersistentCell) {
        this._bindEpoch++;
        this._localEdit = undefined;
        this._settledAwaitingRelease = false;
        this._lastKnownValue = undefined;
        this._bindingHydrated = false;
      }
      this._cleanupCellSubscription();
      // Only apply the component's schema when the CellHandle doesn't already
      // have one. Pattern-compiled $bindings (e.g. $images, $files) arrive with
      // a schema from the pattern compiler — overriding it via asSchema() would
      // create a divergent cell view where component writes and pattern reads
      // target different schema projections.
      if (
        schema !== undefined && value instanceof CellHandle &&
        !value.ref().schema
      ) {
        this._currentValue = value.asSchema<T>(schema);
      } else {
        this._currentValue = value;
      }
      this._setupCellSubscription();
    }
  }

  /**
   * Get the current value from CellHandle<T> | T
   */
  getValue(): Readonly<T> {
    // A pending local edit wins over bound state until it is confirmed or
    // superseded — a re-render in that window must not repaint stale state.
    if (this._localEdit !== undefined) {
      return this._localEdit.value as Readonly<T>;
    }
    if (this._currentValue === undefined || this._currentValue === null) {
      return undefined as T;
    }
    // A same-cell rebind can install a handle that has not hydrated yet
    // (get() still undefined). Keep showing the last known value until its
    // first real delivery arrives instead of repainting emptiness. Once the
    // subscription has delivered, an undefined value is an authoritative
    // clear and must show the component's normal empty fallback.
    if (
      !this._bindingHydrated &&
      isCellHandle(this._currentValue) &&
      (this._currentValue as CellHandle<T>).get() === undefined &&
      this._lastKnownValue !== undefined
    ) {
      return this._lastKnownValue as Readonly<T>;
    }
    return this.options.getValue(this._currentValue);
  }

  /**
   * Set a new value, handling timing and transactions
   */
  setValue(newValue: T): void {
    if (this._currentValue === undefined || this._currentValue === null) return;

    const oldValue = this.getValue();

    if (isCellHandle(this._currentValue)) {
      // Track the edit so stale bound-state deliveries (late hydration,
      // partial echoes of earlier keystrokes, pre-write snapshots on rebound
      // handles) cannot repaint over it while the write is pending.
      this._localEdit = { value: newValue };
      this._settledAwaitingRelease = false;
      this._lastKnownValue = newValue;
    }

    const performUpdate = () => {
      this._applyingLocalWrite = true;
      try {
        this.options.setValue(this._currentValue!, newValue, oldValue);
      } finally {
        this._applyingLocalWrite = false;
      }

      // A custom setter gives no in-flight signal, so the local apply is all
      // the confirmation we will get — release the edit right away (status
      // quo behavior for such components). The default setter tracks its
      // write and releases on settle instead.
      if (this._inFlightWrites === 0) {
        this._localEdit = undefined;
      }

      // Call custom change handler
      this.options.onChange(newValue, oldValue);
    };

    // Use timing controller if available
    if (this._inputTiming) {
      this._inputTiming.schedule(performUpdate);
    } else {
      performUpdate();
    }
  }

  /**
   * Update timing controller options
   */
  updateTimingOptions(timingOptions: Partial<InputTimingOptions>): void {
    if (this._inputTiming) {
      this._inputTiming.updateOptions(timingOptions);
    }
    this.options.timing = { ...this.options.timing, ...timingOptions };
  }

  /**
   * Notify timing controller of focus event
   */
  onFocus(): void {
    this._inputTiming?.onFocus();
  }

  /**
   * Notify timing controller of blur event
   */
  onBlur(): void {
    this._inputTiming?.onBlur();
  }

  /**
   * Cancel any pending operations
   */
  cancel(): void {
    this._inputTiming?.cancel();
    // A cancelled pending write abandons its local edit; bound state is
    // authoritative again.
    this._localEdit = undefined;
    this._settledAwaitingRelease = false;
  }

  /**
   * Run any pending (debounced or throttled) write immediately, so a following
   * read or commit sees the latest value.
   */
  flush(): void {
    this._inputTiming?.flush();
  }

  /**
   * Check if current value is a Cell
   */
  hasCell(): boolean {
    return isCellHandle(this._currentValue);
  }

  /**
   * Get the underlying Cell (if applicable)
   */
  getCell(): CellHandle<T> | null {
    return isCellHandle(this._currentValue)
      ? this._currentValue as CellHandle<T>
      : null;
  }

  //
  // ReactiveController implementation
  //

  hostConnected(): void {
    this._setupCellSubscription();
  }

  hostDisconnected(): void {
    this._cleanupCellSubscription();
    this._inputTiming?.cancel();
  }

  //
  // Private methods
  //

  private defaultGetValue(value: CellHandle<T> | T): T {
    if (isCellHandle(value)) {
      const cellValue = (value as CellHandle<T>).get();
      return cellValue === undefined ? (cellValue as T) : cellValue;
    }
    return value as T;
  }

  private defaultSetValue(
    value: CellHandle<T> | T,
    newValue: T,
    _oldValue: T,
  ): void {
    if (isCellHandle(value)) {
      const epoch = this._bindEpoch;
      this._inFlightWrites++;
      // set() resolves once the write round-trip completes (it never rejects;
      // failures are logged and swallowed inside set()).
      value.set(newValue).finally(() => {
        this._inFlightWrites--;
        if (epoch !== this._bindEpoch || this._inFlightWrites > 0) return;
        this._releaseLocalEditAfterSettle();
      });
    } else {
      // For non-Cell values, we can't directly modify them
      // This should be handled by the component's property system
      // The caller should update their property and trigger re-render
    }
  }

  /**
   * All in-flight writes settled: release the pending local edit if bound
   * state converged on it. If it did not (a same-cell rebind may have swapped
   * in a pre-write snapshot first), keep the edit but mark that the next
   * delivery is authoritative — deliveries are FIFO, so anything arriving
   * after the write settled reflects post-write state.
   */
  private _releaseLocalEditAfterSettle(): void {
    if (this._localEdit === undefined) return;
    const raw = isCellHandle(this._currentValue)
      ? (this._currentValue as CellHandle<T>).get()
      : undefined;
    if (raw !== undefined && deepValueEqual(raw, this._localEdit.value)) {
      this._localEdit = undefined;
    } else {
      this._settledAwaitingRelease = true;
    }
  }

  private _setupCellSubscription(): void {
    if (isCellHandle(this._currentValue)) {
      let previousValue: T | undefined;
      this._bindingHydrated = false;
      this._subscribeEcho = true;
      try {
        this._cellUnsubscribe = this._currentValue.subscribe((newValue) => {
          // Call onChange when the cell value changes from the backend
          // This ensures components like cf-select can update their DOM state
          const typedNewValue = newValue as T | undefined;
          if (!this._subscribeEcho) this._bindingHydrated = true;
          const suppressed = this._classifyDelivery(typedNewValue);
          // `Object.is`, not `!==`: an unchanged `NaN` must not re-announce,
          // and a `0` -> `-0` change is a real change.
          if (!suppressed && !Object.is(typedNewValue, previousValue)) {
            const oldValue = previousValue;
            previousValue = typedNewValue;
            if (oldValue !== undefined || typedNewValue !== undefined) {
              this.options.onChange(typedNewValue as T, oldValue as T);
            }
          } else if (suppressed) {
            // Keep the raw-stream bookkeeping coherent without announcing a
            // value the UI never showed.
            previousValue = typedNewValue;
          }
          if (this.options.triggerUpdate) {
            this.host.requestUpdate();
          }
        });
      } finally {
        this._subscribeEcho = false;
      }
    }
  }

  /**
   * Decide how a subscription delivery interacts with a pending local edit.
   * Returns true when the delivery is a stale snapshot that must neither
   * repaint nor be announced over the user's pending edit.
   */
  private _classifyDelivery(value: T | undefined): boolean {
    if (this._localEdit === undefined) {
      if (value !== undefined) {
        this._lastKnownValue = value;
      } else if (this._bindingHydrated) {
        // An authoritative clear (a real delivery of undefined, not the
        // no-information initial echo of a fresh handle): forget the last
        // known value so a later same-cell rebind cannot resurrect it.
        this._lastKnownValue = undefined;
      }
      return false;
    }
    if (this._applyingLocalWrite) {
      // Our own optimistic apply echoing back synchronously. Deliver it as
      // before, but a local echo does not confirm the edit — only bound state
      // catching up (below) or the write settling may release it.
      if (value !== undefined) this._lastKnownValue = value;
      return false;
    }
    if (value !== undefined && deepValueEqual(value, this._localEdit.value)) {
      // Bound state caught up with the edit — the echo confirmed it.
      this._localEdit = undefined;
      this._settledAwaitingRelease = false;
      this._lastKnownValue = value;
      return false;
    }
    if (
      this._settledAwaitingRelease &&
      (value !== undefined || this._bindingHydrated)
    ) {
      // Writes settled without converging; deliveries are FIFO, so this one
      // reflects post-write state and supersedes the local edit — whether a
      // genuinely newer remote edit or an authoritative clear (the edit was
      // lost). A fresh rebound handle's initial undefined echo carries no
      // information and does not release.
      this._localEdit = undefined;
      this._settledAwaitingRelease = false;
      this._lastKnownValue = value;
      return false;
    }
    // Stale pre-write snapshot: late hydration, the partial echo of an
    // earlier keystroke, or a rebound handle's initial state. The local edit
    // wins until the echo confirms or a post-settle value supersedes it.
    return true;
  }

  private _cleanupCellSubscription(): void {
    if (this._cellUnsubscribe) {
      this._cellUnsubscribe();
      this._cellUnsubscribe = null;
    }
  }
}

/**
 * Whether two refs address the same persistent cell (same document, space,
 * scope and path), ignoring schema and cfcLabelView — the ref parts that
 * drift across re-renders while CFC label views settle. `CellHandle.equals()`
 * is stricter (it compares cfcLabelView), which is exactly why a drift-driven
 * rebind replaces the bound handle; local-edit continuity must follow the
 * persistent cell instead. Scope matters: user-/session-scoped cells are
 * partitioned storage, so a same-id ref with a different scope is a
 * different cell.
 */
function sameCellDoc(a: CellRef, b: CellRef): boolean {
  return a.id === b.id && a.space === b.space && a.scope === b.scope &&
    a.path.length === b.path.length &&
    a.path.every((segment, index) => segment === b.path[index]);
}

/**
 * Structural equality for confirming a local edit against a delivered cell
 * value (plain JSON-ish data; CellHandles compare by identity only).
 */
function deepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof CellHandle || b instanceof CellHandle) return false;
  if (!isObjectOrArray(a) || !isObjectOrArray(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepValueEqual(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bObj = b as Record<string, unknown>;
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every((key) =>
    Object.hasOwn(bObj, key) &&
    deepValueEqual((a as Record<string, unknown>)[key], bObj[key])
  );
}

/**
 * Specialized CellController for string values with common input patterns
 */
export class StringCellController extends CellController<string> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<string> = {},
  ) {
    super(host, {
      timing: { strategy: "debounce", delay: 300 },
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCellHandle(value)) {
          return (value as CellHandle<string>).get() || "";
        }
        // Handle empty strings explicitly - don't treat them as falsy
        return value === undefined || value === null ? "" : value as string;
      }),
    });
  }
}

/**
 * Specialized CellController for boolean values with common checkbox patterns
 */
export class BooleanCellController extends CellController<boolean> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<boolean> = {},
  ) {
    super(host, {
      timing: { strategy: "immediate" }, // Booleans usually update immediately
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCellHandle(value)) {
          return (value as CellHandle<boolean>).get() ?? false;
        }
        return value as boolean || false;
      }),
    });
  }

  /**
   * Toggle the boolean value
   */
  toggle(): void {
    this.setValue(!this.getValue());
  }
}

/**
 * Specialized CellController for array values with common list patterns
 */
export class ArrayCellController<T> extends CellController<T[]> {
  constructor(
    host: ReactiveControllerHost,
    options: CellControllerOptions<T[]> = {},
  ) {
    super(host, {
      timing: { strategy: "immediate" }, // Arrays usually update immediately
      ...options,
      getValue: options.getValue || ((value) => {
        if (isCellHandle(value)) {
          return (value as CellHandle<T[]>).get() || [];
        }
        return value as T[] || [];
      }),
    });
  }

  /**
   * Add an item to the array
   */
  addItem(item: T): void {
    if (this.hasCell()) {
      const cell = this.getCell()!;
      cell.push(item);
    } else {
      // Fallback for plain arrays
      const currentArray = this.getValue();
      this.setValue([...currentArray, item]);
    }
  }

  /**
   * Remove an item from the array
   * Note: Cell doesn't have native remove/splice methods, so we use filter + setValue
   */
  removeItem(itemToRemove: T): void {
    const currentArray = this.getValue();
    // `Object.is` matching: a `NaN` element is removable, and `0`/`-0` are
    // distinct.
    this.setValue(
      currentArray.filter((item) => !Object.is(item, itemToRemove)),
    );
  }

  /**
   * Update an item in the array
   */
  updateItem(oldItem: T, newItem: T): void {
    const currentArray = this.getValue();
    // As in `removeItem()`: match by `Object.is`, not `indexOf`'s `===`.
    const index = currentArray.findIndex((item) => Object.is(item, oldItem));
    if (index !== -1) {
      if (this.hasCell()) {
        const cell = this.getCell()!;
        const itemCell = cell.key(index);
        itemCell.set(newItem);
      } else {
        // Fallback for plain arrays
        const newArray = [...currentArray];
        newArray[index] = newItem;
        this.setValue(newArray);
      }
    }
  }
}

/**
 * Factory function for creating properly typed CellControllers
 */
export function createCellController<T>(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<T>,
): CellController<T> {
  return new CellController<T>(host, options);
}

/**
 * Factory function for string CellControllers (common case)
 */
export function createStringCellController(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<string>,
): StringCellController {
  return new StringCellController(host, options);
}

/**
 * Factory function for boolean CellControllers (common case)
 */
export function createBooleanCellController(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<boolean>,
): BooleanCellController {
  return new BooleanCellController(host, options);
}

/**
 * Factory function for array CellControllers (common case)
 */
export function createArrayCellController<T>(
  host: ReactiveControllerHost,
  options?: CellControllerOptions<T[]>,
): ArrayCellController<T> {
  return new ArrayCellController<T>(host, options);
}
