const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectDirectory = path.resolve(__dirname, '../../..');
const launcher = path.join(projectDirectory, 'scripts/dev-local.cjs');

// Each loader gets a fresh process so @next/env cannot reuse its initial-env
// cache. Only synthetic fixtures are loaded; real project environment files and
// application modules are never imported by these tests.
function childEnvironment(overrides = {}) {
  const env = { NODE_ENV: 'production', USERNAME: 'fixture_windows_user' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function fixture(t, files = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, 'miaotv-dev-local-'),
  );
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('miaotv-dev-local-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), contents);
  }
  return directory;
}

const loadScript = `
  (async () => {
    try {
      const { loadLocalDevEnvironment } = require(process.argv[1]);
      const env = await loadLocalDevEnvironment(process.argv[2]);
      const keys = JSON.parse(process.argv[3]);
      const values = Object.fromEntries(keys.map(key => [key, env[key] ?? null]));
      process.stdout.write(JSON.stringify(values) + '\\n');
    } catch (error) {
      process.stderr.write(String(error.message) + '\\n');
      process.exitCode = 1;
    }
  })();
`;

function loadFixture(
  directory,
  overrides = {},
  keys = ['USERNAME', 'NODE_ENV'],
) {
  return spawnSync(
    process.execPath,
    ['-e', loadScript, launcher, directory, JSON.stringify(keys)],
    {
      cwd: projectDirectory,
      env: childEnvironment(overrides),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
}

function output(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('local development loads the project owner instead of inherited Windows USERNAME', (t) => {
  const directory = fixture(t, { '.env.local': 'USERNAME=admin\n' });
  assert.deepEqual(output(loadFixture(directory)), {
    USERNAME: 'admin',
    NODE_ENV: 'development',
  });
});

test('local owner selection follows the Next development environment file precedence', async (t) => {
  const files = [
    '.env.development.local',
    '.env.local',
    '.env.development',
    '.env',
  ];
  for (let selected = 0; selected < files.length; selected += 1) {
    await t.test(files[selected], (t) => {
      const directory = fixture(
        t,
        Object.fromEntries(
          files.map((file, index) => [
            file,
            index < selected
              ? 'NEXT_PUBLIC_SITE_NAME=fixture\n'
              : `USERNAME=owner_${index}\n`,
          ]),
        ),
      );
      assert.equal(
        output(loadFixture(directory)).USERNAME,
        `owner_${selected}`,
      );
    });
  }
});

test('local owner uses Next quoting, comments and environment expansion rules', (t) => {
  const directory = fixture(t, {
    '.env.local':
      'OWNER_SUFFIX=owner\nUSERNAME="dev_${OWNER_SUFFIX}" # fixture comment\n',
  });
  assert.equal(output(loadFixture(directory)).USERNAME, 'dev_owner');
});

test('local development rejects a missing or empty file owner instead of falling back to Windows', async (t) => {
  const cases = [
    ['no files', {}],
    [
      'unrelated variables',
      { '.env.local': 'NEXT_PUBLIC_SITE_NAME=fixture\n' },
    ],
    ['empty value', { '.env.local': 'USERNAME=\n' }],
    ['whitespace value', { '.env.local': 'USERNAME="   "\n' }],
  ];
  for (const [name, files] of cases) {
    await t.test(name, (t) => {
      const result = loadFixture(fixture(t, files));
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /USERNAME/);
      assert.equal(result.stdout, '');
    });
  }
});

test('local owner override preserves explicit environment values for other settings', (t) => {
  const directory = fixture(t, {
    '.env.local':
      'USERNAME=admin\nPASSWORD=file-fixture-password\nNEXT_PUBLIC_SITE_NAME=file-site\n',
  });
  const values = output(
    loadFixture(
      directory,
      {
        PASSWORD: 'explicit-fixture-password',
        NEXT_PUBLIC_SITE_NAME: 'explicit-site',
      },
      ['USERNAME', 'PASSWORD', 'NEXT_PUBLIC_SITE_NAME'],
    ),
  );
  assert.deepEqual(values, {
    USERNAME: 'admin',
    PASSWORD: 'explicit-fixture-password',
    NEXT_PUBLIC_SITE_NAME: 'explicit-site',
  });
});

test('local development reloads files despite an inherited Next processed-env marker', (t) => {
  const directory = fixture(t, { '.env.local': 'USERNAME=admin\n' });
  assert.equal(
    output(
      loadFixture(directory, {
        __NEXT_PROCESSED_ENV: 'true',
        NODE_ENV: 'test',
      }),
    ).USERNAME,
    'admin',
  );
});

const rejectHostScript = `
  const Module = require('node:module');
  const originalLoad = Module._load;
  let environmentLoads = 0;
  let serverSpawns = 0;
  Module._load = function(request, parent, isMain) {
    if (request === '@next/env') return {
      loadEnvConfig() { environmentLoads += 1; throw new Error('Unexpected environment loading'); },
    };
    if (request === 'node:child_process' || request === 'child_process') return {
      spawn() { serverSpawns += 1; throw new Error('Unexpected server spawn'); },
      spawnSync() { serverSpawns += 1; throw new Error('Unexpected server spawn'); },
    };
    if (/generate-manifest\\.js$/.test(request)) throw new Error('Unexpected manifest generation');
    return originalLoad.call(this, request, parent, isMain);
  };
  process.exit = code => { throw new Error('Unexpected process exit: ' + code); };
  (async () => {
    let message = '';
    try {
      const { startLocalDev } = require(process.argv[1]);
      await startLocalDev(JSON.parse(process.argv[2]));
    } catch (error) { message = String(error.message); }
    process.stdout.write(JSON.stringify({ environmentLoads, serverSpawns, message }) + '\\n');
    process.exitCode = 0;
  })();
`;

test('local launcher rejects hostname overrides before loading configuration or starting a server', async (t) => {
  for (const args of [
    ['--hostname', '0.0.0.0'],
    ['--hostname=0.0.0.0'],
    ['-H', '0.0.0.0'],
    ['-H0.0.0.0'],
  ]) {
    await t.test(args.join(' '), () => {
      const result = spawnSync(
        process.execPath,
        ['-e', rejectHostScript, launcher, JSON.stringify(args)],
        {
          cwd: projectDirectory,
          env: childEnvironment(),
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      const values = output(result);
      assert.equal(values.environmentLoads, 0);
      assert.equal(values.serverSpawns, 0);
      assert.match(values.message, /hostname|127\.0\.0\.1/);
    });
  }
});

const launchScript = `
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const originalLoad = Module._load;
  const child = new EventEmitter();
  child.kill = () => true;
  let launch;
  let manifestOwner;
  let fileValueForManifest;
  Module._load = function(request, parent, isMain) {
    if (request === '@next/env') return {
      loadEnvConfig() {
        Object.assign(process.env, {
          USERNAME: 'admin', FILE_ONLY_SETTING: 'file-fixture-value',
          __NEXT_PROCESSED_ENV: 'true',
        });
      },
    };
    if (request === 'node:child_process' || request === 'child_process') return {
      spawn(executable, args, options) {
        launch = {
          executable, args, cwd: options.cwd, stdio: options.stdio,
          windowsHide: options.windowsHide,
          environment: Object.fromEntries([
            'USERNAME', 'NODE_ENV', 'PASSWORD', 'NEXT_PUBLIC_SITE_NAME',
            '__NEXT_PROCESSED_ENV', 'FILE_ONLY_SETTING',
          ].map(key => [key, options.env[key] ?? null])),
        };
        return child;
      },
    };
    if (/generate-manifest\\.js$/.test(request)) {
      manifestOwner = process.env.USERNAME;
      fileValueForManifest = process.env.FILE_ONLY_SETTING;
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { startLocalDev } = require(process.argv[1]);
    startLocalDev(['--port', '3456', '--turbopack']);
    child.emit('exit', 0, null);
    process.stdout.write(JSON.stringify({ launch, manifestOwner, fileValueForManifest }) + '\\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\\n');
    process.exitCode = 1;
  }
`;

test('local launcher forwards CLI arguments and owner without freezing file settings in the Next child', () => {
  const result = spawnSync(process.execPath, ['-e', launchScript, launcher], {
    cwd: projectDirectory,
    env: childEnvironment({
      PASSWORD: 'explicit-fixture-password',
      NEXT_PUBLIC_SITE_NAME: 'explicit-site',
      __NEXT_PROCESSED_ENV: 'true',
    }),
    encoding: 'utf8',
    timeout: 10000,
  });
  const values = output(result);
  assert.equal(values.launch.executable, process.execPath);
  assert.match(values.launch.args[0], /next[\\/]dist[\\/]bin[\\/]next$/);
  assert.deepEqual(values.launch.args.slice(1), [
    'dev',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3456',
    '--turbopack',
  ]);
  assert.equal(values.launch.cwd, projectDirectory);
  assert.equal(values.launch.stdio, 'inherit');
  assert.equal(values.launch.windowsHide, true);
  assert.deepEqual(values.launch.environment, {
    USERNAME: 'admin',
    NODE_ENV: 'development',
    PASSWORD: 'explicit-fixture-password',
    NEXT_PUBLIC_SITE_NAME: 'explicit-site',
    __NEXT_PROCESSED_ENV: null,
    FILE_ONLY_SETTING: null,
  });
  assert.equal(values.manifestOwner, 'admin');
  assert.equal(values.fileValueForManifest, 'file-fixture-value');
});
