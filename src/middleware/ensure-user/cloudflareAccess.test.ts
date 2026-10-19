import type * as jose from "jose";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";
import { resolveSharedWorkspaceContext } from "./delegated";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "aud-tag";

const keys = vi.hoisted(() => ({ jwks: null as unknown }));

vi.mock("cloudflare:workers", () => ({
  env: {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "aud-tag",
  },
}));
vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof jose>()),
  createRemoteJWKSet: () => keys.jwks,
}));
vi.mock("./delegated", () => ({ resolveSharedWorkspaceContext: vi.fn() }));

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys.jwks = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(() => {
  vi.mocked(resolveSharedWorkspaceContext).mockResolvedValue({
    userId: "u",
    userEmail: "e",
    emailVerified: true,
    organizationId: "shared-workspace",
    role: "owner",
  });
});

function signAccessToken(payload: JWTPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(POLICY_AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function resolve(payload: JWTPayload) {
  const token = await signAccessToken(payload);
  return resolveCloudflareAccessContext(
    new Headers({ "cf-access-jwt-assertion": token }),
  );
}

describe("resolveCloudflareAccessContext (schil: servicetoken)", () => {
  it("lets a service token through as its own fixed user", async () => {
    await resolve({ sub: "", common_name: "abc123.access" });

    expect(resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "servicetoken-abc123.access",
      "abc123.access@servicetoken.invalid",
    );
  });

  it("still resolves a signed-in person by sub and email", async () => {
    await resolve({ sub: "person-1", email: "donny@repositive.nl" });

    expect(resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "person-1",
      "donny@repositive.nl",
    );
  });

  it("rejects a token with neither a person nor a service token", async () => {
    await expect(resolve({ sub: "" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
