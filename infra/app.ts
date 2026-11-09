#!/usr/bin/env node
import {
  App,
  BootstraplessSynthesizer,
  DefaultStackSynthesizer,
  Tags,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { loadConfig } from "./config.js";
import { AppStack, CertificateStack, DataStack } from "./stacks.js";
import { ToolingStack, qualifier } from "./tooling.js";
const app = new App();
const config = loadConfig();
const props = (region = config.region) => ({
  env: { account: config.account, region },
  synthesizer: new DefaultStackSynthesizer({ qualifier }),
});
new ToolingStack(app, "dnt-tooling", config, {
  env: { account: config.account, region: config.region },
  synthesizer: new BootstraplessSynthesizer(),
});
const data = new DataStack(app, "dnt-data", props());
new CertificateStack(app, "dnt-certificate", config, props("us-east-1"));
const application = new AppStack(app, "dnt-app", config, data, props());
iam.PermissionsBoundary.of(application).apply(
  iam.ManagedPolicy.fromManagedPolicyName(
    application,
    "Boundary",
    "dnt-runtime-boundary",
  ),
);
Tags.of(app).add("Project", "dnt");
Tags.of(app).add("ManagedBy", "CDK");
app.synth();
