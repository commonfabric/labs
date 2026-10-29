import * as Engine from "@commonfabric/memory/v2/engine";
import { DEFAULT_BRANCH, scopeOfScopeKey } from "@commonfabric/memory/v2";
import type { StoreReadThrough } from "../storage/interface.ts";

/**
 * A store read-through backed by one space's engine, for the serving
 * runtime co-hosted with it: reads the named instance at the engine's
 * current head and returns it in the keyed frame-entry shape the memory
 * server delivers to a lease-holder session, `coverClass` included. An
 * address the engine holds nothing at comes back as a `deleted` entry at
 * seq 0. Every call is one synchronous engine read; the engine's own
 * document cache stands in front of it. `onRead` is called once per
 * read, for the caller's counters. Once the engine's database has been
 * closed the read-through returns `undefined` for every address: a
 * finalized statement must not be reached, and a runtime still reading
 * past that point is one being torn down.
 */
export const engineReadThrough = (
  engine: Engine.Engine,
  options: { onRead?: () => void } = {},
): StoreReadThrough =>
({ id, scopeKey }) => {
  if (!engine.database.open) return undefined;
  options.onRead?.();
  const state = Engine.readState(engine, { id, scopeKey });
  const seq = state?.seq ?? 0;
  const coverClass = Engine.commitClassOfSeq(engine, seq);
  const entry = {
    branch: state?.branch ?? DEFAULT_BRANCH,
    id,
    scope: scopeOfScopeKey(scopeKey),
    scopeKey,
    seq,
    ...(coverClass === undefined ? {} : { coverClass }),
  };
  return state === null || state.document === null
    ? { ...entry, deleted: true as const }
    : { ...entry, doc: state.document };
};
