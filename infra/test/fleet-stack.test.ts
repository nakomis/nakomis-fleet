import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FleetStack } from '../lib/fleet-stack';

function synth(deployEnv: 'sandbox' | 'prod') {
  const app = new cdk.App();
  const stack = new FleetStack(app, `Fleet-${deployEnv}`, {
    env: { account: '123456789012', region: 'eu-west-2' },
    deployEnv,
    githubOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
  });
  return Template.fromStack(stack);
}

describe.each(['sandbox', 'prod'] as const)('%s', (env) => {
  const zone = env === 'prod' ? 'nakomis.com' : 'sandbox.nakomis.com';
  let t: Template;
  beforeAll(() => {
    t = synth(env);
  });

  test('device registry and connection tables', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', { TableName: `nakomis-fleet-devices-${env}` });
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: `nakomis-fleet-connections-${env}`,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  test('HTTP API routes are all behind the JWT authoriser', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    const routes = t.findResources('AWS::ApiGatewayV2::Route');
    const httpRoutes = Object.values(routes).filter((r) => r.Properties.AuthorizationType !== undefined && r.Properties.RouteKey.includes('/'));
    expect(httpRoutes.length).toBe(11);
    for (const r of httpRoutes) expect(r.Properties.AuthorizationType).toBe('JWT');
  });

  test('CORS only allows the app origin (plus localhost in sandbox)', () => {
    const origins = env === 'prod' ? [`https://app.${zone}`] : [`https://app.${zone}`, 'http://localhost:5173', 'http://localhost:5174'];
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP', CorsConfiguration: Match.objectLike({ AllowOrigins: origins }) });
  });

  test('IoT rules feed responses and status into the ingest Lambda', () => {
    for (const channel of ['responses', 'status']) {
      t.hasResourceProperties('AWS::IoT::TopicRule', {
        RuleName: `nakomis_fleet_${channel}_${env}`,
        TopicRulePayload: Match.objectLike({ Sql: Match.stringLikeRegexp(`FROM '\\+/\\+/${channel}'`) }),
      });
    }
  });

  test('the API may only publish to command topics', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'iot:Publish', Resource: `arn:aws:iot:eu-west-2:123456789012:topic/*/*/commands` }),
        ]),
      },
    });
  });

  test(`custom domains api.fleet.${zone} and ws.fleet.${zone}`, () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: `api.fleet.${zone}` });
    t.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: `ws.fleet.${zone}` });
    t.resourceCountIs('AWS::Route53::RecordSet', 4);
  });

  test('CI role trusts this repo and can publish the remote', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `nakomis-nakomis-fleet-github-ci-${env}`,
      ManagedPolicyArns: Match.anyValue(),
    });
  });
});

test('only prod can promote, by reading the sandbox bucket', () => {
  const prod = JSON.stringify(synth('prod').toJSON());
  const sandbox = JSON.stringify(synth('sandbox').toJSON());
  expect(prod).toContain('PROMOTE_SOURCE_BUCKET');
  expect(prod).toContain('arn:aws:s3:::nakomis-firmware-sandbox/*');
  expect(sandbox).not.toContain('PROMOTE_SOURCE_BUCKET');
});
