import {
  type FabricValue,
  hashStringOf,
  valueEqual,
} from "@commonfabric/data-model";
import {
  type Cell,
  getDerivedInternalCellLink,
  getMetaLink,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  type IExtendedStorageTransaction,
  isLink,
  type NormalizedFullLink,
  parseLink,
  type Pattern,
  type Runtime,
  systemPatternSource,
} from "@commonfabric/runner";
import {
  loadStoredCfcEnvelope,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import {
  readOwnerFieldPolicy,
  stageOwnerPolicyAdoption,
} from "@commonfabric/runner/cfc/owner-adoption";
import { isObjectOrArray } from "@commonfabric/utils/types";

function address(link: NormalizedFullLink): NormalizedFullLink {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: [...link.path],
  };
}

const PROFILE_SOURCE = systemPatternSource("system/profile-home.tsx");

export interface ProfileNameProtectionInspection {
  status: "protected" | "repairable";
  inspection: string;
  profile: NormalizedFullLink;
  owner: string;
  name: string;
  positions: {
    target: NormalizedFullLink;
    protection: "present" | "missing";
  }[];
}

interface ProfileNamePlan {
  report: ProfileNameProtectionInspection;
  source: NormalizedFullLink;
  missing: { target: NormalizedFullLink; value: FabricValue }[];
}

/** Inspects the supported named-cell chain with all reads on one transaction. */
function readPlan(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  profile: Cell<unknown>,
  pattern: Pattern,
): ProfileNamePlan {
  const piece = profile.withTx(tx);
  const profileLink = address(piece.getAsNormalizedFullLink());
  const identity = getPatternIdentityRef(piece);
  const setup = getPatternSetupIdentityRef(piece);
  if (
    profileLink.path.length !== 0 || profileLink.scope !== "space" ||
    getPatternSource(piece) !== PROFILE_SOURCE || !identity ||
    !valueEqual(identity, setup) ||
    !valueEqual(identity, runtime.patternManager.getArtifactEntryRef(pattern))
  ) {
    throw new Error(
      "Profile repair requires a source-attached profile with completed setup",
    );
  }
  readStoredCfcMetadata(tx, profileLink, { meta: {} });
  const envelope = loadStoredCfcEnvelope(tx, profileLink);
  if (envelope.status !== "loaded") {
    throw new Error("The profile's protection envelope is unavailable");
  }
  const source = { ...profileLink, path: ["name"] };
  const { schema: namePolicy, owner } = readOwnerFieldPolicy(tx, source);
  const { owner: avatarOwner } = readOwnerFieldPolicy(tx, {
    ...profileLink,
    path: ["avatar"],
  });
  const claim = isObjectOrArray(namePolicy)
    ? namePolicy.ifc?.writeAuthorizedBy
    : undefined;
  if (
    owner !== avatarOwner ||
    owner !== tx.getCfcState().trustSnapshot?.actingPrincipal ||
    !isObjectOrArray(claim) || !isObjectOrArray(claim.__ctWriterIdentityOf) ||
    !valueEqual(claim.__ctWriterIdentityOf.path, ["setName"])
  ) {
    throw new Error(
      "Profile repair requires the existing profile owner's setName policy",
    );
  }
  const descriptor = pattern.derivedInternalCells?.find((item) =>
    item.partialCause === "name"
  );
  if (!descriptor) {
    throw new Error("The profile does not have the supported named name cell");
  }
  const projection = tx.readValueOrThrow(source);
  if (!isLink(projection)) {
    throw new Error("The profile name projection is not a supported cell link");
  }
  let target = address(parseLink(projection, source));
  const named = getDerivedInternalCellLink(profile, descriptor);
  if (
    target.id !== named.id || target.space !== named.space ||
    target.path.length !== 0
  ) {
    throw new Error("The profile name points outside its named internal cell");
  }
  const positions: ProfileNameProtectionInspection["positions"] = [];
  const missing: ProfileNamePlan["missing"] = [];
  const evidence: unknown[] = [identity, setup, projection, envelope.metadata];
  let name: string;
  for (let depth = 0;; depth++) {
    if (
      target.space !== profileLink.space || target.scope !== "space" ||
      target.path.length !== 0
    ) {
      throw new Error(
        "The profile name chain leaves its supported space or scope",
      );
    }
    const current = runtime.getCellFromLink(target, undefined, tx);
    const value = tx.readValueOrThrow(target);
    readStoredCfcMetadata(tx, target, { meta: {} });
    const stored = loadStoredCfcEnvelope(tx, target);
    if (stored.status === "unreadable") throw new Error(stored.reason);
    if (stored.status === "loaded") {
      const targetPolicy = readOwnerFieldPolicy(tx, target);
      const policy = isObjectOrArray(targetPolicy.schema)
        ? targetPolicy.schema.ifc
        : undefined;
      if (
        !policy || targetPolicy.owner !== owner ||
        !valueEqual(policy.writeAuthorizedBy, claim)
      ) {
        throw new Error(
          "The name chain has conflicting or incomplete existing protection",
        );
      }
    } else {
      missing.push({ target, value });
    }
    positions.push({
      target,
      protection: stored.status === "loaded" ? "present" : "missing",
    });
    evidence.push(target, value, stored);
    if (typeof value === "string") {
      name = value;
      break;
    }
    const backlink = getMetaLink(current, "result");
    if (
      depth !== 0 || !isLink(value) || !backlink ||
      backlink.id !== profileLink.id ||
      backlink.space !== profileLink.space ||
      backlink.scope !== profileLink.scope || backlink.path.length !== 0
    ) {
      throw new Error("The profile name has an unsupported legacy cell layout");
    }
    target = address(parseLink(value, target));
  }
  const report = {
    status: missing.length === 0 ? "protected" as const : "repairable" as const,
    profile: profileLink,
    owner,
    name,
    positions,
  };
  return {
    report: { ...report, inspection: hashStringOf({ report, evidence }) },
    source,
    missing,
  };
}

async function loadProfilePattern(
  runtime: Runtime,
  profile: Cell<unknown>,
): Promise<Pattern> {
  await profile.sync();
  const identity = getPatternIdentityRef(profile);
  if (!identity) {
    throw new Error("The profile has no retained pattern identity");
  }
  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(identity.identity, profile.space);
  if (!program || !program.main.endsWith("/system/profile-home.tsx")) {
    throw new Error(
      "The verified profile source is unavailable or unsupported",
    );
  }
  const pattern = await runtime.patternManager.loadPatternByIdentity(
    identity.identity,
    identity.symbol,
    profile.space,
    { repairCache: false },
  );
  if (!pattern) throw new Error("The verified profile pattern is unavailable");
  const descriptor = pattern.derivedInternalCells?.find((item) =>
    item.partialCause === "name"
  );
  if (descriptor) {
    const named = runtime.getCellFromLink(
      getDerivedInternalCellLink(profile, descriptor),
    );
    await named.sync();
    const value = named.getRawUntyped();
    if (isLink(value)) {
      await runtime.getCellFromLink(
        parseLink(value, named.getAsNormalizedFullLink()),
      ).sync();
    }
  }
  return pattern;
}

/** Returns an inspection receipt without changing the profile or its cells. */
export async function inspectProfileNameProtection(
  runtime: Runtime,
  profile: Cell<unknown>,
): Promise<ProfileNameProtectionInspection> {
  const pattern = await loadProfilePattern(runtime, profile);
  const tx = runtime.edit();
  try {
    return readPlan(runtime, tx, profile, pattern).report;
  } finally {
    tx.abort();
  }
}

/** Applies exactly the inspected protection, retaining the name and all cell IDs. */
export async function repairProfileNameProtection(
  runtime: Runtime,
  profile: Cell<unknown>,
  expectedInspection: string,
): Promise<ProfileNameProtectionInspection> {
  const pattern = await loadProfilePattern(runtime, profile);
  const tx = runtime.edit();
  try {
    const plan = readPlan(runtime, tx, profile, pattern);
    if (plan.report.inspection !== expectedInspection) {
      throw new Error(
        "The profile changed after inspection; inspect it again before applying",
      );
    }
    if (plan.missing.length === 0) return plan.report;
    for (const { target, value } of plan.missing) {
      stageOwnerPolicyAdoption(tx, plan.source, target, value);
    }
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();
    if (result.error) throw new Error(result.error.message);
    await runtime.storageManager.synced();
    return await inspectProfileNameProtection(runtime, profile.withTx());
  } finally {
    tx.abort();
  }
}
