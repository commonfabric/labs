/**
 * FUTURE REPRO: patternized map callbacks should not overtaint plain siblings
 *
 * If a local object aggregate mixes reactive and plain fields, later
 * computations over the plain field should stay plain.
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
          const meta = { kind: file.type, label: "plain" };
          const shout = meta.label + "!";
          return <span>{shout}</span>;
        })}
      </div>
    ),
  };
});
