/// <cts-enable />
import { computed, type Confidential, pattern } from "commonfabric";

interface Item {
  title: Confidential<string, ["carol"]>;
  done: boolean;
}

interface Input {
  secret: Confidential<string, ["alice"]>;
  note: string;
  flag: Confidential<boolean, ["bob"]>;
  items: Item[];
}

export default pattern<Input>(({ secret, note, flag, items }) => {
  const shout = computed(() => secret.toUpperCase());
  const echo = computed(() => shout + "?");
  const greeting = computed(() => "hi " + note);
  const chosen = computed(() => (flag ? secret : note));
  const direct = flag ? secret : note;
  const both = computed(() => secret + note);
  const count = computed(() => items.length);
  const titles = items.map((item) => item.title);
  const loud = items.map((item) => computed(() => item.title + "!"));
  return {
    shout,
    echo,
    greeting,
    chosen,
    direct,
    both,
    count,
    titles,
    loud,
    note,
    secret,
  };
});
