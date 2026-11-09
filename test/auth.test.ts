import test from "node:test";
import assert from "node:assert/strict";
import { authenticate } from "../src/api/auth.js";
const config = {
  issuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example",
  clientId: "dntclient",
  agentRoles: ["arn:aws:iam::123456789012:role/agents/dnt"],
};
const claims = {
  iss: config.issuer,
  client_id: config.clientId,
  token_use: "access",
  sub: "stable-subject",
  exp: Date.now() / 1000 + 300,
};
const jwt = (overrides = {}) => ({
  rawPath: "/api/v1/me",
  requestContext: {
    authorizer: { jwt: { claims: { ...claims, ...overrides } } },
  },
});
test("Cognito identity requires an access token for the configured issuer and client", () => {
  assert.equal(authenticate(jwt(), config), "cognito:stable-subject");
  for (const overrides of [
    { token_use: "id" },
    { iss: "wrong" },
    { client_id: "another-app" },
    { exp: 0 },
    { exp: "bad" },
    { sub: "" },
  ])
    assert.throws(() => authenticate(jwt(overrides), config));
  assert.throws(() =>
    authenticate(
      { rawPath: "/api/v1/me", headers: { "x-principal": "cognito:operator" } },
      config,
    ),
  );
});
test("IAM role sessions map to registered canonical role ARNs without trusting headers", () => {
  const event = (userArn: string) => ({
    rawPath: "/agent/v1/me",
    requestContext: { authorizer: { iam: { userArn } } },
  });
  assert.equal(
    authenticate(
      event("arn:aws:sts::123456789012:assumed-role/dnt/session"),
      config,
    ),
    "iam:arn:aws:iam::123456789012:role/agents/dnt",
  );
  assert.equal(
    authenticate(event("arn:aws:iam::123456789012:user/operator"), config),
    "iam:arn:aws:iam::123456789012:user/operator",
  );
  assert.throws(() =>
    authenticate(
      event("arn:aws:sts::999999999999:assumed-role/dnt/session"),
      config,
    ),
  );
  assert.throws(() =>
    authenticate(
      event("arn:aws:sts::123456789012:assumed-role/other/session"),
      config,
    ),
  );
  assert.throws(() =>
    authenticate({ ...jwt(), rawPath: "/agent/v1/me" }, config),
  );
});
