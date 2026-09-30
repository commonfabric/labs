/**
 * The allocators, re-exported so a test can hold the functions the pattern
 * runtime runs.
 *
 * `collection-naming/naming.ts` takes `lift`, `Writable` and `equals` from
 * `commonfabric` as VALUES, and those are ambient declarations that bind
 * nothing outside the pattern runtime's module environment — a plain Deno
 * import of that module fails to link. Compiling this file through the
 * harness puts `naming.ts` in the graph, where `commonfabric` resolves to the
 * real builder, and hands the evaluated `assignName` and `createNamed` back to
 * the host.
 */

export { assignName, createNamed } from "../../collection-naming/naming.ts";
