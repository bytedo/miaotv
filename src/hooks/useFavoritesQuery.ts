'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import { type Favorite, getAllFavorites } from '@/lib/db.client';

// Every view reads the same Record cache so optimistic writes reach all cards.
export const favoritesQueryOptions = queryOptions({
  queryKey: ['favorites'] as const,
  queryFn: (): Promise<Record<string, Favorite>> => getAllFavorites(),
  staleTime: 5 * 60 * 1000,
  gcTime: 10 * 60 * 1000,
  retry: 1,
});

export function useFavoritesQuery(options?: { enabled?: boolean }) {
  return useQuery({ ...favoritesQueryOptions, enabled: options?.enabled });
}

const selectFavoritesArray = (favorites: Record<string, Favorite>) =>
  Object.entries(favorites)
    .map(([key, favorite]) => ({ ...favorite, key }))
    .sort((a, b) => b.save_time - a.save_time);

export function useFavoritesArrayQuery(options?: { enabled?: boolean }) {
  return useQuery({
    ...favoritesQueryOptions,
    enabled: options?.enabled,
    select: selectFavoritesArray,
  });
}

export function useIsFavoritedQuery(
  source: string,
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...favoritesQueryOptions,
    enabled: (options?.enabled ?? true) && !!source && !!id,
    select: (favorites) => !!favorites[source + '+' + id],
  });
}
