/**
 * A V8 heap snapshot of the calling thread's isolate, written to a file, for
 * finding what holds a thread's memory. Writing one stops the thread until
 * the file is complete, and V8 needs memory of its own while it writes, so a
 * process takes one isolate's snapshot at a time.
 */

import { writeHeapSnapshot } from "@node/v8";

/**
 * Writes a heap snapshot of this isolate into `directory`, named for the
 * process, `thread` and the time, and returns the file's path.
 */
export function writeThreadHeapSnapshot(
  directory: string,
  thread: string,
): string {
  const time = new Date().toISOString().replaceAll(":", "-");
  return writeHeapSnapshot(
    `${directory}/heap-${Deno.pid}-${thread}-${time}.heapsnapshot`,
  );
}
