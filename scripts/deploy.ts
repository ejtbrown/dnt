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
