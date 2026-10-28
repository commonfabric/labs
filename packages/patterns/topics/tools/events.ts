/**
 * What happened on a Topics board, as the live view shows it: the events
 * between two readings of the board, and the recent events a single reading
 * still records. An event carries the Topic it happened to as it now stands.
 */

import type { Topic, TopicComment, TopicLink } from "./mirror.ts";

/** One thing that happened to a Topic, at `at`, in milliseconds. */
export type TopicEvent =
  & { topic: Topic; at: number }
  & (
    | { kind: "filed" }
    | { kind: "comment"; comment: TopicComment }
    | { kind: "edited"; comment: TopicComment }
    | { kind: "retracted"; comment: TopicComment }
    | { kind: "retitled"; before: string }
    | { kind: "body"; before: string }
    | { kind: "link"; link: TopicLink }
    | { kind: "unlinked"; link: TopicLink }
    | { kind: "mention"; other: Topic }
    | { kind: "unmentioned"; other: Topic }
  );

/**
 * The events that turn the board `before` into the board `after`, oldest
 * first. A change with no timestamp of its own, such as a new body, is dated
 * `now`.
 */
export function changes(
  before: readonly Topic[],
  after: readonly Topic[],
  now: number,
): TopicEvent[] {
  const earlier = new Map(before.map((topic) => [topic.number, topic]));
  const namedBefore = byReference(before);
  const namedAfter = byReference(after);
  const events: TopicEvent[] = [];
  for (const topic of after) {
    const was = earlier.get(topic.number);
    if (was === undefined) {
      events.push({ kind: "filed", topic, at: topic.createdAt || now });
      continue;
    }
    if (was.title !== topic.title) {
      events.push({ kind: "retitled", topic, before: was.title, at: now });
    }
    if (was.body !== topic.body) {
      events.push({ kind: "body", topic, before: was.body, at: now });
    }
    for (const [index, comment] of topic.comments.entries()) {
      const old = was.comments[index];
      if (old === undefined) {
        if (!comment.removed) {
          events.push({
            kind: "comment",
            topic,
            comment,
            at: comment.sentAt || now,
          });
        }
      } else if (comment.removed && !old.removed) {
        events.push({ kind: "retracted", topic, comment, at: now });
      } else if (
        !comment.removed &&
        (comment.body !== old.body || comment.editedAt !== old.editedAt)
      ) {
        events.push({
          kind: "edited",
          topic,
          comment,
          at: comment.editedAt ?? now,
        });
      }
    }
    for (const [index, link] of topic.links.entries()) {
      const old = was.links[index];
      if (old === undefined) {
        if (!link.removed) {
          events.push({ kind: "link", topic, link, at: link.addedAt ?? now });
        }
      } else if (link.removed && !old.removed) {
        events.push({ kind: "unlinked", topic, link, at: now });
      }
    }
    // A reference counts from when the Topic it names is on the board, so
    // one made before that Topic was read is reported once it is.
    for (const id of topic.mentions) {
      const other = namedAfter.get(id);
      if (
        other !== undefined &&
        !(was.mentions.includes(id) && namedBefore.get(id) !== undefined)
      ) {
        events.push({ kind: "mention", topic, other, at: now });
      }
    }
    for (const id of was.mentions) {
      const other = namedBefore.get(id);
      if (other !== undefined && !topic.mentions.includes(id)) {
        events.push({
          kind: "unmentioned",
          topic,
          other: namedAfter.get(id) ?? other,
          at: now,
        });
      }
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

/**
 * Each of `topics` by the references that name it, its address and piece,
 * the first Topic a reference names where two share it.
 */
function byReference(topics: readonly Topic[]): Map<string, Topic> {
  const named = new Map<string, Topic>();
  for (const topic of topics) {
    for (const reference of [topic.address, topic.piece]) {
      if (!named.has(reference)) named.set(reference, topic);
    }
  }
  return named;
}

/**
 * The newest `count` events a single reading of the board still records,
 * Topics filed, comments, and links, by their own timestamps, oldest first.
 */
export function history(topics: readonly Topic[], count: number): TopicEvent[] {
  const events: TopicEvent[] = topics.flatMap((topic): TopicEvent[] => [
    ...(topic.createdAt > 0
      ? [{ kind: "filed" as const, topic, at: topic.createdAt }]
      : []),
    ...topic.comments.flatMap((comment) =>
      comment.removed || comment.sentAt === 0
        ? []
        : [{ kind: "comment" as const, topic, comment, at: comment.sentAt }]
    ),
    ...topic.links.flatMap((link) =>
      link.removed || link.addedAt === undefined
        ? []
        : [{ kind: "link" as const, topic, link, at: link.addedAt }]
    ),
  ]);
  return events.sort((a, b) => a.at - b.at).slice(-count);
}
