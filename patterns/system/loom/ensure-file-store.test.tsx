/**
 * The Loom creates its space's file store when it names none, keeps the store
 * it names however often it is asked again, and adds no panel for it.
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
import type { FileStoreOutput } from "../fabrifile/schemas.tsx";
import Loom from "./main.tsx";

/** A store the test holds, to compare a later one with. */
interface HeldStore {
  store?: Writable<FileStoreOutput>;
}

export default pattern(() => {
  // A Loom that names no store, so `ensureFileStore` creates one.
  const loom = Loom({});
  const held = Writable.of<HeldStore>({});
  // Something in the test's space, which is the Loom's.
  const here = new Writable({ [NAME]: "Here" });
  const ensure = action(() => loom.ensureFileStore.send());
  const hold = action(() => {
    if (loom.fileStore !== undefined) held.set({ store: loom.fileStore });
  });

  return {
    [TESTS]: [
      { assertion: assert(() => loom.fileStore?.get() === undefined) },
      { action: ensure },
      // The store is a piece in the Loom's space, and starts out empty.
      {
        assertion: assert(() =>
          loom.fileStore?.get() !== undefined &&
          spaceOf(loom.fileStore) === spaceOf(here) &&
          loom.fileStore.key("entries").get()?.length === 0
        ),
      },
      // It is no panel, and no piece the root registers.
      {
        assertion: assert(() =>
          loom.panels.length === 0 && loom.pieceRegistry.length === 0
        ),
      },
      { action: hold },
      // Asked again, it creates nothing and keeps the store it named.
      { action: ensure },
      { action: ensure },
      {
        assertion: assert(() =>
          held.get().store?.get() !== undefined &&
          loom.fileStore?.equals(held.key("store")) === true
        ),
      },
      {
        assertion: assert(() =>
          loom.panels.length === 0 && loom.pieceRegistry.length === 0
        ),
      },
    ],
  };
});
