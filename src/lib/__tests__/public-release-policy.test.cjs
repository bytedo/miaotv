const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { shouldPublish } = require('../../../scripts/public-release-policy.cjs');

const requested = {
  REPOSITORY: 'bytedo/miaotv',
  EVENT_NAME: 'workflow_dispatch',
  GIT_REF: 'refs/heads/main',
  INPUT_PUBLISH: 'true',
};

test('only an explicit request on the public main branch publishes an image', () => {
  assert.equal(shouldPublish(requested), true);
  for (const change of [
    { REPOSITORY: 'example/development' },
    { REPOSITORY: 'example/fork' },
    { EVENT_NAME: 'pull_request' },
    { EVENT_NAME: 'push' },
    { GIT_REF: 'refs/heads/feature' },
    { GIT_REF: 'refs/tags/v1' },
    { INPUT_PUBLISH: 'false' },
    { INPUT_PUBLISH: '' },
    { INPUT_PUBLISH: undefined },
  ]) {
    assert.equal(shouldPublish({ ...requested, ...change }), false);
  }
  assert.equal(shouldPublish({}), false);
});

test('the image workflow uses the publication guard for registry writes', () => {
  const workflow = readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/docker-image.yml'),
    'utf8',
  );
  assert.match(workflow, /node scripts\/public-release-policy\.cjs/);
  assert.match(workflow, /INPUT_PUBLISH: \$\{\{ inputs\.publish_image \}\}/);
  for (const step of [
    'Registry login',
    'Publish verified image and save digest',
    'Upload published digest',
  ]) {
    assert.ok(
      workflow.includes(
        `- name: ${step}\n        if: steps.policy.outputs.publish == 'true'`,
      ),
    );
  }
});
