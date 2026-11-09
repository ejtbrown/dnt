import { loadConfig } from "../infra/config.js";
import { cdk, aws, verifyAccount } from "./aws.js";
const config = loadConfig();
verifyAccount(config.account);
if (!config.cognitoPoolId || !config.cognitoClientId)
  throw new Error(
    "Deploy the shared Cognito pool and register the dnt client, then set cognitoPoolId and cognitoClientId in config/deploy.json",
  );
const client = aws([
  "cognito-idp",
  "describe-user-pool-client",
  "--region",
  config.region,
  "--user-pool-id",
  config.cognitoPoolId,
  "--client-id",
  config.cognitoClientId,
  "--query",
  "UserPoolClient.{CallbackURLs:CallbackURLs,LogoutURLs:LogoutURLs,AllowedOAuthFlows:AllowedOAuthFlows,AllowedOAuthScopes:AllowedOAuthScopes,ClientId:ClientId,HasSecret:contains(keys(@), 'ClientSecret')}",
]);
if (
  client.HasSecret ||
  !client.CallbackURLs?.includes(`https://${config.domain}/auth/callback`) ||
  !client.LogoutURLs?.includes(`https://${config.domain}/`) ||
  !client.AllowedOAuthFlows?.includes("code") ||
  !client.AllowedOAuthScopes?.includes("openid")
)
  throw new Error("Cognito app client does not match the dnt OAuth contract");
if (!config.mcpCognitoClientId)
  throw new Error("Register the dnt-mcp Cognito client before deployment");
const mcpClient = aws([
  "cognito-idp",
  "describe-user-pool-client",
  "--region",
  config.region,
  "--user-pool-id",
  config.cognitoPoolId,
  "--client-id",
  config.mcpCognitoClientId,
  "--query",
  "UserPoolClient.{CallbackURLs:CallbackURLs,AllowedOAuthFlows:AllowedOAuthFlows,AllowedOAuthScopes:AllowedOAuthScopes,HasSecret:contains(keys(@), 'ClientSecret')}",
]);
if (
  mcpClient.HasSecret ||
  mcpClient.CallbackURLs?.length !== 1 ||
  mcpClient.CallbackURLs[0] !== `https://${config.domain}/oauth/callback` ||
  !mcpClient.AllowedOAuthFlows?.includes("code") ||
  !mcpClient.AllowedOAuthScopes?.includes("openid")
)
  throw new Error("MCP Cognito client does not match the broker contract");
cdk(["synth", "--strict", "--quiet"]);
cdk(["diff", "dnt-certificate", "dnt-data", "--fail-on", "never"]);
cdk(["deploy", "dnt-certificate", "dnt-data", "--require-approval", "never"]);
const certificate = aws([
  "cloudformation",
  "describe-stacks",
  "--region",
  "us-east-1",
  "--stack-name",
  "dnt-certificate",
  "--query",
  "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]",
]);
if (typeof certificate !== "string")
  throw new Error("Certificate output missing");
const parameters = [
  "--parameters",
  `dnt-app:CognitoPoolId=${config.cognitoPoolId}`,
  "--parameters",
  `dnt-app:CognitoClientId=${config.cognitoClientId}`,
  "--parameters",
  `dnt-app:CertificateArn=${certificate}`,
];
cdk(["diff", "dnt-app", "--fail-on", "never", ...parameters]);
cdk(["deploy", "dnt-app", "--require-approval", "never", ...parameters]);
