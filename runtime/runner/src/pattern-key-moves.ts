/**
 * The new key of each pattern that moved when the patterns were sorted into
 * `<category>/<pattern>/` directories, indexed by its old key.
 *
 * A key is a path below the patterns route. A key in this table that ends in
 * `/` names a directory, and every file below that directory moved with it.
 * Any other key names one file. Stored `system:` refs, the module names of
 * stored programs, the root sources that space genesis receipts record, and
 * recorded test fixtures can name the old keys, so code that reads one of
 * those names maps it with {@link currentPatternKey}. Opening a piece rewrites
 * its stored ref to the new key, but a genesis receipt is never rewritten, so
 * the table is permanent, and so is every old key in it: no file may be added
 * at one.
 */
export const MOVED_PATTERN_KEYS: Readonly<Record<string, string>> = {
  "activity-log/": "apps/activity-log/",
  "agent/": "apps/agent/",
  "annotation-manager.tsx": "apps/annotation-manager/annotation-manager.tsx",
  "annotation.tsx": "apps/annotation/annotation.tsx",
  "aside.tsx": "examples/aside/aside.tsx",
  "base/": "apps/base/",
  "battleship/": "showcase/battleship/",
  "book-recommendations/": "apps/book-recommendations/",
  "bookmarks.tsx": "apps/bookmarks/bookmarks.tsx",
  "budget-tracker/": "apps/budget-tracker/",
  "calendar/": "apps/calendar/",
  "card-piles/": "showcase/card-piles/",
  "catalog/": "dev/catalog/",
  "cell-link.tsx": "dev/cell-link/cell-link.tsx",
  "cfc-agent-prompt-injection-demo/":
    "examples/cfc-agent-prompt-injection-demo/",
  "cfc-authorized-save/": "examples/cfc-authorized-save/",
  "cfc-authorship-chat/": "examples/cfc-authorship-chat/",
  "cfc-exchange-rules/": "examples/cfc-exchange-rules/",
  "cfc-group-chat-demo/": "examples/cfc-group-chat-demo/",
  "cfc-input-cell-demo/": "examples/cfc-input-cell-demo/",
  "cfc-render-policy-demo/": "examples/cfc-render-policy-demo/",
  "cfc-row-label-mailbox/": "examples/cfc-row-label-mailbox/",
  "cfc-row-label-records/": "examples/cfc-row-label-records/",
  "cfc-spec-gallery/": "examples/cfc-spec-gallery/",
  "cfc-staged-publish/": "examples/cfc-staged-publish/",
  "cfc-trusted-component-examples/": "examples/cfc-trusted-component-examples/",
  "cfc-trusted-surfaces/": "examples/cfc-trusted-surfaces/",
  "cfc/": "system/cfc/",
  "chatbot.tsx": "system/chatbot/chatbot.tsx",
  "cheeseboard.tsx": "apps/cheeseboard/cheeseboard.tsx",
  "collaborative-note/": "dev/collaborative-note/",
  "collection-naming/": "product/collection-naming/",
  "compiler.tsx": "examples/compiler/compiler.tsx",
  "computed-element-key-captures.test.tsx":
    "dev/checks/computed-element-key-captures.test.tsx",
  "contacts/": "apps/contacts/",
  "counter/": "examples/counter/",
  "cozy-poll/": "apps/cozy-poll/",
  "deep-research.tsx": "apps/deep-research/deep-research.tsx",
  "dice-handlers.ts": "showcase/dice/dice-handlers.ts",
  "dice.test.tsx": "showcase/dice/dice.test.tsx",
  "dice.tsx": "showcase/dice/dice.tsx",
  "do-list/": "examples/do-list/",
  "examples/arbitrary-wish-example.tsx":
    "examples/arbitrary-wish-example/arbitrary-wish-example.tsx",
  "examples/array-in-cell-with-remove-editable.tsx":
    "examples/array-in-cell-with-remove-editable/array-in-cell-with-remove-editable.tsx",
  "examples/cf-chart-demo.tsx": "examples/cf-chart-demo/cf-chart-demo.tsx",
  "examples/cf-checkbox-cell.tsx":
    "examples/cf-checkbox-cell/cf-checkbox-cell.tsx",
  "examples/cf-code-editor-cell.tsx":
    "examples/cf-code-editor-cell/cf-code-editor-cell.tsx",
  "examples/cf-picker.test.tsx": "examples/cf-picker/cf-picker.test.tsx",
  "examples/cf-picker.tsx": "examples/cf-picker/cf-picker.tsx",
  "examples/cf-render-subpath.tsx":
    "examples/cf-render-subpath/cf-render-subpath.tsx",
  "examples/cf-render.tsx": "examples/cf-render/cf-render.tsx",
  "examples/cf-tags.tsx": "examples/cf-tags/cf-tags.tsx",
  "examples/clock.test.tsx": "examples/clock/clock.test.tsx",
  "examples/clock.tsx": "examples/clock/clock.tsx",
  "examples/data/phonetic-alphabet.json":
    "examples/phonetic-speller/data/phonetic-alphabet.json",
  "examples/drag-drop-demo.tsx": "examples/drag-drop-demo/drag-drop-demo.tsx",
  "examples/fetch-delay.test.tsx": "examples/fetch-json/fetch-delay.test.tsx",
  "examples/fetch-json.tsx": "examples/fetch-json/fetch-json.tsx",
  "examples/fetch-mock.test.tsx": "examples/fetch-json/fetch-mock.test.tsx",
  "examples/fetch-program-test.tsx":
    "examples/fetch-program-test/fetch-program-test.tsx",
  "examples/instantiate-pattern.test.tsx":
    "examples/instantiate-pattern/instantiate-pattern.test.tsx",
  "examples/instantiate-pattern.tsx":
    "examples/instantiate-pattern/instantiate-pattern.tsx",
  "examples/llm.tsx": "examples/llm/llm.tsx",
  "examples/multi-option-selection.tsx":
    "examples/multi-option-selection/multi-option-selection.tsx",
  "examples/nested-counter.tsx": "examples/nested-counter/nested-counter.tsx",
  "examples/nested-mentionables.tsx":
    "examples/nested-mentionables/nested-mentionables.tsx",
  "examples/output_schema.tsx": "examples/output_schema/output_schema.tsx",
  "examples/phonetic-speller.test.tsx":
    "examples/phonetic-speller/phonetic-speller.test.tsx",
  "examples/phonetic-speller.tsx":
    "examples/phonetic-speller/phonetic-speller.tsx",
  "examples/profile-aware-writer.tsx":
    "examples/profile-aware-writer/profile-aware-writer.tsx",
  "examples/queue-test.tsx": "examples/queue-test/queue-test.tsx",
  "examples/reactive-now.test.tsx":
    "examples/reactive-now/reactive-now.test.tsx",
  "examples/reactive-now.tsx": "examples/reactive-now/reactive-now.tsx",
  "examples/suggestion-test.tsx":
    "examples/suggestion-test/suggestion-test.tsx",
  "examples/summary-index-tester.tsx":
    "examples/summary-index-tester/summary-index-tester.tsx",
  "examples/ui-variants-demo.tsx": "examples/ui-variants/ui-variants-demo.tsx",
  "examples/ui-variants-host.tsx": "examples/ui-variants/ui-variants-host.tsx",
  "examples/wish-note-example.tsx":
    "examples/wish-note-example/wish-note-example.tsx",
  "examples/write-and-run.tsx": "examples/write-and-run/write-and-run.tsx",
  "experimental/": "dev/experimental/",
  "fabrichat/": "system/fabrichat/",
  "fabrifile/": "system/fabrifile/",
  "factory-outputs/": "dev/factory-outputs/",
  "fair-share/": "examples/fair-share/",
  "file-share/": "apps/file-share/",
  "form-demo.tsx": "examples/form-demo/form-demo.tsx",
  "gideon-tests/": "dev/gideon-tests/",
  "group-chat-lobby.tsx": "examples/group-chat-lobby/group-chat-lobby.tsx",
  "group-chat-room.tsx": "examples/group-chat-room/group-chat-room.tsx",
  "habit-tracker/": "apps/habit-tracker/",
  "iframe-cursor-canvas/": "examples/iframe-cursor-canvas/",
  "iframe-firebreak-commons/": "showcase/iframe-firebreak-commons/",
  "iframe-impossible-machine/": "showcase/iframe-impossible-machine/",
  "iframe-orbital-salvage-yard/": "showcase/iframe-orbital-salvage-yard/",
  "iframe-ring-loops/": "showcase/iframe-ring-loops/",
  "iframe-shared-tape-lab/": "showcase/iframe-shared-tape-lab/",
  "iframe-signal-atlas/": "showcase/iframe-signal-atlas/",
  "iframe-verb-list/": "examples/iframe-verb-list/",
  "image-analysis.tsx": "apps/image-analysis/image-analysis.tsx",
  "image.tsx": "examples/image/image.tsx",
  "kept-element-references.test.tsx":
    "dev/checks/kept-element-references.test.tsx",
  "lift-kept-element-fields.test.tsx":
    "dev/checks/lift-kept-element-fields.test.tsx",
  "link-preview.tsx": "examples/link-preview/link-preview.tsx",
  "lobby/": "product/lobby/",
  "loom-chat-room-fixture/": "dev/loom-chat-room-fixture/",
  "loom-overlay-fixture/": "dev/loom-overlay-fixture/",
  "loom/": "system/loom/",
  "lunch-poll/": "apps/lunch-poll/",
  "map-captured-object-spread/": "dev/map-captured-object-spread/",
  "map-demo.test.tsx": "examples/map-demo/map-demo.test.tsx",
  "map-demo.tsx": "examples/map-demo/map-demo.tsx",
  "mobile-app-demo.tsx": "examples/mobile-app-demo/mobile-app-demo.tsx",
  "nested-map-ifelse-test.tsx":
    "dev/nested-map-ifelse-test/nested-map-ifelse-test.tsx",
  "notes/": "system/notes/",
  "pattern-index.tsx": "examples/pattern-index/pattern-index.tsx",
  "person-workbench/": "apps/person-workbench/",
  "plain-array-callback-locals/": "dev/plain-array-callback-locals/",
  "primitives/": "product/primitives/",
  "profile-group-chat/": "examples/profile-group-chat/",
  "profile-roster-live-demo.tsx":
    "examples/profile-roster-live-demo/profile-roster-live-demo.tsx",
  "project-list/": "apps/project-list/",
  "reading-list/": "examples/reading-list/",
  "recommend-a-book/": "apps/recommend-a-book/",
  "regression/": "dev/regression/",
  "render-test.tsx": "dev/render-test/render-test.tsx",
  "rendered-click-streams.test.ts": "dev/checks/rendered-click-streams.test.ts",
  "router/": "examples/router/",
  "scope-bug-computed-vnode-blank/": "dev/scope-bug-computed-vnode-blank/",
  "scope-bug-ct1597-forward/": "dev/scope-bug-ct1597-forward/",
  "scope-bug-ct1597-reduce/": "dev/scope-bug-ct1597-reduce/",
  "scoped-group-chat/": "examples/scoped-group-chat/",
  "scoped-user-directory/": "examples/scoped-user-directory/",
  "scrabble/": "showcase/scrabble/",
  "self-improving-classifier.test.tsx":
    "apps/self-improving-classifier/self-improving-classifier.test.tsx",
  "self-improving-classifier.tsx":
    "apps/self-improving-classifier/self-improving-classifier.tsx",
  "self-reference-test.tsx": "dev/self-reference-test/self-reference-test.tsx",
  "self.test.tsx": "system/self/self.test.tsx",
  "self.tsx": "system/self/self.tsx",
  "shared-note/": "apps/shared-note/",
  "shared-profile-demo/": "examples/shared-profile-demo/",
  "shared-profile-roster/": "examples/shared-profile-roster/",
  "shopping-list.test.tsx": "apps/shopping-list/shopping-list.test.tsx",
  "shopping-list.tsx": "apps/shopping-list/shopping-list.tsx",
  "simple-list/": "examples/simple-list/",
  "store-mapper.test.tsx": "apps/store-mapper/store-mapper.test.tsx",
  "store-mapper.tsx": "apps/store-mapper/store-mapper.tsx",
  "suggestable/": "examples/suggestable/",
  "system/agent-queue.test.tsx": "system/agent-queue/agent-queue.test.tsx",
  "system/agent-queue.tsx": "system/agent-queue/agent-queue.tsx",
  "system/agent-run.test.tsx": "system/agent-run/agent-run.test.tsx",
  "system/agent-run.tsx": "system/agent-run/agent-run.tsx",
  "system/backlinks-index.test.tsx":
    "system/backlinks-index/backlinks-index.test.tsx",
  "system/backlinks-index.tsx": "system/backlinks-index/backlinks-index.tsx",
  "system/common-fabric.tsx": "system/common-fabric/common-fabric.tsx",
  "system/default-app-ben.test.tsx":
    "dev/default-app-ben/default-app-ben.test.tsx",
  "system/default-app-ben.tsx": "dev/default-app-ben/default-app-ben.tsx",
  "system/default-app-participants.test.tsx":
    "system/default-app/default-app-participants.test.tsx",
  "system/default-app.test.tsx": "system/default-app/default-app.test.tsx",
  "system/default-app.tsx": "system/default-app/default-app.tsx",
  "system/favorites-manager.tsx":
    "system/favorites-manager/favorites-manager.tsx",
  "system/home-ben.tsx": "system/home/home-ben.tsx",
  "system/home-refusal-notice.test.tsx":
    "system/home/home-refusal-notice.test.tsx",
  "system/home-shared-space-catalog.test.tsx":
    "system/home/home-shared-space-catalog.test.tsx",
  "system/home.test.tsx": "system/home/home.test.tsx",
  "system/home.tsx": "system/home/home.tsx",
  "system/journal.tsx": "system/journal/journal.tsx",
  "system/knowledge-graph.tsx": "system/knowledge-graph/knowledge-graph.tsx",
  "system/link-tool.tsx": "system/link-tool/link-tool.tsx",
  "system/mentionables-inspector.tsx":
    "system/mentionables-inspector/mentionables-inspector.tsx",
  "system/omnibox-fab.tsx": "system/omnibox-fab/omnibox-fab.tsx",
  "system/piece-grid.tsx": "system/piece-grid/piece-grid.tsx",
  "system/private-inbox-refusal-text.test.ts":
    "system/private-inbox/private-inbox-refusal-text.test.ts",
  "system/private-inbox-refusal-text.ts":
    "system/private-inbox/private-inbox-refusal-text.ts",
  "system/private-inbox-request.test.tsx":
    "system/private-inbox/private-inbox-request.test.tsx",
  "system/private-inbox.pointer-type.test.ts":
    "system/private-inbox/private-inbox.pointer-type.test.ts",
  "system/private-inbox.test.tsx":
    "system/private-inbox/private-inbox.test.tsx",
  "system/private-inbox.tsx": "system/private-inbox/private-inbox.tsx",
  "system/profile-create.default-profile.test.tsx":
    "system/profile-create/profile-create.default-profile.test.tsx",
  "system/profile-create.test.tsx":
    "system/profile-create/profile-create.test.tsx",
  "system/profile-create.tsx": "system/profile-create/profile-create.tsx",
  "system/profile-embed.test.tsx":
    "system/profile-embed/profile-embed.test.tsx",
  "system/profile-embed.tsx": "system/profile-embed/profile-embed.tsx",
  "system/profile-home.owner-gated.test.ts":
    "system/profile-home/profile-home.owner-gated.test.ts",
  "system/profile-home.test.tsx": "system/profile-home/profile-home.test.tsx",
  "system/profile-home.tsx": "system/profile-home/profile-home.tsx",
  "system/profile-look.test.ts": "system/profile-look/profile-look.test.ts",
  "system/profile-look.ts": "system/profile-look/profile-look.ts",
  "system/profile-picker.tsx": "system/profile-picker/profile-picker.tsx",
  "system/quick-capture.test.tsx":
    "system/quick-capture/quick-capture.test.tsx",
  "system/quick-capture.tsx": "system/quick-capture/quick-capture.tsx",
  "system/shared-space-catalog.test.tsx":
    "system/shared-space/shared-space-catalog.test.tsx",
  "system/shared-space-catalog.ts":
    "system/shared-space/shared-space-catalog.ts",
  "system/shared-space-collection.sessions.test.tsx":
    "system/shared-space/shared-space-collection.sessions.test.tsx",
  "system/shared-space-collection.tsx":
    "system/shared-space/shared-space-collection.tsx",
  "system/shared-space-interface.test.tsx":
    "system/shared-space/shared-space-interface.test.tsx",
  "system/shared-space-interface.ts":
    "system/shared-space/shared-space-interface.ts",
  "system/shared-space-profiles.test.tsx":
    "system/shared-space/shared-space-profiles.test.tsx",
  "system/space-overview.tsx": "system/space-overview/space-overview.tsx",
  "system/suggestion-history.tsx":
    "system/suggestion-history/suggestion-history.tsx",
  "system/suggestion.tsx": "system/suggestion/suggestion.tsx",
  "system/summary-index.tsx": "system/summary-index/summary-index.tsx",
  "test/": "dev/test/",
  "test/vnode-helpers.ts": "tools/test-support/vnode-helpers.ts",
  "text-swapper.tsx": "examples/text-swapper/text-swapper.tsx",
  "todo-list/": "examples/todo-list/",
  "top-level-demos.test.tsx": "dev/checks/top-level-demos.test.tsx",
  "topic-workbench/": "apps/topic-workbench/",
  "topics/": "apps/topics/",
  "untested-apps.test.tsx": "dev/checks/untested-apps.test.tsx",
  "vehicles.test.ts": "dev/factory-outputs/vehicles.test.ts",
  "vehicles.ts": "dev/factory-outputs/vehicles.ts",
  "weekly-calendar/": "apps/weekly-calendar/",
  "wordsearch/": "showcase/wordsearch/",
  "work-snapshot/": "apps/work-snapshot/",
  "workbench/": "product/workbench/",
};

/**
 * The table's entries, longest key first, so that the entry for a file is found
 * before the entry for the directory holding it.
 */
const MOVES = Object.entries(MOVED_PATTERN_KEYS).sort(([a], [b]) =>
  b.length - a.length
);

/** The entry of `moves` whose key names `key` or a directory holding it. */
function movedBy(
  key: string,
  moves: readonly (readonly [string, string])[],
): string {
  for (const [from, to] of moves) {
    if (key === from) return to;
    if (from.endsWith("/") && key.startsWith(from)) {
      return to + key.slice(from.length);
    }
  }
  return key;
}

/** The table's entries reversed, longest new key first. */
const FORMER = Object.entries(MOVED_PATTERN_KEYS)
  .map(([from, to]) => [to, from] as const)
  .sort(([a], [b]) => b.length - a.length);

/**
 * The key a pattern is served under, given a key it may have been served under
 * before it moved. A key that never moved comes back unchanged.
 */
export function currentPatternKey(key: string): string {
  return movedBy(key, MOVES);
}

/**
 * The key a pattern was served under before it moved, given the key it is
 * served under now. A key that never moved comes back unchanged.
 */
export function formerPatternKey(key: string): string {
  return movedBy(key, FORMER);
}

/**
 * Whether a stored program's entry module name names the pattern served under
 * `key`, by that key or by the key the pattern had before it moved. A compile
 * can put any root in front of a current key, so a current key is matched by
 * the name's ending. A former key is matched only below a patterns directory
 * (`/api/patterns/`, `/packages/patterns/`, or `/patterns/`) or at the root,
 * which are the roots programs were compiled under before the move; matched by
 * its ending alone, a former key such as `chatbot.tsx` would also match a file
 * of that name inside another pattern.
 */
export function mainNamesPattern(main: string, key: string): boolean {
  const former = formerPatternKey(key);
  return main.endsWith(`/${key}`) ||
    (former !== key &&
      (main === `/${former}` || main.endsWith(`/patterns/${former}`)));
}
