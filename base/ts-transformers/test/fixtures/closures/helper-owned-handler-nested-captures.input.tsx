/**
 * TRANSFORM REPRO: helper-owned handler with nested callback captures
 *
 * The generated handler state includes `fileId`, `content`, `savedContent`, and
 * `onSaveFile`, which the handler body uses only inside the nested `.then(...)`
 * callback.
 */

import { action, Default, pattern, Stream, Writable } from "commonfabric";

function flushLater(
  fileId: Writable<Default<string, "">>,
  content: Writable<Default<string, "">>,
  savedContent: Writable<Default<string, "">>,
  onSaveFile: Stream<{ fileId: string; content: string }>,
): void {
  const nextContent = content.get();
  const lastSaved = savedContent.get();
  const targetFileId = fileId.get().trim();
  if (!targetFileId || nextContent === lastSaved) return;
  onSaveFile.send({ fileId: targetFileId, content: nextContent });
}

interface Input {
  fileId: Writable<Default<string, "">>;
  content: Writable<Default<string, "">>;
  savedContent: Writable<Default<string, "">>;
  onSaveFile: Stream<{ fileId: string; content: string }>;
}

interface Output {
  trigger: Stream<void>;
}

export default pattern<Input, Output>(
  ({ fileId, content, savedContent, onSaveFile }) => {
    const trigger = action(() => {
      Promise.resolve().then(() => {
        flushLater(fileId, content, savedContent, onSaveFile);
      });
    });

    return { trigger };
  },
);
