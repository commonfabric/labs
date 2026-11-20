/// <cts-enable />
import { computed, pattern, wish } from "commonfabric";

// `wish` for the targets the comparison simulates (`compare/wish-home.ts`):
// the profile the home space lists, two of its fields, and the list of
// mentionable pieces of the space, which is empty. No per-element construct
// is here.
export default pattern<{ note: string }>(({ note }) => {
  const profile = wish<{ name: string; bio: string }>({ query: "#profile" });
  const name = wish<string>({ query: "#profileName" });
  const bio = wish<string>({ query: "#profileBio" });
  const mentionable = wish<{ title: string }[]>({ query: "#mentionable" });
  const greeting = computed(() => `hello ${profile.result?.name ?? "nobody"}`);
  const about = computed(() => `${name.result}: ${bio.result}`);
  const count = computed(() => (mentionable.result ?? []).length);
  return {
    note,
    greeting,
    about,
    count,
    profile: profile.result,
    problem: profile.error,
    mentionable: mentionable.result,
  };
});
