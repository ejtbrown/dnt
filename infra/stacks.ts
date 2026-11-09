import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpJwtAuthorizer,
  HttpIamAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { Config } from "./config.js";

export class DataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly content: s3.Bucket;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: true });
    this.table = new dynamodb.Table(this, "Records", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.content = new s3.Bucket(this, "Content", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new CfnOutput(this, "TableName", { value: this.table.tableName });
    new CfnOutput(this, "ContentBucket", { value: this.content.bucketName });
  }
}
export class CertificateStack extends Stack {
  constructor(scope: Construct, id: string, config: Config, props: StackProps) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.zoneName,
    });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.domain,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    new CfnOutput(this, "CertificateArn", {
      value: certificate.certificateArn,
    });
  }
}
export class AppStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    config: Config,
    data: DataStack,
    props: StackProps,
  ) {
    super(scope, id, { ...props, terminationProtection: true });
    const poolId = new CfnParameter(this, "CognitoPoolId", {
      type: "String",
      allowedPattern: `${config.region}_[A-Za-z0-9]+`,
    });
    const clientId = new CfnParameter(this, "CognitoClientId", {
      type: "String",
      allowedPattern: "[a-z0-9]+",
    });
    const certArn = new CfnParameter(this, "CertificateArn", {
      type: "String",
      allowedPattern: `arn:aws:acm:us-east-1:${config.account}:certificate/.*`,
    });
    const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${poolId.valueAsString}`;
    const functionLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const fn = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("dist/api"),
      timeout: Duration.seconds(15),
      memorySize: 256,
      logGroup: functionLogs,
      environment: {
        TABLE_NAME: data.table.tableName,
        CONTENT_BUCKET: data.content.bucketName,
        COGNITO_ISSUER: issuer,
        COGNITO_CLIENT_ID: clientId.valueAsString,
        PROJECT_CREATORS: JSON.stringify(config.projectCreators),
        AGENT_ROLES: JSON.stringify(config.agentRoles),
      },
    });
    data.table.grantReadWriteData(fn);
    data.content.grantRead(fn);
    data.content.grantPut(fn);
    const api = new apigw.HttpApi(this, "HttpApi", {
      apiName: "dnt",
      createDefaultStage: true,
    });
    const integration = new HttpLambdaIntegration("Service", fn);
    api.addRoutes({
      path: "/api/v1/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer: new HttpJwtAuthorizer("Cognito", issuer, {
        jwtAudience: [clientId.valueAsString],
      }),
      authorizationScopes: ["openid"],
    });
    api.addRoutes({
      path: "/agent/v1/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer: new HttpIamAuthorizer(),
    });
    const accessLogs = new logs.LogGroup(this, "AccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationError: "$context.integrationErrorMessage",
      }),
    };
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit: 25,
    };
    new cloudwatch.Alarm(this, "ApiErrors", {
      metric: api.metricServerError({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "dnt API server errors; configure notification actions for operations",
    });
    const web = new s3.Bucket(this, "Web", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const routing = new cloudfront.Function(this, "SpaRouting", {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri === '/auth/callback') r.uri = '/index.html'; return r; }",
      ),
    });
    const security = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${config.authDomain}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
            override: true,
          },
        },
      },
    );
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: [config.domain],
      certificate: acm.Certificate.fromCertificateArn(
        this,
        "Certificate",
        certArn.valueAsString,
      ),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(web),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: security,
        functionAssociations: [
          {
            function: routing,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(
            `${api.apiId}.execute-api.${config.region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: security,
        },
        "/config.json": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(web),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: security,
        },
      },
    });
    const deploymentLogs = new logs.LogGroup(this, "DeploymentLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new deployment.BucketDeployment(this, "WebDeployment", {
      logGroup: deploymentLogs,
      destinationBucket: web,
      sources: [
        deployment.Source.asset("dist/web"),
        deployment.Source.jsonData("config.json", {
          clientId: clientId.valueAsString,
          authDomain: config.authDomain,
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
      prune: false,
      memoryLimit: 256,
      cacheControl: [deployment.CacheControl.noCache()],
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.zoneName,
    });
    for (const type of ["A", "AAAA"] as const) {
      const Props = {
        zone,
        recordName: config.domain,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution),
        ),
      };
      if (type === "A") new route53.ARecord(this, "AliasA", Props);
      else new route53.AaaaRecord(this, "AliasAAAA", Props);
    }
    new CfnOutput(this, "Url", { value: `https://${config.domain}` });
    new CfnOutput(this, "AgentApi", { value: `${api.apiEndpoint}/agent/v1` });
    new CfnOutput(this, "AgentInvokeArn", {
      value: `arn:aws:execute-api:${config.region}:${config.account}:${api.apiId}/*/*/agent/v1/*`,
    });
  }
}
