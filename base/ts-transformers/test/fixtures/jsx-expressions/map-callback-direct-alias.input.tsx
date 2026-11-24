/**
 * TRANSFORM REPRO: patternized map callback may keep direct field aliases structural
 *
 * A direct alias like `const kind = file.type` can lower to `file.key("type")`
 * when it is only forwarded into JSX, because the renderer already knows how
 * to subscribe to structural opaque refs.
 */

import {
  Default,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

interface FileEntry {
  name: string;
  type: "file" | "folder";
}

interface Input {
  files: Writable<Default<FileEntry[], []>>;
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ files }) => {
  return {
    [UI]: (
      <div>
        {files.map((file) => {
          const kind = file.type;
          return <span>{kind}</span>;
        })}
      </div>
    ),
  };
});
