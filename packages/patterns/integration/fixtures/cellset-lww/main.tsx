import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * A name typed into a `PerUser` draft and saved by a handler that reads the
 * draft and writes the trimmed name back into it — fixture for the cellset-lww
 * own-write race (`cellset-lww.test.ts`).
 *
 * Two sessions of one identity share the draft, as two tabs of one user do.
 * The save's write-back is a handler echo standing on the same document the
 * next typed name is written to, which is the race the test drives.
 */

type NameCell = Writable<string | Default<"">>;

export interface CellsetLwwInput {
  profileDraft?: PerUser<NameCell>;
  profileName?: PerUser<NameCell>;
}

export interface CellsetLwwOutput {
  [NAME]: string;
  [UI]: VNode;
  profileDraft: PerUser<NameCell>;
  currentProfileName: string;
  saveProfile: Stream<void>;
}

const saveProfile = handler<void, {
  profileDraft: NameCell;
  profileName: NameCell;
}>((_, { profileDraft, profileName }) => {
  const name = (profileDraft.get() ?? "").trim();
  if (!name) return;
  profileName.set(name);
  profileDraft.set(name);
});

export default pattern<CellsetLwwInput, CellsetLwwOutput>(
  ({ profileDraft, profileName }) => {
    const draftCell: NameCell = profileDraft!;
    const nameCell: NameCell = profileName!;
    return {
      [NAME]: "cellset-lww fixture",
      [UI]: (
        <div>
          <span>cellset-lww fixture</span>
        </div>
      ),
      profileDraft: draftCell as PerUser<NameCell>,
      currentProfileName: computed(() => nameCell.get() ?? ""),
      saveProfile: saveProfile({
        profileDraft: draftCell,
        profileName: nameCell,
      }),
    };
  },
);
