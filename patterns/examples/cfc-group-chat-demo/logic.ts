export type RandomSource = () => number;

export const seededRandom = (seed: number): RandomSource => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let value = Math.imul(current ^ (current >>> 15), 1 | current);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export type MessageOrigin = "sent" | "imported";

export interface ChatProfile {
  readonly name: string;
  readonly accentColor: string;
}

export interface ParticipantClaim<ProfileRef = unknown> {
  readonly name: string;
  readonly accentColor: string;
  readonly profile?: ProfileRef;
}

export interface SentChatMessage<ProfileRef = unknown> {
  readonly origin: "sent";
  readonly authorName: string;
  readonly authorProfile: ProfileRef;
  readonly body: string;
  readonly timestamp: number;
}

export interface ImportedClaimedChatMessage<ProfileRef = unknown> {
  readonly origin: "imported";
  readonly authorName: string;
  readonly authorProfile?: ProfileRef;
  readonly body: string;
  readonly timestamp: number;
}

export type PlainChatMessage<ProfileRef = unknown> =
  | SentChatMessage<ProfileRef>
  | ImportedClaimedChatMessage<ProfileRef>;

export interface ChatRoom<Message = PlainChatMessage> {
  readonly name: string;
  readonly messages: Message[];
  readonly createdAt: number;
}

const PROFILE_COLORS = [
  "#2563eb",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#c2410c",
  "#0f766e",
] as const;

const RANDOM_IMPORTED_BODIES = [
  "Jumping in late here.",
  "I think we already covered this above.",
  "Can we loop back on the last point?",
  "Sharing a quick update from the thread.",
  "I might be missing context, but this seems fine.",
] as const;

const hashText = (text: string): number =>
  Array.from(text).reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );

export const accentColorForName = (name: string): string =>
  PROFILE_COLORS[hashText(name) % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];

export const makeProfileSnapshot = (
  name: string,
  previous?: ChatProfile,
): ChatProfile => ({
  name,
  accentColor: previous?.accentColor ?? accentColorForName(name),
});

export const createSentMessageSnapshot = <ProfileRef>(
  authorProfile: ProfileRef,
  author: ChatProfile,
  body: string,
): SentChatMessage<ProfileRef> => ({
  origin: "sent",
  authorName: author.name,
  authorProfile,
  body,
  timestamp: Date.now(),
});

export const createRoomSnapshot = <Message>(
  name: string,
): ChatRoom<Message> => ({
  name,
  messages: [],
  createdAt: Date.now(),
});

const createImportedClaimedMessage = <ProfileRef>(
  author: ParticipantClaim<ProfileRef>,
  body: string,
  timestamp: number,
): ImportedClaimedChatMessage<ProfileRef> => ({
  origin: "imported",
  authorName: author.name,
  ...(author.profile !== undefined ? { authorProfile: author.profile } : {}),
  body,
  timestamp,
});

const compareMessagesByThreadOrder = (
  left: Pick<PlainChatMessage, "authorName" | "body" | "origin" | "timestamp">,
  right: Pick<PlainChatMessage, "authorName" | "body" | "origin" | "timestamp">,
): number => {
  const timestampOrder = left.timestamp - right.timestamp;
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  const authorOrder = left.authorName.localeCompare(right.authorName);
  if (authorOrder !== 0) {
    return authorOrder;
  }

  const bodyOrder = left.body.localeCompare(right.body);
  if (bodyOrder !== 0) {
    return bodyOrder;
  }

  return left.origin.localeCompare(right.origin);
};

export const sortDisplayMessages = <
  Message extends Pick<
    PlainChatMessage,
    "authorName" | "body" | "origin" | "timestamp"
  >,
>(
  messages: readonly Message[],
): Message[] => Array.from(messages).sort(compareMessagesByThreadOrder);

const chooseRandom = <Value>(
  values: readonly Value[],
  random: RandomSource,
): Value | undefined => {
  if (values.length === 0) {
    return undefined;
  }

  const index = Math.floor(random() * values.length);
  return values[index] ?? values[0];
};

const randomInsertTimestamp = (
  messages: readonly PlainChatMessage[],
  random: RandomSource,
): number => {
  const ordered = sortDisplayMessages(messages);
  if (ordered.length === 0) {
    return Date.now();
  }

  const slot = random() * (ordered.length + 1);
  const rightIndex = Math.floor(slot);
  const fractional = slot - rightIndex;
  if (rightIndex <= 0) {
    return ordered[0]!.timestamp - 1 - fractional;
  }
  if (rightIndex >= ordered.length) {
    return ordered[ordered.length - 1]!.timestamp + 1 + fractional;
  }

  const leftTimestamp = ordered[rightIndex - 1]!.timestamp;
  const rightTimestamp = ordered[rightIndex]!.timestamp;
  const gap = rightTimestamp - leftTimestamp;
  if (gap > 0.001) {
    return leftTimestamp + gap * (fractional === 0 ? 0.5 : fractional);
  }

  return leftTimestamp + random() * 0.001;
};

export const createRandomImportedClaimedMessages = <ProfileRef>(
  existingMessages: readonly PlainChatMessage<ProfileRef>[],
  participants: readonly ParticipantClaim<ProfileRef>[],
  random: RandomSource = Math.random,
): ImportedClaimedChatMessage<ProfileRef>[] => {
  const authorPool = Array.from(participants);
  const workingMessages = sortDisplayMessages(existingMessages);
  const insertCount = Math.min(3, workingMessages.length);
  if (authorPool.length === 0 || insertCount === 0) {
    return [];
  }

  return Array.from({ length: insertCount }, () => {
    const author = chooseRandom(authorPool, random);
    const body = chooseRandom(RANDOM_IMPORTED_BODIES, random);
    if (!author || !body) {
      return undefined;
    }
    const timestamp = randomInsertTimestamp(workingMessages, random);
    const message = createImportedClaimedMessage(author, body, timestamp);
    workingMessages.push(message);
    return message;
  }).filter((message): message is ImportedClaimedChatMessage<ProfileRef> =>
    message !== undefined
  );
};
