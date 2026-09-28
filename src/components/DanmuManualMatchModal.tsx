/* eslint-disable @next/next/no-img-element */
'use client';

import { Loader2, Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface DanmuManualSelection {
  animeId: number;
  animeTitle: string;
  episodeId: number;
  episodeTitle: string;
  episodeUrl?: string;
}

interface DanmuSearchEpisodeItem {
  episodeId: number;
  episodeTitle: string;
  url?: string;
}

interface DanmuSearchAnimeItem {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription?: string;
  imageUrl?: string;
  episodes: DanmuSearchEpisodeItem[];
}

interface DanmuManualMatchModalProps {
  isOpen: boolean;
  defaultKeyword: string;
  currentEpisode: number;
  onClose: () => void;
  onApply: (selection: DanmuManualSelection) => Promise<void> | void;
  portalContainer?: HTMLElement | null;
}

function buildAnimeMeta(anime: DanmuSearchAnimeItem): string {
  const parts = [anime.typeDescription, anime.type].filter(Boolean);
  if (parts.length === 0) return '未知类型';
  return parts.join(' / ');
}

export default function DanmuManualMatchModal({
  isOpen,
  defaultKeyword,
  currentEpisode,
  onClose,
  onApply,
  portalContainer,
}: DanmuManualMatchModalProps) {
  const [mounted, setMounted] = useState(false);
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DanmuSearchAnimeItem[]>([]);
  const [selectedAnimeId, setSelectedAnimeId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyingEpisodeId, setApplyingEpisodeId] = useState<number | null>(
    null,
  );
  const [episodeDescending, setEpisodeDescending] = useState(false);
  const [episodeViewMode, setEpisodeViewMode] = useState<'list' | 'grid'>(
    'list',
  );
  const [mobilePane, setMobilePane] = useState<'results' | 'episodes'>(
    'results',
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const episodesHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousMobilePaneRef = useRef(mobilePane);
  const episodeListRef = useRef<HTMLDivElement>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);
  const scopeRef = useRef(0);
  const titleId = useId();

  const selectedAnime = useMemo(
    () => results.find((item) => item.animeId === selectedAnimeId) || null,
    [results, selectedAnimeId],
  );

  const searchDanmuSource = useCallback(async (rawKeyword: string) => {
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    const normalizedKeyword = rawKeyword.trim();
    if (!normalizedKeyword) {
      setSearching(false);
      setError('请输入搜索关键词');
      setResults([]);
      setSelectedAnimeId(null);
      return;
    }

    const controller = new AbortController();
    searchControllerRef.current = controller;
    setSearching(true);
    setError(null);
    setMobilePane('results');
    try {
      const response = await fetch(
        `/api/danmu-external/search?keyword=${encodeURIComponent(normalizedKeyword)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const data = await response.json();
      if (
        controller.signal.aborted ||
        searchControllerRef.current !== controller
      )
        return;
      if (!response.ok || data?.code !== 200) {
        throw new Error(data?.message || `搜索失败: ${response.status}`);
      }

      const animes = Array.isArray(data?.animes)
        ? (data.animes as DanmuSearchAnimeItem[])
        : [];
      setResults(animes);

      if (animes.length === 0) {
        setSelectedAnimeId(null);
        setError('没有找到匹配的弹幕源，请尝试更换关键词');
        return;
      }

      setSelectedAnimeId((prev) => {
        if (prev && animes.some((item) => item.animeId === prev)) {
          return prev;
        }
        return animes[0].animeId;
      });
    } catch (err) {
      if (
        controller.signal.aborted ||
        searchControllerRef.current !== controller
      )
        return;
      setResults([]);
      setSelectedAnimeId(null);
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      if (searchControllerRef.current === controller) {
        searchControllerRef.current = null;
        setSearching(false);
      }
    }
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setKeyword(defaultKeyword || '');
    setResults([]);
    setSelectedAnimeId(null);
    setError(null);
    setApplyingEpisodeId(null);
    setSearching(false);
    setMobilePane('results');
    applyingRef.current = false;
    scopeRef.current += 1;
    if (defaultKeyword.trim()) void searchDanmuSource(defaultKeyword);

    return () => {
      scopeRef.current += 1;
      searchControllerRef.current?.abort();
      searchControllerRef.current = null;
    };
  }, [defaultKeyword, isOpen, currentEpisode, searchDanmuSource]);

  useEffect(() => {
    if (!mounted || !isOpen) return;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const previous = document.body.style.overflow;
    const previousRoot = document.documentElement.style.overflow;
    const mobileBreakpoint = window.matchMedia('(max-width: 767px)');
    const keepFocusInside = () => {
      const active = document.activeElement;
      const title = titleRef.current;
      if (!dialog || !title || active === title) return;
      // 旋转可能隐藏当前列并将焦点退回 body，内部 Tab 处理器无法接管它。
      if (!dialog.contains(active) || !active?.getClientRects().length) {
        title.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', keepFocusInside);
    mobileBreakpoint.addEventListener('change', keepFocusInside);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      mobileBreakpoint.removeEventListener('change', keepFocusInside);
      document.body.style.overflow = previous;
      document.documentElement.style.overflow = previousRoot;
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (document.activeElement === document.body ||
          dialog?.contains(document.activeElement))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [isOpen, mounted, portalContainer]);

  useEffect(() => {
    const changedPane = previousMobilePaneRef.current !== mobilePane;
    previousMobilePaneRef.current = mobilePane;
    if (
      !isOpen ||
      !changedPane ||
      !window.matchMedia('(max-width: 767px)').matches
    )
      return;
    const heading =
      mobilePane === 'episodes'
        ? episodesHeadingRef.current
        : resultsHeadingRef.current;
    heading?.focus({ preventScroll: true });
  }, [isOpen, mobilePane]);

  useEffect(() => {
    if (!isOpen) return;
    const list = episodeListRef.current;
    if (!list || !list.clientHeight) return;
    const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!current) {
      list.scrollTop = 0;
      return;
    }
    list.scrollTop +=
      current.getBoundingClientRect().top -
      list.getBoundingClientRect().top -
      (list.clientHeight - current.clientHeight) / 2;
  }, [
    isOpen,
    selectedAnime,
    mobilePane,
    currentEpisode,
    episodeViewMode,
    episodeDescending,
  ]);

  const applyEpisode = async (
    episode: DanmuSearchEpisodeItem,
    index: number,
  ) => {
    if (!selectedAnime || applyingRef.current) return;
    const scope = scopeRef.current;
    applyingRef.current = true;
    setApplyingEpisodeId(episode.episodeId);
    setError(null);
    try {
      await onApply({
        animeId: selectedAnime.animeId,
        animeTitle: selectedAnime.animeTitle,
        episodeId: episode.episodeId,
        episodeTitle: episode.episodeTitle || `第${index + 1}集`,
        episodeUrl: episode.url,
      });
    } catch (err) {
      if (scopeRef.current === scope) {
        setError(err instanceof Error ? err.message : '弹幕匹配失败，请重试');
      }
    } finally {
      if (scopeRef.current === scope) {
        applyingRef.current = false;
        setApplyingEpisodeId(null);
      }
    }
  };

  if (!mounted || !isOpen) return null;

  return createPortal(
    <>
      <div
        className='fixed inset-0 z-[1008] bg-black/65 backdrop-blur-sm'
        onClick={onClose}
      />
      {/* Mobile: full-screen sheet / Desktop: centered dialog */}
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        className='fixed inset-x-0 top-0 z-[1009] flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-gray-950/95 dark:bg-slate-950/95 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(90dvh,720px)] md:w-[min(96vw,1080px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-white/20 md:p-0 md:shadow-2xl [&_button]:touch-manipulation [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-[-2px] [&_button]:focus-visible:outline-green-400'
        onKeyDown={(event) => {
          // 按钮上的空格键只操作弹窗，避免同时触发播放器热键。
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === titleRef.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        {/* Header */}
        <div className='flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-2 sm:px-5 sm:py-3'>
          <div className='min-w-0'>
            <h2
              ref={titleRef}
              id={titleId}
              tabIndex={-1}
              className='text-base font-semibold text-white outline-none sm:text-lg'
            >
              手动匹配弹幕
            </h2>
            <p className='text-xs text-slate-400'>
              搜索番剧并指定集数，立即覆盖当前弹幕
            </p>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-300 transition hover:bg-white/10 hover:text-white'
            aria-label='关闭手动匹配弹窗'
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        {/* Search Bar */}
        <div className='shrink-0 border-b border-white/10 px-4 py-2 sm:px-5 sm:py-3'>
          <form
            className='flex min-w-0 gap-2'
            onSubmit={(event) => {
              event.preventDefault();
              if (applyingRef.current) return;
              if (window.matchMedia('(pointer: coarse)').matches) {
                titleRef.current?.focus({ preventScroll: true });
              }
              void searchDanmuSource(keyword);
            }}
          >
            <input
              type='search'
              name='danmu-keyword'
              aria-label='弹幕源搜索关键词'
              aria-describedby={error ? `${titleId}-error` : undefined}
              enterKeyHint='search'
              autoComplete='off'
              autoCapitalize='none'
              spellCheck={false}
              value={keyword}
              disabled={applyingEpisodeId !== null}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) {
                  event.preventDefault();
                }
              }}
              placeholder='输入标题关键词，例如：猫和老鼠…'
              className='h-11 min-w-0 flex-1 rounded-lg border border-white/15 bg-gray-900/80 px-3 text-base text-slate-100 outline-none transition focus:border-green-400 sm:text-sm'
            />
            <button
              type='submit'
              aria-label='搜索弹幕源'
              disabled={applyingEpisodeId !== null || !keyword.trim()}
              className='inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 text-sm font-medium text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60'
            >
              {searching ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <Search className='h-4 w-4' />
              )}
              <span className='hidden sm:inline'>搜索弹幕源</span>
            </button>
          </form>
          {error && (
            <p
              id={`${titleId}-error`}
              role='status'
              className='mt-2 break-words text-xs text-amber-300'
            >
              {error}
            </p>
          )}
        </div>

        <div
          className='grid shrink-0 grid-cols-2 gap-2 border-b border-white/10 px-4 py-2 md:hidden'
          role='group'
          aria-label='弹幕匹配步骤'
        >
          <button
            type='button'
            aria-pressed={mobilePane === 'results'}
            onClick={() => setMobilePane('results')}
            className={`min-h-11 rounded-lg px-2 text-sm font-medium ${mobilePane === 'results' ? 'bg-green-500/15 text-green-300' : 'text-slate-300 hover:bg-white/5'}`}
          >
            1. 选择弹幕源
          </button>
          <button
            type='button'
            aria-pressed={mobilePane === 'episodes'}
            disabled={!selectedAnime}
            onClick={() => setMobilePane('episodes')}
            className={`min-h-11 rounded-lg px-2 text-sm font-medium disabled:opacity-40 ${mobilePane === 'episodes' ? 'bg-green-500/15 text-green-300' : 'text-slate-300 hover:bg-white/5'}`}
          >
            2. 选择集数
          </button>
        </div>

        {/* 手机上逐步选择，避免先滚过所有番剧才能到达集数。 */}
        <div className='min-h-0 flex-1 overflow-hidden md:grid md:grid-cols-2'>
          {/* Left: Anime list */}
          <div
            className={`${mobilePane === 'results' ? 'flex' : 'hidden'} h-full min-h-0 min-w-0 flex-col md:flex md:border-r md:border-white/10`}
          >
            <h3
              ref={resultsHeadingRef}
              tabIndex={-1}
              aria-live='polite'
              className='shrink-0 border-b border-white/10 px-4 py-2 text-xs text-slate-400 outline-none sm:px-5'
            >
              {searching
                ? '正在搜索弹幕源…'
                : `搜索结果（${results.length} 个）`}
            </h3>
            <div
              className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4'
              aria-busy={searching}
            >
              {searching && results.length === 0 ? (
                <div className='rounded-lg border border-white/10 bg-white/5 p-4 text-center text-sm text-slate-300'>
                  正在搜索…
                </div>
              ) : results.length === 0 ? (
                <div className='rounded-lg border border-dashed border-white/15 bg-white/5 p-4 text-center text-sm text-slate-300'>
                  暂无结果
                </div>
              ) : (
                <div className='space-y-2'>
                  {results.map((anime) => (
                    <button
                      key={anime.animeId}
                      type='button'
                      aria-pressed={selectedAnimeId === anime.animeId}
                      disabled={applyingEpisodeId !== null}
                      onClick={() => {
                        setSelectedAnimeId(anime.animeId);
                        setMobilePane('episodes');
                      }}
                      className={`flex w-full min-w-0 items-center gap-3 rounded-lg border px-2.5 py-2.5 text-left transition ${
                        selectedAnimeId === anime.animeId
                          ? 'border-green-400/70 bg-green-500/15'
                          : 'border-white/10 bg-white/5 hover:bg-white/10'
                      }`}
                    >
                      <div className='h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800/80'>
                        {anime.imageUrl ? (
                          <img
                            width={40}
                            height={56}
                            loading='lazy'
                            decoding='async'
                            src={anime.imageUrl.replace(
                              /^http:\/\//,
                              'https://',
                            )}
                            alt={anime.animeTitle}
                            className='h-full w-full object-cover'
                            onError={(e) => {
                              const target = e.currentTarget;
                              target.style.display = 'none';
                              if (target.nextElementSibling) {
                                (
                                  target.nextElementSibling as HTMLElement
                                ).style.display = 'flex';
                              }
                            }}
                          />
                        ) : null}
                        <div
                          className='h-full w-full items-center justify-center text-[10px] text-slate-400'
                          style={{ display: anime.imageUrl ? 'none' : 'flex' }}
                        >
                          无封面
                        </div>
                      </div>
                      <div className='min-w-0 flex-1'>
                        <p className='truncate text-sm font-medium text-white'>
                          {anime.animeTitle}
                        </p>
                        <p className='mt-0.5 truncate text-xs text-slate-400'>
                          {buildAnimeMeta(anime)}
                        </p>
                        <p className='mt-0.5 text-[11px] text-slate-500'>
                          共 {anime.episodes.length} 集
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Episode list */}
          <div
            className={`${mobilePane === 'episodes' ? 'flex' : 'hidden'} h-full min-h-0 min-w-0 flex-col md:flex`}
          >
            <div className='flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-400 sm:px-4'>
              <h3
                ref={episodesHeadingRef}
                tabIndex={-1}
                className='min-w-0 flex-1 truncate outline-none'
                title={selectedAnime?.animeTitle}
              >
                {selectedAnime
                  ? `集数列表：${selectedAnime.animeTitle}`
                  : '集数列表'}
              </h3>
              {selectedAnime && selectedAnime.episodes.length > 0 && (
                <div className='flex items-center gap-2'>
                  {/* 倒序切换按钮 */}
                  <button
                    type='button'
                    onClick={() => setEpisodeDescending((prev) => !prev)}
                    aria-label={
                      episodeDescending ? '切换为正序集数' : '切换为倒序集数'
                    }
                    aria-pressed={episodeDescending}
                    className='flex h-11 w-11 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-green-400'
                    title={episodeDescending ? '切换正序' : '切换倒序'}
                  >
                    <svg
                      className='h-4 w-4'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth='2'
                        d='M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4'
                      />
                    </svg>
                  </button>
                  {/* 视图切换按钮 */}
                  <div className='flex items-center gap-1 rounded-md bg-gray-800/80 p-1'>
                    <button
                      type='button'
                      onClick={() => setEpisodeViewMode('list')}
                      title='列表视图'
                      aria-label='列表视图'
                      aria-pressed={episodeViewMode === 'list'}
                      className={`flex h-11 w-11 items-center justify-center rounded text-xs font-medium transition-colors ${
                        episodeViewMode === 'list'
                          ? 'bg-green-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <svg
                        className='h-3.5 w-3.5'
                        fill='none'
                        stroke='currentColor'
                        viewBox='0 0 24 24'
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          strokeWidth='2'
                          d='M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'
                        />
                      </svg>
                    </button>
                    <button
                      type='button'
                      onClick={() => setEpisodeViewMode('grid')}
                      title='格子视图'
                      aria-label='格子视图'
                      aria-pressed={episodeViewMode === 'grid'}
                      className={`flex h-11 w-11 items-center justify-center rounded text-xs font-medium transition-colors ${
                        episodeViewMode === 'grid'
                          ? 'bg-green-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <svg
                        className='h-3.5 w-3.5'
                        fill='none'
                        stroke='currentColor'
                        viewBox='0 0 24 24'
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          strokeWidth='2'
                          d='M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z'
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div
              ref={episodeListRef}
              className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4'
            >
              {!selectedAnime ? (
                <div className='rounded-lg border border-dashed border-white/15 bg-white/5 p-4 text-center text-sm text-slate-300'>
                  请先选择弹幕源
                </div>
              ) : selectedAnime.episodes.length === 0 ? (
                <div className='rounded-lg border border-dashed border-white/15 bg-white/5 p-4 text-center text-sm text-slate-300'>
                  此弹幕源暂无可用集数，请选择其他搜索结果
                </div>
              ) : (
                <>
                  {episodeViewMode === 'list' ? (
                    <div className='space-y-2'>
                      {(episodeDescending
                        ? [...selectedAnime.episodes].reverse()
                        : selectedAnime.episodes
                      ).map((ep, index) => {
                        const originalIndex = episodeDescending
                          ? selectedAnime.episodes.length - 1 - index
                          : index;
                        const currentMark =
                          originalIndex + 1 === currentEpisode;
                        const applying = applyingEpisodeId === ep.episodeId;
                        return (
                          <button
                            key={ep.episodeId}
                            type='button'
                            aria-current={currentMark ? 'true' : undefined}
                            aria-busy={applying}
                            disabled={applyingEpisodeId !== null}
                            onClick={() => void applyEpisode(ep, originalIndex)}
                            className={`flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                              currentMark
                                ? 'border-cyan-400/60 bg-cyan-500/10'
                                : 'border-white/10 bg-white/5 hover:bg-white/10'
                            } ${applyingEpisodeId !== null ? 'cursor-not-allowed opacity-70' : ''}`}
                          >
                            <span className='truncate text-sm text-slate-100'>
                              {ep.episodeTitle || `第${originalIndex + 1}集`}
                            </span>
                            <span className='shrink-0 text-xs text-slate-400'>
                              {applying ? (
                                <span className='inline-flex items-center gap-1'>
                                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                  应用中
                                </span>
                              ) : currentMark ? (
                                '当前集'
                              ) : (
                                '使用此集'
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className='grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4'>
                      {(episodeDescending
                        ? [...selectedAnime.episodes].reverse()
                        : selectedAnime.episodes
                      ).map((ep, index) => {
                        const originalIndex = episodeDescending
                          ? selectedAnime.episodes.length - 1 - index
                          : index;
                        const currentMark =
                          originalIndex + 1 === currentEpisode;
                        const applying = applyingEpisodeId === ep.episodeId;
                        return (
                          <button
                            key={ep.episodeId}
                            type='button'
                            aria-current={currentMark ? 'true' : undefined}
                            aria-label={
                              ep.episodeTitle || `第${originalIndex + 1}集`
                            }
                            aria-busy={applying}
                            disabled={applyingEpisodeId !== null}
                            onClick={() => void applyEpisode(ep, originalIndex)}
                            className={`min-h-11 min-w-0 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                              currentMark
                                ? 'bg-cyan-500 text-white shadow-md'
                                : 'bg-white/5 text-slate-100 hover:bg-white/10 border border-white/10'
                            } ${applyingEpisodeId !== null ? 'cursor-not-allowed opacity-70' : ''}`}
                            title={
                              ep.episodeTitle || `第${originalIndex + 1}集`
                            }
                          >
                            <div className='truncate'>
                              {applying ? (
                                <Loader2 className='h-4 w-4 animate-spin mx-auto' />
                              ) : (
                                originalIndex + 1
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>,
    portalContainer || document.body,
  );
}
