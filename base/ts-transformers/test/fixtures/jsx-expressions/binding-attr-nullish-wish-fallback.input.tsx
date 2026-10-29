import { pattern, UI, wish } from "commonfabric";

interface Profile {
  name: string;
  avatar?: string;
}

interface BadgeState {
  profileInput?: Profile;
}

// FIXTURE: binding-attr-nullish-wish-fallback
// Verifies: a nullish-coalescing binary at a bidirectional JSX binding
//   position — optional pattern input falling back to a wish() result —
//   lowers without crashing the compute-wrap invariant (lunch-poll PR #4928
//   shape 3, JSX-attribute form):
//   <cf-profile-badge $profile={profileInput ?? profileWish.result} />
// Context: regression companion to the builder-argument computation
//   diagnostic — the JSX-attribute form is supported; only the builder-call
//   argument form requires the hoist diagnostic.
export default pattern<BadgeState>(({ profileInput }) => {
  const profileWish = wish<Profile>({ query: "#profile" });
  return {
    [UI]: (
      <div>
        <cf-profile-badge $profile={profileInput ?? profileWish.result} />
      </div>
    ),
  };
});
