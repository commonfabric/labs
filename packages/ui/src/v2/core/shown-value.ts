import type { CellHandle } from "@commonfabric/runtime-client";

/**
 * What a component shows of `handle`'s cell: its value, or nothing while the
 * worker refuses the handle's read. Unlike `get()`, it does not throw for a
 * refusal, so a render in progress shows nothing of the cell in its place. A
 * component that shows the cell's contents shows a placeholder where
 * `handle.refusal` is set, and one that writes checks it first: a value made
 * from the nothing read here would replace one the host was never shown.
 */
export function shownValue<T>(
  handle: CellHandle<T>,
): Readonly<T> | undefined {
  const read = handle.lastRead();
  return "refused" in read ? undefined : read.value;
}
