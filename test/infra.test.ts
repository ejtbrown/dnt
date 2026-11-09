import test from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { AppStack, DataStack } from "../infra/stacks.js";
import { ToolingStack } from "../infra/tooling.js";
import { loadConfig } from "../infra/config.js";
const app = new App({
  context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" },
});
const config = loadConfig();
const props = { env: { account: config.account, region: config.region } };
const data = new DataStack(app, "dnt-data", props);
const service = new AppStack(app, "dnt-app", config, data, props);
const tooling = new ToolingStack(app, "dnt-tooling", config, props);
iam.PermissionsBoundary.of(service).apply(
  iam.ManagedPolicy.fromManagedPolicyName(
    service,
    "Boundary",
    "dnt-runtime-boundary",
  ),
);
const dataTemplate = Template.fromStack(data);
const serviceTemplate = Template.fromStack(service);
const toolingTemplate = Template.fromStack(tooling);
test("data is retained and recoverable, with no idle compute infrastructure", () => {
  dataTemplate.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }),
  });
  dataTemplate.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  for (const template of [dataTemplate, serviceTemplate])
    for (const type of [
      "AWS::EC2::VPC",
      "AWS::EC2::NatGateway",
      "AWS::RDS::DBInstance",
    ])
      template.resourceCountIs(type, 0);
});
test("human and agent routes require different authenticated mechanisms", () => {
  serviceTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "ANY /api/v1/{proxy+}",
    AuthorizationType: "JWT",
    AuthorizationScopes: ["openid"],
  });
  serviceTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "ANY /agent/v1/{proxy+}",
    AuthorizationType: "AWS_IAM",
  });
  serviceTemplate.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
  serviceTemplate.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Environment: {
      Variables: Match.objectLike({
        PROJECT_CREATORS: JSON.stringify(config.projectCreators),
      }),
    },
  });
});
test("CloudFront never caches authenticated API responses or serves content objects directly", () => {
  serviceTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: "/api/*",
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
          AllowedMethods: [
            "GET",
            "HEAD",
            "OPTIONS",
            "PUT",
            "PATCH",
            "POST",
            "DELETE",
          ],
        }),
      ]),
    }),
  });
  const distribution = Object.values(
    serviceTemplate.findResources("AWS::CloudFront::Distribution"),
  )[0] as any;
  assert.ok(
    !JSON.stringify(
      distribution.Properties.DistributionConfig.Origins,
    ).includes("Content"),
  );
});
test("runtime roles have a permissions boundary and CI role is restricted to main", () => {
  const runtimeRoles = Object.values(
    serviceTemplate.findResources("AWS::IAM::Role"),
  ) as any[];
  assert.ok(runtimeRoles.length > 0);
  assert.ok(runtimeRoles.every((r) => r.Properties.PermissionsBoundary));
  toolingTemplate.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "dnt-github-deploy",
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:ejtbrown@9349498/dnt@1451000902:ref:refs/heads/main",
            },
          },
        }),
      ]),
    },
  });
  const policies = toolingTemplate.findResources("AWS::IAM::Policy");
  const runnerPolicy = Object.values(policies).find((p: any) =>
    JSON.stringify(p.Properties.Roles).includes("RunnerRole"),
  ) as any;
  const actions = runnerPolicy.Properties.PolicyDocument.Statement.flatMap(
    (s: any) => s.Action,
  );
  assert.ok(
    !actions.some(
      (a: string) => a.startsWith("sts:") || a.startsWith("cloudformation:"),
    ),
  );
});

test("public-repository runners reject events from untrusted GitHub actors", () => {
  toolingTemplate.hasResourceProperties("AWS::CodeBuild::Project", {
    Triggers: { FilterGroups: [[
      { Type: "EVENT", Pattern: "WORKFLOW_JOB_QUEUED" },
      { Type: "ACTOR_ACCOUNT_ID", Pattern: `^(${config.runnerActorIds.join("|")})$` },
      { Type: "WORKFLOW_NAME", Pattern: "^(Validate dnt|Deploy dnt)$" },
    ]], Webhook: true },
  });
  const runner = Object.values(toolingTemplate.findResources("AWS::CodeBuild::Project"))[0] as any;
  assert.ok(runner.DependsOn.some((id: string) => id.startsWith("RunnerRoleDefaultPolicy")));
});
