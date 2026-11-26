/**
 * A store finds its viewer's profile with `#profile`, and says why it refuses
 * an add for want of one as that wish reports it. The test runtime's home has
 * no profile, so the wish confirms there is none; `store.test.tsx` covers a
 * wish that could not look, and one that has not answered yet.
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import type { FileRequestOutcome } from "./schemas.tsx";
import { ensureFileStore, type FileStoreRecord } from "./store.tsx";

export default pattern(() => {
  const record = Writable.of<FileStoreRecord>({});
  const ensure = ensureFileStore({ fileStore: record });
  // Sent through the record's link, as a room's composer sends to its store,
  // so that the send needs nothing of the store's result but the stream.
  const action_add = action(() => {
    record.key("store").key("add").send({ requestId: "add", name: "new.png" });
  });

  return {
    [TESTS]: [
      { action: ensure },
      { action: action_add },
      {
        assertion: assert(() => {
          const refused: FileRequestOutcome | undefined = record.key("store")
            .get()?.get()?.requests?.["add"];
          return refused?.status === "refused" &&
            refused.code === "not-permitted" &&
            refused.reason === "You have no profile yet.";
        }),
      },
    ],
  };
});
