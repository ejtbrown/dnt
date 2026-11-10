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
  serviceTemplate.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
  const apiPolicy = Object.entries(
    serviceTemplate.findResources("AWS::IAM::Policy"),
  ).find(([id]) =>
    id.startsWith("ApiFunctionServiceRoleDefaultPolicy"),
  )![1] as any;
  const nameLookup = apiPolicy.Properties.PolicyDocument.Statement.find(
    (s: any) => [s.Action].flat().includes("cognito-idp:AdminGetUser"),
  );
  assert.ok(
    JSON.stringify(nameLookup.Resource).includes('"Ref":"CognitoPoolId"'),
  );
  assert.ok(!JSON.stringify(nameLookup.Resource).includes("*"));
  serviceTemplate.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Environment: {
      Variables: Match.objectLike({
        COGNITO_POOL_ID: Match.anyValue(),
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
    Triggers: {
      FilterGroups: [
        [
          { Type: "EVENT", Pattern: "WORKFLOW_JOB_QUEUED" },
          {
            Type: "ACTOR_ACCOUNT_ID",
            Pattern: `^(${config.runnerActorIds.join("|")})$`,
          },
          { Type: "WORKFLOW_NAME", Pattern: "^(Validate dnt|Deploy dnt)$" },
        ],
      ],
      Webhook: true,
    },
  });
  const runner = Object.values(
    toolingTemplate.findResources("AWS::CodeBuild::Project"),
  )[0] as any;
  assert.ok(
    runner.DependsOn.some((id: string) =>
      id.startsWith("RunnerRoleDefaultPolicy"),
    ),
  );
});

test("CloudFormation can resolve only the dnt bootstrap version parameters", () => {
  const policy = Object.values(
    toolingTemplate.findResources("AWS::IAM::ManagedPolicy"),
  ).find(
    (p: any) => p.Properties.ManagedPolicyName === "dnt-cloudformation",
  ) as any;
  const statement = policy.Properties.PolicyDocument.Statement.find((s: any) =>
    s.Action.includes("ssm:GetParameters"),
  );
  assert.deepEqual(
    statement.Resource.sort(),
    [
      `arn:aws:ssm:us-east-1:${config.account}:parameter/cdk-bootstrap/dntkit001/version`,
      `arn:aws:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/dntkit001/version`,
    ].sort(),
  );
});

test("deployment helper layers remain inside the permitted application namespace", () => {
  const layers = Object.values(
    serviceTemplate.findResources("AWS::Lambda::LayerVersion"),
  ) as any[];
  assert.ok(layers.length > 0);
  assert.ok(
    layers.every((layer) => layer.Properties.LayerName.startsWith("dnt-app-")),
  );
});

test("MCP routes forward uncached requests and OAuth state is retained with TTL", () => {
  serviceTemplate.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    RouteSettings: {
      "ANY /oauth/{proxy+}": {
        ThrottlingBurstLimit: 10,
        ThrottlingRateLimit: 5,
      },
    },
  });
  const stage = Object.values(
    serviceTemplate.findResources("AWS::ApiGatewayV2::Stage"),
  )[0] as any;
  const oauthRoute = Object.entries(
    serviceTemplate.findResources("AWS::ApiGatewayV2::Route"),
  ).find(
    ([, route]: [string, any]) =>
      route.Properties.RouteKey === "ANY /oauth/{proxy+}",
  )![0];
  assert.ok(
    stage.DependsOn.includes(oauthRoute),
    "Throttle settings must wait for the OAuth route",
  );
  dataTemplate.resourceCountIs("AWS::DynamoDB::Table", 2);
  dataTemplate.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }),
  });
  for (const path of ["/mcp", "/oauth/{proxy+}", "/.well-known/{proxy+}"])
    serviceTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: `ANY ${path}`,
      AuthorizationType: "NONE",
    });
  const distribution = Object.values(
    serviceTemplate.findResources("AWS::CloudFront::Distribution"),
  )[0] as any;
  for (const path of ["/mcp", "/oauth/*", "/.well-known/*"]) {
    const behavior =
      distribution.Properties.DistributionConfig.CacheBehaviors.find(
        (b: any) => b.PathPattern === path,
      );
    assert.equal(
      behavior.CachePolicyId,
      "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    );
    assert.equal(
      behavior.OriginRequestPolicyId,
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
    assert.ok(behavior.AllowedMethods.includes("POST"));
  }
  serviceTemplate.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    Timeout: 28,
    Environment: {
      Variables: Match.objectLike({
        MCP_COGNITO_CLIENT_ID: config.mcpCognitoClientId,
        MCP_CLIENT_METADATA_URLS: JSON.stringify(config.mcpClientMetadataUrls),
        PUBLIC_ORIGIN: `https://${config.domain}`,
      }),
    },
  });
  const boundary = Object.values(
    toolingTemplate.findResources("AWS::IAM::ManagedPolicy"),
  ).find(
    (p: any) => p.Properties.ManagedPolicyName === "dnt-runtime-boundary",
  ) as any;
  const statement = boundary.Properties.PolicyDocument.Statement.find(
    (s: any) => [s.Action].flat().includes("cognito-idp:AdminGetUser"),
  );
  assert.equal(
    statement.Resource,
    `arn:aws:cognito-idp:${config.region}:${config.account}:userpool/${config.cognitoPoolId}`,
  );
});

test("Cognito reconciliation is durable, serial, filtered, and isolated from HTTP write privileges", () => {
  dataTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
    StreamSpecification: { StreamViewType: "NEW_IMAGE" },
  });
  serviceTemplate.hasResourceProperties("AWS::Lambda::Function", {
    ReservedConcurrentExecutions: 1,
    Timeout: 300,
  });
  serviceTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    StartingPosition: "TRIM_HORIZON",
    BatchSize: 1,
    MaximumRetryAttempts: 6,
    MaximumRecordAgeInSeconds: 21600,
    FilterCriteria: {
      Filters: [
        {
          Pattern: JSON.stringify({
            eventName: ["INSERT", "MODIFY"],
            dynamodb: {
              NewImage: {
                pk: { S: [{ prefix: "PROJECT#" }] },
                sk: { S: ["GROUP_SYNC"] },
                value: { M: { status: { S: ["pending"] } } },
              },
            },
          }),
        },
      ],
    },
    DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
  });
  const policies = serviceTemplate.findResources("AWS::IAM::Policy");
  for (const prefix of ["ApiFunction", "McpFunction", "GroupWorker"]) {
    const policy = Object.entries(policies).find(([id]) =>
      id.startsWith(prefix),
    )![1] as any;
    const actions = policy.Properties.PolicyDocument.Statement.flatMap(
      (s: any) => [s.Action].flat(),
    );
    assert.equal(
      actions.includes("cognito-idp:DeleteGroup"),
      prefix === "GroupWorker",
    );
  }
});

test("global administration is read from Cognito and no runtime creator allowlist remains", () => {
  const policies = serviceTemplate.findResources("AWS::IAM::Policy");
  for (const prefix of ["ApiFunction", "McpFunction", "GroupWorker"]) {
    const policy = Object.entries(policies).find(([id]) =>
      id.startsWith(prefix),
    )![1] as any;
    const actions = policy.Properties.PolicyDocument.Statement.flatMap(
      (s: any) => [s.Action].flat(),
    );
    assert.equal(
      actions.includes("cognito-idp:AdminListGroupsForUser"),
      prefix !== "GroupWorker",
    );
  }
  for (const fn of Object.values(
    serviceTemplate.findResources("AWS::Lambda::Function"),
  ) as any[])
    assert.ok(!fn.Properties.Environment?.Variables?.PROJECT_CREATORS);
});

test("only the exact public page GET is anonymous and direct links reach the SPA", () => {
  serviceTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /api/v1/public/documents/{reference}",
    AuthorizationType: "NONE",
  });
  const routing = Object.values(
    serviceTemplate.findResources("AWS::CloudFront::Function"),
  )[0] as any;
  const handler = new Function(
    `${routing.Properties.FunctionCode}; return handler;`,
  )();
  for (const uri of ["/t/ROOT-1", "/d/admin-uuid", "/auth/callback"])
    assert.equal(handler({ request: { uri } }).uri, "/index.html");
  for (const uri of [
    "/api/v1/projects",
    "/api/v1/public/documents/ref",
    "/assets/app.js",
    "/d/x/revisions",
  ])
    assert.equal(handler({ request: { uri } }).uri, uri);
});
