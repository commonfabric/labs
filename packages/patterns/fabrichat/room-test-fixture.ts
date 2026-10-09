/** Shared storage and descriptions for the FabriChat room's pattern tests. */
import {
  action,
  type AddIntegrity,
  FabricEpochNsec,
  pattern,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import { CHAT_POLICY } from "./records.ts";
import type { StoredActivity, StoredMemory, StoredMessage } from "./room.tsx";
import type {
  ChatRoomAbout,
  ChatRoomPolicy,
  ChatRoomRecord,
} from "./schemas.tsx";

/** Fresh protected records shared by the viewers of one test room. */
export const testRoomStorage = pattern(() => {
  return {
    records: new Writable<StoredMessage[]>([]),
    memory: new Writable<StoredMemory>(),
    activity: new Writable<StoredActivity[]>([]),
    roster: new Writable<ParticipantRoster>({}),
  };
});

/** A labeled room description, optionally identifying a standalone room. */
export const testRoomAbout = pattern<
  { kind: "direct" | "group"; standalone: boolean }
>(({ kind, standalone }) => {
  const policy = new Writable<AddIntegrity<ChatRoomPolicy, ["chat-test"]>>(
    CHAT_POLICY,
  );
  const record = new Writable<AddIntegrity<ChatRoomRecord, ["chat-test"]>>();
  const about = new Writable<AddIntegrity<ChatRoomAbout, ["chat-test"]>>();
  const initialize = action(() => {
    record.set({ kind, title: "Team", createdAt: new FabricEpochNsec(0n) });
    about.set({
      kind,
      title: "Team",
      createdAt: new FabricEpochNsec(0n),
      policy,
      ...(standalone ? { record } : {}),
    });
  });
  return { about, initialize };
});
