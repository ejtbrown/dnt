import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { deploymentOidcSubject, type Config } from "./config.js";
export const qualifier = "dntkit001";
export class ToolingStack extends Stack {
  constructor(scope: Construct, id: string, config: Config, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: true });
    const arn = (service: string, region: string, resource: string) =>
      `arn:aws:${service}:${region}:${config.account}:${resource}`;
    const runtimeBoundary = new iam.ManagedPolicy(this, "RuntimeBoundary", {
      managedPolicyName: "dnt-runtime-boundary",
      statements: [
        new iam.PolicyStatement({
          actions: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogStreams",
          ],
          resources: [
            arn("logs", config.region, "log-group:dnt-app-*:*"),
            arn("logs", config.region, "log-group:/aws/lambda/dnt-app-*:*"),
          ],
        }),
        new iam.PolicyStatement({
          actions: ["s3:*"],
          resources: [
            "arn:aws:s3:::dnt-data-*",
            "arn:aws:s3:::dnt-data-*/*",
            "arn:aws:s3:::dnt-app-*",
            "arn:aws:s3:::dnt-app-*/*",
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          resources: [
            `arn:aws:s3:::cdk-${qualifier}-assets-${config.account}-${config.region}`,
            `arn:aws:s3:::cdk-${qualifier}-assets-${config.account}-${config.region}/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchGetItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:DescribeTable",
            "dynamodb:ConditionCheckItem",
            "dynamodb:DescribeStream",
            "dynamodb:GetRecords",
            "dynamodb:GetShardIterator",
          ],
          resources: [arn("dynamodb", config.region, "table/dnt-data-*")],
        }),
        new iam.PolicyStatement({
          actions: [
            "cloudfront:CreateInvalidation",
            "cloudfront:GetInvalidation",
          ],
          resources: [arn("cloudfront", "", "distribution/*")],
        }),
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [arn("lambda", config.region, "function:dnt-app-*")],
        }),
      ],
    });
    runtimeBoundary.addStatements(
      new iam.PolicyStatement({
        actions: ["dynamodb:ListStreams"],
        resources: ["*"],
      }),
    );
    runtimeBoundary.addStatements(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:ListUsers",
          "cognito-idp:GetGroup",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:CreateGroup",
          "cognito-idp:DeleteGroup",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
        ],
        resources: [
          arn("cognito-idp", config.region, `userpool/${config.cognitoPoolId}`),
        ],
      }),
    );
    runtimeBoundary.addStatements(
      new iam.PolicyStatement({
        actions: [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ],
        resources: [arn("sqs", config.region, "dnt-app-*")],
      }),
    );
    const execution = new iam.ManagedPolicy(this, "ExecutionPolicy", {
      managedPolicyName: "dnt-cloudformation",
    });
    const allow = (
      actions: string[],
      resources: string[],
      conditions?: Record<string, Record<string, unknown>>,
    ) =>
      execution.addStatements(
        new iam.PolicyStatement({ actions, resources, conditions }),
      );
    allow(
      ["s3:*"],
      [
        "arn:aws:s3:::dnt-data-*",
        "arn:aws:s3:::dnt-data-*/*",
        "arn:aws:s3:::dnt-app-*",
        "arn:aws:s3:::dnt-app-*/*",
      ],
    );
    allow(
      [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucketLocation",
      ],
      [config.region, "us-east-1"].flatMap((region) => [
        `arn:aws:s3:::cdk-${qualifier}-assets-${config.account}-${region}`,
        `arn:aws:s3:::cdk-${qualifier}-assets-${config.account}-${region}/*`,
      ]),
    );
    allow(
      ["ssm:GetParameter", "ssm:GetParameters"],
      [config.region, "us-east-1"].map((region) =>
        arn("ssm", region, `parameter/cdk-bootstrap/${qualifier}/version`),
      ),
    );
    allow(["sqs:*"], [arn("sqs", config.region, "dnt-app-*")]);
    allow(
      [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
      ],
      ["*"],
      {
        ArnLike: {
          "lambda:FunctionArn": arn(
            "lambda",
            config.region,
            "function:dnt-app-*",
          ),
        },
      },
    );
    allow(
      [
        "lambda:GetEventSourceMapping",
        "lambda:ListTags",
        "lambda:TagResource",
        "lambda:UntagResource",
      ],
      [arn("lambda", config.region, "event-source-mapping:*")],
    );
    allow(["dynamodb:*"], [arn("dynamodb", config.region, "table/dnt-data-*")]);
    allow(
      ["lambda:*"],
      [
        arn("lambda", config.region, "function:dnt-app-*"),
        arn("lambda", config.region, "layer:dnt-app-*"),
        arn("lambda", config.region, "layer:dnt-app-*:*"),
      ],
    );
    allow(
      ["logs:*"],
      [
        arn("logs", config.region, "log-group:dnt-app-*"),
        arn("logs", config.region, "log-group:dnt-app-*:*"),
        arn("logs", config.region, "log-group:/aws/lambda/dnt-app-*"),
        arn("logs", config.region, "log-group:/aws/lambda/dnt-app-*:*"),
      ],
    );
    allow(["logs:DescribeLogGroups", "lambda:GetAccountSettings"], ["*"]);
    allow(
      ["iam:CreateServiceLinkedRole"],
      [
        arn(
          "iam",
          "",
          "role/aws-service-role/ops.apigateway.amazonaws.com/AWSServiceRoleForAPIGateway",
        ),
      ],
      {
        StringEquals: { "iam:AWSServiceName": "ops.apigateway.amazonaws.com" },
      },
    );
    allow(
      [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
      ],
      ["*"],
    );

    allow(
      ["apigateway:*"],
      [
        `arn:aws:apigateway:${config.region}::/apis`,
        `arn:aws:apigateway:${config.region}::/apis/*`,
      ],
    );
    allow(
      ["apigateway:GET", "apigateway:POST", "apigateway:DELETE"],
      [`arn:aws:apigateway:${config.region}::/tags/*`],
    );
    allow(["cloudfront:*"], ["*"]); // CloudFront generates IDs; tooling remains administrator-owned.
    allow(
      [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
        "cloudwatch:ListTagsForResource",
      ],
      [arn("cloudwatch", config.region, "alarm:dnt-app-*")],
    );
    const appRoles = arn("iam", "", "role/dnt-app-*");
    allow(["iam:CreateRole", "iam:PutRolePermissionsBoundary"], [appRoles], {
      StringEquals: {
        "iam:PermissionsBoundary": runtimeBoundary.managedPolicyArn,
      },
    });
    allow(
      [
        "iam:GetRole",
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      [appRoles],
    );
    allow(["iam:PassRole"], [appRoles], {
      StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
    });
    allow(["acm:RequestCertificate"], ["*"], {
      "ForAllValues:StringEquals": { "acm:DomainNames": [config.domain] },
      Null: { "acm:DomainNames": "false" },
      StringEquals: { "acm:ValidationMethod": "DNS" },
    });
    allow(
      [
        "acm:DescribeCertificate",
        "acm:ListTagsForCertificate",
        "acm:AddTagsToCertificate",
      ],
      [arn("acm", "us-east-1", "certificate/*")],
    );
    allow(
      ["acm:DeleteCertificate", "acm:RemoveTagsFromCertificate"],
      [arn("acm", "us-east-1", "certificate/*")],
      { StringEquals: { "aws:ResourceTag/Project": "dnt" } },
    );
    allow(
      ["route53:GetHostedZone", "route53:ListResourceRecordSets"],
      [`arn:aws:route53:::hostedzone/${config.hostedZoneId}`],
    );
    allow(
      ["route53:ChangeResourceRecordSets"],
      [`arn:aws:route53:::hostedzone/${config.hostedZoneId}`],
      {
        "ForAllValues:StringLike": {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
            config.domain,
            `_*.${config.domain}`,
          ],
        },
        Null: {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false",
        },
      },
    );
    allow(["route53:GetChange"], ["arn:aws:route53:::change/*"]);
    const oidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHub",
      arn("iam", "", "oidc-provider/token.actions.githubusercontent.com"),
    );
    const deploy = new iam.Role(this, "DeployRole", {
      roleName: "dnt-github-deploy",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(oidc, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            deploymentOidcSubject(config),
        },
      }),
    });
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [config.region, "us-east-1"].flatMap((region) =>
          ["deploy", "file-publishing", "lookup"].map((kind) =>
            arn(
              "iam",
              "",
              `role/cdk-${qualifier}-${kind}-role-${config.account}-${region}`,
            ),
          ),
        ),
      }),
    );
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          arn("cloudformation", "us-east-1", "stack/dnt-certificate/*"),
          arn("cloudformation", config.region, "stack/dnt-app/*"),
        ],
      }),
    );
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:DescribeUserPool",
          "cognito-idp:DescribeUserPoolClient",
        ],
        resources: [arn("cognito-idp", config.region, "userpool/*")],
      }),
    );
    const runnerLogs = new logs.LogGroup(this, "RunnerLogs", {
      logGroupName: "/aws/codebuild/dnt-runner",
      retention: logs.RetentionDays.ONE_MONTH,
    });
    const runnerRole = new iam.Role(this, "RunnerRole", {
      roleName: "dnt-runner",
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": config.account },
          ArnEquals: {
            "aws:SourceArn": arn(
              "codebuild",
              config.region,
              "project/dnt-runner",
            ),
          },
        },
      }),
    });
    runnerLogs.grantWrite(runnerRole);
    const connectionGrant = iam.Grant.addToPrincipal({
      grantee: runnerRole,
      actions: [
        "codeconnections:GetConnection",
        "codeconnections:GetConnectionToken",
      ],
      resourceArns: [config.connectionArn],
    });
    const runner = new codebuild.CfnProject(this, "Runner", {
      name: "dnt-runner",
      serviceRole: runnerRole.roleArn,
      artifacts: { type: "NO_ARTIFACTS" },
      timeoutInMinutes: 60,
      queuedTimeoutInMinutes: 30,
      concurrentBuildLimit: 2,
      environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_SMALL",
        image: "aws/codebuild/standard:7.0",
        privilegedMode: false,
      },
      source: {
        type: "GITHUB",
        location: `https://github.com/${config.repository}.git`,
        auth: { type: "CODECONNECTIONS", resource: config.connectionArn },
      },
      triggers: {
        webhook: true,
        filterGroups: [
          [
            { type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" },
            {
              type: "ACTOR_ACCOUNT_ID",
              pattern: `^(${config.runnerActorIds.join("|")})$`,
            },
            { type: "WORKFLOW_NAME", pattern: "^(Validate dnt|Deploy dnt)$" },
          ],
        ],
      },
      logsConfig: {
        cloudWatchLogs: {
          status: "ENABLED",
          groupName: runnerLogs.logGroupName,
        },
      },
    });
    connectionGrant.applyBefore(runner);
    new CfnOutput(this, "DeployRoleArn", { value: deploy.roleArn });
    new CfnOutput(this, "ExecutionPolicyArn", {
      value: execution.managedPolicyArn,
    });
  }
}
