import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface PermissionDefinitionInput {
  id?: string;
  label?: string;
}

interface RolePermissionInput {
  id?: string;
  label?: string;
  grants?: string[];
}

interface PermissionDefinition {
  id: string;
  label: string;
}

interface RoleDefinition {
  id: string;
  label: string;
  grants: string[];
}

interface TogglePermissionEvent {
  role?: string;
  permission?: string;
  grant?: boolean;
}

interface RoleSummary {
  id: string;
  label: string;
  granted: string[];
  missing: string[];
  enabledCount: number;
  disabledCount: number;
  summary: string;
}

interface PermissionMatrixRow {
  label: string;
  grants: Record<string, boolean>;
}

type PermissionMatrixView = Record<string, PermissionMatrixRow>;

interface UserPermissionMatrixArgs {
  permissions: Default<
    PermissionDefinitionInput[],
    typeof defaultPermissions
  >;
  roles: Default<RolePermissionInput[], typeof defaultRoles>;
}

const defaultPermissions: PermissionDefinition[] = [
  { id: "manageUsers", label: "Manage Users" },
  { id: "editContent", label: "Edit Content" },
  { id: "viewReports", label: "View Reports" },
  { id: "publishContent", label: "Publish Content" },
];

const defaultRoles: RoleDefinition[] = [
  {
    id: "admin",
    label: "Administrator",
    grants: [
      "manageUsers",
      "editContent",
      "viewReports",
      "publishContent",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    grants: [
      "editContent",
      "viewReports",
      "publishContent",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    grants: ["viewReports"],
  },
];

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeKey = (value: unknown, fallback: string): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
        return trimmed;
      }
      const segments = trimmed
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(/\s+/);
      if (segments.length > 0) {
        const [first, ...rest] = segments;
        const normalized = first.toLowerCase() +
          rest
            .map((segment) => {
              const lower = segment.toLowerCase();
              return lower.charAt(0).toUpperCase() + lower.slice(1);
            })
            .join("");
        const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, "");
        if (sanitized.length > 0) {
          return sanitized;
        }
      }
    }
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
};

const ensureUniqueKey = (value: string, used: Set<string>): string => {
  let candidate = value;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${value}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizePermissionList = (
  value: unknown,
): PermissionDefinition[] => {
  const source = Array.isArray(value) ? value : defaultPermissions;
  const sanitized: PermissionDefinition[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const entry = source[index] as PermissionDefinitionInput | undefined;
    const fallback = defaultPermissions[index] ?? defaultPermissions[0];
    const fallbackLabel = sanitizeLabel(
      fallback?.label ?? fallback?.id ?? `Permission ${index + 1}`,
      `Permission ${index + 1}`,
    );
    const keySource = entry?.id ?? entry?.label ?? fallback.id;
    const key = sanitizeKey(keySource, fallback.id);
    if (!key) continue;
    const id = ensureUniqueKey(key, used);
    const label = sanitizeLabel(entry?.label, fallbackLabel);
    sanitized.push({ id, label });
  }
  if (sanitized.length === 0) {
    return defaultPermissions.map((entry) => ({ ...entry }));
  }
  return sanitized;
};

const sanitizeRoleList = (
  value: unknown,
  permissions: readonly PermissionDefinition[],
): RoleDefinition[] => {
  const source = Array.isArray(value) ? value : defaultRoles;
  const sanitized: RoleDefinition[] = [];
  const used = new Set<string>();
  const available = new Set(permissions.map((entry) => entry.id));
  const labels = new Map(
    permissions.map((entry) => [entry.label.toLowerCase(), entry.id]),
  );
  for (let index = 0; index < source.length; index++) {
    const entry = source[index] as RolePermissionInput | undefined;
    const fallback = defaultRoles[index] ?? defaultRoles[0];
    const label = sanitizeLabel(entry?.label, fallback.label);
    const keySource = entry?.id ?? entry?.label ?? fallback.id;
    const key = sanitizeKey(keySource, fallback.id);
    if (!key) continue;
    const id = ensureUniqueKey(key, used);
    const grantSource = Array.isArray(entry?.grants) && entry?.grants.length > 0
      ? entry?.grants
      : fallback.grants;
    const grantSet = new Set<string>();
    for (const raw of grantSource) {
      if (typeof raw !== "string") continue;
      const normalized = sanitizeKey(raw, "");
      if (normalized && available.has(normalized)) {
        grantSet.add(normalized);
        continue;
      }
      const lower = raw.trim().toLowerCase();
      const byLabel = labels.get(lower);
      if (byLabel) {
        grantSet.add(byLabel);
      }
    }
    const grants = permissions
      .map((entry) => entry.id)
      .filter((permissionId) => grantSet.has(permissionId));
    sanitized.push({ id, label, grants });
  }
  if (sanitized.length === 0) {
    return defaultRoles.map((entry) => ({
      id: entry.id,
      label: entry.label,
      grants: permissions
        .map((perm) => perm.id)
        .filter((perm) => entry.grants.includes(perm)),
    }));
  }
  return sanitized;
};

const cloneRoleList = (
  entries: readonly RoleDefinition[],
): RoleDefinition[] => {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    grants: [...entry.grants],
  }));
};

const resolveRoleId = (
  roles: readonly RoleDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const direct = roles.find((role) => role.id === trimmed);
  if (direct) return direct.id;
  const normalized = sanitizeKey(trimmed, "");
  if (normalized) {
    const byKey = roles.find((role) => role.id === normalized);
    if (byKey) return byKey.id;
  }
  const lower = trimmed.toLowerCase();
  const byLabel = roles.find((role) => role.label.toLowerCase() === lower);
  return byLabel?.id ?? null;
};

const resolvePermissionId = (
  permissions: readonly PermissionDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const direct = permissions.find((permission) => permission.id === trimmed);
  if (direct) return direct.id;
  const normalized = sanitizeKey(trimmed, "");
  if (normalized) {
    const byKey = permissions.find((permission) =>
      permission.id === normalized
    );
    if (byKey) return byKey.id;
  }
  const lower = trimmed.toLowerCase();
  const byLabel = permissions.find((permission) =>
    permission.label.toLowerCase() === lower
  );
  return byLabel?.id ?? null;
};

const matrixFromRoles = (
  roles: readonly RoleDefinition[],
  permissions: readonly PermissionDefinition[],
): PermissionMatrixView => {
  const matrix: PermissionMatrixView = {};
  for (const role of roles) {
    const grants: Record<string, boolean> = {};
    for (const permission of permissions) {
      grants[permission.id] = role.grants.includes(permission.id);
    }
    matrix[role.id] = { label: role.label, grants };
  }
  return matrix;
};

const computeRoleSummaries = (
  roles: readonly RoleDefinition[],
  permissions: readonly PermissionDefinition[],
): RoleSummary[] => {
  const order = permissions.map((entry) => entry.id);
  const total = order.length;
  return roles.map((role) => {
    const granted = order.filter((id) => role.grants.includes(id));
    const missing = order.filter((id) => !granted.includes(id));
    const enabledCount = granted.length;
    const disabledCount = total - enabledCount;
    const summary = `${role.label}: ${enabledCount}/${
      Math.max(total, 1)
    } permissions`;
    return {
      id: role.id,
      label: role.label,
      granted,
      missing,
      enabledCount,
      disabledCount,
      summary,
    };
  });
};

const toggleRolePermission = handler(
  (
    event: TogglePermissionEvent | undefined,
    context: {
      assignments: Cell<RoleDefinition[]>;
      baseRoles: Cell<RoleDefinition[]>;
      permissions: Cell<PermissionDefinition[]>;
      history: Cell<string[]>;
    },
  ) => {
    const permissions = context.permissions.get() ?? [];
    if (permissions.length === 0) {
      return;
    }
    const stored = context.assignments.get();
    const base = context.baseRoles.get();
    const current = Array.isArray(stored) && stored.length > 0
      ? cloneRoleList(stored)
      : Array.isArray(base)
      ? cloneRoleList(base)
      : [];
    if (current.length === 0) {
      return;
    }
    const roleId = resolveRoleId(current, event?.role);
    const permissionId = resolvePermissionId(permissions, event?.permission);
    if (!roleId || !permissionId) {
      return;
    }
    const index = current.findIndex((entry) => entry.id === roleId);
    if (index === -1) {
      return;
    }
    const role = current[index];
    const grantSet = new Set(role.grants);
    const desired = typeof event?.grant === "boolean"
      ? event.grant
      : !grantSet.has(permissionId);
    const alreadyGranted = grantSet.has(permissionId);
    if (desired && alreadyGranted) {
      return;
    }
    if (!desired && !alreadyGranted) {
      return;
    }
    if (desired) {
      grantSet.add(permissionId);
    } else {
      grantSet.delete(permissionId);
    }
    const ordered = permissions.map((permission) => permission.id);
    current[index] = {
      id: role.id,
      label: role.label,
      grants: ordered.filter((id) => grantSet.has(id)),
    };
    context.assignments.set(cloneRoleList(current));
    const permission = permissions.find((entry) => entry.id === permissionId);
    const action = desired ? "Granted" : "Revoked";
    const message = `${action} ${
      permission?.label ?? permissionId
    } for ${role.label}`;
    const existing = context.history.get();
    const history = Array.isArray(existing)
      ? [...existing, message]
      : [message];
    context.history.set(history);
  },
);

// Module-scope lift definitions
const liftSanitizePermissionList = lift(sanitizePermissionList);

const liftBaseRoles = lift((input: {
  entries: RolePermissionInput[] | undefined;
  permissionList: PermissionDefinition[];
}) => sanitizeRoleList(input.entries, input.permissionList));

const liftActiveRoles = lift((input: {
  stored: RoleDefinition[];
  base: RoleDefinition[];
}) => {
  const stored = Array.isArray(input.stored) ? input.stored : [];
  if (stored.length > 0) {
    return cloneRoleList(stored);
  }
  return cloneRoleList(input.base);
});

const liftMatrix = lift((input: {
  roleList: RoleDefinition[];
  permissionList: PermissionDefinition[];
}) => matrixFromRoles(input.roleList, input.permissionList));

const liftSummaries = lift((input: {
  roleList: RoleDefinition[];
  permissionList: PermissionDefinition[];
}) => computeRoleSummaries(input.roleList, input.permissionList));

const liftSummaryLabels = lift((entries: RoleSummary[]) =>
  entries.map((entry) => entry.summary)
);

const liftTotalEnabled = lift((entries: RoleSummary[]) =>
  entries.reduce((total, entry) => total + entry.enabledCount, 0)
);

const liftTotalRoles = lift((entries: RoleDefinition[]) => entries.length);

const liftTotalPermissions = lift((entries: PermissionDefinition[]) =>
  entries.length
);

const liftHistoryView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

const liftLastChange = lift((entries: string[] | undefined) => {
  if (Array.isArray(entries) && entries.length > 0) {
    return entries[entries.length - 1];
  }
  return "No changes yet";
});

export const userPermissionMatrix = pattern<UserPermissionMatrixArgs>(
  ({ permissions, roles }) => {
    const permissionsList = liftSanitizePermissionList(permissions);
    const baseRoles = liftBaseRoles({
      entries: roles,
      permissionList: permissionsList,
    });

    const assignmentStore = cell<RoleDefinition[]>([]);
    const changeHistory = cell<string[]>([]);

    const activeRoles = liftActiveRoles({
      stored: assignmentStore,
      base: baseRoles,
    });

    const matrix = liftMatrix({
      roleList: activeRoles,
      permissionList: permissionsList,
    });

    const summaries = liftSummaries({
      roleList: activeRoles,
      permissionList: permissionsList,
    });

    const summaryLabels = liftSummaryLabels(summaries);

    const totalEnabled = liftTotalEnabled(summaries);

    const totalRoles = liftTotalRoles(activeRoles);

    const totalPermissions = liftTotalPermissions(permissionsList);

    const status =
      str`${totalEnabled} grants across ${totalRoles} roles and ${totalPermissions} permissions`;

    const historyView = liftHistoryView(changeHistory);

    const lastChange = liftLastChange(changeHistory);

    return {
      permissions: permissionsList,
      roles: activeRoles,
      matrix,
      summaries,
      summaryLabels,
      totals: {
        enabled: totalEnabled,
        roles: totalRoles,
        permissions: totalPermissions,
      },
      status,
      history: historyView,
      lastChange,
      togglePermission: toggleRolePermission({
        assignments: assignmentStore,
        baseRoles,
        permissions: permissionsList,
        history: changeHistory,
      }),
    };
  },
);

export default userPermissionMatrix;
