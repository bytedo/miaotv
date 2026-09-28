'use client';

import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  Calendar,
  ChevronRight,
  Film,
  Play,
  Sparkles,
  Trash2,
  Tv,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import type { Favorite, PlayRecord, Reminder } from '@/lib/db.client';
import { getDoubanDetails } from '@/lib/douban.client';
import { getHomeTab } from '@/lib/navigation';
import { cleanExpiredCache } from '@/lib/shortdrama-cache';
import type { ReleaseCalendarItem } from '@/lib/types';
import { useClearFavoritesMutation } from '@/hooks/useFavoritesMutations';
// Query Options 工厂函数 - 使用新的 TanStack Query hooks
import { favoritesQueryOptions } from '@/hooks/useFavoritesQuery';
import { useHomePageQueries } from '@/hooks/useHomePageQueries';
import { playRecordsQueryOptions } from '@/hooks/usePlayRecordsQuery';
import { useClearRemindersMutation } from '@/hooks/useRemindersMutations';
import { remindersQueryOptions } from '@/hooks/useRemindersQuery';
import { useTMDBLogos } from '@/hooks/useTMDBLogo';
import { useWatchingUpdatesQuery } from '@/hooks/useWatchingUpdates';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import ContinueWatching from '@/components/ContinueWatching';
import HeroBanner from '@/components/HeroBanner';
import PageLayout from '@/components/PageLayout';
import ScrollableRow from '@/components/ScrollableRow';
import SectionTitle from '@/components/SectionTitle';
import ShortDramaCard from '@/components/ShortDramaCard';
import { useSite } from '@/components/SiteProvider';
import SkeletonCard from '@/components/SkeletonCard';
import VideoCard from '@/components/VideoCard';

const AnnouncementDialog = dynamic(
  () => import('@/components/AnnouncementDialog'),
);

const EMPTY_FAVORITES: Record<string, Favorite> = {};
const EMPTY_PLAY_RECORDS: Record<string, PlayRecord> = {};
const EMPTY_REMINDERS: Record<string, Reminder> = {};

function combineHeroDetails(
  results: UseQueryResult<Awaited<ReturnType<typeof getDoubanDetails>>>[],
) {
  return results.map((result) =>
    result.data?.code === 200 ? result.data.data : null,
  );
}

const BackgroundWatchingUpdates = memo(function BackgroundWatchingUpdates() {
  const authInfo = getAuthInfoFromBrowserCookie();
  const storageType =
    typeof window !== 'undefined'
      ? (window as any).RUNTIME_CONFIG?.STORAGE_TYPE || 'localstorage'
      : 'localstorage';

  useWatchingUpdatesQuery({
    enabled: Boolean(authInfo?.username && storageType !== 'localstorage'),
  });
  return null;
});

const UpcomingReleasesSection = memo(function UpcomingReleasesSection({
  releases,
  today,
}: {
  releases: ReleaseCalendarItem[];
  today: string;
}) {
  const [upcomingFilter, setUpcomingFilter] = useState<'all' | 'movie' | 'tv'>(
    'all',
  );
  const releaseCounts = useMemo(
    () => ({
      all: releases.length,
      movie: releases.filter((release) => release.type === 'movie').length,
      tv: releases.filter((release) => release.type === 'tv').length,
    }),
    [releases],
  );

  return (
    <section className='mb-8'>
      <div className='mb-4 flex items-center justify-between'>
        <SectionTitle
          title='即将上映'
          icon={Calendar}
          iconColor='text-orange-500'
        />
        <Link
          href='/release-calendar'
          className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
        >
          查看更多
          <ChevronRight className='w-4 h-4 ml-1' />
        </Link>
      </div>

      {/* Tab 切换 */}
      <div className='mb-4 flex gap-2'>
        {[
          {
            key: 'all',
            label: '全部',
            count: releaseCounts.all,
          },
          {
            key: 'movie',
            label: '电影',
            count: releaseCounts.movie,
          },
          {
            key: 'tv',
            label: '电视剧',
            count: releaseCounts.tv,
          },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            aria-pressed={upcomingFilter === key}
            onClick={() => setUpcomingFilter(key as 'all' | 'movie' | 'tv')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              upcomingFilter === key
                ? 'bg-orange-500 text-white shadow-md'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`ml-1.5 text-xs ${
                  upcomingFilter === key
                    ? 'text-white/80'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                ({count})
              </span>
            )}
          </button>
        ))}
      </div>

      <ScrollableRow enableVirtualization={true}>
        {releases
          .filter(
            (release) =>
              upcomingFilter === 'all' || release.type === upcomingFilter,
          )
          .map((release, index) => {
            // 计算距离上映还有几天（使用字符串比较）
            const releaseDate = release.releaseDate; // "YYYY-MM-DD"

            let remarksText;
            if (releaseDate < today) {
              // 已上映：计算天数差
              const releaseParts = releaseDate.split('-').map(Number);
              const todayParts = today.split('-').map(Number);
              const releaseMs = new Date(
                releaseParts[0],
                releaseParts[1] - 1,
                releaseParts[2],
              ).getTime();
              const todayMs = new Date(
                todayParts[0],
                todayParts[1] - 1,
                todayParts[2],
              ).getTime();
              const daysAgo = Math.floor(
                (todayMs - releaseMs) / (1000 * 60 * 60 * 24),
              );
              remarksText = `已上映${daysAgo}天`;
            } else if (releaseDate === today) {
              remarksText = '今日上映';
            } else {
              // 即将上映：计算天数差
              const releaseParts = releaseDate.split('-').map(Number);
              const todayParts = today.split('-').map(Number);
              const releaseMs = new Date(
                releaseParts[0],
                releaseParts[1] - 1,
                releaseParts[2],
              ).getTime();
              const todayMs = new Date(
                todayParts[0],
                todayParts[1] - 1,
                todayParts[2],
              ).getTime();
              const daysUntil = Math.ceil(
                (releaseMs - todayMs) / (1000 * 60 * 60 * 24),
              );
              remarksText = `${daysUntil}天后上映`;
            }

            return (
              <div
                key={`${release.id}-${index}`}
                className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
              >
                <VideoCard
                  source='upcoming_release'
                  id={release.id}
                  source_name='即将上映'
                  from='douban'
                  title={release.title}
                  poster={release.cover || '/placeholder-poster.jpg'}
                  year={release.releaseDate.split('-')[0]}
                  type={release.type}
                  remarks={remarksText}
                  releaseDate={release.releaseDate}
                  query={release.title}
                  episodes={
                    release.episodes || (release.type === 'tv' ? undefined : 1)
                  }
                />
              </div>
            );
          })}
      </ScrollableRow>
    </section>
  );
});

function HomeClient({
  initialConfig,
}: {
  initialConfig: {
    showHeroBanner: boolean;
    showContinueWatching: boolean;
    showUpcomingReleases: boolean;
    showHotMovies: boolean;
    showHotTvShows: boolean;
    showNewAnime: boolean;
    showHotVariety: boolean;
    showHotShortDramas: boolean;
  };
}) {
  const searchParams = useSearchParams();
  const activeTab = getHomeTab(searchParams.get('tab'));

  // 🔥 所有 useState 必须在最前面，保证 Hook 调用顺序稳定
  const [favoriteFilter, setFavoriteFilter] = useState<
    'all' | 'movie' | 'tv' | 'anime' | 'shortdrama' | 'live' | 'variety'
  >('all');
  const [favoriteSortBy, setFavoriteSortBy] = useState<
    'recent' | 'title' | 'rating'
  >('recent');
  const [reminderFilter, setReminderFilter] = useState<
    'all' | 'upcoming' | 'today' | 'released'
  >('all');
  const [showClearFavoritesDialog, setShowClearFavoritesDialog] =
    useState(false);
  const [showClearRemindersDialog, setShowClearRemindersDialog] =
    useState(false);
  const [requireClearConfirmation, setRequireClearConfirmation] =
    useState(false);
  const deferredFavoriteFilter = useDeferredValue(favoriteFilter);
  const deferredFavoriteSortBy = useDeferredValue(favoriteSortBy);
  const deferredReminderFilter = useDeferredValue(reminderFilter);
  const favoritesEnabled = activeTab === 'favorites';
  const remindersEnabled = activeTab === 'reminders';
  const upcomingReleasesEnabled =
    activeTab === 'home' && initialConfig.showUpcomingReleases;

  // 🔥 使用 useMemo 确保 config 对象引用稳定，避免 hooks 数量变化
  const stableConfig = useMemo(
    () => ({
      showHotMovies: activeTab === 'home' && initialConfig.showHotMovies,
      showHotTvShows: activeTab === 'home' && initialConfig.showHotTvShows,
      showHotVariety: activeTab === 'home' && initialConfig.showHotVariety,
      showNewAnime: activeTab === 'home' && initialConfig.showNewAnime,
      showHotShortDramas:
        activeTab === 'home' && initialConfig.showHotShortDramas,
    }),
    [
      activeTab,
      initialConfig.showHotMovies,
      initialConfig.showHotTvShows,
      initialConfig.showHotVariety,
      initialConfig.showNewAnime,
      initialConfig.showHotShortDramas,
    ],
  );

  const [upcomingReleases, setUpcomingReleases] = useState<
    ReleaseCalendarItem[]
  >([]);
  const [showAnnouncement, setShowAnnouncement] = useState(false);

  // 🚀 TanStack Query - 首页数据查询（替代 GlobalCache）
  // 🔥 传入配置，只加载需要显示的模块数据
  const { data: homeData, loadingBySection } = useHomePageQueries(stableConfig);

  const { announcement, siteName } = useSite();

  const {
    hotMovies,
    hotTvShows,
    hotVarietyShows,
    hotAnime,
    hotShortDramas,
    bangumiCalendar: bangumiCalendarData,
  } = homeData;

  // 🚀 Memoize HeroBanner items to prevent unnecessary re-renders
  // HeroBanner uses React.memo, but items array is recreated on every render
  // This causes memo to fail shallow comparison and re-render unnecessarily
  const heroBannerItems = useMemo(
    () => [
      // 豆瓣电影
      ...hotMovies.slice(0, 2).map((movie) => ({
        id: movie.id,
        title: movie.title,
        poster: movie.poster,
        backdrop: movie.backdrop,
        trailerUrl: movie.trailerUrl,
        description: movie.plot_summary,
        year: movie.year,
        rate: movie.rate,
        douban_id: Number(movie.id),
        type: 'movie',
      })),
      // 豆瓣电视剧
      ...hotTvShows.slice(0, 2).map((show) => ({
        id: show.id,
        title: show.title,
        poster: show.poster,
        backdrop: show.backdrop,
        trailerUrl: show.trailerUrl,
        description: show.plot_summary,
        year: show.year,
        rate: show.rate,
        douban_id: Number(show.id),
        type: 'tv',
      })),
      // 豆瓣综艺
      ...hotVarietyShows.slice(0, 1).map((show) => ({
        id: show.id,
        title: show.title,
        poster: show.poster,
        backdrop: show.backdrop,
        trailerUrl: show.trailerUrl,
        description: show.plot_summary,
        year: show.year,
        rate: show.rate,
        douban_id: Number(show.id),
        type: 'variety',
      })),
      // 豆瓣动漫
      ...hotAnime.slice(0, 1).map((anime) => ({
        id: anime.id,
        title: anime.title,
        poster: anime.poster,
        backdrop: anime.backdrop,
        trailerUrl: anime.trailerUrl,
        description: anime.plot_summary,
        year: anime.year,
        rate: anime.rate,
        douban_id: Number(anime.id),
        type: 'anime',
      })),
    ],
    [hotMovies, hotTvShows, hotVarietyShows, hotAnime],
  );

  const heroEnabled = activeTab === 'home' && initialConfig.showHeroBanner;
  const heroDetails = useQueries({
    queries: heroBannerItems.map((item) => ({
      queryKey: ['douban', 'details', String(item.douban_id)],
      queryFn: () => getDoubanDetails(String(item.douban_id)),
      enabled: heroEnabled,
      staleTime: 30 * 60 * 1000,
      retry: 1,
    })),
    subscribed: heroEnabled,
    combine: combineHeroDetails,
  });
  const heroLogoItems = useMemo(
    () =>
      heroEnabled
        ? heroBannerItems.map((item) => ({
            title: item.title,
            year: item.year,
            type: item.type,
          }))
        : [],
    [heroEnabled, heroBannerItems],
  );
  const tmdbLogos = useTMDBLogos(heroLogoItems);
  const heroBannerItemsWithLogos = useMemo(
    () =>
      heroBannerItems.map((item, index) => ({
        ...item,
        description: heroDetails[index]?.plot_summary || item.description,
        backdrop: heroDetails[index]?.backdrop || item.backdrop,
        trailerUrl: heroDetails[index]?.trailerUrl || item.trailerUrl,
        tmdbLogo: tmdbLogos[item.title] || undefined,
      })),
    [heroBannerItems, heroDetails, tmdbLogos],
  );

  // 🚀 Memoize enableVideo to prevent HeroBanner remount
  // Reading window.RUNTIME_CONFIG on every render can cause props to change
  const enableVideo = useMemo(() => {
    if (typeof window === 'undefined') return true; // SSR默认启用
    return !(window as any).RUNTIME_CONFIG?.DISABLE_HERO_TRAILER;
  }, []); // Empty deps - only read once on mount

  // 🎯 优化：缓存今日番剧计算
  const todayAnimes = useMemo(() => {
    const today = new Date();
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentWeekday = weekdays[today.getDay()];

    return (
      bangumiCalendarData.find((item) => item.weekday.en === currentWeekday)
        ?.items || []
    );
  }, [bangumiCalendarData]); // 依赖bangumiCalendarData，数据变化时重新计算

  // 🎯 优化：缓存今天的日期（用于上映日期计算）
  const today = useMemo(() => {
    // 使用 Asia/Shanghai 时区，返回 YYYY-MM-DD 格式字符串（与 watching-updates.ts 保持一致）
    const dateStr = new Date().toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return dateStr.replace(/\//g, '-'); // "2026/04/02" -> "2026-04-02"
  }, []); // 空依赖，只在组件挂载时计算一次

  useEffect(() => {
    if (!announcement?.trim()) {
      setShowAnnouncement(false);
      return;
    }

    try {
      setShowAnnouncement(
        localStorage.getItem('hasSeenAnnouncement') !== announcement,
      );
    } catch {
      // Browsers that block storage should still let visitors read the notice.
      setShowAnnouncement(true);
    }
  }, [announcement]);

  useEffect(() => {
    const readClearConfirmation = () => {
      setRequireClearConfirmation(
        localStorage.getItem('requireClearConfirmation') === 'true',
      );
    };
    readClearConfirmation();
    window.addEventListener('storage', readClearConfirmation);
    window.addEventListener('localStorageChanged', readClearConfirmation);
    return () => {
      window.removeEventListener('storage', readClearConfirmation);
      window.removeEventListener('localStorageChanged', readClearConfirmation);
    };
  }, []);

  // Cards and ContinueWatching observe their own data on the home tab. Keeping
  // whole-record subscriptions here would rerender every row on a heart click.
  const { data: allFavorites = EMPTY_FAVORITES } = useQuery({
    ...favoritesQueryOptions,
    enabled: favoritesEnabled,
    subscribed: favoritesEnabled,
  });
  const { data: allPlayRecords = EMPTY_PLAY_RECORDS } = useQuery({
    ...playRecordsQueryOptions,
    enabled: favoritesEnabled,
    subscribed: favoritesEnabled,
  });
  const { data: allReminders = EMPTY_REMINDERS } = useQuery({
    ...remindersQueryOptions,
    enabled: remindersEnabled,
    subscribed: remindersEnabled,
  });

  // 收藏夹数据
  type FavoriteItem = {
    id: string;
    source: string;
    title: string;
    poster: string;
    episodes: number;
    source_name: string;
    currentEpisode?: number;
    search_title?: string;
    origin?: 'vod' | 'live';
    type?: string;
    releaseDate?: string;
    remarks?: string;
  };

  // 🚀 TanStack Query - 使用 useMemo 计算收藏列表（自动响应数据变化）
  const favoriteItems = useMemo(() => {
    if (!favoritesEnabled) return [];
    // 根据保存时间排序（从近到远）
    return Object.entries(allFavorites)
      .sort(([, a], [, b]) => b.save_time - a.save_time)
      .map(([key, fav]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);

        // 查找对应的播放记录，获取当前集数
        const playRecord = allPlayRecords[key];
        const currentEpisode = playRecord?.index;

        return {
          id,
          source,
          title: fav.title,
          year: fav.year,
          poster: fav.cover,
          episodes: fav.total_episodes,
          source_name: fav.source_name,
          currentEpisode,
          search_title: fav?.search_title,
          origin: fav?.origin,
          type: fav?.type,
          releaseDate: fav?.releaseDate,
          remarks: fav?.remarks,
        } as FavoriteItem;
      });
  }, [allFavorites, allPlayRecords, favoritesEnabled]);

  // 🚀 TanStack Query - 使用 useMemo 计算提醒列表（自动响应数据变化）
  const reminderItems = useMemo(() => {
    if (!remindersEnabled) return [];
    // 根据保存时间排序（从近到远）
    return Object.entries(allReminders)
      .sort(([, a], [, b]) => b.save_time - a.save_time)
      .map(([key, reminder]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);

        return {
          id,
          source,
          title: reminder.title,
          year: reminder.year,
          poster: reminder.cover,
          episodes: reminder.total_episodes,
          source_name: reminder.source_name,
          search_title: reminder?.search_title,
          origin: reminder?.origin,
          type: reminder?.type,
          releaseDate: reminder.releaseDate,
          remarks: reminder?.remarks,
        };
      });
  }, [allReminders, remindersEnabled]);

  // 🎯 优化：缓存收藏夹统计信息计算
  const favoriteStats = useMemo(() => {
    if (favoriteItems.length === 0) return null;

    return {
      total: favoriteItems.length,
      movie: favoriteItems.filter((item) => {
        if (item.type) return item.type === 'movie';
        if (item.source === 'shortdrama' || item.source_name === '短剧')
          return false;
        if (item.source === 'bangumi') return false;
        if (item.origin === 'live') return false;
        return item.episodes === 1;
      }).length,
      tv: favoriteItems.filter((item) => {
        if (item.type) return item.type === 'tv';
        if (item.source === 'shortdrama' || item.source_name === '短剧')
          return false;
        if (item.source === 'bangumi') return false;
        if (item.origin === 'live') return false;
        return item.episodes > 1;
      }).length,
      anime: favoriteItems.filter((item) => {
        if (item.type) return item.type === 'anime';
        return item.source === 'bangumi';
      }).length,
      shortdrama: favoriteItems.filter((item) => {
        if (item.type) return item.type === 'shortdrama';
        return item.source === 'shortdrama' || item.source_name === '短剧';
      }).length,
      live: favoriteItems.filter((item) => item.origin === 'live').length,
      variety: favoriteItems.filter((item) => {
        if (item.type) return item.type === 'variety';
        return false;
      }).length,
    };
  }, [favoriteItems]);

  const reminderCards = useMemo(() => {
    // 筛选
    let filtered = reminderItems;
    if (deferredReminderFilter === 'upcoming') {
      filtered = reminderItems.filter((item) => {
        if (!item.releaseDate) return false;
        return item.releaseDate > today;
      });
    } else if (deferredReminderFilter === 'today') {
      filtered = reminderItems.filter((item) => {
        if (!item.releaseDate) return false;
        return item.releaseDate === today;
      });
    } else if (deferredReminderFilter === 'released') {
      filtered = reminderItems.filter((item) => {
        if (!item.releaseDate) return false;
        return item.releaseDate < today;
      });
    }

    return filtered.map((item) => {
      // 智能计算上映状态
      let calculatedRemarks = item.remarks;

      if (item.releaseDate) {
        // 使用字符串比较（YYYY-MM-DD 格式可以直接比较）
        const releaseDate = item.releaseDate; // "YYYY-MM-DD"

        if (releaseDate < today) {
          // 已上映：计算天数差
          const releaseParts = releaseDate.split('-').map(Number);
          const todayParts = today.split('-').map(Number);
          const releaseMs = new Date(
            releaseParts[0],
            releaseParts[1] - 1,
            releaseParts[2],
          ).getTime();
          const todayMs = new Date(
            todayParts[0],
            todayParts[1] - 1,
            todayParts[2],
          ).getTime();
          const daysAgo = Math.floor(
            (todayMs - releaseMs) / (1000 * 60 * 60 * 24),
          );
          calculatedRemarks = `已上映${daysAgo}天`;
        } else if (releaseDate === today) {
          calculatedRemarks = '今日上映';
        } else {
          // 即将上映：计算天数差
          const releaseParts = releaseDate.split('-').map(Number);
          const todayParts = today.split('-').map(Number);
          const releaseMs = new Date(
            releaseParts[0],
            releaseParts[1] - 1,
            releaseParts[2],
          ).getTime();
          const todayMs = new Date(
            todayParts[0],
            todayParts[1] - 1,
            todayParts[2],
          ).getTime();
          const daysUntil = Math.ceil(
            (releaseMs - todayMs) / (1000 * 60 * 60 * 24),
          );
          calculatedRemarks = `${daysUntil}天后上映`;
        }
      }

      return (
        <div key={`${item.source}+${item.id}`} className='w-full'>
          <VideoCard
            query={item.search_title}
            {...item}
            from='reminder'
            remarks={calculatedRemarks}
            releaseDate={item.releaseDate}
          />
        </div>
      );
    });
  }, [reminderItems, deferredReminderFilter, today]);

  const favoriteCards = useMemo(() => {
    // 筛选
    let filtered = favoriteItems;
    if (deferredFavoriteFilter === 'movie') {
      filtered = favoriteItems.filter((item) => {
        // 优先用 type 字段判断
        if (item.type) return item.type === 'movie';
        // 向后兼容：没有 type 时用 episodes 判断
        if (item.source === 'shortdrama' || item.source_name === '短剧')
          return false;
        if (item.source === 'bangumi') return false; // 排除动漫
        if (item.origin === 'live') return false; // 排除直播
        // vod 来源：按集数判断
        return item.episodes === 1;
      });
    } else if (deferredFavoriteFilter === 'tv') {
      filtered = favoriteItems.filter((item) => {
        // 优先用 type 字段判断
        if (item.type) return item.type === 'tv';
        // 向后兼容：没有 type 时用 episodes 判断
        if (item.source === 'shortdrama' || item.source_name === '短剧')
          return false;
        if (item.source === 'bangumi') return false; // 排除动漫
        if (item.origin === 'live') return false; // 排除直播
        // vod 来源：按集数判断
        return item.episodes > 1;
      });
    } else if (deferredFavoriteFilter === 'anime') {
      filtered = favoriteItems.filter((item) => {
        // 优先用 type 字段判断
        if (item.type) return item.type === 'anime';
        // 向后兼容：用 source 判断
        return item.source === 'bangumi';
      });
    } else if (deferredFavoriteFilter === 'shortdrama') {
      filtered = favoriteItems.filter((item) => {
        // 优先用 type 字段判断
        if (item.type) return item.type === 'shortdrama';
        // 向后兼容：用 source 判断
        return item.source === 'shortdrama' || item.source_name === '短剧';
      });
    } else if (deferredFavoriteFilter === 'live') {
      filtered = favoriteItems.filter((item) => item.origin === 'live');
    } else if (deferredFavoriteFilter === 'variety') {
      filtered = favoriteItems.filter((item) => {
        // 优先用 type 字段判断
        if (item.type) return item.type === 'variety';
        // 向后兼容：暂无 fallback
        return false;
      });
    }

    // 排序
    if (deferredFavoriteSortBy === 'title') {
      const compareTitles = new Intl.Collator('zh-CN').compare;
      filtered = [...filtered].sort((a, b) => compareTitles(a.title, b.title));
    }
    // 'recent' 已经在 updateFavoriteItems 中按 save_time 排序了

    return filtered.map((item) => {
      // 智能计算即将上映状态
      let calculatedRemarks = item.remarks;

      if (item.releaseDate) {
        // 使用字符串比较（YYYY-MM-DD 格式可以直接比较）
        const releaseDate = item.releaseDate; // "YYYY-MM-DD"

        if (releaseDate < today) {
          // 已上映：计算天数差
          const releaseParts = releaseDate.split('-').map(Number);
          const todayParts = today.split('-').map(Number);
          const releaseMs = new Date(
            releaseParts[0],
            releaseParts[1] - 1,
            releaseParts[2],
          ).getTime();
          const todayMs = new Date(
            todayParts[0],
            todayParts[1] - 1,
            todayParts[2],
          ).getTime();
          const daysAgo = Math.floor(
            (todayMs - releaseMs) / (1000 * 60 * 60 * 24),
          );
          calculatedRemarks = `已上映${daysAgo}天`;
        } else if (releaseDate === today) {
          calculatedRemarks = '今日上映';
        } else {
          // 即将上映：计算天数差
          const releaseParts = releaseDate.split('-').map(Number);
          const todayParts = today.split('-').map(Number);
          const releaseMs = new Date(
            releaseParts[0],
            releaseParts[1] - 1,
            releaseParts[2],
          ).getTime();
          const todayMs = new Date(
            todayParts[0],
            todayParts[1] - 1,
            todayParts[2],
          ).getTime();
          const daysUntil = Math.ceil(
            (releaseMs - todayMs) / (1000 * 60 * 60 * 24),
          );
          calculatedRemarks = `${daysUntil}天后上映`;
        }
      }

      return (
        <div key={`${item.source}+${item.id}`} className='w-full'>
          <VideoCard
            query={item.search_title}
            {...item}
            from='favorite'
            remarks={calculatedRemarks}
          />
        </div>
      );
    });
  }, [favoriteItems, deferredFavoriteFilter, deferredFavoriteSortBy, today]);

  useEffect(() => {
    cleanExpiredCache().catch(console.error);
  }, []);

  const { data: calendarReleases } = useQuery({
    queryKey: ['releaseCalendar', 'home', 100],
    queryFn: async ({ signal }): Promise<ReleaseCalendarItem[]> => {
      const response = await fetch('/api/release-calendar?limit=100', {
        signal,
      });
      if (!response.ok) throw new Error('获取即将上映数据失败');
      const data = await response.json();
      return Array.isArray(data.items) ? data.items : [];
    },
    enabled: upcomingReleasesEnabled,
    subscribed: upcomingReleasesEnabled,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  useEffect(() => {
    if (!calendarReleases || !upcomingReleasesEnabled) return;
    if (calendarReleases.length === 0 || !window.Worker) {
      setUpcomingReleases([]);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('../workers/releaseCalendar.worker.ts', import.meta.url),
      );
      worker.onmessage = (event: MessageEvent) => {
        setUpcomingReleases(
          event.data.error ? [] : event.data.selectedItems || [],
        );
      };
      worker.onerror = () => setUpcomingReleases([]);
      worker.postMessage({ releases: calendarReleases, today });
    } catch (error) {
      console.warn('处理即将上映数据失败:', error);
      setUpcomingReleases([]);
    }
    return () => worker?.terminate();
  }, [calendarReleases, upcomingReleasesEnabled, today]);

  // 🚀 TanStack Query - 使用 useMutation 管理清空收藏操作
  // 特性：乐观更新（立即清空 UI）+ 错误回滚（失败时恢复数据）
  const clearFavoritesMutation = useClearFavoritesMutation();

  // 🚀 TanStack Query - 使用 useMutation 管理清空提醒操作
  const clearRemindersMutation = useClearRemindersMutation();

  // Keep settled rows referentially stable when a dialog or saved-list control changes.
  const homeContent = useMemo(() => {
    if (activeTab !== 'home') return null;
    return (
      <>
        {/* Hero Banner 轮播 */}
        {initialConfig.showHeroBanner &&
          heroBannerItemsWithLogos.length > 0 && (
            <section className='mb-8'>
              <HeroBanner
                items={heroBannerItemsWithLogos}
                autoPlayInterval={8000}
                showControls={true}
                showIndicators={true}
                enableVideo={enableVideo}
              />
            </section>
          )}

        {/* 继续观看 */}
        {/* 继续观看 */}
        {initialConfig.showContinueWatching && <ContinueWatching />}

        {initialConfig.showUpcomingReleases && upcomingReleases.length > 0 && (
          <UpcomingReleasesSection releases={upcomingReleases} today={today} />
        )}

        {/* 热门电影 */}
        {initialConfig.showHotMovies && (
          <section className='mb-8'>
            <div className='mb-4 flex items-center justify-between'>
              <SectionTitle
                title='热门电影'
                icon={Film}
                iconColor='text-red-500'
              />
              <Link
                href='/douban?type=movie'
                className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
              >
                查看更多
                <ChevronRight className='w-4 h-4 ml-1' />
              </Link>
            </div>
            <ScrollableRow enableVirtualization={true}>
              {loadingBySection.hotMovies
                ? // 加载状态显示灰色占位数据
                  Array.from({ length: 8 }).map((_, index) => (
                    <SkeletonCard key={index} />
                  ))
                : // 显示真实数据
                  hotMovies.map((movie, index) => (
                    <div
                      key={index}
                      className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                    >
                      <VideoCard
                        from='douban'
                        source='douban'
                        id={movie.id}
                        source_name='豆瓣'
                        title={movie.title}
                        poster={movie.poster}
                        douban_id={Number(movie.id)}
                        rate={movie.rate}
                        year={movie.year}
                        type='movie'
                      />
                    </div>
                  ))}
            </ScrollableRow>
          </section>
        )}

        {/* 热门剧集 */}
        {initialConfig.showHotTvShows && (
          <section className='mb-8'>
            <div className='mb-4 flex items-center justify-between'>
              <SectionTitle
                title='热门剧集'
                icon={Tv}
                iconColor='text-blue-500'
              />
              <Link
                href='/douban?type=tv'
                className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
              >
                查看更多
                <ChevronRight className='w-4 h-4 ml-1' />
              </Link>
            </div>
            <ScrollableRow enableVirtualization={true}>
              {loadingBySection.hotTvShows
                ? // 加载状态显示灰色占位数据
                  Array.from({ length: 8 }).map((_, index) => (
                    <SkeletonCard key={index} />
                  ))
                : // 显示真实数据
                  hotTvShows.map((show, index) => (
                    <div
                      key={index}
                      className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                    >
                      <VideoCard
                        from='douban'
                        source='douban'
                        id={show.id}
                        source_name='豆瓣'
                        title={show.title}
                        poster={show.poster}
                        douban_id={Number(show.id)}
                        rate={show.rate}
                        year={show.year}
                        type='tv'
                      />
                    </div>
                  ))}
            </ScrollableRow>
          </section>
        )}

        {/* 每日新番放送 */}
        {initialConfig.showNewAnime && (
          <section className='mb-8'>
            <div className='mb-4 flex items-center justify-between'>
              <SectionTitle
                title='新番放送'
                icon={Calendar}
                iconColor='text-purple-500'
              />
              <Link
                href='/douban?type=anime'
                className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
              >
                查看更多
                <ChevronRight className='w-4 h-4 ml-1' />
              </Link>
            </div>
            <ScrollableRow enableVirtualization={true}>
              {loadingBySection.bangumiCalendar
                ? // 加载状态显示灰色占位数据
                  Array.from({ length: 8 }).map((_, index) => (
                    <SkeletonCard key={index} />
                  ))
                : // 展示当前日期的番剧
                  todayAnimes.map((anime, index) => (
                    <div
                      key={`${anime.id}-${index}`}
                      className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                    >
                      <VideoCard
                        from='douban'
                        source='bangumi'
                        id={anime.id.toString()}
                        source_name='Bangumi'
                        title={anime.name_cn || anime.name}
                        poster={
                          anime.images?.large ||
                          anime.images?.common ||
                          anime.images?.medium ||
                          anime.images?.small ||
                          anime.images?.grid ||
                          '/placeholder-poster.jpg'
                        }
                        douban_id={anime.id}
                        rate={anime.rating?.score?.toFixed(1) || ''}
                        year={anime.air_date?.split('-')?.[0] || ''}
                        isBangumi={true}
                      />
                    </div>
                  ))}
            </ScrollableRow>
          </section>
        )}

        {/* 热门综艺 */}
        {initialConfig.showHotVariety && (
          <section className='mb-8'>
            <div className='mb-4 flex items-center justify-between'>
              <SectionTitle
                title='热门综艺'
                icon={Sparkles}
                iconColor='text-pink-500'
              />
              <Link
                href='/douban?type=show'
                className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
              >
                查看更多
                <ChevronRight className='w-4 h-4 ml-1' />
              </Link>
            </div>
            <ScrollableRow enableVirtualization={true}>
              {loadingBySection.hotVarietyShows
                ? // 加载状态显示灰色占位数据
                  Array.from({ length: 8 }).map((_, index) => (
                    <SkeletonCard key={index} />
                  ))
                : // 显示真实数据
                  hotVarietyShows.map((show, index) => (
                    <div
                      key={index}
                      className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                    >
                      <VideoCard
                        from='douban'
                        source='douban'
                        id={show.id}
                        source_name='豆瓣'
                        title={show.title}
                        poster={show.poster}
                        douban_id={Number(show.id)}
                        rate={show.rate}
                        year={show.year}
                        type='variety'
                      />
                    </div>
                  ))}
            </ScrollableRow>
          </section>
        )}

        {/* 热门短剧 */}
        {initialConfig.showHotShortDramas && (
          <section className='mb-8'>
            <div className='mb-4 flex items-center justify-between'>
              <SectionTitle
                title='热门短剧'
                icon={Play}
                iconColor='text-orange-500'
              />
              <Link
                href='/shortdrama'
                className='flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors'
              >
                查看更多
                <ChevronRight className='w-4 h-4 ml-1' />
              </Link>
            </div>
            <ScrollableRow enableVirtualization={true}>
              {loadingBySection.hotShortDramas
                ? // 加载状态显示灰色占位数据
                  Array.from({ length: 8 }).map((_, index) => (
                    <SkeletonCard key={index} />
                  ))
                : // 显示真实数据
                  hotShortDramas.map((drama, index) => (
                    <ShortDramaCard
                      key={index}
                      drama={drama}
                      className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                    />
                  ))}
            </ScrollableRow>
          </section>
        )}
      </>
    );
  }, [
    activeTab,
    initialConfig,
    heroBannerItemsWithLogos,
    enableVideo,
    upcomingReleases,
    today,
    hotMovies,
    hotTvShows,
    todayAnimes,
    hotVarietyShows,
    hotShortDramas,
    loadingBySection,
  ]);

  const handleCloseAnnouncement = (announcement: string) => {
    setShowAnnouncement(false);
    try {
      localStorage.setItem('hasSeenAnnouncement', announcement);
    } catch {
      // A failed persistence write must not prevent dismissing the dialog.
    }
  };

  return (
    <PageLayout>
      <BackgroundWatchingUpdates />
      <div className='overflow-visible pb-32 md:pb-safe-bottom'>
        {activeTab !== 'home' && (
          <nav
            aria-label='个人片单'
            className='mb-6 flex items-center gap-5 text-sm'
          >
            <Link
              href='/'
              className='text-gray-500 hover:text-cyan-600 dark:text-gray-400'
            >
              首页
            </Link>
            <Link
              href='/?tab=favorites'
              aria-current={activeTab === 'favorites' ? 'page' : undefined}
              className={
                activeTab === 'favorites'
                  ? 'font-semibold text-cyan-600 dark:text-cyan-400'
                  : 'text-gray-500 hover:text-cyan-600 dark:text-gray-400'
              }
            >
              收藏夹
            </Link>
            <Link
              href='/?tab=reminders'
              aria-current={activeTab === 'reminders' ? 'page' : undefined}
              className={
                activeTab === 'reminders'
                  ? 'font-semibold text-cyan-600 dark:text-cyan-400'
                  : 'text-gray-500 hover:text-cyan-600 dark:text-gray-400'
              }
            >
              想看
            </Link>
          </nav>
        )}
        <div className='w-full mx-auto'>
          {activeTab === 'reminders' ? (
            // 想看视图
            <section className='mb-8'>
              <div className='mb-6 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  我想看
                </h2>
                {reminderItems.length > 0 && (
                  <button
                    className='flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-white hover:bg-red-600 dark:text-red-400 dark:hover:text-white dark:hover:bg-red-500 border border-red-300 dark:border-red-700 hover:border-red-600 dark:hover:border-red-500 rounded-lg transition-all duration-200 shadow-sm hover:shadow-md'
                    onClick={() => {
                      if (requireClearConfirmation) {
                        setShowClearRemindersDialog(true);
                      } else {
                        clearRemindersMutation.mutate();
                      }
                    }}
                  >
                    <Trash2 className='w-4 h-4' />
                    <span>清空想看</span>
                  </button>
                )}
              </div>

              {/* 筛选标签 */}
              {reminderItems.length > 0 && (
                <div className='mb-4 flex flex-wrap gap-2'>
                  {[
                    { key: 'all' as const, label: '全部', icon: '📚' },
                    { key: 'upcoming' as const, label: '即将上映', icon: '⏰' },
                    { key: 'today' as const, label: '今日上映', icon: '🎉' },
                    { key: 'released' as const, label: '已上映', icon: '✅' },
                  ].map(({ key, label, icon }) => (
                    <button
                      key={key}
                      onClick={() => setReminderFilter(key)}
                      aria-pressed={reminderFilter === key}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        reminderFilter === key
                          ? 'bg-linear-to-r from-orange-500 to-red-500 text-white shadow-lg scale-105'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      <span className='mr-1'>{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <div
                aria-busy={reminderFilter !== deferredReminderFilter}
                className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'
              >
                {reminderCards}
                {reminderItems.length === 0 && (
                  <div className='col-span-full flex flex-col items-center justify-center py-16 px-4'>
                    <div className='mb-6 relative'>
                      <div className='absolute inset-0 bg-linear-to-r from-orange-300 to-red-300 dark:from-orange-600 dark:to-red-600 opacity-20 blur-3xl rounded-full animate-pulse'></div>
                      <svg
                        className='w-32 h-32 relative z-10'
                        viewBox='0 0 200 200'
                        fill='none'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path
                          d='M100 50 L100 120 M100 50 L130 80'
                          className='stroke-gray-400 dark:stroke-gray-500'
                          strokeWidth='8'
                          strokeLinecap='round'
                          strokeLinejoin='round'
                        />
                        <circle
                          cx='100'
                          cy='100'
                          r='70'
                          className='fill-gray-300 dark:fill-gray-600 stroke-gray-400 dark:stroke-gray-500'
                          strokeWidth='3'
                        />
                        <path
                          d='M100 50 L100 120 M100 50 L130 80'
                          fill='none'
                          stroke='currentColor'
                          strokeWidth='2'
                          strokeDasharray='5,5'
                          className='text-gray-400 dark:text-gray-500'
                        />
                      </svg>
                    </div>

                    <h3 className='text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2'>
                      暂无想看内容
                    </h3>
                    <p className='text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs'>
                      发现即将上映的内容，点击 🔔 标记想看吧！
                    </p>
                  </div>
                )}
              </div>

              {/* 确认对话框 */}
              <ConfirmDialog
                isOpen={showClearRemindersDialog}
                title='确认清空想看'
                message={`确定要清空所有想看内容吗？\n\n这将删除 ${reminderItems.length} 项内容，此操作无法撤销。`}
                confirmText='确认清空'
                cancelText='取消'
                variant='danger'
                onConfirm={() => {
                  clearRemindersMutation.mutate();
                  setShowClearRemindersDialog(false);
                }}
                onCancel={() => setShowClearRemindersDialog(false)}
              />
            </section>
          ) : activeTab === 'favorites' ? (
            // 收藏夹视图
            <section className='mb-8'>
              <div className='mb-6 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  我的收藏
                </h2>
                {favoriteItems.length > 0 && (
                  <button
                    className='flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 hover:text-white hover:bg-red-600 dark:text-red-400 dark:hover:text-white dark:hover:bg-red-500 border border-red-300 dark:border-red-700 hover:border-red-600 dark:hover:border-red-500 rounded-lg transition-all duration-200 shadow-sm hover:shadow-md'
                    onClick={() => {
                      // 根据用户设置决定是否显示确认对话框
                      if (requireClearConfirmation) {
                        setShowClearFavoritesDialog(true);
                      } else {
                        // 🚀 使用 mutation.mutate() 清空收藏
                        // 特性：立即清空 UI（乐观更新），失败时自动回滚
                        clearFavoritesMutation.mutate();
                      }
                    }}
                  >
                    <Trash2 className='w-4 h-4' />
                    <span>清空收藏</span>
                  </button>
                )}
              </div>

              {/* 统计信息 */}
              {favoriteStats && (
                <div className='mb-4 flex flex-wrap gap-2 text-sm text-gray-600 dark:text-gray-400'>
                  <span className='px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full'>
                    共{' '}
                    <strong className='text-gray-900 dark:text-gray-100'>
                      {favoriteStats.total}
                    </strong>{' '}
                    项
                  </span>
                  {favoriteStats.movie > 0 && (
                    <span className='px-3 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-full'>
                      电影 {favoriteStats.movie}
                    </span>
                  )}
                  {favoriteStats.tv > 0 && (
                    <span className='px-3 py-1 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-full'>
                      剧集 {favoriteStats.tv}
                    </span>
                  )}
                  {favoriteStats.anime > 0 && (
                    <span className='px-3 py-1 bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-300 rounded-full'>
                      动漫 {favoriteStats.anime}
                    </span>
                  )}
                  {favoriteStats.shortdrama > 0 && (
                    <span className='px-3 py-1 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 rounded-full'>
                      短剧 {favoriteStats.shortdrama}
                    </span>
                  )}
                  {favoriteStats.live > 0 && (
                    <span className='px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-full'>
                      直播 {favoriteStats.live}
                    </span>
                  )}
                  {favoriteStats.variety > 0 && (
                    <span className='px-3 py-1 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 rounded-full'>
                      综艺 {favoriteStats.variety}
                    </span>
                  )}
                </div>
              )}

              {/* 筛选标签 */}
              {favoriteItems.length > 0 && (
                <div className='mb-4 flex flex-wrap gap-2'>
                  {[
                    { key: 'all' as const, label: '全部', icon: '📚' },
                    { key: 'movie' as const, label: '电影', icon: '🎬' },
                    { key: 'tv' as const, label: '剧集', icon: '📺' },
                    { key: 'anime' as const, label: '动漫', icon: '🎌' },
                    { key: 'shortdrama' as const, label: '短剧', icon: '🎭' },
                    { key: 'live' as const, label: '直播', icon: '📡' },
                    { key: 'variety' as const, label: '综艺', icon: '🎪' },
                  ].map(({ key, label, icon }) => (
                    <button
                      key={key}
                      onClick={() => setFavoriteFilter(key)}
                      aria-pressed={favoriteFilter === key}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        favoriteFilter === key
                          ? 'bg-linear-to-r from-blue-500 to-purple-500 text-white shadow-lg scale-105'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      <span className='mr-1'>{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* 排序选项 */}
              {favoriteItems.length > 0 && (
                <div className='mb-4 flex items-center gap-2 text-sm'>
                  <span className='text-gray-600 dark:text-gray-400'>
                    排序：
                  </span>
                  <div className='flex gap-2'>
                    {[
                      { key: 'recent' as const, label: '最近添加' },
                      { key: 'title' as const, label: '标题 A-Z' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setFavoriteSortBy(key)}
                        aria-pressed={favoriteSortBy === key}
                        className={`px-3 py-1 rounded-md transition-colors ${
                          favoriteSortBy === key
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div
                aria-busy={
                  favoriteFilter !== deferredFavoriteFilter ||
                  favoriteSortBy !== deferredFavoriteSortBy
                }
                className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'
              >
                {favoriteCards}
                {favoriteItems.length === 0 && (
                  <div className='col-span-full flex flex-col items-center justify-center py-16 px-4'>
                    {/* SVG 插画 - 空收藏夹 */}
                    <div className='mb-6 relative'>
                      <div className='absolute inset-0 bg-linear-to-r from-pink-300 to-purple-300 dark:from-pink-600 dark:to-purple-600 opacity-20 blur-3xl rounded-full animate-pulse'></div>
                      <svg
                        className='w-32 h-32 relative z-10'
                        viewBox='0 0 200 200'
                        fill='none'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        {/* 心形主体 */}
                        <path
                          d='M100 170C100 170 30 130 30 80C30 50 50 30 70 30C85 30 95 40 100 50C105 40 115 30 130 30C150 30 170 50 170 80C170 130 100 170 100 170Z'
                          className='fill-gray-300 dark:fill-gray-600 stroke-gray-400 dark:stroke-gray-500 transition-colors duration-300'
                          strokeWidth='3'
                        />
                        {/* 虚线边框 */}
                        <path
                          d='M100 170C100 170 30 130 30 80C30 50 50 30 70 30C85 30 95 40 100 50C105 40 115 30 130 30C150 30 170 50 170 80C170 130 100 170 100 170Z'
                          fill='none'
                          stroke='currentColor'
                          strokeWidth='2'
                          strokeDasharray='5,5'
                          className='text-gray-400 dark:text-gray-500'
                        />
                      </svg>
                    </div>

                    {/* 文字提示 */}
                    <h3 className='text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2'>
                      收藏夹空空如也
                    </h3>
                    <p className='text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs'>
                      快去发现喜欢的影视作品，点击 ❤️ 添加到收藏吧！
                    </p>
                  </div>
                )}
              </div>

              {/* 确认对话框 */}
              <ConfirmDialog
                isOpen={showClearFavoritesDialog}
                title='确认清空收藏'
                message={`确定要清空所有收藏吗？\n\n这将删除 ${favoriteItems.length} 项收藏，此操作无法撤销。`}
                confirmText='确认清空'
                cancelText='取消'
                variant='danger'
                onConfirm={() => {
                  // 🚀 使用 mutation.mutate() 清空收藏
                  // 特性：立即清空 UI（乐观更新），失败时自动回滚
                  clearFavoritesMutation.mutate();
                  setShowClearFavoritesDialog(false);
                }}
                onCancel={() => setShowClearFavoritesDialog(false)}
              />
            </section>
          ) : (
            homeContent
          )}
        </div>
      </div>
      {announcement && showAnnouncement && (
        <AnnouncementDialog
          announcement={announcement}
          siteName={siteName}
          isOpen={showAnnouncement}
          onClose={() => handleCloseAnnouncement(announcement)}
        />
      )}
    </PageLayout>
  );
}

export default HomeClient;
