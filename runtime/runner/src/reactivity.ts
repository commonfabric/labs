import { Cancel, isCancel, noOp } from "./cancel.ts";
import { Cell, isCell } from "./cell.ts";

/**
 * Effect that runs a callback when the value changes. The callback is also
 * called immediately. Nested reactive values are flattened out, i.e. all layers
 * are subscribed to and the callback is called on the last level.
 *
 * @param {any} value - The value to observe.
 * @param {function} callback - The callback to run when the value changes.
 * @returns {function} - A function to cancel the effect.
 */
export const effect = <T>(
  value: Cell<T> | T,
  callback: (value: T) => Cancel | undefined | void,
): Cancel => {
  if (isCell(value)) {
    return value.sink(callback);
  } else {
    const cancel = callback(value as T);
    return isCancel(cancel) ? cancel : noOp;
  }
};
