'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

export interface SearchSuggestion {
  text: string;
  type: 'related';
}

export function searchSuggestionsQueryOptions(query: string) {
  const search = query.trim();
  return queryOptions({
    queryKey: ['searchSuggestions', search] as const,
    queryFn: async ({ signal }): Promise<SearchSuggestion[]> => {
      if (!search) return [];
      const response = await fetch(
        `/api/search/suggestions?q=${encodeURIComponent(search)}`,
        { signal },
      );
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data.suggestions)) return [];
      return data.suggestions
        .filter((item: { text?: unknown }) => typeof item?.text === 'string')
        .map((item: { text: string }) => ({ text: item.text, type: 'related' as const }));
    },
    enabled: search.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useSearchSuggestionsQuery(query: string, enabled: boolean) {
  // Detach from the previous query when hidden so its fetch is also aborted.
  return useQuery(searchSuggestionsQueryOptions(enabled ? query : ''));
}
