/**
 * That an element of a filtered, sorted `computed()` still carries the
 * identity of the stored record it was derived from.
 *
 * This is a property of the runtime, not of Topics: the reader's rows come
 * from such a view, and the retraction controls are bound to their elements,
 * so if a derived element were a copy every control would stamp something no
 * reader shows. The views below are therefore a minimal reproduction of that
 * shape rather than an attempt to re-test `topic.tsx`'s own `commentsView` —
 * the shipped views are covered where they can only be covered, through the
 * rendered rows and a real click, in
 * `integration/topic-retraction-controls.test.ts`.
 *
 * The views cannot simply be shared with the pattern. A reactive read declares
 * the schema it can SEE from the properties it names, so `removedAt` has to be
 * written out inside each `computed()`; behind a helper call it is not named,
 * is never demanded, and reads back absent on every element. `isPresent` in
 * `topic.tsx` records that rule at its declaration. What guards this file
 * against drifting from the shipped filter instead is
 * `assert_view_agrees_with_shipped_count` below, which holds the local view to
 * `commentCount` — the count `topic.tsx` derives with its own copy of the
 * predicate.
 *
 * `removeComment` and `removeLink` are the oracles rather than a bespoke
 * assertion, because they already prove membership with `equals()` against the
 * stored positions and reject loudly when it fails. Handing them an element
 * taken from a view therefore answers the question with a pass or a throw.
 *
 * The negative half lives in topics-rejections.test.tsx, where a structural
 * copy of a real stored comment is refused — the case that separates identity
 * from content, since a copy satisfies every content-based check.
 */
import { action, assert, computed, pattern, TESTS } from "commonfabric";
import Topic from "./topic.tsx";

export default pattern(() => {
  const topic = Topic({ title: "View identity" });

  // One append per action, rather than three in one. The harness settles
  // between actions, so each record lands before the next is sent and arrival
  // order stops being an assumption about how a run of `send()` calls is
  // drained.
  //
  // What it does NOT buy is distinct `sentAt` stamps. A settle is faster than
  // the clock's millisecond, so the three still tie — measured here, not
  // assumed: the assertion below reads them non-decreasing and goes red on
  // strictly increasing. So the view's comparator ties on every pair, and the
  // order the rows appear in is the stored array's order under a stable sort.
  // That is exactly what addressing a row by index relies on, which is why the
  // assertion pins it rather than trusting it.
  const add_first = action(() => {
    topic.addComment.send({ body: "first", agentName: "Sol" });
  });
  const add_second = action(() => {
    topic.addComment.send({ body: "second", agentName: "Sol" });
  });
  const add_third = action(() => {
    topic.addComment.send({ body: "third", agentName: "Sol" });
  });

  const add_link_one = action(() => {
    topic.addLink.send({
      kind: "web",
      url: "https://example.com/one",
      label: "one",
      agentName: "Sol",
    });
  });
  const add_link_two = action(() => {
    topic.addLink.send({
      kind: "web",
      url: "https://example.com/two",
      label: "two",
      agentName: "Sol",
    });
  });
  const add_link_three = action(() => {
    topic.addLink.send({
      kind: "web",
      url: "https://example.com/three",
      label: "three",
      agentName: "Sol",
    });
  });

  const commentsView = computed(() =>
    topic.comments.filter((c) => c.removedAt === undefined).toSorted((a, b) =>
      a.sentAt - b.sentAt
    )
  );
  const linksView = computed(() =>
    topic.links.filter((l) => l.removedAt === undefined)
  );

  // Index 1 of the VIEW, twice. The two calls are deliberately identical, and
  // what separates them is what sits at that index each time.
  //
  // The first runs while the view and the stored array still agree — three
  // live comments in `sentAt` order — so it proves the element addresses a
  // stored record at all. The second runs after a record has been stamped, so
  // the view holds the first and the last while the array still holds all
  // three: view index 1 is now stored index 2. Only the second can tell an
  // element taken from the view apart from one taken from the array, and it is
  // the reason this file retracts twice rather than once.
  const retract_view_index_1 = action(() => {
    const target = commentsView[1];
    if (target) {
      topic.removeComment.send({ comment: target, agentName: "Sol" });
    }
  });
  const retract_view_index_1_again = action(() => {
    const target = commentsView[1];
    if (target) {
      topic.removeComment.send({ comment: target, agentName: "Sol" });
    }
  });

  const retract_link_index_1 = action(() => {
    const target = linksView[1];
    if (target) topic.removeLink.send({ link: target, agentName: "Sol" });
  });
  const retract_link_index_1_again = action(() => {
    const target = linksView[1];
    if (target) topic.removeLink.send({ link: target, agentName: "Sol" });
  });

  const assert_three_comments = assert(() => topic.comments.length === 3);

  /** The thread is in the order it was filed, and `sentAt` never goes
   * backwards along it. Both are relied on below, because every row here is
   * addressed by its index in the view. Non-decreasing rather than increasing
   * is the honest bound: these records tie, and a comparator that ties leaves
   * the stable sort returning the array's own order. */
  const assert_thread_in_filed_order = assert(() => {
    const stored = topic.comments;
    const bodies = stored.map((c) => c.body);
    const ordered = bodies[0] === "first" && bodies[1] === "second" &&
      bodies[2] === "third";
    const nonDecreasing = stored.every((c, i) =>
      i === 0 || stored[i - 1]!.sentAt <= c.sentAt
    );
    return ordered && nonDecreasing;
  });

  /** The drift guard named in the header: the local view and the shipped
   * `commentCount` must agree about what is present. They are separate copies
   * of one predicate, so a change to the shipped one that this file did not
   * follow shows up here rather than passing silently. */
  const assert_view_agrees_with_shipped_count = assert(() =>
    commentsView.length === topic.commentCount
  );

  const assert_second_stamped = assert(() => {
    const stamped = topic.comments.filter((c) => c.removedAt !== undefined);
    return topic.comments.length === 3 && stamped.length === 1 &&
      stamped[0]?.body === "second";
  });

  // The stored array and the view now disagree about index 1: the array holds
  // the stamped "second" there, the view holds "third". Asserted so the step
  // that follows is known to be the divergent one rather than assumed to be.
  const assert_view_and_array_diverge = assert(() =>
    topic.comments[1]?.body === "second" &&
    topic.comments[1]?.removedAt !== undefined &&
    commentsView[1]?.body === "third"
  );

  // "third", not "second": the element came from the view. Bound to the array
  // position this would have found the already-stamped "second" and rejected,
  // leaving one stamped record rather than two.
  const assert_third_stamped_too = assert(() => {
    const stamped = topic.comments.filter((c) => c.removedAt !== undefined);
    const live = topic.comments.filter((c) => c.removedAt === undefined);
    return topic.comments.length === 3 && stamped.length === 2 &&
      live.length === 1 && live[0]?.body === "first" &&
      stamped.some((c) => c.body === "third");
  });

  const assert_reader_sees_one = assert(() => topic.commentCount === 1);

  const assert_links_stamped_through_view = assert(() => {
    const stamped = topic.links.filter((l) => l.removedAt !== undefined);
    const live = topic.links.filter((l) => l.removedAt === undefined);
    return topic.links.length === 3 && stamped.length === 2 &&
      live.length === 1 && live[0]?.url === "https://example.com/one" &&
      stamped.some((l) => l.url === "https://example.com/three");
  });

  return {
    [TESTS]: [
      { action: add_first },
      { action: add_second },
      { action: add_third },
      { action: add_link_one },
      { action: add_link_two },
      { action: add_link_three },
      { assertion: assert_three_comments },
      { assertion: assert_thread_in_filed_order },
      { assertion: assert_view_agrees_with_shipped_count },
      { action: retract_view_index_1 },
      { assertion: assert_second_stamped },
      { assertion: assert_view_and_array_diverge },
      { assertion: assert_view_agrees_with_shipped_count },
      { action: retract_view_index_1_again },
      { assertion: assert_third_stamped_too },
      { assertion: assert_reader_sees_one },
      { action: retract_link_index_1 },
      { action: retract_link_index_1_again },
      { assertion: assert_links_stamped_through_view },
    ],
  };
});
