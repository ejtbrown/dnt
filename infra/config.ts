import { readFileSync } from "node:fs";
import { z } from "zod";
export const configSchema = z.object({
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  domain: z.string().regex(/^[a-z0-9.-]+$/),
  zoneName: z.string(),
  hostedZoneId: z.string().regex(/^Z[A-Z0-9]+$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  repositoryOwnerId: z.string().regex(/^\d+$/),
  repositoryId: z.string().regex(/^\d+$/),
  runnerActorIds: z.array(z.string().regex(/^\d+$/)).min(1),
  connectionArn: z
    .string()
    .regex(
      /^arn:aws:code(connections|star-connections):[a-z0-9-]+:\d{12}:connection\/[a-f0-9-]+$/,
    ),
  cognitoPoolId: z.string(),
  cognitoClientId: z.string(),
  mcpCognitoClientId: z.string(),
  mcpClientMetadataUrls: z.array(z.url().startsWith("https://")).min(1),
  authDomain: z.url().startsWith("https://"),
  agentRoles: z.array(
    z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/),
  ),
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(): Config {
  return configSchema.parse(
    JSON.parse(readFileSync("config/deploy.json", "utf8")),
  );
}

export function deploymentOidcSubject(config: Config): string {
  const [owner, repository] = config.repository.split("/");
  return `repo:${owner}@${config.repositoryOwnerId}/${repository}@${config.repositoryId}:ref:refs/heads/main`;
}
