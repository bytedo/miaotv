'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { RegistrationPolicy } from '@/lib/account-policy';
import {
  REGISTRATION_POLICY_EVENT,
  REGISTRATION_POLICY_STORAGE_KEY,
} from '@/lib/registration-policy-events';

export const registrationPolicyQueryOptions = queryOptions({
  queryKey: ['registration-policy'],
  queryFn: async ({ signal }): Promise<RegistrationPolicy> => {
    const response = await fetch('/api/server-config', {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error('无法获取注册设置，请稍后重试');
    const data = await response.json();
    if (
      typeof data.allowRegister !== 'boolean' ||
      typeof data.requireApproval !== 'boolean' ||
      typeof data.requireInviteCode !== 'boolean'
    ) {
      throw new Error('注册设置无效，请刷新页面后重试');
    }
    return {
      allowRegister: data.allowRegister,
      requireApproval: data.requireApproval,
      requireInviteCode: data.requireInviteCode,
    };
  },
  staleTime: 0,
  refetchOnMount: 'always',
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
  refetchInterval: 15_000,
  retry: 1,
});

export function useRegistrationPolicy(initialPolicy?: RegistrationPolicy) {
  const query = useQuery({
    ...registrationPolicyQueryOptions,
    initialData: initialPolicy,
    initialDataUpdatedAt: 0,
  });
  const { refetch } = query;

  useEffect(() => {
    const refresh = () => {
      void refetch();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === REGISTRATION_POLICY_STORAGE_KEY) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener(REGISTRATION_POLICY_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener(REGISTRATION_POLICY_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [refetch]);

  return query;
}
