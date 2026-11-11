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
  "UserPoolClient.{ClientName:ClientName,ExplicitAuthFlows:ExplicitAuthFlows,ClientId:ClientId,HasSecret:contains(keys(@), 'ClientSecret')}",
]);
if (
  !client.HasSecret ||
  client.ClientName !== "dnt-browser" ||
  !client.ExplicitAuthFlows?.includes("ALLOW_USER_PASSWORD_AUTH") ||
  config.authDomain !== "https://login.auth.ejtbrown.com/signin"
)
  throw new Error(
    "The confidential dnt client does not match the shared browser sign-in contract",
  );
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
  "UserPoolClient.{ClientName:ClientName,ExplicitAuthFlows:ExplicitAuthFlows,HasSecret:contains(keys(@), 'ClientSecret')}",
]);
if (
  !mcpClient.HasSecret ||
  mcpClient.ClientName !== "dnt-mcp-browser" ||
  !mcpClient.ExplicitAuthFlows?.includes("ALLOW_USER_PASSWORD_AUTH")
)
  throw new Error(
    "The confidential MCP client does not match the shared browser sign-in contract",
  );
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
