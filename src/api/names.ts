import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  type AdminGetUserCommandInput,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
const client = new CognitoIdentityProviderClient({});
// Names are display metadata only. Identity and permissions always use the
// authenticated principal. Cache is bounded and never keyed by client headers.
export class AccountNames {
  private cache = new Map<string, { name: string; expires: number }>();
  constructor(
    private poolId: string,
    private lookup: (
      input: AdminGetUserCommandInput,
    ) => Promise<AdminGetUserCommandOutput> = (input) =>
      client.send(new AdminGetUserCommand(input), {
        abortSignal: AbortSignal.timeout(2000),
      }),
  ) {}
  async resolve(principal: string, username?: string): Promise<string> {
    if (!principal.startsWith("cognito:") || !username) return principal;
    const cached = this.cache.get(principal);
    if (cached && cached.expires > Date.now()) return cached.name;
    try {
      const user = await this.lookup({
        UserPoolId: this.poolId,
        Username: username,
      });
      const attributes = Object.fromEntries(
        (user.UserAttributes ?? []).map((a) => [a.Name!, a.Value]),
      );
      if (`cognito:${attributes.sub}` !== principal) return principal;
      const name =
        attributes.name?.trim() ||
        attributes.preferred_username?.trim() ||
        (attributes.email_verified === "true" ? attributes.email : undefined) ||
        principal;
      if (this.cache.size >= 1000)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(principal, { name, expires: Date.now() + 300_000 });
      return name;
    } catch {
      console.warn(JSON.stringify({ error: "AttributionNameUnavailable" }));
      return principal;
    }
  }
}
