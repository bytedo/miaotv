import { request as httpsRequest } from 'https';
import { isIP } from 'net';

interface ProxyDnsAddress {
  address: string;
  family: 4 | 6;
}

interface DnsAnswer {
  records: ProxyDnsAddress[];
  ttl: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 256;
const LOOKUP_TIMEOUT_MS = 5000;
const cache = new Map<string, DnsAnswer & { expiresAt: number }>();
const pending = new Map<string, Promise<DnsAnswer>>();

export function isProxyFakeIp(address: string): boolean {
  const parts = address.split('.');
  return (
    isIP(address) === 4 &&
    parts[0] === '198' &&
    (parts[1] === '18' || parts[1] === '19')
  );
}

function parseDnsAnswer(value: unknown): DnsAnswer {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid DNS JSON response');
  const response = value as Record<string, unknown>;
  if (response.Status !== 0 || response.TC === true)
    throw new Error('DNS over HTTPS did not return a complete answer');
  const answers = response.Answer === undefined ? [] : response.Answer;
  const authority = response.Authority === undefined ? [] : response.Authority;
  if (!Array.isArray(answers) || !Array.isArray(authority))
    throw new Error('Invalid DNS JSON records');

  const records: ProxyDnsAddress[] = [];
  for (const answer of answers) {
    if (
      !answer ||
      !Number.isInteger(answer.type) ||
      typeof answer.data !== 'string'
    )
      throw new Error('Invalid DNS JSON record');
    if (answer.type === 1 || answer.type === 28) {
      const family = answer.type === 1 ? 4 : 6;
      if (isIP(answer.data) !== family)
        throw new Error('Invalid DNS address record');
      records.push({ address: answer.data, family });
    }
  }

  // Alias TTLs also constrain positive answers. For a missing address family,
  // use the resolver's authority TTL; without one, do not cache the result.
  const ttlRecords = records.length
    ? answers
    : authority.length
      ? [...answers, ...authority]
      : [];
  const ttl = ttlRecords.length
    ? Math.min(
        300,
        ...ttlRecords.map((record) =>
          Number.isSafeInteger(record?.TTL) && record.TTL > 0 ? record.TTL : 0,
        ),
      )
    : 0;
  return { records, ttl };
}

function queryDns(
  endpoint: URL,
  hostname: string,
  type: 'A' | 'AAAA',
  signal: AbortSignal,
): Promise<DnsAnswer> {
  const url = new URL(endpoint);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', type);
  return new Promise((resolve, reject) => {
    // This explicitly configured resolver is the TLS-authenticated trust root.
    // Native https does not follow redirects or recurse through proxy DNS.
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/dns-json',
          'Accept-Encoding': 'identity',
        },
        rejectUnauthorized: true,
        signal,
      },
      (incoming) => {
        incoming.on('error', reject);
        incoming.on('aborted', () =>
          reject(new Error('DNS over HTTPS response was interrupted')),
        );
        if (incoming.statusCode !== 200) {
          incoming.destroy();
          reject(new Error('DNS over HTTPS request was unsuccessful'));
          return;
        }
        if (Number(incoming.headers['content-length']) > MAX_RESPONSE_BYTES) {
          incoming.destroy();
          reject(new Error('DNS over HTTPS response is too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            incoming.destroy();
            reject(new Error('DNS over HTTPS response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new Error('Invalid DNS JSON response'));
            return;
          }
          try {
            resolve(parseDnsAnswer(json));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function lookupDns(endpoint: URL, hostname: string): Promise<DnsAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const answers = await Promise.all([
      queryDns(endpoint, hostname, 'A', controller.signal),
      queryDns(endpoint, hostname, 'AAAA', controller.signal),
    ]);
    const records = Array.from(
      new Map(
        answers.flatMap((answer) =>
          answer.records.map((record) => [record.address, record] as const),
        ),
      ).values(),
    );
    if (!records.length)
      throw new Error('DNS over HTTPS returned no address records');
    return { records, ttl: Math.min(...answers.map((answer) => answer.ttl)) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function resolveProxyDnsOverHttps(
  hostname: string,
  endpointValue: string,
): Promise<ProxyDnsAddress[]> {
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('Invalid PROXY_DNS_OVER_HTTPS endpoint');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('PROXY_DNS_OVER_HTTPS requires HTTPS without URL credentials');
  endpoint.hash = '';
  const key = `${endpoint.href}\n${hostname}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.records.map((record) => ({ ...record }));
  }
  cache.delete(key);
  let lookup = pending.get(key);
  if (!lookup) {
    if (pending.size >= MAX_CACHE_ENTRIES)
      throw new Error('Too many concurrent proxy DNS lookups');
    lookup = lookupDns(endpoint, hostname).then((answer) => {
      if (answer.ttl > 0) {
        if (cache.size >= MAX_CACHE_ENTRIES)
          cache.delete(cache.keys().next().value!);
        cache.set(key, {
          ...answer,
          expiresAt: Date.now() + answer.ttl * 1000,
        });
      }
      return answer;
    });
    pending.set(key, lookup);
  }
  try {
    const answer = await lookup;
    return answer.records.map((record) => ({ ...record }));
  } finally {
    if (pending.get(key) === lookup) pending.delete(key);
  }
}
