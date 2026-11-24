/**
 * The key each moved pattern moved to, indexed by the key it moved from.
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
 *
 * A pattern that moves again gets a second entry, from the key it moved to
 * before, and the entry naming that key stays as it is: the lookups follow the
 * entries from one key to the next, so each entry records one move. The table
 * holds no cycle.
 */
export const MOVED_PATTERN_KEYS: Readonly<Record<string, string>> = {
  "activity-log/": "apps/activity-log/",
  "agent/": "apps/agent/",
  "annotation-manager.tsx": "apps/annotation-manager/annotation-manager.tsx",
  "annotation.tsx": "apps/annotation/annotation.tsx",
  "apps/activity-log/activity-log.tsx": "apps/activity-log/main.tsx",
  "apps/agent/agent.tsx": "apps/agent/main.tsx",
  "apps/annotation-manager/annotation-manager.tsx":
    "apps/annotation-manager/main.tsx",
  "apps/assumption-surfacer/assumption-surfacer.tsx":
    "apps/assumption-surfacer/main.tsx",
  "apps/bookmarks/bookmarks.tsx": "apps/bookmarks/main.tsx",
  "apps/calendar/calendar.tsx": "apps/calendar/main.tsx",
  "apps/cheeseboard/cheeseboard.tsx": "apps/cheeseboard/main.tsx",
  "apps/codenames-helper/codenames-helper.tsx":
    "apps/codenames-helper/main.tsx",
  "apps/contacts/contact-book.tsx": "apps/contacts/main.tsx",
  "apps/deep-research/deep-research.tsx": "apps/deep-research/main.tsx",
  "apps/food-recipe/food-recipe.tsx": "apps/food-recipe/main.tsx",
  "apps/habit-tracker/habit-tracker.tsx": "apps/habit-tracker/main.tsx",
  "apps/image-analysis/image-analysis.tsx": "apps/image-analysis/main.tsx",
  "apps/meal-orchestrator/meal-orchestrator.tsx":
    "apps/meal-orchestrator/main.tsx",
  "apps/recommend-a-book/library.tsx": "apps/recommend-a-book/library/main.tsx",
  "apps/recommend-a-book/main.test.tsx":
    "apps/recommend-a-book/invitation.test.tsx",
  "apps/recommend-a-book/main.tsx": "apps/recommend-a-book/invitation.tsx",
  "apps/redactor/vault.tsx": "apps/redactor/main.tsx",
  "apps/reward-spinner/reward-spinner.tsx": "apps/reward-spinner/main.tsx",
  "apps/self-improving-classifier/self-improving-classifier.tsx":
    "apps/self-improving-classifier/main.tsx",
  "apps/shopping-list/shopping-list.tsx": "apps/shopping-list/main.tsx",
  "apps/smart-rubric/smart-rubric.tsx": "apps/smart-rubric/main.tsx",
  "apps/star-chart/star-chart.tsx": "apps/star-chart/main.tsx",
  "apps/store-mapper/store-mapper.tsx": "apps/store-mapper/main.tsx",
  "apps/story-weaver/story-weaver.tsx": "apps/story-weaver/main.tsx",
  "apps/weekly-calendar/weekly-calendar.tsx": "apps/weekly-calendar/main.tsx",
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
  "dev/map-captured-object-spread/main.test.tsx":
    "dev/map-captured-object-spread/map-captured-object-spread.test.tsx",
  "dev/map-captured-object-spread/main.tsx":
    "dev/map-captured-object-spread/map-captured-object-spread.tsx",
  "dice-handlers.ts": "showcase/dice/dice-handlers.ts",
  "dice.test.tsx": "showcase/dice/dice.test.tsx",
  "dice.tsx": "showcase/dice/dice.tsx",
  "do-list/": "examples/do-list/",
  "examples/arbitrary-wish-example.tsx":
    "examples/arbitrary-wish-example/arbitrary-wish-example.tsx",
  "examples/arbitrary-wish-example/arbitrary-wish-example.tsx":
    "examples/arbitrary-wish-example/main.tsx",
  "examples/array-in-cell-with-remove-editable.tsx":
    "examples/array-in-cell-with-remove-editable/array-in-cell-with-remove-editable.tsx",
  "examples/array-in-cell-with-remove-editable/array-in-cell-with-remove-editable.tsx":
    "examples/array-in-cell-with-remove-editable/main.tsx",
  "examples/aside/aside.tsx": "examples/aside/main.tsx",
  "examples/cf-chart-demo.tsx": "examples/cf-chart-demo/cf-chart-demo.tsx",
  "examples/cf-chart-demo/cf-chart-demo.tsx": "examples/cf-chart-demo/main.tsx",
  "examples/cf-checkbox-cell.tsx":
    "examples/cf-checkbox-cell/cf-checkbox-cell.tsx",
  "examples/cf-checkbox-cell/cf-checkbox-cell.tsx":
    "examples/cf-checkbox-cell/main.tsx",
  "examples/cf-code-editor-cell.tsx":
    "examples/cf-code-editor-cell/cf-code-editor-cell.tsx",
  "examples/cf-picker.test.tsx": "examples/cf-picker/cf-picker.test.tsx",
  "examples/cf-picker.tsx": "examples/cf-picker/cf-picker.tsx",
  "examples/cf-picker/cf-picker.tsx": "examples/cf-picker/main.tsx",
  "examples/cf-render-subpath.tsx":
    "examples/cf-render-subpath/cf-render-subpath.tsx",
  "examples/cf-render.tsx": "examples/cf-render/cf-render.tsx",
  "examples/cf-render/cf-render.tsx": "examples/cf-render/main.tsx",
  "examples/cf-tags.tsx": "examples/cf-tags/cf-tags.tsx",
  "examples/cfc-agent-prompt-injection-demo/main.test.tsx":
    "examples/cfc-agent-prompt-injection-demo/cfc-agent-prompt-injection-demo.test.tsx",
  "examples/cfc-agent-prompt-injection-demo/main.tsx":
    "examples/cfc-agent-prompt-injection-demo/cfc-agent-prompt-injection-demo.tsx",
  "examples/cfc-authorized-save/main.test.tsx":
    "examples/cfc-authorized-save/cfc-authorized-save.test.tsx",
  "examples/cfc-authorized-save/main.tsx":
    "examples/cfc-authorized-save/cfc-authorized-save.tsx",
  "examples/cfc-authorship-chat/main.test.tsx":
    "examples/cfc-authorship-chat/cfc-authorship-chat.test.tsx",
  "examples/cfc-authorship-chat/main.tsx":
    "examples/cfc-authorship-chat/cfc-authorship-chat.tsx",
  "examples/cfc-render-policy-demo/main.test.tsx":
    "examples/cfc-render-policy-demo/cfc-render-policy-demo.test.tsx",
  "examples/cfc-render-policy-demo/main.tsx":
    "examples/cfc-render-policy-demo/cfc-render-policy-demo.tsx",
  "examples/cfc-row-label-mailbox/main.test.tsx":
    "examples/cfc-row-label-mailbox/cfc-row-label-mailbox.test.tsx",
  "examples/cfc-row-label-mailbox/main.tsx":
    "examples/cfc-row-label-mailbox/cfc-row-label-mailbox.tsx",
  "examples/cfc-row-label-records/main.test.tsx":
    "examples/cfc-row-label-records/cfc-row-label-records.test.tsx",
  "examples/cfc-row-label-records/main.tsx":
    "examples/cfc-row-label-records/cfc-row-label-records.tsx",
  "examples/cfc-spec-gallery/main.test.tsx":
    "examples/cfc-spec-gallery/cfc-spec-gallery.test.tsx",
  "examples/cfc-spec-gallery/main.tsx":
    "examples/cfc-spec-gallery/cfc-spec-gallery.tsx",
  "examples/cfc-staged-publish/main.test.tsx":
    "examples/cfc-staged-publish/cfc-staged-publish.test.tsx",
  "examples/cfc-staged-publish/main.tsx":
    "examples/cfc-staged-publish/cfc-staged-publish.tsx",
  "examples/cfc-trusted-component-examples/main.test.tsx":
    "examples/cfc-trusted-component-examples/cfc-trusted-component-examples.test.tsx",
  "examples/cfc-trusted-component-examples/main.tsx":
    "examples/cfc-trusted-component-examples/cfc-trusted-component-examples.tsx",
  "examples/cfc-trusted-surfaces/main.test.tsx":
    "examples/cfc-trusted-surfaces/cfc-trusted-surfaces.test.tsx",
  "examples/cfc-trusted-surfaces/main.tsx":
    "examples/cfc-trusted-surfaces/cfc-trusted-surfaces.tsx",
  "examples/clock.test.tsx": "examples/clock/clock.test.tsx",
  "examples/clock.tsx": "examples/clock/clock.tsx",
  "examples/clock/clock.tsx": "examples/clock/main.tsx",
  "examples/compiler/compiler.tsx": "examples/compiler/main.tsx",
  "examples/counter/counter.tsx": "examples/counter/main.tsx",
  "examples/data/phonetic-alphabet.json":
    "examples/phonetic-speller/data/phonetic-alphabet.json",
  "examples/do-list/do-list.tsx": "examples/do-list/main.tsx",
  "examples/drag-drop-demo.tsx": "examples/drag-drop-demo/drag-drop-demo.tsx",
  "examples/drag-drop-demo/drag-drop-demo.tsx":
    "examples/drag-drop-demo/main.tsx",
  "examples/fetch-delay.test.tsx": "examples/fetch-json/fetch-delay.test.tsx",
  "examples/fetch-json.tsx": "examples/fetch-json/fetch-json.tsx",
  "examples/fetch-json/fetch-json.tsx": "examples/fetch-json/main.tsx",
  "examples/fetch-mock.test.tsx": "examples/fetch-json/fetch-mock.test.tsx",
  "examples/fetch-program-test.tsx":
    "examples/fetch-program-test/fetch-program-test.tsx",
  "examples/form-demo/form-demo.tsx": "examples/form-demo/main.tsx",
  "examples/group-chat-lobby/group-chat-lobby.tsx":
    "examples/group-chat-lobby/main.tsx",
  "examples/image/image.tsx": "examples/image/main.tsx",
  "examples/instantiate-pattern.test.tsx":
    "examples/instantiate-pattern/instantiate-pattern.test.tsx",
  "examples/instantiate-pattern.tsx":
    "examples/instantiate-pattern/instantiate-pattern.tsx",
  "examples/instantiate-pattern/instantiate-pattern.tsx":
    "examples/instantiate-pattern/main.tsx",
  "examples/link-preview/link-preview.tsx": "examples/link-preview/main.tsx",
  "examples/llm.tsx": "examples/llm/llm.tsx",
  "examples/llm/llm.tsx": "examples/llm/main.tsx",
  "examples/map-demo/map-demo.tsx": "examples/map-demo/main.tsx",
  "examples/mobile-app-demo/mobile-app-demo.tsx":
    "examples/mobile-app-demo/main.tsx",
  "examples/multi-option-selection.tsx":
    "examples/multi-option-selection/multi-option-selection.tsx",
  "examples/multi-option-selection/multi-option-selection.tsx":
    "examples/multi-option-selection/main.tsx",
  "examples/nested-counter.tsx": "examples/nested-counter/nested-counter.tsx",
  "examples/nested-counter/nested-counter.tsx":
    "examples/nested-counter/main.tsx",
  "examples/nested-mentionables.tsx":
    "examples/nested-mentionables/nested-mentionables.tsx",
  "examples/output_schema.tsx": "examples/output_schema/output_schema.tsx",
  "examples/output_schema/output_schema.tsx": "examples/output_schema/main.tsx",
  "examples/pattern-index/pattern-index.tsx": "examples/pattern-index/main.tsx",
  "examples/phonetic-speller.test.tsx":
    "examples/phonetic-speller/phonetic-speller.test.tsx",
  "examples/phonetic-speller.tsx":
    "examples/phonetic-speller/phonetic-speller.tsx",
  "examples/phonetic-speller/phonetic-speller.tsx":
    "examples/phonetic-speller/main.tsx",
  "examples/profile-aware-writer.tsx":
    "examples/profile-aware-writer/profile-aware-writer.tsx",
  "examples/profile-aware-writer/profile-aware-writer.tsx":
    "examples/profile-aware-writer/main.tsx",
  "examples/queue-test.tsx": "examples/queue-test/queue-test.tsx",
  "examples/reactive-now.test.tsx":
    "examples/reactive-now/reactive-now.test.tsx",
  "examples/reactive-now.tsx": "examples/reactive-now/reactive-now.tsx",
  "examples/reactive-now/reactive-now.tsx": "examples/reactive-now/main.tsx",
  "examples/reading-list/reading-list.tsx": "examples/reading-list/main.tsx",
  "examples/scoped-group-chat/main-plain-inputs.tsx":
    "examples/scoped-group-chat/plain-inputs/main.tsx",
  "examples/scoped-group-chat/main-with-writable-inputs.tsx":
    "examples/scoped-group-chat/writable-inputs/main.tsx",
  "examples/scoped-group-chat/main.test.tsx":
    "examples/scoped-group-chat/writable-inputs.test.tsx",
  "examples/simple-list/simple-list.tsx": "examples/simple-list/main.tsx",
  "examples/suggestion-test.tsx":
    "examples/suggestion-test/suggestion-test.tsx",
  "examples/summary-index-tester.tsx":
    "examples/summary-index-tester/summary-index-tester.tsx",
  "examples/text-swapper/text-swapper.tsx": "examples/text-swapper/main.tsx",
  "examples/todo-list/todo-list.tsx": "examples/todo-list/main.tsx",
  "examples/ui-variants-demo.tsx": "examples/ui-variants/ui-variants-demo.tsx",
  "examples/ui-variants-host.tsx": "examples/ui-variants/ui-variants-host.tsx",
  "examples/wish-note-example.tsx":
    "examples/wish-note-example/wish-note-example.tsx",
  "examples/wish-note-example/wish-note-example.tsx":
    "examples/wish-note-example/main.tsx",
  "examples/write-and-run.tsx": "examples/write-and-run/write-and-run.tsx",
  "examples/write-and-run/write-and-run.tsx": "examples/write-and-run/main.tsx",
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
 * The index of the entry of `moves` whose key names `key` or a directory
 * holding it; -1 when none does.
 */
function entryMoving(
  key: string,
  moves: readonly (readonly [string, string])[],
): number {
  return moves.findIndex(([from]) =>
    key === from || (from.endsWith("/") && key.startsWith(from))
  );
}

/** `key` as the entry of `moves` that names it moves it. */
function movedBy(
  key: string,
  moves: readonly (readonly [string, string])[],
): string {
  const entry = entryMoving(key, moves);
  return entry < 0 ? key : movedByEntry(key, moves[entry]);
}

/** `key` as `[from, to]`, an entry naming it, moves it. */
function movedByEntry(
  key: string,
  [from, to]: readonly [string, string],
): string {
  return from.endsWith("/") ? to + key.slice(from.length) : to;
}

/**
 * The keys `key` passes through as `moves` is applied to it again and again,
 * nearest first, until a key `moves` leaves unchanged; none when `moves`
 * leaves `key` itself unchanged. A pattern's moves apply each entry at most
 * once, so the walk stops at a key it already reached or at an entry it
 * already applied: a cycle in a table ends it instead of hanging it, including
 * one through directory entries that reaches a longer key on every pass.
 */
function movesFrom(
  key: string,
  moves: readonly (readonly [string, string])[],
): string[] {
  const keys: string[] = [];
  const seen = new Set([key]);
  const applied = new Set<number>();
  for (let at = key;;) {
    const entry = entryMoving(at, moves);
    if (entry < 0 || applied.has(entry)) return keys;
    applied.add(entry);
    const next = movedByEntry(at, moves[entry]);
    if (seen.has(next)) return keys;
    seen.add(next);
    keys.push(next);
    at = next;
  }
}

/** The lookups a table of moves answers. */
export interface PatternKeyMoves {
  /**
   * The key a pattern is served under, given a key it may have been served
   * under before it moved, however many times it moved since. A key that
   * never moved comes back unchanged.
   */
  current(key: string): string;

  /**
   * The key a pattern was served under before its latest move, given the key
   * it is served under now. A key that never moved comes back unchanged.
   */
  former(key: string): string;

  /**
   * Every key a pattern was served under before it came to be served under
   * `key`, the key before its latest move first and its first key last; none
   * for a key that never moved.
   */
  formers(key: string): string[];
}

/**
 * The lookups of `table`, a table of moves shaped as
 * {@link MOVED_PATTERN_KEYS} is.
 */
export function patternKeyMovesIn(
  table: Readonly<Record<string, string>>,
): PatternKeyMoves {
  // A file's own entry is found before the entry for a directory holding it,
  // so each direction is searched longest key first.
  const forward = Object.entries(table)
    .sort(([a], [b]) => b.length - a.length);
  const backward = Object.entries(table)
    .map(([from, to]) => [to, from] as const)
    .sort(([a], [b]) => b.length - a.length);
  return {
    current: (key) => movesFrom(key, forward).at(-1) ?? key,
    former: (key) => movedBy(key, backward),
    formers: (key) => movesFrom(key, backward),
  };
}

const MOVES = patternKeyMovesIn(MOVED_PATTERN_KEYS);

/** {@link PatternKeyMoves.current} of {@link MOVED_PATTERN_KEYS}. */
export function currentPatternKey(key: string): string {
  return MOVES.current(key);
}

/** {@link PatternKeyMoves.former} of {@link MOVED_PATTERN_KEYS}. */
export function formerPatternKey(key: string): string {
  return MOVES.former(key);
}

/** {@link PatternKeyMoves.formers} of {@link MOVED_PATTERN_KEYS}. */
export function formerPatternKeys(key: string): string[] {
  return MOVES.formers(key);
}

/**
 * Whether a stored program's entry module name names the pattern served under
 * `key`, by that key or by a key the pattern had before it moved. A compile
 * can put any root in front of a current key, so a current key is matched by
 * the name's ending. A former key is matched only below a patterns directory
 * (`/api/patterns/`, `/packages/patterns/`, or `/patterns/`) or at the root,
 * which are the roots programs were compiled under before the move; matched by
 * its ending alone, a former key such as `chatbot.tsx` would also match a file
 * of that name inside another pattern.
 */
export function mainNamesPattern(main: string, key: string): boolean {
  return main.endsWith(`/${key}`) ||
    formerPatternKeys(key).some((former) =>
      main === `/${former}` || main.endsWith(`/patterns/${former}`)
    );
}
