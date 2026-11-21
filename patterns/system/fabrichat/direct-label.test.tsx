/**
 * How a FabriChat manager's rendered list labels a direct room with no title:
 * with whom it is with, their principal shortened for display by `shortDid()`,
 * so that a `did:key` reads as its method and the last few characters of its
 * key, and a principal short enough to read is shown whole.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElements,
  propsOf,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import type { SharedSpaceCatalogStorage } from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** The gesture a start takes, as a client's start control makes it. */
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

/** A stand-in principal as long as a real one, which the list shortens. */
const DANA = "did:key:z6MkTestFabriChatDirectLabe1CounterpartKeyXyzAbcd9";

/** A stand-in principal short enough that the list shows it whole. */
const BOB = "did:key:z6MkBob";

/**
 * The labels of the rooms `root` lists, in the order it lists them. A
 * notice's link carries no label, so it adds none.
 */
const listedLabels = (root: unknown): string[] =>
  findElements(root, "cf-cell-link").flatMap((node) => {
    const label = readValue(propsOf(node)?.label);
    return typeof label === "string" ? [label] : [];
  });

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);

  return {
    [TESTS]: [
      {
        action: manager.openDirect,
        event: { requestId: "d-dana", counterpart: DANA },
        trustedUi: startGesture,
      },
      // A long principal is shown as its method and the last four characters
      // of its key, and not whole.
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          manager.rooms[0]?.counterpart === DANA &&
          listedLabels(manager[UI]).join("|") === "With did:key:…bcd9"
        ),
      },
      {
        action: manager.openDirect,
        event: { requestId: "d-bob", counterpart: BOB },
        trustedUi: startGesture,
      },
      // A principal short enough to read is shown whole.
      {
        assertion: assert(() =>
          manager.rooms.length === 2 &&
          listedLabels(manager[UI]).sort().join("|") ===
            `With ${BOB}|With did:key:…bcd9`
        ),
      },
    ],
  };
});
