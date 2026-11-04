import {
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface User {
  displayName: string;
}

export interface Directory {
  users: User[] | Default<[]>;
}

export interface UserPointer {
  user?: User;
}

export interface JoinAsEvent {
  name: string;
}

export interface RenameEvent {
  name: string;
}

const DEFAULT_DIRECTORY = { users: [] } satisfies Directory;

type DirectoryCell = Writable<Directory | Default<typeof DEFAULT_DIRECTORY>>;
type MeCell = Writable<UserPointer | Default<Record<PropertyKey, never>>>;

const joinAs = handler<JoinAsEvent, {
  directory: DirectoryCell;
  me: MeCell;
}>(({ name }, { directory, me }) => {
  const trimmed = name.trim();
  if (!trimmed) return;
  const users = directory.key("users");
  users.push({ displayName: trimmed });
  const idx = users.get().length - 1;
  me.set({ user: users.key(idx) });
});

const rename = handler<RenameEvent, {
  me: MeCell;
}>(({ name }, { me }) => {
  const trimmed = name.trim();
  if (!trimmed) return;
  const userRef = me.key("user");
  if (!userRef.get()) return;
  userRef.key("displayName").set(trimmed);
});

export interface ScopedUserDirectoryInput {
  directory?: PerSpace<Directory | Default<typeof DEFAULT_DIRECTORY>>;
  me?: PerUser<UserPointer | Default<Record<PropertyKey, never>>>;
}

export interface ScopedUserDirectoryOutput {
  [NAME]: string;
  [UI]: VNode;
  directory: PerSpace<Directory | Default<typeof DEFAULT_DIRECTORY>>;
  me: PerUser<UserPointer | Default<Record<PropertyKey, never>>>;
  userCount: number;
  joinAs: Stream<JoinAsEvent>;
  rename: Stream<RenameEvent>;
}

export default pattern<ScopedUserDirectoryInput, ScopedUserDirectoryOutput>(
  ({ directory, me }) => {
    const boundJoinAs = joinAs({ directory, me });
    const boundRename = rename({ me });
    const users = directory.users;
    const userCount = users.length;
    const myDisplayName = me.user?.displayName ?? "(not joined)";

    return {
      [NAME]: "Scoped user directory",
      [UI]: (
        <div>
          <div>Users: {userCount}</div>
          <div>Me: {myDisplayName}</div>
        </div>
      ),
      directory,
      me,
      userCount,
      joinAs: boundJoinAs,
      rename: boundRename,
    };
  },
);
