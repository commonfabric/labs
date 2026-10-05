import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertThrows } from "@std/assert";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import {
  buildCfcPolicyArtifactManifest,
  buildCfcPolicySnapshot,
  isExactModulePolicyRef,
  lowerCfcPolicyTemplateRules,
  validateCfcPolicyArtifactManifest,
} from "../src/cfc/policy.ts";

const manifestBody = () => ({
  formatVersion: 1 as const,
  moduleIdentity: "sha256:module",
  symbol: "releaseRules",
  template: {
    templateVersion: 1 as const,
    exchangeRules: [{
      name: "releaseToReviewer",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: { var: "$reviewer" },
          space: { thisPolicyField: "subject" },
          role: "reader",
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$reviewer" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

type MutableRecord = Record<string, unknown>;
const mutableBody = (): MutableRecord =>
  structuredClone(manifestBody()) as unknown as MutableRecord;
const mutableTemplate = (body: MutableRecord): MutableRecord =>
  body.template as MutableRecord;
const mutableRule = (body: MutableRecord): MutableRecord =>
  (mutableTemplate(body).exchangeRules as unknown[])[0] as MutableRecord;

describe("CFC module policy templates", () => {
  it("computes the normative manifest digest and deep-freezes the artifact", () => {
    const body = manifestBody();
    const artifact = buildCfcPolicyArtifactManifest(body);
    expect(artifact.policyDigest).toBe(hashStringOf({
      domain: "cfc/policy-manifest/v1",
      manifest: body,
    }));
    expect(artifact.manifest).toEqual(body);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.manifest)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.template)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.template.exchangeRules[0])).toBe(
      true,
    );
  });

  it("is insensitive to authored object-key order", () => {
    const a = buildCfcPolicyArtifactManifest(manifestBody());
    const source = manifestBody();
    const b = buildCfcPolicyArtifactManifest({
      symbol: source.symbol,
      template: {
        integrityRequirements: source.template.integrityRequirements,
        dependencies: source.template.dependencies,
        exchangeRules: source.template.exchangeRules,
        templateVersion: source.template.templateVersion,
      },
      moduleIdentity: source.moduleIdentity,
      formatVersion: source.formatVersion,
    });
    expect(b.policyDigest).toBe(a.policyDigest);
  });

  it("validates a transported envelope and rejects digest tampering", () => {
    const artifact = buildCfcPolicyArtifactManifest(manifestBody());
    expect(validateCfcPolicyArtifactManifest(artifact)).toEqual(artifact);
    expect(() =>
      validateCfcPolicyArtifactManifest({
        ...artifact,
        policyDigest: "sha256:wrong",
      })
    ).toThrow(/policyDigest mismatch/);
  });

  it("hands back an artifact it validated without validating it again", () => {
    // A fresh, equal envelope is rebuilt; the rebuilt artifact, frozen as
    // validation returns it, comes back as itself.
    const artifact = buildCfcPolicyArtifactManifest(manifestBody());
    const transported = JSON.parse(JSON.stringify(artifact));
    const validated = validateCfcPolicyArtifactManifest(transported);
    expect(validated).not.toBe(transported);
    expect(Object.isFrozen(validated.manifest.template)).toBe(true);
    expect(validateCfcPolicyArtifactManifest(validated)).toBe(validated);
  });

  it("rejects unsupported versions, unknown keys, and duplicate rule names", () => {
    expect(() =>
      buildCfcPolicyArtifactManifest({
        ...manifestBody(),
        formatVersion: 2,
      } as never)
    ).toThrow(/formatVersion must be 1/);
    expect(() =>
      buildCfcPolicyArtifactManifest({
        ...manifestBody(),
        extra: true,
      } as never)
    ).toThrow(/unknown key "extra"/);
    const duplicate = manifestBody();
    duplicate.template.exchangeRules.push(
      duplicate.template.exchangeRules[0],
    );
    expect(() => buildCfcPolicyArtifactManifest(duplicate)).toThrow(
      /duplicate rule name/,
    );
  });

  it("rejects general rules without integrity or policy-state evidence", () => {
    const body = manifestBody();
    body.template.exchangeRules[0] = {
      ...body.template.exchangeRules[0],
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [],
      },
    } as never;
    expect(() => buildCfcPolicyArtifactManifest(body)).toThrow(
      /integrity or policyState guard/,
    );
  });

  it("rejects postcondition variables unbound by the target or guards", () => {
    const body = manifestBody();
    body.template.exchangeRules[0] = {
      ...body.template.exchangeRules[0],
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$unbound" },
        }],
        integrity: [],
      },
    };
    expect(() => buildCfcPolicyArtifactManifest(body)).toThrow(
      /unbound postcondition variable "\$unbound"/,
    );
  });

  it("validates every portable template field and nested pattern", () => {
    const rich = mutableBody();
    const template = mutableTemplate(rich);
    const rule = mutableRule(rich);
    template.dependencies = {
      authorityOnly: ["did:key:authority"],
      dataBearing: ["of:data"],
    };
    template.integrityRequirements = {
      read: [{
        type: "ReadEvidence",
        delegates: [{ var: "$reviewer" }],
      }],
      write: [{ type: "WriteEvidence" }],
      share: [{ type: "ShareEvidence" }],
    };
    rule.guard = {
      policyState: [{ kind: "approved", reviewer: { var: "$reviewer" } }],
    };
    rule.preConfScope = "anywhere";
    expect(buildCfcPolicyArtifactManifest(rich as never).manifest.template)
      .toEqual(template);
    expect(
      lowerCfcPolicyTemplateRules(
        buildCfcPolicyArtifactManifest(rich as never).manifest.template,
      )[0],
    ).toMatchObject({
      id: "releaseToReviewer",
      preConfScope: "anywhere",
      preCondition: {
        policyState: [{ kind: "approved", reviewer: { var: "$reviewer" } }],
      },
    });

    const invalid: Array<[RegExp, () => unknown]> = [
      [/manifest body must be an object/, () => null],
      [
        /moduleIdentity must be/,
        () => ({ ...manifestBody(), moduleIdentity: "" }),
      ],
      [/symbol must be/, () => ({ ...manifestBody(), symbol: "" })],
      [
        /template must be an object/,
        () => ({ ...manifestBody(), template: null }),
      ],
      [
        /templateVersion must be 1/,
        () => {
          const body = mutableBody();
          mutableTemplate(body).templateVersion = 2;
          return body;
        },
      ],
      [
        /exchangeRules must be an array/,
        () => {
          const body = mutableBody();
          mutableTemplate(body).exchangeRules = "rules";
          return body;
        },
      ],
      [
        /module policy rule must be an object/,
        () => {
          const body = mutableBody();
          mutableTemplate(body).exchangeRules = [null];
          return body;
        },
      ],
      [
        /unknown key "extra"/,
        () => {
          const body = mutableBody();
          mutableRule(body).extra = true;
          return body;
        },
      ],
      [
        /rule needs a name/,
        () => {
          const body = mutableBody();
          mutableRule(body).name = "";
          return body;
        },
      ],
      [
        /needs a preCondition/,
        () => {
          const body = mutableBody();
          mutableRule(body).preCondition = null;
          return body;
        },
      ],
      [
        /preCondition.*unknown key|unknown key.*preCondition/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).extra = true;
          return body;
        },
      ],
      [
        /confidentiality must be an array/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).confidentiality =
            true;
          return body;
        },
      ],
      [
        /must target THIS_POLICY/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).confidentiality =
            [];
          return body;
        },
      ],
      [
        /contains an undefined/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).integrity = [
            undefined,
          ];
          return body;
        },
      ],
      [
        /contains undefined/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).integrity = [{
            type: "Evidence",
            nested: { value: undefined },
          }];
          return body;
        },
      ],
      [
        /malformed variable/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).integrity = [{
            var: "",
          }];
          return body;
        },
      ],
      [
        /invalid THIS_POLICY in/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).integrity = [{
            thisPolicy: true,
          }];
          return body;
        },
      ],
      [
        /invalid THIS_POLICY field/,
        () => {
          const body = mutableBody();
          (mutableRule(body).preCondition as MutableRecord).integrity = [{
            thisPolicyField: "other",
          }];
          return body;
        },
      ],
      [
        /preConfScope must be/,
        () => {
          const body = mutableBody();
          mutableRule(body).preConfScope = "invalid";
          return body;
        },
      ],
      [
        /needs a postCondition/,
        () => {
          const body = mutableBody();
          mutableRule(body).postCondition = null;
          return body;
        },
      ],
      [
        /postCondition.*unknown key|unknown key.*postCondition/,
        () => {
          const body = mutableBody();
          (mutableRule(body).postCondition as MutableRecord).extra = true;
          return body;
        },
      ],
      [
        /cannot mint integrity/,
        () => {
          const body = mutableBody();
          (mutableRule(body).postCondition as MutableRecord).integrity = [{
            type: "Minted",
          }];
          return body;
        },
      ],
      [
        /guard must be an object/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = true;
          return body;
        },
      ],
      [
        /guard.*unknown key|unknown key.*guard/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = {
            policyState: [{ kind: "ok" }],
            extra: true,
          };
          return body;
        },
      ],
      [
        /must be an array/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = { policyState: true };
          return body;
        },
      ],
      [
        /must name at least one/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = { policyState: [] };
          return body;
        },
      ],
      [
        /grant-pattern records/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = { policyState: [1] };
          return body;
        },
      ],
      [
        /concrete non-empty string kind/,
        () => {
          const body = mutableBody();
          mutableRule(body).guard = { policyState: [{ kind: "" }] };
          return body;
        },
      ],
      [
        /dependencies must be an object/,
        () => {
          const body = mutableBody();
          mutableTemplate(body).dependencies = null;
          return body;
        },
      ],
      [
        /template dependencies.*unknown key|unknown key.*template dependencies/,
        () => {
          const body = mutableBody();
          (mutableTemplate(body).dependencies as MutableRecord).extra = true;
          return body;
        },
      ],
      [
        /authorityOnly must be a string array/,
        () => {
          const body = mutableBody();
          (mutableTemplate(body).dependencies as MutableRecord).authorityOnly =
            [1];
          return body;
        },
      ],
      [
        /integrityRequirements must be an object/,
        () => {
          const body = mutableBody();
          mutableTemplate(body).integrityRequirements = null;
          return body;
        },
      ],
      [
        /integrityRequirements.*unknown key|unknown key.*integrityRequirements/,
        () => {
          const body = mutableBody();
          (mutableTemplate(body).integrityRequirements as MutableRecord).extra =
            true;
          return body;
        },
      ],
      [
        /integrityRequirements.read must be an array/,
        () => {
          const body = mutableBody();
          (mutableTemplate(body).integrityRequirements as MutableRecord).read =
            true;
          return body;
        },
      ],
    ];

    for (const [message, create] of invalid) {
      const error = assertThrows(
        () => buildCfcPolicyArtifactManifest(create() as never),
        Error,
      );
      if (!message.test(error.message)) {
        throw new Error(`${message}: ${error.message}`);
      }
    }
  });

  it("rejects malformed transported manifest envelopes", () => {
    const artifact = buildCfcPolicyArtifactManifest(manifestBody());
    expect(() => validateCfcPolicyArtifactManifest(null)).toThrow(
      "envelope must be an object",
    );
    expect(() =>
      validateCfcPolicyArtifactManifest({ ...artifact, extra: true })
    ).toThrow('unknown key "extra"');
    expect(() =>
      validateCfcPolicyArtifactManifest({ ...artifact, policyDigest: "" })
    ).toThrow("policyDigest must be a non-empty string");
  });

  it("keeps legacy deployment-record digest bytes unchanged", () => {
    const input = [{
      id: "legacy",
      selection: "referenced" as const,
      rules: [{
        id: "release",
        appliesTo: { type: CFC_ATOM_TYPE.Space, id: "space:a" },
        preCondition: {
          integrity: [{
            type: CFC_ATOM_TYPE.HasRole,
            principal: "did:key:alice",
            space: "space:a",
            role: "reader",
          }],
        },
        post: {
          addAlternatives: [{
            type: CFC_ATOM_TYPE.User,
            subject: "did:key:alice",
          }],
        },
      }],
    }];
    const before = buildCfcPolicySnapshot(input)!.records[0].digest;
    buildCfcPolicyArtifactManifest(manifestBody());
    expect(buildCfcPolicySnapshot(input)!.records[0].digest).toBe(before);
  });

  it("admits a module policy reference only as six own enumerable fields", () => {
    const fields = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: "sha256:module",
      symbol: "releaseRules",
      policyDigest: "sha256:digest",
      subject: "did:key:z6MkSubject",
    };
    expect(isExactModulePolicyRef({ ...fields })).toBe(true);

    const { subject, ...rest } = fields;
    expect(
      isExactModulePolicyRef(Object.assign(Object.create({ subject }), rest)),
    )
      .toBe(false);
    const hidden = { ...rest };
    Object.defineProperty(hidden, "subject", {
      value: subject,
      enumerable: false,
    });
    expect(isExactModulePolicyRef(hidden)).toBe(false);
    const accessor = { ...rest };
    Object.defineProperty(accessor, "subject", {
      get: () => subject,
      enumerable: true,
    });
    expect(isExactModulePolicyRef(accessor)).toBe(false);
    expect(isExactModulePolicyRef({ ...fields, [Symbol("extra")]: 1 })).toBe(
      false,
    );
  });
});
