import ipaddr from 'ipaddr.js';

import type { AdminConfig } from './admin.types';

export function isIPInTrustedRange(address: string, range: string): boolean {
  try {
    const client = ipaddr.process(address);
    if (range === '*') return true;
    if (range.includes('/')) {
      const [network, prefix] = ipaddr.parseCIDR(range);
      return client.kind() === network.kind() && client.match(network, prefix);
    }
    const expected = ipaddr.process(range);
    return client.kind() === expected.kind() && client.toNormalizedString() === expected.toNormalizedString();
  } catch { return false; }
}

export function isRequestFromTrustedNetwork(request: Request, config: AdminConfig): boolean {
  const environment = process.env.TRUSTED_NETWORK_IPS;
  const rules = environment
    ? { enabled: true, trustedIPs: environment.split(',').map((value) => value.trim()).filter(Boolean) }
    : config.TrustedNetworkConfig;
  if (!rules?.enabled || !rules.trustedIPs.length) return false;
  const peer = (request as Request & { ip?: string }).ip;
  // Next's web Request has no socket address. Forwarded headers are usable
  // only when the operator explicitly trusts an ingress that overwrites them.
  const forwarded = process.env.TRUST_PROXY_HEADERS === 'true'
    ? request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || request.headers.get('cf-connecting-ip')
    : undefined;
  const address = peer || forwarded;
  return !!address && rules.trustedIPs.some((range) => isIPInTrustedRange(address, range.trim()));
}
