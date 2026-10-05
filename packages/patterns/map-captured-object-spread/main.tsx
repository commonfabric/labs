// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * Fixture: a spread of a captured object literal inside a reactive `.map()`
 * callback.
 *
 * `bindings` is a plain object of cells in the pattern body. The callback
 * reaches it as a capture, which it reads as an opaque reference, and the
 * handler binding spreads it. Each bound `record` stream is exported, so the
 * test can fire one and see which cells its handler was given.
 */

import {
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  Writable,
} from "commonfabric";

export interface Input {
  ids: string[];
  log: Writable<string[] | Default<[]>>;
  prefix: Writable<string | Default<"">>;
}

export interface Output {
  [NAME]: string;
  log: string[];
  record: Stream<void>[];
}

const recordId = handler<
  void,
  { log: Writable<string[]>; prefix: Writable<string>; id: string }
>((_, { log, prefix, id }) => {
  log.push(`${prefix.get()}:${id}`);
});

export default pattern<Input, Output>(({ ids, log, prefix }) => {
  const bindings = { log, prefix };
  const record = ids.map((id) => recordId({ ...bindings, id }));

  return {
    [NAME]: "Captured object spread",
    log,
    record,
  };
});
