import { redirect } from 'next/navigation';

import { getRegistrationPolicy } from '@/lib/account-policy';
import { getConfig } from '@/lib/config';

import RegisterPageClient from './RegisterPageClient';

export default async function RegisterPage() {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  ) {
    redirect('/login');
  }
  const config = await getConfig();
  return <RegisterPageClient {...getRegistrationPolicy(config.UserConfig)} />;
}
