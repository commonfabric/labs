import {
  type AddIntegrity,
  AuthoredByCurrentUser,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  RepresentsCurrentUser,
  RequiresIntegrity,
  Stream,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import {
  activeAdminRoleForSubject,
  adminRegistryEntries,
  adminRegistryEveryoneIsAdmin,
  type EmptyAdminRegistryValue,
  subjectHasAdminRole,
} from "../cfc/admin/mod.ts";
import {
  type ChatProfile,
  type ChatRoom,
  createRoomSnapshot,
  createSentMessageSnapshot,
  type ImportedClaimedChatMessage as PlainImportedClaimedChatMessage,
  makeProfileSnapshot,
  type ParticipantClaim,
  type PlainChatMessage,
  type SentChatMessage,
} from "./logic.ts";

export const TRUSTED_GROUP_CHAT_PROFILE_SURFACE =
  "TrustedGroupChatProfileSurface";
export const TRUSTED_GROUP_CHAT_SEND_SURFACE = "TrustedGroupChatSendSurface";
export const TRUSTED_GROUP_CHAT_ROOM_SURFACE = "TrustedGroupChatRoomSurface";
export const TRUSTED_GROUP_CHAT_ADMIN_SURFACE = "TrustedGroupChatAdminSurface";
export const TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION =
  "TrustedGroupChatSaveProfile";
export const TRUSTED_GROUP_CHAT_SEND_ACTION = "TrustedGroupChatSendMessage";
export const TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";
export const TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION = "TrustedGroupChatSetAdmin";
export const GROUP_CHAT_ADMIN_INTEGRITY = "group-chat-admin" as const;

export type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof commitTrustedProfileSave,
    typeof TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
    typeof TRUSTED_GROUP_CHAT_PROFILE_SURFACE
  >
>;

export type ProfileCell = Writable<ChatProfile | undefined>;
export type TrustedProfileCell = Writable<TrustedProfile>;
export interface ChatAdminRoleAssignment {
  readonly subject: ProfileCell;
  readonly displayName: string;
}
export type ChatAdminRole = AddIntegrity<
  ChatAdminRoleAssignment,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export interface MyProfileValue {
  readonly profile?: ProfileCell;
}

export interface MyProfileStoredValue {
  readonly profile?: ChatProfile;
}

export type EmptyMyProfileValue = Record<PropertyKey, never>;
export type MyProfileCellValue =
  | MyProfileStoredValue
  | Default<EmptyMyProfileValue>;
export type MyProfileCell = Writable<MyProfileCellValue>;
export type AuthorProfileCell = ProfileCell;

export type TrustedSentChatMessage = AuthoredByCurrentUser<
  TrustedActionWrite<
    SentChatMessage<ProfileCell>,
    typeof commitTrustedMessageSend,
    typeof TRUSTED_GROUP_CHAT_SEND_ACTION,
    typeof TRUSTED_GROUP_CHAT_SEND_SURFACE
  >
>;

export type ImportedClaimedChatMessage = PlainImportedClaimedChatMessage<
  AuthorProfileCell
>;

export type SharedChatMessage =
  | TrustedSentChatMessage
  | ImportedClaimedChatMessage;

export type SharedMessagesValue = SharedChatMessage[] | Default<[]>;
export type SharedMessagesCell = Writable<SharedMessagesValue>;

export interface SharedProfileEntry {
  readonly profile: ProfileCell;
}

export type SharedProfilesValue = SharedProfileEntry[] | Default<[]>;
export type SharedProfilesCell = Writable<SharedProfilesValue>;

export type TrustedChatRoom = ChatRoom<SharedChatMessage>;

export type ChatAdminList = RequiresIntegrity<
  AddIntegrity<
    TrustedActionWrite<
      ChatAdminRole[],
      typeof commitTrustedAdminToggle,
      typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
      typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
    >,
    readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
  >,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export type ChatAdminBootstrapRole = AddIntegrity<
  ChatAdminRoleAssignment,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export type ChatEveryoneAdminFlag =
  | RequiresIntegrity<
    AddIntegrity<
      TrustedActionWrite<
        true,
        typeof commitTrustedAdminToggle,
        typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
        typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
      >,
      readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
    >,
    readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
  >
  | TrustedActionWrite<
    false,
    typeof commitTrustedAdminToggle,
    typeof TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
    typeof TRUSTED_GROUP_CHAT_ADMIN_SURFACE
  >;

export interface ChatAdminRegistryStoredValue {
  readonly admins?: ChatAdminList;
  readonly bootstrapAdmin?: ChatAdminBootstrapRole;
  readonly everyoneIsAdmin?: ChatEveryoneAdminFlag;
}

export type ChatAdminRegistryValue =
  | ChatAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type ChatAdminRegistryCell = Writable<ChatAdminRegistryValue>;

export type SharedRoomList = RequiresIntegrity<
  AddIntegrity<
    TrustedActionWrite<
      TrustedChatRoom[],
      typeof commitTrustedRoomAdd,
      typeof TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
      typeof TRUSTED_GROUP_CHAT_ROOM_SURFACE
    >,
    readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
  >,
  readonly [typeof GROUP_CHAT_ADMIN_INTEGRITY]
>;

export interface SharedRoomsStoredValue {
  readonly list?: SharedRoomList;
}

export type EmptySharedRoomsValue = Record<PropertyKey, never>;
export type SharedRoomsValue =
  | SharedRoomsStoredValue
  | Default<EmptySharedRoomsValue>;
export type SharedRoomsCell = Writable<SharedRoomsValue>;

/**
 * The click a `cf-submit-input` delivers, from its button or from Enter in its
 * field. It is a trusted DOM gesture, and it carries the field's text as
 * `target.value`.
 */
export interface SubmittedTextEvent {
  readonly target?: { readonly value?: string };
}

const submittedText = (event: SubmittedTextEvent | undefined): string =>
  event?.target?.value ?? "";

const nonEmptyEventName = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const messagesValue = (
  messages: SharedMessagesCell,
): SharedChatMessage[] =>
  Array.from((messages.get() as SharedChatMessage[] | undefined) ?? []);

export const profilesValue = (
  profiles: SharedProfilesCell,
): ProfileCell[] =>
  Array.from((profiles.get() as SharedProfileEntry[] | undefined) ?? [])
    .map((entry) => entry.profile)
    .reduce<ProfileCell[]>(
      (uniqueProfiles, profile) =>
        uniqueProfiles.some((knownProfile) => equals(knownProfile, profile))
          ? uniqueProfiles
          : [...uniqueProfiles, profile],
      [],
    );

export const roomsValue = (
  rooms: SharedRoomsCell,
): TrustedChatRoom[] =>
  Array.from((rooms.get() as SharedRoomsStoredValue | undefined)?.list ?? []);

export const myProfileValue = (
  myProfile: MyProfileCell,
): MyProfileStoredValue => myProfile.get() ?? {};

export const currentProfileCell = (
  myProfile: MyProfileCell,
): ProfileCell | undefined =>
  myProfileValue(myProfile).profile === undefined
    ? undefined
    : myProfile.key("profile").resolveAsCell();

export const currentProfileSnapshot = (
  myProfile: MyProfileCell,
): ChatProfile | undefined => currentProfileCell(myProfile)?.get();

export const chatAdminRolesValue = (
  adminRegistry: ChatAdminRegistryCell,
): ChatAdminRole[] => {
  const explicitAdmins = adminRegistryEntries<ChatAdminRole>(adminRegistry);
  if (explicitAdmins.length > 0) {
    return explicitAdmins;
  }
  const bootstrapAdmin = (
    adminRegistry.get() as ChatAdminRegistryStoredValue | undefined
  )?.bootstrapAdmin;
  if (bootstrapAdmin === undefined) {
    return [];
  }
  const subject: ProfileCell = adminRegistry.key("bootstrapAdmin").key(
    "subject",
  )
    .resolveAsCell();
  return [{
    ...bootstrapAdmin,
    subject,
  } as ChatAdminRole];
};

export const chatAdminEveryoneIsAdmin = (
  adminRegistry: ChatAdminRegistryCell,
): boolean => adminRegistryEveryoneIsAdmin<ChatAdminRole>(adminRegistry);

export const currentUserAdminRole = (
  myProfile: MyProfileCell,
  adminRegistry: ChatAdminRegistryCell,
): ChatAdminRole | undefined => {
  if (myProfileValue(myProfile).profile === undefined) {
    return undefined;
  }
  const profile = myProfile.key("profile").resolveAsCell();
  const explicitRole = activeAdminRoleForSubject(
    chatAdminRolesValue(adminRegistry),
    profile,
  );
  if (explicitRole !== undefined) {
    return explicitRole;
  }
  const profileValue = currentProfileSnapshot(myProfile);
  if (
    !profileValue?.name ||
    !chatAdminEveryoneIsAdmin(adminRegistry)
  ) {
    return undefined;
  }

  return {
    subject: profile,
    displayName: profileValue.name,
  } as ChatAdminRole;
};

export const currentUserIsAdmin = (
  myProfile: MyProfileCell,
  adminRegistry: ChatAdminRegistryCell,
): boolean => currentUserAdminRole(myProfile, adminRegistry) !== undefined;

export const currentUserCanManageAdmins = (
  myProfile: MyProfileCell,
  adminRegistry: ChatAdminRegistryCell,
): boolean => currentUserIsAdmin(myProfile, adminRegistry);

export const participantClaimsValue = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): ParticipantClaim<AuthorProfileCell>[] => {
  const participants: ParticipantClaim<AuthorProfileCell>[] = [];
  const addParticipant = (
    name: string | undefined,
    accentColor: string | undefined,
    profile: AuthorProfileCell | undefined,
  ) => {
    if (!name) {
      return;
    }
    if (
      profile !== undefined &&
      participants.some((participant) => equals(profile, participant.profile))
    ) {
      return;
    }
    participants.push({
      name,
      accentColor: accentColor ?? "#64748b",
      ...(profile !== undefined ? { profile } : {}),
    });
  };

  profilesValue(profiles).forEach((profile) => {
    const profileValue = profile.get();
    addParticipant(profileValue?.name, profileValue?.accentColor, profile);
  });

  const mineValue = currentProfileSnapshot(myProfile);
  addParticipant(
    mineValue?.name,
    mineValue?.accentColor,
    currentProfileCell(myProfile),
  );

  messagesValue(messages).forEach((message) => {
    const profile = message.authorProfile;
    const profileValue = profile?.get();
    addParticipant(
      profileValue?.name ?? message.authorName,
      profileValue?.accentColor,
      profile,
    );
  });

  return participants;
};

export const participantSummary = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
): string => {
  const participants = participantClaimsValue(profiles, myProfile, messages);
  return participants.length === 0
    ? "No participants yet"
    : participants.map((participant) => participant.name).join(" · ");
};

export interface AdminParticipantRow {
  readonly name: string;
  readonly accentColor: string;
  readonly profile?: AuthorProfileCell;
  readonly isAdmin: boolean;
  readonly everyoneIsAdmin: boolean;
  readonly canManageAdmins: boolean;
}

export const adminParticipantRowsValue = (
  profiles: SharedProfilesCell,
  myProfile: MyProfileCell,
  messages: SharedMessagesCell,
  adminRegistry: ChatAdminRegistryCell,
): AdminParticipantRow[] => {
  const adminRoles = chatAdminRolesValue(adminRegistry);
  const everyoneIsAdmin = chatAdminEveryoneIsAdmin(adminRegistry);
  const canManageAdmins = currentUserCanManageAdmins(myProfile, adminRegistry);
  return participantClaimsValue(profiles, myProfile, messages)
    .filter((participant) => participant.profile !== undefined)
    .map((participant) => ({
      name: participant.name,
      accentColor: participant.accentColor,
      profile: participant.profile,
      isAdmin: everyoneIsAdmin ||
        subjectHasAdminRole(adminRoles, participant.profile),
      everyoneIsAdmin,
      canManageAdmins,
    }));
};

export const registerProfile = (
  profiles: SharedProfilesCell,
  profile: ProfileCell,
): void => {
  const currentProfiles = profilesValue(profiles);
  if (currentProfiles.some((knownProfile) => equals(knownProfile, profile))) {
    return;
  }
  profiles.push({ profile } as SharedProfileEntry);
};

export const applyTrustedProfileSave = (
  myProfile: MyProfileCell,
  profiles: SharedProfilesCell,
  rawName: string,
): {
  trimmedName: string | null;
  profile?: ProfileCell;
} => {
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return { trimmedName: null };
  }

  const existingProfile = currentProfileSnapshot(myProfile);
  const nextSnapshot = makeProfileSnapshot(
    trimmedName,
    existingProfile,
  ) as TrustedProfile;
  // Each user's profile must be its OWN cell, but it must stay SPACE-scoped:
  // the cell is shared through the registry and through message
  // `authorProfile` links, and a user/session-scoped instance is isolated by
  // reader (docs/specs/scoped-cell-instances.md) — other participants would
  // dereference it to their own empty instance and see "Unnamed user".
  // Distinctness per user comes from creation, not scope: the cell is minted
  // on each user's FIRST save (per-invocation cause) and remembered in the
  // PerUser `myProfile` pointer, so later saves update the same entity. (The
  // earlier `Writable.for("profile")` variant used a constant cause, which
  // collapsed every user onto one shared entity and broke authorship
  // verification.)
  const profile = currentProfileCell(myProfile) ??
    Writable.perSpace.of<TrustedProfile>(nextSnapshot);
  profile.set(nextSnapshot);
  myProfile.set({ profile });
  registerProfile(profiles, profile);
  return { trimmedName, profile };
};

export const prepareTrustedMessageSend = (
  myProfile: MyProfileCell,
  rawBody: string,
): {
  trimmedBody: string | null;
  message: TrustedSentChatMessage | null;
} => {
  const profileValue = currentProfileSnapshot(myProfile);
  const trimmedBody = rawBody.trim();
  if (!profileValue || !trimmedBody) {
    return {
      trimmedBody: null,
      message: null,
    };
  }
  const profileCell = currentProfileCell(myProfile);
  if (!profileCell) {
    return {
      trimmedBody: null,
      message: null,
    };
  }

  return {
    trimmedBody,
    message: createSentMessageSnapshot(
      profileCell,
      profileValue,
      trimmedBody,
    ) as TrustedSentChatMessage,
  };
};

export const applyTrustedMessageSend = (
  messages: readonly SharedChatMessage[],
  myProfile: MyProfileCell,
  rawBody: string,
): {
  trimmedBody: string | null;
  nextMessages: SharedChatMessage[];
} => {
  const messageList = Array.from(messages);
  const { trimmedBody, message } = prepareTrustedMessageSend(
    myProfile,
    rawBody,
  );
  if (!trimmedBody || !message) {
    return {
      trimmedBody: null,
      nextMessages: messageList,
    };
  }

  return {
    trimmedBody,
    nextMessages: [
      ...messageList,
      message,
    ],
  };
};

export const prepareTrustedRoomAdd = (
  currentAdminRole: ChatAdminRole | undefined,
  rawName: string,
): {
  trimmedName: string | null;
  room: TrustedChatRoom | null;
} => {
  const trimmedName = rawName.trim();
  // This read supplies the admin integrity required by the shared rooms write.
  if (currentAdminRole === undefined || !trimmedName) {
    return {
      trimmedName: null,
      room: null,
    };
  }

  return {
    trimmedName,
    room: createRoomSnapshot<SharedChatMessage>(
      trimmedName,
    ) as TrustedChatRoom,
  };
};

export const commitTrustedProfileSave = handler<
  SubmittedTextEvent,
  {
    myProfile: MyProfileCell;
    profiles: SharedProfilesCell;
  }
>((event, { myProfile, profiles }) => {
  applyTrustedProfileSave(myProfile, profiles, submittedText(event));
});
type TrustedProfileSaveInput = Parameters<typeof commitTrustedProfileSave>[0];

export const commitTrustedMessageSend = handler<
  SubmittedTextEvent,
  {
    myProfile: MyProfileCell;
    messages: SharedMessagesCell;
  }
>((event, { myProfile, messages }) => {
  const { trimmedBody, message } = prepareTrustedMessageSend(
    myProfile,
    submittedText(event),
  );
  if (!trimmedBody || !message) {
    return;
  }

  messages.push(message);
});
type TrustedMessageSendInput = Parameters<typeof commitTrustedMessageSend>[0];

export interface TrustedAdminPolicyEvent {
  readonly type?: string;
  readonly name?: string;
  readonly target?: {
    readonly name?: string;
    readonly value?: string;
    readonly dataset?: {
      readonly adminName?: string;
    };
  };
  readonly everyoneIsAdmin?: boolean;
  readonly detail?: {
    readonly checked?: boolean;
  };
}

interface TrustedAdminPolicyChange {
  readonly admins?: ChatAdminRole[];
  readonly bootstrapAdmin?: ChatAdminRole;
  readonly everyoneIsAdmin?: boolean;
}

export const prepareTrustedAdminToggle = (
  currentAdminRole: ChatAdminRole | undefined,
  adminRegistry: ChatAdminRegistryCell,
  participant: AdminParticipantRow | undefined,
  myProfile?: MyProfileCell,
  nextEveryoneIsAdmin?: boolean,
): TrustedAdminPolicyChange | null => {
  if (currentAdminRole === undefined) {
    return null;
  }

  const adminRoles = chatAdminRolesValue(adminRegistry);
  if (nextEveryoneIsAdmin !== undefined) {
    if (nextEveryoneIsAdmin) {
      return {
        everyoneIsAdmin: true,
      };
    }

    const currentProfile = myProfile === undefined
      ? undefined
      : currentProfileCell(myProfile);
    const currentName = myProfile === undefined
      ? undefined
      : currentProfileSnapshot(myProfile)?.name;
    const bootstrapAdmin =
      adminRoles.length === 0 && currentProfile !== undefined &&
        currentName
        ? {
          subject: currentProfile,
          displayName: currentName,
        } as ChatAdminRole
        : undefined;
    if (adminRoles.length === 0 && bootstrapAdmin === undefined) {
      return null;
    }
    return {
      ...(adminRoles.length > 0 ? { admins: adminRoles } : {}),
      ...(bootstrapAdmin !== undefined ? { bootstrapAdmin } : {}),
      everyoneIsAdmin: false,
    };
  }

  if (chatAdminEveryoneIsAdmin(adminRegistry)) {
    return null;
  }

  const targetProfile = participant?.profile ?? (
    myProfile === undefined ? undefined : currentProfileCell(myProfile)
  );
  const targetName = participant?.name ??
    (myProfile === undefined ? undefined : currentProfileSnapshot(myProfile)
      ?.name);
  if (
    targetProfile === undefined ||
    !targetName
  ) {
    return null;
  }

  const withoutParticipant = adminRoles.filter((role) =>
    !equals(role.subject, targetProfile)
  );
  if (withoutParticipant.length !== adminRoles.length) {
    if (withoutParticipant.length === 0) {
      return null;
    }
    return {
      admins: withoutParticipant,
    };
  }

  return {
    admins: [
      ...withoutParticipant,
      {
        subject: targetProfile,
        displayName: targetName,
      } as ChatAdminRole,
    ],
  };
};

export const commitTrustedAdminToggle = handler<
  TrustedAdminPolicyEvent,
  {
    profiles: SharedProfilesCell;
    myProfile: MyProfileCell;
    messages: SharedMessagesCell;
    adminRegistry: ChatAdminRegistryCell;
    participant?: AdminParticipantRow;
  }
>((
  event,
  { profiles, myProfile, messages, adminRegistry, participant },
) => {
  const eventName = nonEmptyEventName(event?.name) ??
    nonEmptyEventName(event?.target?.dataset?.adminName) ??
    nonEmptyEventName(event?.target?.name);
  const eventParticipant = eventName === undefined
    ? undefined
    : adminParticipantRowsValue(
      profiles,
      myProfile,
      messages,
      adminRegistry,
    ).find((row) => row.name === eventName);
  const nextEveryoneIsAdmin = event?.everyoneIsAdmin ??
    event?.detail?.checked ??
    (participant === undefined &&
        eventName === undefined &&
        (event as { type?: string } | undefined)?.type === "click"
      ? !chatAdminEveryoneIsAdmin(adminRegistry)
      : undefined);
  const nextPolicy = prepareTrustedAdminToggle(
    currentUserAdminRole(myProfile, adminRegistry),
    adminRegistry,
    participant ?? eventParticipant,
    myProfile,
    nextEveryoneIsAdmin,
  );
  if (nextPolicy === null) {
    return;
  }

  if (
    nextPolicy.bootstrapAdmin !== undefined ||
    nextPolicy.everyoneIsAdmin !== undefined
  ) {
    const currentRegistry = adminRegistry.get() as
      | ChatAdminRegistryStoredValue
      | undefined;
    adminRegistry.set({
      ...(currentRegistry?.admins !== undefined
        ? { admins: currentRegistry.admins }
        : {}),
      ...(currentRegistry?.bootstrapAdmin !== undefined
        ? { bootstrapAdmin: currentRegistry.bootstrapAdmin }
        : {}),
      ...(currentRegistry?.everyoneIsAdmin !== undefined
        ? { everyoneIsAdmin: currentRegistry.everyoneIsAdmin }
        : {}),
      ...(nextPolicy.admins !== undefined
        ? { admins: nextPolicy.admins as ChatAdminList }
        : {}),
      ...(nextPolicy.bootstrapAdmin !== undefined
        ? {
          bootstrapAdmin: nextPolicy.bootstrapAdmin as ChatAdminBootstrapRole,
        }
        : {}),
      ...(nextPolicy.everyoneIsAdmin !== undefined
        ? {
          everyoneIsAdmin: nextPolicy.everyoneIsAdmin as ChatEveryoneAdminFlag,
        }
        : {}),
    });
    return;
  }

  if (nextPolicy.admins !== undefined) {
    adminRegistry.key("admins").set(nextPolicy.admins as ChatAdminList);
  }
});
type TrustedAdminToggleInput = Parameters<typeof commitTrustedAdminToggle>[0];

export const commitTrustedRoomAdd = handler<
  SubmittedTextEvent,
  {
    myProfile: MyProfileCell;
    adminRegistry: ChatAdminRegistryCell;
    rooms: SharedRoomsCell;
  }
>((event, { myProfile, adminRegistry, rooms }) => {
  const { trimmedName, room } = prepareTrustedRoomAdd(
    currentUserAdminRole(myProfile, adminRegistry),
    submittedText(event),
  );
  if (!trimmedName || !room) {
    return;
  }

  const nextRooms = [...roomsValue(rooms), room];
  rooms.set({ list: nextRooms as SharedRoomList });
});
type TrustedRoomAddInput = Parameters<typeof commitTrustedRoomAdd>[0];

interface TrustedParticipantsPanelInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  id: string;
}

const TrustedParticipantsPanel = pattern<
  TrustedParticipantsPanelInput,
  { [NAME]: string; [UI]: any }
>((
  { profiles, myProfile, messages, id }: TrustedParticipantsPanelInput,
): { [NAME]: string; [UI]: any } => ({
  [NAME]: computed(() => `${id} participants panel`),
  [UI]: (
    <cf-hstack id={id} gap="2" wrap>
      <cf-chip
        label={computed(() =>
          participantSummary(profiles, myProfile, messages)
        )}
        variant="accent"
      />
    </cf-hstack>
  ),
}));
type TrustedParticipantsPanelInputArg = Parameters<
  typeof TrustedParticipantsPanel
>[0];

export interface TrustedProfileSaveSurfaceInput {
  myProfile: MyProfileCell;
  profiles: SharedProfilesCell;
}

export interface TrustedProfileSaveSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: MyProfileCell;
  currentProfileName: string;
  saveProfile: Stream<SubmittedTextEvent>;
}

export const TrustedProfileSaveSurface = pattern<
  TrustedProfileSaveSurfaceInput,
  TrustedProfileSaveSurfaceOutput
>((
  {
    myProfile,
    profiles,
  }: TrustedProfileSaveSurfaceInput,
): TrustedProfileSaveSurfaceOutput => {
  const saveProfile = commitTrustedProfileSave({
    myProfile,
    profiles,
  } as TrustedProfileSaveInput);
  const currentSavedName = computed(() =>
    currentProfileSnapshot(myProfile)?.name ?? "Name not set"
  );

  return {
    [NAME]: "profile save",
    [UI]: (
      <cf-card
        id="trusted-profile-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_PROFILE_SURFACE}
      >
        <cf-hstack slot="content" gap="2" align="center" wrap>
          <cf-submit-input
            id="trusted-profile-save"
            inputId="trusted-profile-name"
            data-ui-action={TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION}
            placeholder="Set your name"
            buttonText="Save name"
            style={{ minWidth: "16rem", flex: "1 1 16rem" }}
            onClick={saveProfile}
          />
          <cf-label id="trusted-profile-status">
            {currentSavedName}
          </cf-label>
        </cf-hstack>
      </cf-card>
    ),
    myProfile,
    currentProfileName: currentSavedName,
    saveProfile,
  };
});

export interface TrustedAdminPanelInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  adminRegistry: ChatAdminRegistryCell;
}

export interface TrustedAdminPanelOutput {
  [NAME]: string;
  [UI]: any;
  adminRegistry: ChatAdminRegistryCell;
  toggleCurrentUserAdmin: Stream<TrustedAdminPolicyEvent>;
  toggleParticipantAdmin: Stream<TrustedAdminPolicyEvent>;
  toggleEveryoneAdmin: Stream<TrustedAdminPolicyEvent>;
}

export const TrustedAdminPanel = pattern<
  TrustedAdminPanelInput,
  TrustedAdminPanelOutput
>((
  {
    profiles,
    myProfile,
    messages,
    adminRegistry,
  }: TrustedAdminPanelInput,
): TrustedAdminPanelOutput => {
  const toggleAdminPolicy = commitTrustedAdminToggle({
    profiles,
    myProfile,
    messages,
    adminRegistry,
  } as TrustedAdminToggleInput);
  const managerStatus = computed(() =>
    currentProfileSnapshot(myProfile) === undefined
      ? "Save a profile to manage admins"
      : chatAdminEveryoneIsAdmin(adminRegistry)
      ? "Everyone can add rooms"
      : currentUserCanManageAdmins(myProfile, adminRegistry)
      ? "Admin registry editing enabled"
      : "Only admins can edit"
  );
  const everyoneIsAdmin = computed(() =>
    chatAdminEveryoneIsAdmin(adminRegistry)
  );

  return {
    [NAME]: "admin registry",
    [UI]: (
      <cf-card
        id="trusted-admin-panel"
        data-ui-pattern={TRUSTED_GROUP_CHAT_ADMIN_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_ADMIN_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-hstack justify="between" align="center" wrap gap="2">
            <cf-vstack gap="1">
              <cf-heading level={3}>Users</cf-heading>
              <cf-label>
                Admin registry. Current admins can change who may add rooms.
              </cf-label>
            </cf-vstack>
            <cf-chip
              id="trusted-admin-manager-panel-status"
              label={managerStatus}
            />
          </cf-hstack>
          <cf-checkbox
            id="trusted-everyone-admin-checkbox"
            data-ui-action={TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION}
            checked={everyoneIsAdmin}
            disabled={computed(() =>
              !currentUserCanManageAdmins(myProfile, adminRegistry)
            )}
            onClick={toggleAdminPolicy}
          >
            Everyone is admin
          </cf-checkbox>

          <cf-vstack id="trusted-admin-user-list" gap="2">
            {profiles.map((entry) => {
              const profile = entry.profile;
              const name = computed(() =>
                profile.get()?.name ?? "Unnamed user"
              );
              const accentColor = computed(() =>
                profile.get()?.accentColor ?? "#64748b"
              );
              const everyoneForProfile = computed(() =>
                chatAdminEveryoneIsAdmin(adminRegistry)
              );
              const isAdmin = computed(() =>
                everyoneForProfile ||
                subjectHasAdminRole(chatAdminRolesValue(adminRegistry), profile)
              );
              const canManageAdmins = computed(() =>
                currentUserCanManageAdmins(myProfile, adminRegistry)
              );
              const participant = {
                name,
                accentColor,
                profile,
                isAdmin,
                everyoneIsAdmin: everyoneForProfile,
                canManageAdmins,
              } as AdminParticipantRow;
              const toggleDisabled = computed(() =>
                !participant.canManageAdmins || participant.everyoneIsAdmin
              );
              const toggleLabel = computed(() =>
                participant.everyoneIsAdmin
                  ? "Admin via everyone"
                  : participant.isAdmin
                  ? "Remove admin"
                  : "Make admin"
              );
              return (
                <cf-hstack
                  align="center"
                  justify="between"
                  gap="2"
                  wrap
                  style={{
                    padding: "0.5rem 0.75rem",
                    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
                    borderRadius: "0.75rem",
                  }}
                >
                  <cf-hstack align="center" gap="2">
                    <span
                      style={{
                        width: "0.75rem",
                        height: "0.75rem",
                        borderRadius: "9999px",
                        background: participant.accentColor,
                      }}
                    />
                    <cf-label>{participant.name}</cf-label>
                    <cf-chip
                      label={participant.isAdmin ? "Admin" : "Member"}
                      variant={participant.isAdmin ? "accent" : "default"}
                    />
                  </cf-hstack>
                  <cf-button
                    data-ui-control="admin-user-toggle"
                    data-ui-action={TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION}
                    data-admin-name={participant.name}
                    size="sm"
                    disabled={toggleDisabled}
                    onClick={toggleAdminPolicy}
                  >
                    {toggleLabel}
                  </cf-button>
                </cf-hstack>
              );
            })}
          </cf-vstack>
        </cf-vstack>
      </cf-card>
    ),
    adminRegistry,
    toggleCurrentUserAdmin: toggleAdminPolicy,
    toggleParticipantAdmin: toggleAdminPolicy,
    toggleEveryoneAdmin: toggleAdminPolicy,
  };
});

export interface TrustedChatSendSurfaceInput {
  profiles: SharedProfilesCell;
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
}

export interface TrustedChatSendSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  messages: SharedMessagesCell;
  sendMessage: Stream<SubmittedTextEvent>;
}

export const TrustedChatSendSurface = pattern<
  TrustedChatSendSurfaceInput,
  TrustedChatSendSurfaceOutput
>((
  { profiles, myProfile, messages }: TrustedChatSendSurfaceInput,
): TrustedChatSendSurfaceOutput => {
  const sendDisabled = computed(() =>
    currentProfileSnapshot(myProfile) === undefined
  );
  const sendMessage = commitTrustedMessageSend({
    myProfile,
    messages,
  } as TrustedMessageSendInput);

  return {
    [NAME]: "send surface",
    [UI]: (
      <cf-card
        id="trusted-send-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_SEND_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_SEND_SURFACE}
      >
        <cf-vstack slot="content" gap="2">
          {TrustedParticipantsPanel({
            profiles,
            myProfile,
            messages,
            id: "trusted-participants-panel",
          } as TrustedParticipantsPanelInputArg)}
          <cf-submit-input
            id="trusted-send-button"
            inputId="trusted-message-draft"
            data-ui-action={TRUSTED_GROUP_CHAT_SEND_ACTION}
            placeholder="Write a message"
            buttonText="Send"
            disabled={sendDisabled}
            onClick={sendMessage}
          />
        </cf-vstack>
      </cf-card>
    ),
    messages,
    sendMessage,
  };
});

export interface TrustedRoomAddSurfaceInput {
  myProfile: MyProfileCell;
  adminRegistry: ChatAdminRegistryCell;
  rooms: SharedRoomsCell;
}

export interface TrustedRoomAddSurfaceOutput {
  [NAME]: string;
  [UI]: any;
  rooms: SharedRoomsCell;
  addRoom: Stream<SubmittedTextEvent>;
}

export const TrustedRoomAddSurface = pattern<
  TrustedRoomAddSurfaceInput,
  TrustedRoomAddSurfaceOutput
>((
  {
    myProfile,
    adminRegistry,
    rooms,
  }: TrustedRoomAddSurfaceInput,
): TrustedRoomAddSurfaceOutput => {
  const addRoom = commitTrustedRoomAdd({
    myProfile,
    adminRegistry,
    rooms,
  } as TrustedRoomAddInput);
  const addDisabled = computed(() =>
    !currentUserIsAdmin(myProfile, adminRegistry)
  );

  return {
    [NAME]: "room add surface",
    [UI]: (
      <cf-card
        id="trusted-room-surface"
        data-ui-pattern={TRUSTED_GROUP_CHAT_ROOM_SURFACE}
        data-ui-event-integrity={TRUSTED_GROUP_CHAT_ROOM_SURFACE}
      >
        <cf-hstack slot="content" gap="2" align="center" wrap>
          <cf-submit-input
            id="trusted-room-add-button"
            inputId="trusted-room-name"
            data-ui-action={TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION}
            placeholder="Add a room"
            buttonText="Add room"
            disabled={addDisabled}
            style={{ minWidth: "16rem", flex: "1 1 16rem" }}
            onClick={addRoom}
          />
          <cf-label id="trusted-room-admin-hint">
            {computed(() =>
              currentUserIsAdmin(myProfile, adminRegistry)
                ? "Admins can add rooms"
                : "Ask an admin manager to make you an admin"
            )}
          </cf-label>
        </cf-hstack>
      </cf-card>
    ),
    rooms,
    addRoom,
  };
});

export type ParticipantClaimValue = ParticipantClaim<AuthorProfileCell>;
export type AnyPlainChatMessage = PlainChatMessage<AuthorProfileCell>;
