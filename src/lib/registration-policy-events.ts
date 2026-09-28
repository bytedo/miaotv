export const REGISTRATION_POLICY_EVENT = 'registrationPolicyChanged';
export const REGISTRATION_POLICY_STORAGE_KEY =
  'miaotv:registration-policy-updated';

/** Announce a saved change; every page still reads the policy from the server. */
export function notifyRegistrationPolicyChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(REGISTRATION_POLICY_EVENT));
  try {
    window.localStorage.setItem(
      REGISTRATION_POLICY_STORAGE_KEY,
      `${Date.now()}:${Math.random()}`,
    );
  } catch {
    // Focus and interval refreshes remain available when storage is disabled.
  }
}
