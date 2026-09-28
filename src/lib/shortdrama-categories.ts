import type { ShortDramaCategory } from './types';

export function isVisibleShortDramaCategory(category: ShortDramaCategory): boolean {
  return category.type_name?.trim() !== '擦边短剧';
}
