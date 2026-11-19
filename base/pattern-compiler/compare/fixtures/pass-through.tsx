/// <cts-enable />
import { computed, lift, pattern } from "commonfabric";

// Value code that passes a plain input on in place, through each form: the
// whole result, an object member, an array element, a conditional, a
// function parameter, and the result of a `lift`.
const same = (value: string): string => value;
const echo = lift((value: string) => value);

export default pattern<{ secret: string; flag: boolean }>(
  ({ secret, flag }) => {
    const lifted = echo(secret);
    return {
      whole: computed(() => secret),
      member: computed(() => ({ inner: secret })),
      element: computed(() => [secret]),
      chosen: computed(() => (flag ? secret : "none")),
      parameter: computed(() => same(secret)),
      lifted,
      fromLift: computed(() => lifted),
    };
  },
);
