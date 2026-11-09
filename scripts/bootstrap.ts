import { loadConfig } from "../infra/config.js";
import { qualifier } from "../infra/tooling.js";
import { cdk, aws, verifyAccount } from "./aws.js";
const config = loadConfig();
verifyAccount(config.account);
cdk(["synth", "dnt-tooling", "--strict"]);
cdk(["diff", "dnt-tooling", "--method", "template", "--fail-on", "never"]);
// This policy stack must deploy with the administrator's own credentials.
// CDK CLI may infer a default bootstrap execution role even for inline-only stacks.
aws(["cloudformation", "deploy", "--region", config.region,
  "--stack-name", "dnt-tooling", "--template-file", "cdk.out/dnt-tooling.template.json",
  "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset",
  "--tags", "Project=dnt", "ManagedBy=CDK"]);
aws(["cloudformation", "update-termination-protection", "--region", config.region,
  "--stack-name", "dnt-tooling", "--enable-termination-protection"]);
for (const region of new Set([config.region, "us-east-1"]))
  cdk([
    "bootstrap",
    `aws://${config.account}/${region}`,
    "--qualifier",
    qualifier,
    "--toolkit-stack-name",
    "dnt-cdk-toolkit",
    "--termination-protection",
    "--cloudformation-execution-policies",
    `arn:aws:iam::${config.account}:policy/dnt-cloudformation`,
  ]);
