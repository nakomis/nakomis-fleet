export type DeployEnv = 'sandbox' | 'prod';

export const ACCOUNTS: Record<DeployEnv, { account: string; region: string }> = {
  sandbox: { account: '975050268859', region: 'eu-west-2' },
  prod: { account: '637423226886', region: 'eu-west-2' },
};

export const ZONES: Record<DeployEnv, { zoneName: string; hostedZoneId: string }> = {
  sandbox: { zoneName: 'sandbox.nakomis.com', hostedZoneId: 'Z03586633NXU18LFL0JTL' },
  prod: { zoneName: 'nakomis.com', hostedZoneId: 'Z019437529YGFB53BDUGR' },
};

