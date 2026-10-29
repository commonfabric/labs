/**
 * Test: Scoped User Directory
 *
 * Verifies the PerUser-pointer-into-PerSpace-array idiom:
 * - users: PerSpace<Directory> — shared directory readable by all
 * - me: PerUser<UserPointer> — per-user pointer to own entry
 *
 * Key findings:
 * - Raw `.get()` traversal through the directory works correctly
 * - Reactive traversal through `subject.directory.users[0]?.displayName`
 *   returns undefined (PerSpace array element reactive traversal bug)
 * - The link mechanism itself works: writing through `me.user.displayName`
 *   (via rename handler) propagates back to directory[0] as seen via .get()
 *
 * Run: deno task cf test patterns/examples/scoped-user-directory/main.test.tsx
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import ScopedUserDirectory, {
  type Directory,
  type UserPointer,
} from "./main.tsx";

export default pattern(() => {
  const directory = Writable.of<Directory>({ users: [] });
  const me = Writable.of<UserPointer>({});

  const subject = ScopedUserDirectory({ directory, me });

  // === Actions ===

  const action_join_as_alex = action(() => {
    subject.joinAs.send({ name: "Alex" });
  });

  const action_rename_to_alexander = action(() => {
    subject.rename.send({ name: "Alexander" });
  });

  // === Assertions ===

  // Initial state
  const assert_users_empty = assert(() => subject.userCount === 0);
  const assert_me_undefined = assert(() => me.get().user === undefined);

  // After joining as "Alex"
  const assert_one_user = assert(() => subject.userCount === 1);
  const assert_me_is_alex = assert(() =>
    subject.me.user?.displayName === "Alex"
  );
  // Note: reactive traversal through subject.directory.users[0]?.displayName
  // returns undefined (PerSpace array element reactive traversal does not work).
  // Raw .get() on the underlying cell works correctly:
  const assert_directory_first_is_alex = assert(() =>
    directory.get().users[0]?.displayName === "Alex"
  );

  // After renaming via me.user link (proves it's a link, not a copy)
  const assert_directory_first_is_alexander = assert(() =>
    directory.get().users[0]?.displayName === "Alexander"
  );
  const assert_me_is_alexander = assert(() =>
    subject.me.user?.displayName === "Alexander"
  );

  return {
    [TESTS]: [
      // Initial state
      { assertion: assert_users_empty },
      { assertion: assert_me_undefined },

      // Join as "Alex"
      { action: action_join_as_alex },
      { assertion: assert_one_user },
      { assertion: assert_me_is_alex },
      { assertion: assert_directory_first_is_alex },

      // Write through me.user link -> proves it's a link not a copy
      { action: action_rename_to_alexander },
      { assertion: assert_directory_first_is_alexander },
      { assertion: assert_me_is_alexander },
    ],
    subject,
  };
});
