import {
  type AddIntegrity,
  type AnyCell,
  type Default,
  equals,
} from "commonfabric";

export type AdminSubject = AnyCell<any> | object;

export interface AdminRoleAssignment<Subject extends AdminSubject> {
  readonly subject: Subject;
  readonly displayName: string;
}

export type ActiveAdminRole<
  Subject extends AdminSubject,
  Integrity extends string,
> = AddIntegrity<AdminRoleAssignment<Subject>, readonly [Integrity]>;

export interface AdminRegistryStoredValue<Role> {
  readonly admins?: readonly Role[];
  readonly everyoneIsAdmin?: boolean;
}

export type EmptyAdminRegistryValue = Record<PropertyKey, never>;
export type AdminRegistryValue<Role> =
  | AdminRegistryStoredValue<Role>
  | Default<EmptyAdminRegistryValue>;

export const adminRegistryEntries = <Role>(
  registry: {
    get(): AdminRegistryValue<Role> | undefined;
  },
): Role[] =>
  Array.from(
    (registry.get() as AdminRegistryStoredValue<Role> | undefined)
      ?.admins ?? [],
  );

export const adminRegistryEveryoneIsAdmin = <Role>(
  registry: {
    get(): AdminRegistryValue<Role> | undefined;
  },
): boolean => {
  const stored = registry.get() as AdminRegistryStoredValue<Role> | undefined;
  if (stored?.everyoneIsAdmin === false) {
    return false;
  }
  const roles = adminRegistryEntries<Role>(registry);
  if (roles.length === 0) {
    return true;
  }
  return stored?.everyoneIsAdmin === true;
};

export const activeAdminRoleForSubject = <
  Subject extends AdminSubject,
  Role extends AdminRoleAssignment<Subject>,
>(
  roles: readonly Role[],
  subject: Subject | undefined,
): Role | undefined =>
  subject === undefined
    ? undefined
    : roles.find((role) => equals(role.subject, subject));

export const subjectHasAdminRole = <
  Subject extends AdminSubject,
  Role extends AdminRoleAssignment<Subject>,
>(
  roles: readonly Role[],
  subject: Subject | undefined,
): boolean => activeAdminRoleForSubject(roles, subject) !== undefined;
