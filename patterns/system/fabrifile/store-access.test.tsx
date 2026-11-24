/**
 * Who a store lets change its entries, by what the store's space admits them
 * to: a member who didn't add a file is refused a change to it, and a reader's
 * request is not even answered, since the space's access list refuses it the
 * write. The owner, who may change anything, is `store.test.tsx`'s subject.
 */
import {
  action,
  assert,
  type Cell,
  multiUserTest,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import {
  epochNsecFromMsec,
  type FileEntry,
  type FileProfile,
  type FileRequestOutcome,
} from "./schemas.tsx";
import { FileStoreCore } from "./store.tsx";

/** What came of a request: the code it was refused with, or `done`. */
const outcomeOf = (outcome: FileRequestOutcome | undefined) =>
  outcome === undefined
    ? undefined
    : outcome.status === "refused"
    ? outcome.code
    : outcome.status;

/** The store everyone in the space shares. */
interface Setup {
  list: Writable<FileEntry[]>;
  requests: Writable<Record<string, FileRequestOutcome>>;
}

export const setup = pattern(() => ({
  list: Writable.of<FileEntry[]>([]),
  requests: Writable.of<Record<string, FileRequestOutcome>>({}),
}));

export const owner = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<FileProfile>({ name: "Owen" });
  const action_seed = action(() => {
    setup.list.push({
      name: "photo.png",
      mediaType: "image/png",
      blob: { space: spaceOf(setup.list)!, id: "fid1:photo" },
      size: 4,
      addedAt: epochNsecFromMsec(0),
      addedBy: profile,
    });
  });

  return {
    [TESTS]: [
      { action: action_seed },
      { assertion: assert(() => setup.list.get().length === 1) },
      { label: "seeded" },
    ],
  };
});

export const member = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<FileProfile>({ name: "Mia" });
  const store = FileStoreCore({
    entries: setup.list,
    requests: setup.requests,
    myProfile: profile,
  });
  const photo: Cell<FileEntry> = setup.list.key(0);
  const action_change = action(() => {
    store.remove.send({ requestId: "member-remove", entry: photo });
    store.rename.send({
      requestId: "member-rename",
      entry: photo,
      name: "holiday.png",
    });
  });

  return {
    [TESTS]: [
      { await: "seeded" },
      { action: action_change },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["member-remove"]) === "not-permitted"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["member-rename"]) === "not-permitted"
        ),
      },
      {
        assertion: assert(() =>
          setup.list.get().map((file) => file.name).join(", ") === "photo.png"
        ),
      },
      { label: "member tried" },
    ],
  };
});

export const reader = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<FileProfile>({ name: "Rea" });
  const store = FileStoreCore({
    entries: setup.list,
    requests: setup.requests,
    myProfile: profile,
  });
  const photo: Cell<FileEntry> = setup.list.key(0);
  const action_remove = action(() => {
    store.remove.send({ requestId: "reader-remove", entry: photo });
  });

  return {
    [TESTS]: [
      { await: "member tried" },
      // The member's refusals are in the requests this reader reads.
      {
        assertion: assert(() =>
          outcomeOf(store.requests["member-remove"]) === "not-permitted"
        ),
      },
      { action: action_remove },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["reader-remove"]) === undefined
        ),
      },
      { assertion: assert(() => setup.list.get().length === 1) },
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
