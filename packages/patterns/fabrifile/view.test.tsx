/**
 * A store's rendering, over a store whose streams only record what they are
 * sent: what each row shows of its entry, and what its controls send.
 */
import {
  action,
  assert,
  type Cell,
  computed,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findNodeByProp,
  propValue,
  readValue,
} from "../test/vnode-helpers.ts";
import {
  type AddFileEvent,
  epochNsecFromMsec,
  type FileEntry,
  type FileProfile,
  type RemoveFileEvent,
  type RenameFileEvent,
} from "./schemas.tsx";
import { FileStoreView } from "./view.tsx";

const SPACE = "did:key:z6Mk-fabrifile-view";

/** Records the name of each entry a `remove` names. */
const recordRemove = handler<RemoveFileEvent, { log: Writable<string[]> }>(
  (event, { log }) => {
    log.push(`remove ${event.entry?.get().name}`);
  },
);

/** Records each name a `rename` asks for. */
const recordRename = handler<RenameFileEvent, { log: Writable<string[]> }>(
  (event, { log }) => {
    log.push(`rename ${event.entry?.get().name} to ${event.name}`);
  },
);

/** Records each name an `add` asks for. */
const recordAdd = handler<AddFileEvent, { log: Writable<string[]> }>(
  (event, { log }) => {
    log.push(`add ${event.name}`);
  },
);

export default pattern(() => {
  const log = Writable.of<string[]>([]);
  const profile = Writable.of<FileProfile>({ name: "Ada" });
  // An entry links its adder's profile, a cell, which only an action can
  // write into it.
  const list = Writable.of<FileEntry[]>([]);
  const entries = computed((): Cell<FileEntry>[] =>
    list.get().map((_, i) => list.key(i))
  );
  const action_seed = action(() => {
    list.push({
      name: "photo.png",
      mediaType: "image/png",
      blob: { space: SPACE, id: "fid1:photo" },
      size: 2048,
      addedAt: epochNsecFromMsec(0),
      addedBy: profile,
    });
  });
  const view = FileStoreView({
    store: {
      entries,
      byName: {},
      requests: {},
      add: recordAdd({ log }),
      remove: recordRemove({ log }),
      rename: recordRename({ log }),
    },
  });

  const action_remove = action(() => clickButton(view[UI], "Remove"));
  const action_rename = action(() => {
    const input = findNodeByProp(view[UI], "placeholder", "Rename to…");
    const submit = propValue(input, "oncf-submit") as {
      send: (event: unknown) => void;
    };
    submit.send({ detail: { value: "holiday.png" } });
  });

  return {
    [TESTS]: [
      { action: action_seed },
      {
        assertion: assert(() =>
          readValue(propValue(findElement(view[UI], "cf-image"), "blob")) !==
            undefined
        ),
      },
      {
        assertion: assert(() =>
          JSON.stringify(
            readValue(propValue(findElement(view[UI], "cf-blob-link"), "blob")),
          ) === JSON.stringify({ space: SPACE, id: "fid1:photo" })
        ),
      },
      {
        assertion: assert(() =>
          readValue(
            propValue(findElement(view[UI], "cf-blob-link"), "name"),
          ) ===
            "photo.png"
        ),
      },
      { action: action_remove },
      { assertion: assert(() => log.get().join("; ") === "remove photo.png") },
      { action: action_rename },
      {
        assertion: assert(() =>
          log.get().join("; ") ===
            "remove photo.png; rename photo.png to holiday.png"
        ),
      },
    ],
    view,
  };
});
