import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

type Input = { url: string | Default<"/api/patterns/index.md"> };

/** A URL to a #patternIndex */
export type Output = { [NAME]: string; [UI]: VNode; url: string };

const PatternIndexUrl = pattern<Input, Output>(
  ({ url }) => {
    return {
      [NAME]: computed(() => `Pattern Index: ${url}`),
      [UI]: (
        <cf-screen>
          <cf-input $value={url} />
        </cf-screen>
      ),
      url,
    };
  },
);

export default PatternIndexUrl;
