/// <cts-enable />
import { type Default, pattern } from "commonfabric";

interface Profile {
  name: string;
  nick: Default<string, "anon">;
}

interface Input {
  primary?: Profile;
  backup: Profile;
  label?: string;
  fallback: Default<string, "none">;
  enabled: boolean;
}

// PL §3.5: the operand that `??`, `||` or `&&` selects is the operand
// itself. Where it is a record, the output holds the reference to it, at
// the left as at the right, so a default of the operand's schema reaches a
// reader of the output. Where it is a scalar, the output holds its value.
export default pattern<Input>(
  ({ primary, backup, label, fallback, enabled }) => {
    return {
      coalesced: primary ?? backup,
      either: primary || backup,
      both: enabled && backup,
      text: label ?? fallback,
    };
  },
);
