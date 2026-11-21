/// <cts-enable />
import { computed, type Default, type Integrity, pattern } from "commonfabric";

interface Profile {
  name: string;
  nick: Default<string, "anon">;
}

interface Input {
  profile: Integrity<Profile, ["vouched"]>;
}

// Ruling T1: a read of `profile` whole carries the object's integrity, also
// where a default fills `nick`. A read that selects `nick` carries the empty
// integrity where the default fills it.
export default pattern<Input>(({ profile }) => {
  const derived = computed(() => JSON.stringify(profile));
  return {
    whole: profile,
    nick: profile.nick,
    name: profile.name,
    derived,
  };
});
