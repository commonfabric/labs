/// <cts-enable />
import { computed, type Confidential, pattern } from "commonfabric";

interface Input {
  flag: boolean;
  secret: Confidential<string, ["alice"]>;
  plain: string;
  extra?: string;
}

// The branch each selector takes, which the value code reports to the
// executor: a conditional expression, `||`, `??`, and an `if` in the block
// of a `computed`.
export default pattern<Input>(({ flag, secret, plain, extra }) => {
  const shown = flag ? secret : plain;
  const either = plain || secret;
  const given = extra ?? plain;
  const chosen = computed(() => {
    if (flag) return secret.length;
    return plain.length;
  });
  return { shown, either, given, chosen };
});
