/**
 * Which of a store's controls the view offers each viewer, by what the
 * store's space admits them to: an owner sees every control, a member who
 * didn't add a file can add files but not change that one, and a reader is
 * offered no change at all. The store's streams here only record what they
 * are sent; the store decides what a request does.
 */
import {
  action,
  assert,
  type Cell,
  computed,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
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
import { FileStoreView, type FileStoreViewOutput } from "./view.tsx";

const SPACE = "did:key:z6Mk-fabrifile-view-access";

/**
 * How the control under the wrapper of class `name` in `root` is displayed:
 * `block` where it is offered, `none` where it is not.
 */
const displayOf = (root: unknown, name: string) =>
  readValue(
    (propValue(findNodeByProp(root, "className", name), "style") as
      | { display?: unknown }
      | undefined)?.display,
  );

/** Records nothing; the view's offer is what these tests are about. */
const ignoreAdd = handler<AddFileEvent, Record<string, never>>(() => {});
const ignoreRemove = handler<RemoveFileEvent, Record<string, never>>(() => {});
const ignoreRename = handler<RenameFileEvent, Record<string, never>>(() => {});

/** The entries everyone in the space shares. */
interface Setup {
  list: Writable<FileEntry[]>;
}

export const setup = pattern(() => ({
  list: Writable.of<FileEntry[]>([]),
}));

/** A view over `list`, as one viewer renders it. */
const ViewOver = pattern<{ list: Writable<FileEntry[]> }, FileStoreViewOutput>(
  ({ list }) =>
    FileStoreView({
      store: {
        entries: computed((): Cell<FileEntry>[] =>
          list.get().map((_, i) => list.key(i))
        ),
        byName: {},
        requests: {},
        add: ignoreAdd({}),
        remove: ignoreRemove({}),
        rename: ignoreRename({}),
      },
    }),
);

export const owner = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<FileProfile>({ name: "Owen" });
  const view = ViewOver({ list: setup.list });
  const action_seed = action(() => {
    setup.list.push({
      name: "photo.png",
      mediaType: "image/png",
      blob: { space: SPACE, id: "fid1:photo" },
      size: 4,
      addedAt: epochNsecFromMsec(0),
      addedBy: profile,
    });
  });

  return {
    [TESTS]: [
      { action: action_seed },
      { label: "seeded" },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-add") === "block"
        ),
      },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-rename") === "block"
        ),
      },
    ],
  };
});

export const member = pattern<{ setup: Setup }>(({ setup }) => {
  const view = ViewOver({ list: setup.list });

  return {
    [TESTS]: [
      { await: "seeded" },
      {
        assertion: assert(() => countElements(view[UI], "cf-blob-link") === 1),
      },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-add") === "block"
        ),
      },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-rename") === "none"
        ),
      },
    ],
  };
});

export const reader = pattern<{ setup: Setup }>(({ setup }) => {
  const view = ViewOver({ list: setup.list });

  return {
    [TESTS]: [
      { await: "seeded" },
      {
        assertion: assert(() => countElements(view[UI], "cf-blob-link") === 1),
      },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-add") === "none"
        ),
      },
      {
        assertion: assert(() =>
          displayOf(view[UI], "fabrifile-rename") === "none"
        ),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    owner,
    member,
    reader: { pattern: reader, access: "READ" },
  },
});
