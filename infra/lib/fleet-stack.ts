import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { type DeployEnv, ZONES } from './env-config';

export interface FleetStackProps extends cdk.StackProps {
  deployEnv: DeployEnv;
  githubOidcProviderArn: string;
}

const GITHUB_OWNER = { name: 'nakomis', id: '1488244' };
const FLEET_REPO = { name: 'nakomis-fleet', id: '1230199854' };

export const githubSubjects = (repo: { name: string; id: string }) => [
  `repo:${GITHUB_OWNER.name}@${GITHUB_OWNER.id}/${repo.name}@${repo.id}:*`,
  `repo:${GITHUB_OWNER.name}/${repo.name}:*`,
];

/** Fleet backend: device registry, HTTP API (JWT), live-update WebSocket and the IoT ingest rules. */
export class FleetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FleetStackProps) {
    super(scope, id, props);

    const { deployEnv } = props;
    const isProd = deployEnv === 'prod';
    const zoneName = ZONES[deployEnv].zoneName;
    const apiDomain = `api.fleet.${zoneName}`;
    const wsDomain = `ws.fleet.${zoneName}`;
    const appOrigin = `https://app.${zoneName}`;
    const firmwareBucket = `nakomis-firmware-${deployEnv}`;

    const userPoolId = ssm.StringParameter.valueForStringParameter(this, `/nakomis-infra/${deployEnv}/cognito/user-pool-id`);
    const shellClientId = ssm.StringParameter.valueForStringParameter(this, `/nakomis-shell/${deployEnv}/cognito/client-id`);
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}`;

    // ── Data ───────────────────────────────────────────────────────────────
    const devices = new dynamodb.TableV2(this, 'DevicesTable', {
      tableName: `nakomis-fleet-devices-${deployEnv}`,
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const connections = new dynamodb.TableV2(this, 'ConnectionsTable', {
      tableName: `nakomis-fleet-connections-${deployEnv}`,
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambdas ────────────────────────────────────────────────────────────
    const fn = (name: string, entry: string, handler: string, environment: Record<string, string>, role?: iam.IRole) => {
      const functionName = `nakomis-fleet-${name}-${deployEnv}`;
      return new lambdaNode.NodejsFunction(this, `${name}Function`, {
        functionName,
        entry: path.join(__dirname, '../lambda', entry),
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(30),
        environment: { DEPLOY_ENV: deployEnv, ...environment },
        role,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        // Bundle every dependency rather than relying on the runtime's SDK version.
        bundling: { externalModules: [], minify: true, sourceMap: true },
      });
    };

    // Named, so the sandbox firmware bucket policy can grant the prod role read access for promotion.
    const apiRole = new iam.Role(this, 'ApiRole', {
      roleName: `nakomis-fleet-api-${deployEnv}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    const api = fn(
      'api',
      'api/index.ts',
      'handler',
      {
        DEVICES_TABLE: devices.tableName,
        FIRMWARE_BUCKET: firmwareBucket,
        ...(isProd ? { PROMOTE_SOURCE_BUCKET: 'nakomis-firmware-sandbox' } : {}),
      },
      apiRole,
    );
    devices.grantReadWriteData(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:ListThings', 'iot:DescribeEndpoint'],
        resources: ['*'],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:DescribeThing', 'iot:UpdateThing'],
        resources: [`arn:aws:iot:${this.region}:${this.account}:thing/*`],
      }),
    );
    // Commands only: Fleet never publishes on a device's responses or status topics.
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:Publish'],
        resources: [`arn:aws:iot:${this.region}:${this.account}:topic/*/*/commands`],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${firmwareBucket}/*`],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${firmwareBucket}`],
      }),
    );
    if (isProd) {
      // Promotion copies sandbox builds in; the sandbox bucket policy grants this role read access.
      api.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [`arn:aws:s3:::${firmwareBucket}/*`],
        }),
      );
      api.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectTagging', 's3:ListBucket'],
          resources: ['arn:aws:s3:::nakomis-firmware-sandbox', 'arn:aws:s3:::nakomis-firmware-sandbox/*'],
        }),
      );
    }

    // ── HTTP API ───────────────────────────────────────────────────────────
    const jwt = new authorizers.HttpJwtAuthorizer('ShellJwt', issuer, {
      jwtAudience: [shellClientId],
      identitySource: ['$request.header.Authorization'],
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `nakomis-fleet-${deployEnv}`,
      description: `Fleet API (${deployEnv})`,
      defaultAuthorizer: jwt,
      corsPreflight: {
        allowOrigins: isProd ? [appOrigin] : [appOrigin, 'http://localhost:5173', 'http://localhost:5174'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const apiIntegration = new integrations.HttpLambdaIntegration('ApiIntegration', api);
    const routes: [apigwv2.HttpMethod, string][] = [
      [apigwv2.HttpMethod.GET, '/devices'],
      [apigwv2.HttpMethod.GET, '/devices/{id}'],
      [apigwv2.HttpMethod.PUT, '/devices/{id}'],
      [apigwv2.HttpMethod.POST, '/devices/{id}/ota'],
      [apigwv2.HttpMethod.POST, '/devices/{id}/ota/cancel'],
      [apigwv2.HttpMethod.POST, '/devices/{id}/command'],
      [apigwv2.HttpMethod.POST, '/devices/{id}/wipe'],
      [apigwv2.HttpMethod.GET, '/projects'],
      [apigwv2.HttpMethod.GET, '/projects/{project}/firmware'],
      [apigwv2.HttpMethod.GET, '/projects/{project}/firmware/{version}/url'],
      [apigwv2.HttpMethod.POST, '/projects/{project}/firmware/{version}/promote'],
    ];
    for (const [method, routePath] of routes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration: apiIntegration });
    }

    // ── WebSocket API ──────────────────────────────────────────────────────
    const wsEnv = { CONNECTIONS_TABLE: connections.tableName, USER_POOL_ID: userPoolId, CLIENT_ID: shellClientId };
    const wsConnect = fn('ws-connect', 'ws/index.ts', 'connect', wsEnv);
    const wsDisconnect = fn('ws-disconnect', 'ws/index.ts', 'disconnect', wsEnv);
    const wsMessage = fn('ws-message', 'ws/index.ts', 'message', wsEnv);
    connections.grantReadWriteData(wsConnect);
    connections.grantReadWriteData(wsDisconnect);

    const wsApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `nakomis-fleet-ws-${deployEnv}`,
      connectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('Connect', wsConnect) },
      disconnectRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('Disconnect', wsDisconnect) },
      defaultRouteOptions: { integration: new integrations.WebSocketLambdaIntegration('Message', wsMessage) },
    });
    const wsStage = new apigwv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi: wsApi,
      stageName: 'live',
      autoDeploy: true,
    });

    // ── Ingest: device responses and status → registry + WebSocket ────────
    const ingest = fn('ingest', 'ingest/index.ts', 'handler', {
      DEVICES_TABLE: devices.tableName,
      CONNECTIONS_TABLE: connections.tableName,
      WS_MANAGEMENT_ENDPOINT: wsStage.callbackUrl,
    });
    devices.grantReadWriteData(ingest);
    connections.grantReadWriteData(ingest);
    wsStage.grantManagementApiAccess(ingest);

    for (const channel of ['responses', 'status']) {
      const rule = new iot.CfnTopicRule(this, `Ingest${channel}Rule`, {
        ruleName: `nakomis_fleet_${channel}_${deployEnv}`,
        topicRulePayload: {
          sql: `SELECT *, topic(1) AS project, topic(2) AS deviceId, topic(3) AS channel, timestamp() AS receivedAt FROM '+/+/${channel}'`,
          awsIotSqlVersion: '2016-03-23',
          ruleDisabled: false,
          actions: [{ lambda: { functionArn: ingest.functionArn } }],
        },
      });
      ingest.addPermission(`Allow${channel}Rule`, {
        principal: new iam.ServicePrincipal('iot.amazonaws.com'),
        sourceArn: rule.attrArn,
        sourceAccount: this.account,
      });
    }

    // ── Domains ────────────────────────────────────────────────────────────
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', ZONES[deployEnv]);
    const cert = new acm.Certificate(this, 'ApiCert', {
      domainName: apiDomain,
      subjectAlternativeNames: [wsDomain],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const apiDomainName = new apigwv2.DomainName(this, 'ApiDomain', { domainName: apiDomain, certificate: cert });
    new apigwv2.ApiMapping(this, 'ApiMapping', { api: httpApi, domainName: apiDomainName });
    const wsDomainName = new apigwv2.DomainName(this, 'WsDomain', { domainName: wsDomain, certificate: cert });
    new apigwv2.ApiMapping(this, 'WsMapping', { api: wsApi, domainName: wsDomainName, stage: wsStage });

    for (const [name, domain, target] of [
      ['Api', apiDomain, apiDomainName],
      ['Ws', wsDomain, wsDomainName],
    ] as const) {
      const alias = route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(target.regionalDomainName, target.regionalHostedZoneId),
      );
      new route53.ARecord(this, `${name}AliasA`, { zone, recordName: domain, target: alias });
      new route53.AaaaRecord(this, `${name}AliasAaaa`, { zone, recordName: domain, target: alias });
    }

    // ── CI ─────────────────────────────────────────────────────────────────
    const oidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', props.githubOidcProviderArn);
    const ciRole = new iam.Role(this, 'FleetCiRole', {
      roleName: `nakomis-nakomis-fleet-github-ci-${deployEnv}`,
      description: `Assumed by nakomis-fleet GitHub Actions CI (${deployEnv})`,
      assumedBy: new iam.WebIdentityPrincipal(oidc.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': githubSubjects(FLEET_REPO) },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'RemoteDeployer',
          ssm.StringParameter.valueForStringParameter(this, `/nakomis-shell/${deployEnv}/remote-deployer-policy-arn`),
        ),
      ],
    });
    ciRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    // ── Exports ────────────────────────────────────────────────────────────
    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: `/nakomis-fleet/${deployEnv}/api-url`,
      stringValue: `https://${apiDomain}`,
    });
    new ssm.StringParameter(this, 'WsUrlParam', {
      parameterName: `/nakomis-fleet/${deployEnv}/ws-url`,
      stringValue: `wss://${wsDomain}`,
    });
    new ssm.StringParameter(this, 'ApiRoleArnParam', {
      parameterName: `/nakomis-fleet/${deployEnv}/api-role-arn`,
      stringValue: apiRole.roleArn,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: `https://${apiDomain}` });
    new cdk.CfnOutput(this, 'WsUrl', { value: `wss://${wsDomain}` });
    new cdk.CfnOutput(this, 'ApiFunctionRoleArn', { value: apiRole.roleArn });
    new cdk.CfnOutput(this, 'CiRoleArn', { value: ciRole.roleArn });
  }
}

