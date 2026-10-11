#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNTS, type DeployEnv } from '../lib/env-config';
import { FleetStack } from '../lib/fleet-stack';

const app = new cdk.App();
const deployEnv = (process.env.NPM_ENVIRONMENT ?? 'sandbox') as DeployEnv;
const env = ACCOUNTS[deployEnv];

new FleetStack(app, 'NakomisFleetStack', {
  env,
  deployEnv,
  githubOidcProviderArn: `arn:aws:iam::${env.account}:oidc-provider/token.actions.githubusercontent.com`,
});

cdk.Tags.of(app).add('MH-Project', 'nakomis-fleet');
