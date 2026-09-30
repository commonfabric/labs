/**
 * A brand key that no live declaration carries. Schemas from pre-vocabulary
 * compilations name it in `required`, and a stored schema outlives the
 * declaration that put it there, so the `required` presence checks treat this
 * key as satisfied by any `FabricSpecialObject` rather than probing for it
 * with `in`.
 *
 * TODO(danfuzz): Remove this constant, and the exemptions keyed on it, once no
 * stored schema names the key. The schemas that do are compiled programs from
 * a generator that described a `FabricSpecialObject` structurally, as an
 * object schema with this key among its required properties. A pattern update
 * refuses the structural-to-vocabulary transition, so each piece holding such
 * a program takes a deliberate redeploy, or its space retired. After that, a
 * sweep of the stores for the key string -- with `required` as the positive
 * control, so an empty result is known to mean absence -- has to come back
 * empty before the code goes.
 */
export const FABRIC_SPECIAL_OBJECT_BRAND = "@commonfabric/FabricSpecialObject";
