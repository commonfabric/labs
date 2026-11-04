import { internSchema } from "@commonfabric/data-model-schema";
import { cfcAtom } from "@commonfabric/api/cfc";

const credentialSecretAtom = cfcAtom.resource("CredentialSecret");

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = internSchema(
  {
    type: "object",
    properties: {
      token: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
      tokenType: { type: "string", default: "" },
      scope: { type: "array", items: { type: "string" }, default: [] },
      expiresIn: { type: "number", default: 0 },
      expiresAt: { type: "number", default: 0 },
      refreshToken: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
      user: {
        type: "object",
        properties: {
          email: { type: "string", default: "" },
          name: { type: "string", default: "" },
          picture: { type: "string", default: "" },
        },
      },
    },
  },
);

// More general OAuth2 Token (used by Airtable and future OAuth2 providers)
export const OAuth2TokenSchema = internSchema(
  {
    type: "object",
    properties: {
      accessToken: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
      tokenType: { type: "string", default: "" },
      scope: { type: "array", items: { type: "string" }, default: [] },
      expiresIn: { type: "number", default: 0 },
      expiresAt: { type: "number", default: 0 },
      refreshToken: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
      user: {
        type: "object",
        properties: {
          email: { type: "string", default: "" },
          name: { type: "string", default: "" },
          picture: { type: "string", default: "" },
        },
      },
    },
    required: ["accessToken", "tokenType"],
  },
);

// Webhook confidential config: URL and bearer token written by toolshed
export const WebhookConfigSchema = internSchema(
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
      secret: {
        type: "string",
        default: "",
        ifc: { confidentiality: [credentialSecretAtom] },
      },
    },
    required: ["url", "secret"],
  },
);
