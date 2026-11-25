import { CognitoDirectory } from "../groups/cognito.js";
import { DynamoStore, S3Blobs } from "../api/aws-store.js";
import { Service } from "../api/service.js";
import { CognitoLogin } from "./cognito.js";
import { MetadataClients, OAuthBroker } from "./oauth.js";
import { createHttpHandler } from "./http.js";
import { createGatewayHandler } from "./telemetry.js";
const origin = process.env.PUBLIC_ORIGIN!;
const broker = new OAuthBroker(
  origin,
  new DynamoStore(process.env.OAUTH_TABLE!),
  new MetadataClients(JSON.parse(process.env.MCP_CLIENT_METADATA_URLS ?? "[]")),
  new CognitoLogin({
    issuer: process.env.AUTH_DOMAIN!,
    poolId: process.env.COGNITO_POOL_ID!,
    clientId: process.env.MCP_COGNITO_CLIENT_ID!,
    domain: process.env.AUTH_DOMAIN!,
    callback: `${origin}/oauth/callback`,
  }),
);
const service = new Service(
  new DynamoStore(process.env.TABLE_NAME!),
  new S3Blobs(process.env.CONTENT_BUCKET!),
  new CognitoDirectory(process.env.COGNITO_POOL_ID!),
  process.env.PUBLIC_ORIGIN!,
);
const handle = createHttpHandler(service, broker);
export const handler = createGatewayHandler(origin, handle);
