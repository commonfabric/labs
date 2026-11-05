import type {
  AsCell,
  Cell,
  KeyResultType,
  ReadonlyCell,
  Stream,
} from "../index.ts";

type NotificationPrefs = {
  email: boolean;
  push: boolean;
  sms: boolean;
};

type UserProfile = {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  avatarUrl?: string;
  stats: {
    followers: number;
    following: number;
    posts: number;
    lastLogin: string;
    engagementScore: ReadonlyCell<number>;
    liveFeed: Stream<string>;
  };
  settings: {
    theme: "light" | "dark";
    locale: string;
  };
  notificationPrefs: Cell<NotificationPrefs>;
  preferences: ReadonlyCell<{
    compactMode: boolean;
    language: string;
  }>;
  nested: {
    audit: Cell<
      ReadonlyCell<{
        lastUpdatedBy: string;
        lastUpdatedAt: string;
      }>
    >;
  };
};

type UserProfileCell = Cell<UserProfile>;

declare const user: UserProfileCell;

// Literal keys – most common usage
const _literalId = user.key("id");
const _literalStats = user.key("stats");
const _literalSettings = user.key("settings");
const _literalPrefs = user.key("preferences");
const _literalNotificationPrefs = user.key("notificationPrefs");

// Nested literal access
const _statsFollowers = user.key("stats").key("followers");
const _statsEngagement = user.key("stats").key("engagementScore");
const _statsLiveFeed = user.key("stats").key("liveFeed");
const _settingsTheme = user.key("settings").key("theme");
const _notificationEmail = user.key("notificationPrefs").key("email");
const _nestedAuditUser = user.key("nested").key("audit").key("lastUpdatedBy");

// Dynamic string keys (fallback to any)
declare const stringKey: string;
const _stringAccess = user.key(stringKey);
const _nestedViaString = user.key(stringKey).key("theme");

// Random access of flags to simulate loops with string inputs
declare const runtimeKeys: string[];
for (const key of runtimeKeys) {
  user.key(key);
}

// Helper types to amplify compile-time KeyResultType usage
type AmplifyKeys<
  Source,
  Keys extends readonly PropertyKey[],
> = {
  [Index in Extract<keyof Keys, number>]: KeyResultType<
    Source,
    [Keys[Index]],
    AsCell
  >;
};

type TopLevelKeys = [
  "id",
  "name",
  "email",
  "stats",
  "preferences",
  "notificationPrefs",
];
type AmplifiedTopLevel = AmplifyKeys<UserProfileCell, TopLevelKeys>;

type StatsKeys = ["followers", "engagementScore", "liveFeed", "lastLogin"];
type AmplifiedStats = AmplifyKeys<
  KeyResultType<UserProfileCell, ["stats"], AsCell>,
  StatsKeys
>;

type NotificationKeys = ["email", "push", "sms"];
type AmplifiedNotifications = AmplifyKeys<
  KeyResultType<UserProfileCell, ["notificationPrefs"], AsCell>,
  NotificationKeys
>;

// Recursive helper to exercise longer key chains
type KeyChain<
  Source,
  Keys extends readonly PropertyKey[],
> = Keys extends
  readonly [infer Head extends PropertyKey, ...infer Tail extends PropertyKey[]]
  ? KeyChain<KeyResultType<Source, [Head], AsCell>, Tail>
  : Source;

type FrequentPaths = [
  ["stats", "followers"],
  ["stats", "engagementScore"],
  ["stats", "liveFeed"],
  ["notificationPrefs", "email"],
  ["notificationPrefs", "push"],
  ["preferences", "language"],
  ["nested", "audit", "lastUpdatedBy"],
  ["nested", "audit", "lastUpdatedAt"],
];

type AmplifiedPaths = [
  KeyChain<UserProfileCell, ["stats", "followers"]>,
  KeyChain<UserProfileCell, ["stats", "engagementScore"]>,
  KeyChain<UserProfileCell, ["stats", "liveFeed"]>,
  KeyChain<UserProfileCell, ["notificationPrefs", "email"]>,
  KeyChain<UserProfileCell, ["notificationPrefs", "push"]>,
  KeyChain<UserProfileCell, ["preferences", "language"]>,
  KeyChain<UserProfileCell, ["nested", "audit", "lastUpdatedBy"]>,
  KeyChain<UserProfileCell, ["nested", "audit", "lastUpdatedAt"]>,
];

// Variation with ReadonlyCell/Stream wrapped in Cells
type Timeline = {
  timestamp: string;
  action: string;
  actor: string;
};

type ActivityCell = Cell<{
  recent: ReadonlyCell<Timeline>;
  events: Stream<Timeline>;
}>;

type Account = {
  profile: UserProfile;
  activity: ActivityCell;
  emergencyContacts: Cell<ReadonlyCell<{ name: string; phone: string }>[]>;
};

type AccountCell = Cell<Account>;
declare const account: AccountCell;

const _accountProfile = account.key("profile");
const _accountActivityRecent = account.key("activity").key("recent");
const _accountActivityEvents = account.key("activity").key("events");
const _accountEmergencyContacts = account.key("emergencyContacts");

// Additional amplification on account structure
type AccountPaths = [
  ["profile", "stats", "followers"],
  ["profile", "notificationPrefs", "email"],
  ["profile", "preferences", "language"],
  ["activity", "recent"],
  ["activity", "events"],
  ["emergencyContacts"],
];

type AmplifiedAccountPaths = [
  KeyChain<AccountCell, ["profile", "stats", "followers"]>,
  KeyChain<AccountCell, ["profile", "notificationPrefs", "email"]>,
  KeyChain<AccountCell, ["profile", "preferences", "language"]>,
  KeyChain<AccountCell, ["activity", "recent"]>,
  KeyChain<AccountCell, ["activity", "events"]>,
  KeyChain<AccountCell, ["emergencyContacts"]>,
];
