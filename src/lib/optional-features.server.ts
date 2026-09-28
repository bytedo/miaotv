import { NextResponse } from 'next/server';

import { getConfig } from './config';
import {
  isOptionalFeatureEnabled,
  OPTIONAL_FEATURES,
  type OptionalFeature,
} from './optional-features';

export async function optionalFeatureUnavailable(feature: OptionalFeature) {
  if (isOptionalFeatureEnabled(await getConfig(), feature)) return null;
  return NextResponse.json(
    { error: `${OPTIONAL_FEATURES[feature]}尚未启用` },
    { status: 403 },
  );
}
