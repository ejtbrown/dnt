import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { CognitoLogin, verifyCognitoIdentity } from "../src/mcp/cognito.js";

const issuer = "https://cognito-idp.us-east-2.amazonaws.com/test_pool",
  clientId = "public-client",
  nonce = "independent-login-nonce";
const sub = "11111111-1111-4111-8111-111111111111";
test("Cognito login uses independent PKCE and verifies signature, issuer, audience, expiry, nonce, and identity claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({
    keys: [{ ...jwk, kid: "test", alg: "RS256" }],
  });
  const claims = {
    sub,
    iss: issuer,
    aud: clientId,
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    token_use: "id",
    "cognito:username": "owner",
    name: "Owner",
    email: "owner@example.com",
    email_verified: true,
  };
  const sign = (patch = {}, key = privateKey) =>
    new SignJWT({ ...claims, ...patch })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(key);
  const identity = await verifyCognitoIdentity(
    await sign(),
    keys,
    issuer,
    clientId,
    nonce,
  );
  assert.deepEqual(identity, {
    principal: `cognito:${sub}`,
    username: "owner",
    scopes: [],
    profile: { id: sub, name: "Owner", email: "owner@example.com" },
  });
  assert.equal(
    (
      await verifyCognitoIdentity(
        await sign({ email_verified: false }),
        keys,
        issuer,
        clientId,
        nonce,
      )
    ).profile.email,
    undefined,
  );
  for (const patch of [
    { iss: "https://evil.example" },
    { aud: "wrong-client" },
    { nonce: "replayed-login" },
    { exp: 1 },
    { token_use: "access" },
    { sub: "not-a-subject" },
    { "cognito:username": null },
  ])
    await assert.rejects(() =>
      sign(patch).then((token) =>
        verifyCognitoIdentity(token, keys, issuer, clientId, nonce),
      ),
    );
  const other = await generateKeyPair("RS256");
  await assert.rejects(() =>
    sign({}, other.privateKey).then((token) =>
      verifyCognitoIdentity(token, keys, issuer, clientId, nonce),
    ),
  );
  const login = new CognitoLogin({
    issuer,
    clientId,
    poolId: "test_pool",
    domain: "https://auth.example.com",
    callback: "https://dnt.example.com/oauth/callback",
  });
  const url = new URL(
    login.authorizationUrl("upstream-state", "upstream-challenge", nonce),
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "upstream-challenge");
  assert.equal(url.searchParams.get("state"), "upstream-state");
  assert.equal(url.searchParams.get("nonce"), nonce);
});
