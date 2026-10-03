import type { CellHandle } from "@commonfabric/runtime-client";

/**
 * What a component displays of `handle`'s cell: its value, or nothing while
 * the worker refuses the handle's read. Unlike `get()`, it does not throw for
 * a refusal, so a render in progress displays nothing of the cell in its
 * place, and a component that displays the cell's contents displays a
 * placeholder where `handle.refusal` is set.
 *
 * For display only. It reads a refusal as nothing, and nothing is what a
 * cell that holds nothing reads as too, so a value computed from it, to write
 * or to decide whether to write, would replace a value the host was never
 * shown. Code that writes reads with `get()`, which throws for a refusal, or
 * checks `handle.refusal` first.
 */
export function valueForDisplay<T>(
  handle: CellHandle<T>,
): Readonly<T> | undefined {
  const read = handle.lastRead();
  return "refused" in read ? undefined : read.value;
}
