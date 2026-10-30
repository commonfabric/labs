/**
 * Builder for a Zod schema that is checked at compile time against a model
 * type: a field of the model with no schema entry, or a schema entry naming
 * no field of the model, is a type error rather than a shape that diverges
 * silently at runtime.
 *
 * Vendored via https://github.com/colinhacks/zod/issues/2084
 *
 * Usage:
 *
 * ```
 * export type UserModel = {
 *   id: string
 *   email: string | null
 *   name: string
 *   firstName: string
 *   createdAt: Date
 * }
 *
 * export const UserCreateSchema =
 *   toZod<Omit<UserModel, "createdAt" | "id">>().with({
 *     email: z.string().email().nullable(),
 *     name: z.string(),
 *     firstName: z.string(),
 *   });
 *
 * export type UserCreatePayload = z.infer<typeof UserCreateSchema>
 * ```
 */

import * as z from "zod";

/**
 * The Zod schema shape that `Model` demands: one entry per field, wrapped in
 * `ZodOptional` and `ZodNullable` to match how the field admits `undefined`
 * and `null`.
 */
type Implements<Model> = {
  [key in keyof Model]-?: undefined extends Model[key]
    ? null extends Model[key]
      ? z.ZodNullable<z.ZodOptional<z.ZodType<Model[key]>>>
    : z.ZodOptional<z.ZodType<Model[key]>>
    : null extends Model[key] ? z.ZodNullable<z.ZodType<Model[key]>>
    : z.ZodType<Model[key]>;
};

/**
 * Returns a builder whose `with()` method constructs a `z.object()` from the
 * given schema, accepting it only if it covers `Model` exactly. Written as a
 * two-step call because TypeScript has no way to infer one type argument
 * while pinning another.
 */
export function toZod<Model = never>() {
  return {
    with: <
      Schema extends
        & Implements<Model>
        & {
          [unknownKey in Exclude<keyof Schema, keyof Model>]: never;
        },
    >(
      schema: Schema,
    ) => z.object(schema),
  };
}
