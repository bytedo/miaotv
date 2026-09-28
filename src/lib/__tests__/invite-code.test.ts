// Run with Node's test runner. The loader never imports db.ts, Next or .env.
// These tests cover the client/Lua protocol; they do not simulate Lua internals.
const inviteTestAssert = require('node:assert/strict');
const inviteTestFs = require('node:fs');
const inviteTestPath = require('node:path');
const { test: inviteTest } = require('node:test');
const inviteTestTs = require(
  process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript',
);

function loadInviteCodeForTest(client: unknown) {
  const inviteSourceCache = new Map<string, { exports: any }>();
  const fakeDb = { storage: client === null ? {} : { client } };

  function loadSource(file: string): any {
    if (inviteSourceCache.has(file))
      return inviteSourceCache.get(file)!.exports;
    const filename = inviteTestPath.resolve(__dirname, '..', file);
    const result = inviteTestTs.transpileModule(
      inviteTestFs.readFileSync(filename, 'utf8'),
      {
        fileName: filename,
        reportDiagnostics: true,
        compilerOptions: {
          target: inviteTestTs.ScriptTarget.ES2022,
          module: inviteTestTs.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
      },
    );
    const errors = result.diagnostics.filter(
      (item: any) => item.category === inviteTestTs.DiagnosticCategory.Error,
    );
    inviteTestAssert.deepEqual(errors, []);
    const loaded = { exports: {} as any };
    inviteSourceCache.set(file, loaded);
    const requireSource = (request: string) => {
      if (request === './db') return { db: fakeDb };
      if (request === './redis-compat') return loadSource('redis-compat.ts');
      if (request === './user-identity') return loadSource('user-identity.ts');
      if (request === './invite-code-policy')
        return loadSource('invite-code-policy.ts');
      if (request === 'nanoid')
        return { customAlphabet: () => () => 'ABCDEFGH' };
      if (request === 'crypto') return require('node:crypto');
      throw new Error(
        'Unexpected source import in isolated invite test: ' + request,
      );
    };
    new Function('require', 'module', 'exports', result.outputText)(
      requireSource,
      loaded,
      loaded.exports,
    );
    return loaded.exports;
  }
  return loadSource('invite-code.ts');
}

function inviteEvalClient(kind: 'node-redis' | 'upstash', replies: unknown[]) {
  const calls: unknown[][] = [];
  const marker = {};
  const client: Record<string, any> = {
    marker,
    eval: async function (...args: unknown[]) {
      inviteTestAssert.equal(
        this.marker,
        marker,
        'raw client receiver must be preserved',
      );
      calls.push(args);
      const response = replies.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  client[kind === 'node-redis' ? 'hGetAll' : 'hgetall'] = () => {
    throw new Error('Reservation must not perform separate client-side reads');
  };
  return { client, calls };
}

for (const kind of ['node-redis', 'upstash'] as const) {
  inviteTest(
    kind +
      ': one EVAL owns validation, increment and history using the original namespace',
    async () => {
      const fake = inviteEvalClient(kind, [[1, 1, 3]]);
      const source = loadInviteCodeForTest(fake.client);
      inviteTestAssert.equal(
        await source.useInviteCode(' abcdefgh ', 'new-user', 'request-1'),
        true,
      );
      inviteTestAssert.equal(fake.calls.length, 1);
      const [script, options, values] = fake.calls[0] as any[];
      inviteTestAssert.equal(typeof script, 'string');
      const keys = [
        'invite:ABCDEFGH',
        'invites:active',
        'invite:ABCDEFGH:users',
      ];
      const args = ['ABCDEFGH', 'new-user', 'request-1'];
      if (kind === 'node-redis') {
        inviteTestAssert.deepEqual(options, { keys, arguments: args });
        inviteTestAssert.equal(values, undefined);
      } else {
        inviteTestAssert.deepEqual(options, keys);
        inviteTestAssert.deepEqual(values, args);
      }
    },
  );
}

inviteTest(
  'final-slot retry can acknowledge the same server reservation without a separate active-set check',
  async () => {
    const fake = inviteEvalClient('node-redis', [
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const source = loadInviteCodeForTest(fake.client);
    inviteTestAssert.equal(
      await source.useInviteCode('ABCDEFGH', 'member', 'same-attempt'),
      true,
    );
    inviteTestAssert.equal(
      await source.useInviteCode('ABCDEFGH', 'member', 'same-attempt'),
      true,
    );
    inviteTestAssert.deepEqual(fake.calls[0], fake.calls[1]);
  },
);

for (const reason of [
  'NOT_FOUND',
  'DISABLED',
  'EXPIRED',
  'USED_UP',
  'INVALID_DATA',
  'ATTEMPT_CONFLICT',
  'ATTEMPT_RELEASED',
]) {
  inviteTest(
    'server rejects ' +
      reason +
      ': use throws and cannot report registration success',
    async () => {
      const fake = inviteEvalClient('node-redis', [[0, reason]]);
      const source = loadInviteCodeForTest(fake.client);
      await inviteTestAssert.rejects(
        source.useInviteCode('ABCDEFGH', 'member', 'request'),
        (error: any) =>
          error instanceof source.InviteCodeError && error.code === reason,
      );
      inviteTestAssert.equal(fake.calls.length, 1);
    },
  );
}

inviteTest(
  'concurrent callers propagate the atomic server winner and every exhausted-slot rejection',
  async () => {
    // The fake supplies server decisions, not a second implementation of the Lua.
    const fake = inviteEvalClient('upstash', [
      [1, 1, 1],
      ...Array.from({ length: 19 }, () => [0, 'USED_UP']),
    ]);
    const source = loadInviteCodeForTest(fake.client);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        source.useInviteCode('ABCDEFGH', 'user-' + i, 'attempt-' + i),
      ),
    );
    inviteTestAssert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    inviteTestAssert.equal(
      results.filter((result) => result.status === 'rejected').length,
      19,
    );
    inviteTestAssert.equal(fake.calls.length, 20);
  },
);

inviteTest(
  'release sends the exact attempt and user; stale or repeated release is a no-op',
  async () => {
    const fake = inviteEvalClient('upstash', [
      [1],
      [0, 'NO_RESERVATION'],
      [0, 'NO_RESERVATION'],
    ]);
    const source = loadInviteCodeForTest(fake.client);
    inviteTestAssert.equal(
      await source.releaseInviteCode('ABCDEFGH', 'member', 'attempt-A'),
      true,
    );
    inviteTestAssert.equal(
      await source.releaseInviteCode('ABCDEFGH', 'member', 'attempt-A'),
      false,
    );
    inviteTestAssert.equal(
      await source.releaseInviteCode('ABCDEFGH', 'member', 'stale-attempt'),
      false,
    );
    inviteTestAssert.deepEqual(fake.calls[0][2], [
      'ABCDEFGH',
      'member',
      'attempt-A',
    ]);
    inviteTestAssert.deepEqual(fake.calls[2][2], [
      'ABCDEFGH',
      'member',
      'stale-attempt',
    ]);
  },
);

inviteTest(
  'missing receipt cannot be refunded and missing attempt fails before contacting the backend',
  async () => {
    const fake = inviteEvalClient('node-redis', [[0, 'NO_RESERVATION']]);
    const source = loadInviteCodeForTest(fake.client);
    inviteTestAssert.equal(
      await source.releaseInviteCode('ABCDEFGH', 'legacy-user', 'not-recorded'),
      false,
    );
    await inviteTestAssert.rejects(
      source.releaseInviteCode('ABCDEFGH', 'legacy-user', undefined),
      (error: any) => error.code === 'INVALID_RESERVATION',
    );
    inviteTestAssert.equal(fake.calls.length, 1);
  },
);

inviteTest(
  'corrupt data and transport failures cannot be reported as successful compensation',
  async () => {
    const transport = new Error('connection lost after sending EVAL');
    const fake = inviteEvalClient('node-redis', [
      [0, 'INVALID_DATA'],
      transport,
    ]);
    const source = loadInviteCodeForTest(fake.client);
    await inviteTestAssert.rejects(
      source.releaseInviteCode('ABCDEFGH', 'member', 'request'),
      (error: any) => error.code === 'INVALID_DATA',
    );
    await inviteTestAssert.rejects(
      source.releaseInviteCode('ABCDEFGH', 'member', 'request'),
      (error) => error === transport,
    );
    inviteTestAssert.equal(fake.calls.length, 2);
  },
);

inviteTest(
  'ambiguous consume failure is propagated without a non-atomic fallback or a second reservation',
  async () => {
    const transport = new Error('reply lost');
    const fake = inviteEvalClient('node-redis', [transport]);
    const source = loadInviteCodeForTest(fake.client);
    await inviteTestAssert.rejects(
      source.useInviteCode('ABCDEFGH', 'member', 'request'),
      (error) => error === transport,
    );
    inviteTestAssert.equal(fake.calls.length, 1);
  },
);

inviteTest('unknown or malformed EVAL replies fail closed', async () => {
  const fake = inviteEvalClient('node-redis', [null, 'OK', [true], [2], []]);
  const source = loadInviteCodeForTest(fake.client);
  for (let i = 0; i < 5; i++) {
    await inviteTestAssert.rejects(
      source.useInviteCode('ABCDEFGH', 'member', 'request'),
      (error: any) => error.code === 'INVALID_RESPONSE',
    );
  }
});

inviteTest(
  'SQLite/localstorage and clients without EVAL reject before any account can be created',
  async () => {
    const source = loadInviteCodeForTest(null);
    await inviteTestAssert.rejects(
      source.useInviteCode('ABCDEFGH', 'member', 'request'),
      (error: any) =>
        error.code === 'UNSUPPORTED_STORAGE' &&
        /Redis.*Upstash.*Kvrocks/.test(error.message),
    );
    await inviteTestAssert.rejects(
      source.validateInviteCode('ABCDEFGH'),
      (error: any) => error.code === 'UNSUPPORTED_STORAGE',
    );
    const noEval = loadInviteCodeForTest({ hGetAll: () => ({}) });
    await inviteTestAssert.rejects(
      noEval.useInviteCode('ABCDEFGH', 'member', 'request'),
      /EVAL/,
    );
  },
);

inviteTest(
  'the legacy two-argument consume API remains boolean and generates distinct attempt receipts',
  async () => {
    const fake = inviteEvalClient('node-redis', [
      [1, 1, 3],
      [1, 2, 3],
    ]);
    const source = loadInviteCodeForTest(fake.client);
    inviteTestAssert.equal(
      await source.useInviteCode('ABCDEFGH', 'member'),
      true,
    );
    inviteTestAssert.equal(
      await source.useInviteCode('ABCDEFGH', 'member'),
      true,
    );
    const first = (fake.calls[0][1] as any).arguments[2];
    const second = (fake.calls[1][1] as any).arguments[2];
    inviteTestAssert.match(first, /^[0-9a-f-]{36}$/);
    inviteTestAssert.notEqual(first, second);
  },
);

inviteTest(
  'reservation metadata leaves the existing admin statistics shape and legacy users unchanged',
  async () => {
    const rawInvite = {
      code: 'ABCDEFGH',
      createdBy: 'admin',
      createdAt: String(Date.now() - 1000),
      maxUses: '3',
      currentUses: '2',
      expiresAt: String(Date.now() + 60000),
      disabled: 'false',
      '__reservation:request-1': JSON.stringify({
        username: 'new-user',
        status: 'reserved',
      }),
      '__reservation:released-request': JSON.stringify({
        username: 'retry-user',
        status: 'released',
      }),
    };
    const source = loadInviteCodeForTest({
      hgetall: async () => rawInvite,
      lrange: async () => ['new-user', 'legacy-user'],
    });
    const stats = await source.getInviteCodeStats('ABCDEFGH');
    inviteTestAssert.equal(stats.currentUses, 2);
    inviteTestAssert.equal(stats.remainingUses, 1);
    inviteTestAssert.deepEqual(stats.users, ['new-user', 'legacy-user']);
    inviteTestAssert.equal(stats.status, 'active');
    inviteTestAssert.equal(
      Object.keys(stats).some((key) => key.startsWith('__reservation:')),
      false,
    );
  },
);
