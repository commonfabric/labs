/**
 * The reserved id namespace runtime secrets live in (`runtime-secret.ts`). It
 * is a module of its own so that code which must tell a secret's document from
 * any other, such as the flow-label pass, can do so without importing the
 * module that reads secrets.
 */

/** The reserved id namespace of runtime secrets. */
export const RUNTIME_SECRET_ID_PREFIX = "of:runtime-secret:";

/** Returns whether `id` names a runtime secret. */
export const isRuntimeSecretId = (id: string): boolean =>
  id.startsWith(RUNTIME_SECRET_ID_PREFIX);
