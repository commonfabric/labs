/// <cts-enable />
import { computed, type Confidential, pattern, UI } from "commonfabric";

interface RowInput {
  title: string;
}

// A pattern another names as a tag. Its tree holds a value it computes.
export const Row = pattern<RowInput>(({ title }) => {
  const shout = computed(() => title + "!");
  return { [UI]: <span>{shout}</span> };
});

interface Input {
  secret: Confidential<string, ["alice"]>;
}

export default pattern<Input>(({ secret }) => {
  return {
    [UI]: (
      <div>
        <Row title={secret} />
      </div>
    ),
  };
});
