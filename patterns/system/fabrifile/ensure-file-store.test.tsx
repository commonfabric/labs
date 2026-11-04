/**
 * `ensureFileStore` names a new store in a record that names none, as a piece
 * in the record's space, keeps the store a record names however often it is
 * asked again, and does nothing bound to no record at all.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import type { FileStoreOutput } from "./schemas.tsx";
import { ensureFileStore, type FileStoreRecord } from "./store.tsx";

/** A store the test holds, to compare a later one with. */
interface HeldStore {
  store?: Writable<FileStoreOutput>;
}

export default pattern(() => {
  // A record that names no store, as a root's does before one is needed.
  const record = Writable.of<FileStoreRecord>({});
  const ensure = ensureFileStore({ fileStore: record });
  const unbound = ensureFileStore({});
  const held = Writable.of<HeldStore>({});
  // Something in the test's space, which is the record's.
  const here = new Writable({ [NAME]: "Here" });
  const hold = action(() => held.set({ store: record.get().store }));

  return {
    [TESTS]: [
      { assertion: assert(() => record.get().store === undefined) },
      { action: ensure },
      // The store is a piece in the record's space, and starts out empty.
      {
        assertion: assert(() =>
          record.get().store !== undefined &&
          spaceOf(record.key("store")) === spaceOf(here) &&
          record.key("store").get()?.get().entries.length === 0
        ),
      },
      { action: hold },
      // Asked again, it keeps the store the record names.
      { action: ensure },
      { action: ensure },
      {
        assertion: assert(() =>
          held.get().store !== undefined &&
          record.key("store").equals(held.key("store"))
        ),
      },
      // Bound to no record, it does nothing, and fails nothing.
      { action: unbound },
      {
        assertion: assert(() => record.key("store").equals(held.key("store"))),
      },
    ],
  };
});
