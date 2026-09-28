const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const converter = path.resolve(
  __dirname,
  '../../../scripts/convert-changelog.js',
);

function convertFixture(t, entries, version, githubActions = false) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, 'miaotv-changelog-version-'),
  );
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('miaotv-changelog-version-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const libDirectory = path.join(directory, 'src/lib');
  fs.mkdirSync(libDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'CHANGELOG'),
    entries
      .map(
        (entry) => `## [${entry.version}] - ${entry.date}

### Added

${entry.added.map((item) => `- ${item}`).join('\n')}

### Changed

${entry.changed.map((item) => `- ${item}`).join('\n')}

### Fixed

${entry.fixed.map((item) => `- ${item}`).join('\n')}
`,
      )
      .join('\n'),
  );
  fs.writeFileSync(path.join(directory, 'VERSION.txt'), version);
  fs.writeFileSync(
    path.join(libDirectory, 'version.ts'),
    "const CURRENT_VERSION = '6.6.6';\nexport { CURRENT_VERSION };\n",
  );
  const env = { GITHUB_ACTIONS: String(githubActions) };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, [converter], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const load = createSourceLoader();
  return {
    entries: load(path.join(libDirectory, 'changelog.ts')).changelog,
    version: load(path.join(libDirectory, 'version.ts')).CURRENT_VERSION,
    versionTxt: fs
      .readFileSync(path.join(directory, 'VERSION.txt'), 'utf8')
      .trim(),
  };
}

const releaseEntry = (version) => ({
  version,
  date: '2026-09-23',
  added: [`Added in ${version}`],
  changed: [`Changed in ${version}`],
  fixed: [`Fixed in ${version}`],
});

test('changelog conversion archives ordinary and numeric-suffix releases separately', (t) => {
  const entries = ['6.6.7', '6.6.6+10', '6.6.6+2', '6.6.6+1', '6.6.6'].map(
    releaseEntry,
  );
  const result = convertFixture(t, entries, '6.6.7');
  assert.deepEqual(result.entries, entries);
  assert.equal(result.version, '6.6.7');
  assert.equal(result.versionTxt, '6.6.7');
});

test('local conversion preserves the complete hotfix version for UI matching', (t) => {
  const entries = ['6.6.6+1', '6.6.6'].map(releaseEntry);
  const result = convertFixture(t, entries, '6.6.6+1');
  assert.deepEqual(result.entries, entries);
  assert.equal(result.version, '6.6.6+1');
  assert.equal(result.versionTxt, '6.6.6+1');
  assert.equal(result.entries[0].version, result.version);
});

for (const initialVersion of ['6.6.6', '6.6.6+1']) {
  test(`Actions conversion synchronizes ${initialVersion} to the latest hotfix without dropping its suffix`, (t) => {
    const entries = ['6.6.6+1', '6.6.6'].map(releaseEntry);
    const result = convertFixture(t, entries, initialVersion, true);
    assert.deepEqual(result.entries, entries);
    assert.equal(result.versionTxt, '6.6.6+1');
    assert.equal(result.version, '6.6.6+1');
  });
}
