import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Identity } from "./tools.js";
export interface LoginIdentity extends Identity {
  username: string;
}
export interface LoginProvider {
  authorizationUrl(state: string, challenge: string, nonce: string): string;
  exchange(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<LoginIdentity>;
  active(identity: LoginIdentity): Promise<boolean>;
}
export class CognitoLogin implements LoginProvider {
  private keys;
  private client = new CognitoIdentityProviderClient({});
  constructor(
    private config: {
      issuer: string;
      clientId: string;
      domain: string;
      callback: string;
      poolId: string;
    },
  ) {
    this.keys = createRemoteJWKSet(
      new URL(`${config.issuer}/.well-known/jwks.json`),
    );
  }
  authorizationUrl(state: string, challenge: string, nonce: string) {
    return `${this.config.domain}/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.callback,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`;
  }
  async exchange(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<LoginIdentity> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: this.config.clientId,
      redirect_uri: this.config.callback,
    }).toString();
    const response = await fetch(`${this.config.domain}/oauth2/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
      },
      body,
    });
    if (!response.ok) throw new Error("CognitoExchangeFailed");
    const tokens = await response.json();
    return verifyCognitoIdentity(
      tokens.id_token,
      this.keys,
      this.config.issuer,
      this.config.clientId,
      nonce,
    );
  }

  async active(identity: LoginIdentity) {
    try {
      const user = await this.client.send(
        new AdminGetUserCommand({
          UserPoolId: this.config.poolId,
          Username: identity.username,
        }),
      );
      return (
        user.Enabled === true &&
        ["CONFIRMED", "EXTERNAL_PROVIDER"].includes(user.UserStatus ?? "") &&
        user.UserAttributes?.find((a) => a.Name === "sub")?.Value ===
          identity.profile.id
      );
    } catch (error: any) {
      if (error.name === "UserNotFoundException") return false;
      throw error;
    }
  }
}

export async function verifyCognitoIdentity(
  token: string,
  keys: JWTVerifyGetKey,
  issuer: string,
  clientId: string,
  nonce: string,
): Promise<LoginIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: issuer,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce"],
  });
  if (
    payload.token_use !== "id" ||
    payload.nonce !== nonce ||
    typeof payload.sub !== "string" ||
    !/^[0-9a-f-]{36}$/.test(payload.sub) ||
    typeof payload["cognito:username"] !== "string"
  )
    throw new Error("InvalidCognitoIdentity");
  // Upstream access/refresh/ID tokens never leave this function or enter storage.
  return {
    principal: `cognito:${payload.sub}`,
    username: payload["cognito:username"],
    scopes: [],
    profile: {
      id: payload.sub,
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(payload.email_verified === true && typeof payload.email === "string"
        ? { email: payload.email }
        : {}),
    },
  };
}
