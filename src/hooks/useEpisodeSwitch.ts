import { useCallback, useEffect, useRef, useState } from 'react';

export type EpisodeSwitchTicket = { index: number };

// A ref takes the lock synchronously, before React renders the spinner. A ticket
// prevents an old promise or timeout from releasing a newer episode's lock.
export function useEpisodeSwitch(timeoutMs = 30000) {
  const [switchingEpisodeIndex, setSwitchingEpisodeIndex] = useState<number | null>(null);
  const episodeSwitchRef = useRef<EpisodeSwitchTicket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finishEpisodeSwitch = useCallback((ticket: EpisodeSwitchTicket | null) => {
    if (!ticket || episodeSwitchRef.current !== ticket) return;
    episodeSwitchRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setSwitchingEpisodeIndex(null);
  }, []);

  const cancelEpisodeSwitch = useCallback(() => finishEpisodeSwitch(episodeSwitchRef.current), [finishEpisodeSwitch]);
  const beginEpisodeSwitch = useCallback((index: number) => {
    if (episodeSwitchRef.current !== null || !Number.isInteger(index) || index < 0) return null;
    const ticket = { index };
    episodeSwitchRef.current = ticket;
    setSwitchingEpisodeIndex(index);
    timerRef.current = setTimeout(() => finishEpisodeSwitch(ticket), timeoutMs);
    return ticket;
  }, [finishEpisodeSwitch, timeoutMs]);

  useEffect(() => () => {
    episodeSwitchRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { switchingEpisodeIndex, episodeSwitchRef, beginEpisodeSwitch, finishEpisodeSwitch, cancelEpisodeSwitch };
}
