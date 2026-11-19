/**
 * An editable tag list where you can add and remove tags, with the list held
 * in a cell.
 * Demonstrates `cf-tags` bound to a string array, writing changes back through
 * its `oncf-change` event.
 */
import {
  Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type Input = {
  tags: string[];
};

export type Result = {
  [NAME]: string;
  [UI]: VNode;
  tags: string[] | Default<[]>;
};

const updateTags = handler<
  {
    detail: {
      tags: string[];
    };
  },
  {
    tags: Writable<string[]>;
  }
>(({ detail }, state) => {
  state.tags.set(detail?.tags ?? []);
});

export default pattern<Input, Result>(
  ({ tags }) => {
    return {
      [NAME]: "cf-tags demo",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-tags tags={tags} oncf-change={updateTags({ tags })} />
        </cf-vstack>
      ),
      tags,
    };
  },
);
