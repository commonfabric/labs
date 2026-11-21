/// <cts-enable />
import { computed, pattern, wish } from "commonfabric";

// `wish` for the targets the comparison simulates (`compare/wish-home.ts`):
// the profile the home space lists, two of its fields, the list of
// mentionable pieces and the piece registry of the space, which are empty,
// and two searches for a tag that nothing has. No per-element construct is
// here.
export default pattern<{ note: string }>(({ note }) => {
  const profile = wish<{ name: string; bio: string }>({ query: "#profile" });
  const name = wish<string>({ query: "#profileName" });
  const bio = wish<string>({ query: "#profileBio" });
  const mentionable = wish<{ title: string }[]>({ query: "#mentionable" });
  const registry = wish<{ title: string }[]>({ query: "#pieceRegistry" });
  const found = wish<{ title: string }>({
    query: "#nothingTagged",
    scope: [".", "~"],
  });
  const quiet = wish<{ title: string }>({
    query: "#nothingTagged",
    headless: true,
  });
  const greeting = computed(() => `hello ${profile.result?.name ?? "nobody"}`);
  const about = computed(() => `${name.result}: ${bio.result}`);
  const count = computed(() => (mentionable.result ?? []).length);
  const matches = computed(() => (found.candidates ?? []).length);
  return {
    note,
    greeting,
    about,
    count,
    matches,
    profile: profile.result,
    problem: profile.error,
    mentionable: mentionable.result,
    registry: registry.result,
    missing: found.error,
    quiet: quiet.error,
  };
});
