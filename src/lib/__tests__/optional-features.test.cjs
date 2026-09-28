const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

test('all new optional capabilities require an explicit boolean opt-in', async () => {
  let config = { SiteConfig: {} };
  const load = createSourceLoader({
    './config': { getConfig: async () => config },
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options.status }) } },
  });
  const { OPTIONAL_FEATURES, isOptionalFeatureEnabled } = load('optional-features.ts');
  const { optionalFeatureUnavailable } = load('optional-features.server.ts');
  assert.equal(Object.hasOwn(OPTIONAL_FEATURES, 'EnableWatchRoomScreen'), false);
  assert.equal(Object.hasOwn(OPTIONAL_FEATURES, 'EnableWatchRoomLive'), false);
  for (const feature of Object.keys(OPTIONAL_FEATURES)) {
    assert.equal(isOptionalFeatureEnabled(config, feature), false);
    assert.equal((await optionalFeatureUnavailable(feature)).status, 403);
    config = { SiteConfig: { [feature]: 'true' } };
    assert.equal((await optionalFeatureUnavailable(feature)).status, 403);
    config = { SiteConfig: { [feature]: true } };
    assert.equal(await optionalFeatureUnavailable(feature), null);
    config = { SiteConfig: {} };
  }
});
