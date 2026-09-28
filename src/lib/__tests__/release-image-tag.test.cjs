const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const workflow = readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/docker-image.yml'),
  'utf8',
);

function releaseValues(version) {
  const outputs = { image: 'ghcr.io/example/miaotv' };
  // Execute the workflow's Node expressions with fixture package metadata.
  // This never invokes Docker, a shell, or a registry.
  for (const [, name, expression] of workflow.matchAll(
    /echo "(version|image_tag)=\$\(node -p "([^"]+)"\)"/g,
  )) {
    outputs[name] = runInNewContext(expression, {
      require(file) {
        assert.equal(file, './package.json');
        return { version };
      },
    });
  }
  return (value) =>
    value.replace(/\$\{\{ steps\.policy\.outputs\.(\w+) \}\}/g, (_, name) => {
      assert.ok(Object.hasOwn(outputs, name), `Missing policy output: ${name}`);
      return outputs[name];
    });
}

for (const [version, tag] of [
  ['6.6.6', '6.6.6'],
  ['6.6.6+1', '6.6.6-1'],
  ['6.6.7-rc.1', '6.6.7-rc.1'],
  ['6.6.7+build.2', '6.6.7-build.2'],
]) {
  test(`release ${version} builds, verifies and inspects the same valid image tag`, () => {
    const expand = releaseValues(version);
    const expectedImage = `ghcr.io/example/miaotv:${tag}`;
    const versionTag = workflow.match(
      /type=raw,value=(\$\{\{ steps\.policy\.outputs\.\w+ \}\})/,
    );
    assert.ok(versionTag, 'A versioned metadata tag is required');
    const imageName = workflow.match(/^\s+images: (.+)$/m);
    assert.ok(imageName);
    assert.equal(
      `${expand(imageName[1])}:${expand(versionTag[1])}`,
      expectedImage,
    );
    for (const name of ['SMOKE_IMAGE', 'VERSIONED_IMAGE']) {
      const reference = workflow.match(new RegExp(`^\\s+${name}: (.+)$`, 'm'));
      assert.ok(reference, `${name} must reference the built image`);
      assert.equal(expand(reference[1]), expectedImage);
    }
    assert.match(tag, /^[\w][\w.-]{0,127}$/);
    const label = workflow.match(/org\.opencontainers\.image\.version=(.+)/);
    assert.ok(label);
    assert.equal(
      expand(label[1]),
      version,
      'OCI version retains build metadata',
    );
  });
}
