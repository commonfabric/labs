// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TRANSFORM REPRO: helper-owned handler with nested callback captures
 *
 * Compare on main vs transformer branch:
 *   deno task cf check patterns/dev/gideon-tests/test-helper-owned-handler-nested-captures.tsx --show-transformed --no-run
 *
 * Expected main shape:
 * - generated handler state includes `fileId`, `content`, `savedContent`, and
 *   `onSaveFile`
 *
 * Current branch bug:
 * - generated handler state omits captures that the handler body still uses
 *   inside the nested `.then(...)` callback
 */
import { action, Default, pattern, Stream, Writable } from "commonfabric";

function flushLater(
  fileId: Writable<string | Default<"">>,
  content: Writable<string | Default<"">>,
  savedContent: Writable<string | Default<"">>,
  onSaveFile: Stream<{ fileId: string; content: string }>,
): void {
  const nextContent = content.get();
  const lastSaved = savedContent.get();
  const targetFileId = fileId.get().trim();
  if (!targetFileId || nextContent === lastSaved) return;
  onSaveFile.send({ fileId: targetFileId, content: nextContent });
}

interface Input {
  fileId: Writable<string | Default<"">>;
  content: Writable<string | Default<"">>;
  savedContent: Writable<string | Default<"">>;
  onSaveFile: Stream<{ fileId: string; content: string }>;
}

export interface Output {
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
