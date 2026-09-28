/* eslint-disable @typescript-eslint/no-explicit-any,react-hooks/exhaustive-deps,@typescript-eslint/no-empty-function */

import {
  ExternalLink,
  Heart,
  Link,
  LoaderCircle,
  PlayCircleIcon,
  Radio,
  RefreshCw,
  Star,
  Trash2,
  Bell,
  BellRing,
} from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useLongPress } from '@/hooks/useLongPress';
import { useToggleFavoriteMutation } from '@/hooks/useFavoritesMutations';
import { useToggleReminderMutation } from '@/hooks/useRemindersMutations';
import { useDeletePlayRecordMutation } from '@/hooks/usePlayRecordsMutations';
import {
  favoritesQueryOptions,
  useIsFavoritedQuery,
} from '@/hooks/useFavoritesQuery';
import { useIsRemindedQuery } from '@/hooks/useRemindersQuery';
import { processImageUrl, isSeriesCompleted } from '@/lib/utils';

import { ImagePlaceholder } from '@/components/ImagePlaceholder';
import MobileActionSheet from '@/components/MobileActionSheet';

export interface VideoCardProps {
  id?: string;
  source?: string;
  title?: string;
  query?: string;
  poster?: string;
  episodes?: number;
  source_name?: string;
  source_names?: string[];
  progress?: number;
  year?: string;
  from: 'playrecord' | 'favorite' | 'search' | 'douban' | 'reminder';
  currentEpisode?: number;
  douban_id?: number;
  onDelete?: () => void;
  rate?: string;
  type?: string;
  isBangumi?: boolean;
  isAggregate?: boolean;
  origin?: 'vod' | 'live';
  remarks?: string; // 备注信息（如"已完结"、"更新至20集"等）
  releaseDate?: string; // 上映日期 (YYYY-MM-DD)，用于即将上映内容
  priority?: boolean; // 图片加载优先级（用于首屏可见图片）
}

export type VideoCardHandle = {
  setEpisodes: (episodes?: number) => void;
  setSourceNames: (names?: string[]) => void;
  setDoubanId: (id?: number) => void;
};

import { loadedImageUrls } from '@/lib/imageCache';

// Module-level cache: tracks poster URLs already loaded by the browser.
// Survives VirtuosoGrid remount cycles so re-entering items skip the skeleton.

const VideoCard = forwardRef<VideoCardHandle, VideoCardProps>(
  function VideoCard(
    {
      id,
      title = '',
      query = '',
      poster = '',
      episodes,
      source,
      source_name,
      source_names,
      progress = 0,
      year,
      from,
      currentEpisode,
      douban_id,
      onDelete,
      rate,
      type = '',
      isBangumi = false,
      isAggregate = false,
      origin = 'vod',
      remarks,
      releaseDate,
      priority = false,
    }: VideoCardProps,
    ref,
  ) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const toggleFavoriteMutation = useToggleFavoriteMutation();
    const toggleReminderMutation = useToggleReminderMutation();
    const deletePlayRecordMutation = useDeletePlayRecordMutation();

    const [isLoading, setIsLoading] = useState(() =>
      loadedImageUrls.has(processImageUrl(poster)),
    );
    const [imageLoaded, setImageLoaded] = useState(() =>
      loadedImageUrls.has(processImageUrl(poster)),
    ); // 图片加载状态
    const [showMobileActions, setShowMobileActions] = useState(false);
    const [isNavigating, setIsNavigating] = useState(false); // 导航加载状态

    // 可外部修改的可控字段
    const [dynamicEpisodes, setDynamicEpisodes] = useState<number | undefined>(
      episodes,
    );
    const [dynamicSourceNames, setDynamicSourceNames] = useState<
      string[] | undefined
    >(source_names);
    const [dynamicDoubanId, setDynamicDoubanId] = useState<number | undefined>(
      douban_id,
    );

    // ✅ 合并重复的 useEffect - 减少不必要的渲染
    useEffect(() => {
      setDynamicEpisodes(episodes);
      setDynamicSourceNames(source_names);
      setDynamicDoubanId(douban_id);
    }, [episodes, source_names, douban_id]);

    useImperativeHandle(ref, () => ({
      setEpisodes: (eps?: number) => setDynamicEpisodes(eps),
      setSourceNames: (names?: string[]) => setDynamicSourceNames(names),
      setDoubanId: (id?: number) => setDynamicDoubanId(id),
    }));

    // 使用 useMemo 缓存计算值，避免每次渲染重新计算
    const actualTitle = title;
    const actualPoster = poster;
    // 为豆瓣内容生成收藏用的source和id（仅用于收藏，不用于播放）
    const actualSource =
      source || (from === 'douban' && douban_id ? 'douban' : '');
    const actualId =
      id || (from === 'douban' && douban_id ? douban_id.toString() : '');
    const actualDoubanId = dynamicDoubanId;
    const actualEpisodes = dynamicEpisodes;
    const actualYear = year;
    const actualQuery = query || '';

    const actualSearchType = useMemo(
      () =>
        isAggregate
          ? actualEpisodes && actualEpisodes === 1
            ? 'movie'
            : 'tv'
          : type,
      [isAggregate, actualEpisodes, type],
    );

    // 判断是否为即将上映（未发布的内容）- 只有真正未上映的才算
    const isUpcoming = useMemo(
      () => remarks && remarks.includes('天后上映'),
      [remarks],
    );

    // 判断是否有上映相关标记（包括已上映、今日上映、即将上映）
    const hasReleaseTag = useMemo(
      () =>
        remarks &&
        (remarks.includes('天后上映') ||
          remarks.includes('已上映') ||
          remarks.includes('今日上映')),
      [remarks],
    );

    // 🔥 判断是否应该显示提醒按钮（即将上映或新上映）
    const isNewRelease =
      remarks && (remarks.includes('已上映') || remarks.includes('今日上映'));
    const shouldShowBell =
      from === 'reminder' ||
      (from !== 'favorite' && !!(isUpcoming || isNewRelease));

    // 🚀 TanStack Query - 获取收藏/提醒状态
    const {
      data: favoritedStatus,
      isError: favoriteStatusError,
      refetch: retryFavoriteStatus,
    } = useIsFavoritedQuery(actualSource || '', actualId || '', {
      enabled: !!actualSource && !!actualId && !shouldShowBell,
    });
    const {
      data: remindedStatus,
      isError: reminderStatusError,
      refetch: retryReminderStatus,
    } = useIsRemindedQuery(actualSource || '', actualId || '', {
      enabled: !!actualSource && !!actualId && shouldShowBell,
    });

    // Mutation hooks update this shared cache optimistically for every card and list.
    const favorited = favoritedStatus ?? false;
    const searchFavorited = favoritedStatus ?? null;
    const reminded = remindedStatus ?? false;
    const favoriteStateUnknown = shouldShowBell
      ? remindedStatus === undefined
      : favoritedStatus === undefined;
    const favoriteIdentityMissing = !actualSource || !actualId;
    const favoriteStateError = shouldShowBell
      ? reminderStatusError
      : favoriteStatusError;
    const favoriteRetryAvailable =
      !favoriteIdentityMissing && favoriteStateUnknown && favoriteStateError;
    const favoriteMutationPending =
      toggleFavoriteMutation.isPending || toggleReminderMutation.isPending;
    const favoriteActionDisabled =
      favoriteIdentityMissing ||
      favoriteMutationPending ||
      (favoriteStateUnknown && !favoriteRetryAvailable);
    const favoriteActionBusy =
      !favoriteIdentityMissing &&
      (favoriteMutationPending ||
        (favoriteStateUnknown && !favoriteRetryAvailable));
    const favoriteActionLabel = favoriteIdentityMissing
      ? '该条目暂无可用收藏信息'
      : favoriteStateUnknown
        ? favoriteRetryAvailable
          ? shouldShowBell
            ? '重试加载想看状态'
            : '重试加载收藏状态'
          : shouldShowBell
            ? '想看状态加载中...'
            : '收藏状态加载中...'
        : favoriteMutationPending
          ? '正在保存...'
          : shouldShowBell
            ? reminded
              ? '取消想看'
              : '想看'
            : favorited
              ? '取消收藏'
              : '添加收藏';

    // 🚀 使用 TanStack Query useMutation 优化收藏功能
    const handleToggleFavorite = useCallback(
      async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (
          !actualSource ||
          !actualId ||
          toggleFavoriteMutation.isPending ||
          toggleReminderMutation.isPending
        )
          return;

        if (favoriteRetryAvailable) {
          void (shouldShowBell ? retryReminderStatus() : retryFavoriteStatus());
          return;
        }

        if (shouldShowBell) {
          if (remindedStatus === undefined) return;
          // ========== 即将上映或新上映 → 操作提醒 ==========
          const currentReminded = reminded;

          // 🔄 使用 reminder mutation
          toggleReminderMutation.mutate({
            source: actualSource,
            id: actualId,
            isReminded: currentReminded || false,
            reminder: {
              title: actualTitle,
              source_name: source_name || '即将上映',
              year: actualYear || '',
              cover: actualPoster,
              total_episodes: actualEpisodes ?? 1,
              save_time: Date.now(),
              search_title: actualQuery || actualTitle,
              type: type || undefined,
              origin,
              releaseDate: releaseDate || '', // 提醒必须有 releaseDate
              remarks: remarks,
            },
          });
        } else {
          if (favoritedStatus === undefined) return;
          // ========== 已上映 → 操作收藏 ==========
          const currentFavorited = favorited;

          // 🔄 使用 favorite mutation
          toggleFavoriteMutation.mutate({
            source: actualSource,
            id: actualId,
            isFavorited: currentFavorited || false,
            favorite: {
              title: actualTitle,
              source_name: source_name || '即将上映',
              year: actualYear || '',
              cover: actualPoster,
              total_episodes: actualEpisodes ?? 1,
              save_time: Date.now(),
              search_title: actualQuery || actualTitle,
              type: type || undefined,
              origin,
              releaseDate: releaseDate,
              remarks: remarks,
            },
          });
        }
      },
      [
        shouldShowBell,
        actualSource,
        actualId,
        actualTitle,
        source_name,
        actualYear,
        actualPoster,
        actualEpisodes,
        actualQuery,
        favorited,
        reminded,
        favoritedStatus,
        remindedStatus,
        favoriteRetryAvailable,
        retryFavoriteStatus,
        retryReminderStatus,
        toggleFavoriteMutation,
        toggleReminderMutation,
        type,
        releaseDate,
        remarks,
        origin,
      ],
    );

    const handleDeleteRecord = useCallback(
      async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (from !== 'playrecord' || !actualSource || !actualId) return;

        deletePlayRecordMutation.mutate(
          { source: actualSource, id: actualId },
          {
            onSuccess: () => {
              onDelete?.();
            },
            onError: (err) => {
              console.error('删除播放记录失败:', err);
            },
          },
        );
      },
      [from, actualSource, actualId, onDelete, deletePlayRecordMutation],
    );

    // 🚀 数据预取 - 在 hover 时预取收藏数据和预加载路由
    const handlePrefetch = useCallback(() => {
      if (!actualSource || !actualId) return;

      // 预取收藏数据
      void queryClient.prefetchQuery(favoritesQueryOptions);

      // 🔥 预加载播放页面路由 - 关键优化！
      const doubanIdParam =
        actualDoubanId && actualDoubanId > 0
          ? `&douban_id=${actualDoubanId}`
          : '';

      if (origin === 'live' && actualSource && actualId) {
        const url = `/live?source=${actualSource.replace('live_', '')}&id=${actualId.replace('live_', '')}`;
        router.prefetch(url);
      } else if (actualSource === 'shortdrama' && actualId) {
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}&shortdrama_id=${actualId}`;
        router.prefetch(url);
      } else if (
        from === 'douban' ||
        (isAggregate && !actualSource && !actualId) ||
        actualSource === 'upcoming_release' ||
        actualSource === 'douban' ||
        actualSource === 'bangumi'
      ) {
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}${actualYear ? `&year=${actualYear}` : ''}${doubanIdParam}${actualSearchType ? `&stype=${actualSearchType}` : ''}${isAggregate ? '&prefer=true' : ''}${actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''}`;
        router.prefetch(url);
      } else if (actualSource && actualId) {
        const url = `/play?source=${actualSource}&id=${actualId}&title=${encodeURIComponent(actualTitle)}${actualYear ? `&year=${actualYear}` : ''}${doubanIdParam}${isAggregate ? '&prefer=true' : ''}${actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''}${actualSearchType ? `&stype=${actualSearchType}` : ''}`;
        router.prefetch(url);
      }
    }, [
      actualSource,
      actualId,
      queryClient,
      router,
      origin,
      actualTitle,
      actualYear,
      actualDoubanId,
      actualSearchType,
      isAggregate,
      actualQuery,
      from,
    ]);

    const handleClick = useCallback(() => {
      // 如果是即将上映的内容，不执行跳转，显示提示
      if (isUpcoming) {
        return;
      }

      // 🔥 立即显示加载状态，提供即时反馈
      setIsNavigating(true);

      // 构建豆瓣ID参数
      const doubanIdParam =
        actualDoubanId && actualDoubanId > 0
          ? `&douban_id=${actualDoubanId}`
          : '';

      if (origin === 'live' && actualSource && actualId) {
        // 直播内容跳转到直播页面
        const url = `/live?source=${actualSource.replace('live_', '')}&id=${actualId.replace('live_', '')}`;
        router.push(url);
      } else if (actualSource === 'shortdrama' && actualId) {
        // 短剧内容 - 使用shortdrama_id参数
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}&shortdrama_id=${actualId}`;
        router.push(url);
      } else if (
        from === 'douban' ||
        (isAggregate && !actualSource && !actualId) ||
        actualSource === 'upcoming_release' ||
        actualSource === 'douban' ||
        actualSource === 'bangumi'
      ) {
        // 豆瓣内容 或 聚合搜索 或 即将上映 或 Bangumi番剧 - 只用标题和年份搜索
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}${
          actualYear ? `&year=${actualYear}` : ''
        }${doubanIdParam}${actualSearchType ? `&stype=${actualSearchType}` : ''}${isAggregate ? '&prefer=true' : ''}${actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''}`;
        router.push(url);
      } else if (actualSource && actualId) {
        const url = `/play?source=${actualSource}&id=${actualId}&title=${encodeURIComponent(
          actualTitle,
        )}${actualYear ? `&year=${actualYear}` : ''}${doubanIdParam}${
          isAggregate ? '&prefer=true' : ''
        }${
          actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''
        }${actualSearchType ? `&stype=${actualSearchType}` : ''}`;
        router.push(url);
      }
    }, [
      isUpcoming,
      origin,
      from,
      actualSource,
      actualId,
      router,
      actualTitle,
      actualYear,
      isAggregate,
      actualQuery,
      actualSearchType,
      actualDoubanId,
    ]);

    // 新标签页播放处理函数
    const handlePlayInNewTab = useCallback(() => {
      // 构建豆瓣ID参数
      const doubanIdParam =
        actualDoubanId && actualDoubanId > 0
          ? `&douban_id=${actualDoubanId}`
          : '';

      if (origin === 'live' && actualSource && actualId) {
        // 直播内容跳转到直播页面
        const url = `/live?source=${actualSource.replace('live_', '')}&id=${actualId.replace('live_', '')}`;
        window.open(url, '_blank');
      } else if (actualSource === 'shortdrama' && actualId) {
        // 短剧内容 - 使用shortdrama_id参数
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}&shortdrama_id=${actualId}`;
        window.open(url, '_blank');
      } else if (
        from === 'douban' ||
        (isAggregate && !actualSource && !actualId) ||
        actualSource === 'upcoming_release' ||
        actualSource === 'douban' ||
        actualSource === 'bangumi'
      ) {
        // 豆瓣内容 或 聚合搜索 或 即将上映 或 Bangumi番剧 - 只用标题和年份搜索
        const url = `/play?title=${encodeURIComponent(actualTitle.trim())}${actualYear ? `&year=${actualYear}` : ''}${doubanIdParam}${actualSearchType ? `&stype=${actualSearchType}` : ''}${isAggregate ? '&prefer=true' : ''}${actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''}`;
        window.open(url, '_blank');
      } else if (actualSource && actualId) {
        const url = `/play?source=${actualSource}&id=${actualId}&title=${encodeURIComponent(
          actualTitle,
        )}${actualYear ? `&year=${actualYear}` : ''}${doubanIdParam}${
          isAggregate ? '&prefer=true' : ''
        }${
          actualQuery ? `&stitle=${encodeURIComponent(actualQuery.trim())}` : ''
        }${actualSearchType ? `&stype=${actualSearchType}` : ''}`;
        window.open(url, '_blank');
      }
    }, [
      origin,
      from,
      actualSource,
      actualId,
      actualTitle,
      actualYear,
      isAggregate,
      actualQuery,
      actualSearchType,
      actualDoubanId,
    ]);

    // 长按操作
    const handleLongPress = useCallback(() => {
      if (!showMobileActions) {
        // 防止重复触发
        // 立即显示菜单，避免等待数据加载导致动画卡顿
        setShowMobileActions(true);

        // 收藏状态已由 useIsFavoritedQuery 自动处理
      }
    }, [
      showMobileActions,
      from,
      isAggregate,
      actualSource,
      actualId,
      searchFavorited,
    ]);

    // 长按手势hook
    const longPressProps = useLongPress({
      onLongPress: handleLongPress,
      onClick: handleClick, // 保持点击播放功能
      longPressDelay: 500,
    });

    // 根据评分获取徽章样式 - 使用 useMemo 缓存结果
    const ratingBadgeStyle = useMemo(() => {
      if (!rate) return null;

      const rateNum = parseFloat(rate);

      if (rateNum >= 8.5) {
        // 高分：金色 + 发光
        return {
          bgColor:
            'bg-linear-to-br from-yellow-400 via-amber-500 to-yellow-600',
          ringColor: 'ring-2 ring-yellow-400/50',
          shadowColor: 'shadow-lg shadow-yellow-500/50',
          textColor: 'text-white',
          glowClass: 'group-hover:shadow-yellow-500/70',
        };
      } else if (rateNum >= 7.0) {
        // 中高分：蓝色
        return {
          bgColor: 'bg-linear-to-br from-blue-500 via-blue-600 to-blue-700',
          ringColor: 'ring-2 ring-blue-400/40',
          shadowColor: 'shadow-md shadow-blue-500/30',
          textColor: 'text-white',
          glowClass: 'group-hover:shadow-blue-500/50',
        };
      } else if (rateNum >= 6.0) {
        // 中分：绿色
        return {
          bgColor: 'bg-linear-to-br from-green-500 via-green-600 to-green-700',
          ringColor: 'ring-2 ring-green-400/40',
          shadowColor: 'shadow-md shadow-green-500/30',
          textColor: 'text-white',
          glowClass: 'group-hover:shadow-green-500/50',
        };
      } else {
        // 低分：灰色
        return {
          bgColor: 'bg-linear-to-br from-gray-500 via-gray-600 to-gray-700',
          ringColor: 'ring-2 ring-gray-400/40',
          shadowColor: 'shadow-md shadow-gray-500/30',
          textColor: 'text-white',
          glowClass: 'group-hover:shadow-gray-500/50',
        };
      }
    }, [rate]);

    const config = useMemo(() => {
      const configs = {
        playrecord: {
          showSourceName: true,
          showProgress: true,
          showPlayButton: true,
          showHeart: true,
          showCheckCircle: true,
          showDoubanLink: false,
          showRating: false,
          showYear: false,
        },
        favorite: {
          showSourceName: true,
          showProgress: false,
          showPlayButton: true,
          showHeart: true,
          showCheckCircle: false,
          showDoubanLink: false,
          showRating: false,
          showYear: false,
        },
        search: {
          showSourceName: true,
          showProgress: false,
          showPlayButton: true,
          showHeart: true, // 移动端菜单中需要显示收藏选项
          showCheckCircle: false,
          showDoubanLink: true, // 移动端菜单中显示豆瓣链接
          showRating: false,
          showYear: true,
        },
        douban: {
          showSourceName: false,
          showProgress: false,
          showPlayButton: true,
          showHeart: true, // 所有豆瓣内容都显示收藏按钮
          showCheckCircle: false,
          showDoubanLink: true,
          showRating: !!rate,
          showYear: false,
        },
      };
      return configs[from] || configs.search;
    }, [from, isAggregate, douban_id, rate, isUpcoming]);

    // 移动端操作菜单配置
    const mobileActions = useMemo(() => {
      const actions = [];

      // 播放操作（即将上映的内容不显示播放选项）
      if (config.showPlayButton && !isUpcoming) {
        actions.push({
          id: 'play',
          label: origin === 'live' ? '观看直播' : '播放',
          icon: <PlayCircleIcon size={20} />,
          onClick: handleClick,
          color: 'primary' as const,
        });

        // 新标签页播放
        actions.push({
          id: 'play-new-tab',
          label: origin === 'live' ? '新标签页观看' : '新标签页播放',
          icon: <ExternalLink size={20} />,
          onClick: handlePlayInNewTab,
          color: 'default' as const,
        });
      }

      // 即将上映提示（替代播放操作）
      if (isUpcoming) {
        actions.push({
          id: 'upcoming-notice',
          label: '该影片尚未上映，敬请期待',
          icon: <span className='text-lg'>📅</span>,
          onClick: () => {}, // 不执行任何操作
          disabled: true,
          color: 'default' as const,
        });
      }

      // 聚合源信息 - 直接在菜单中展示，不需要单独的操作项

      // 收藏/取消收藏操作（或提醒操作）
      if (config.showHeart && actualSource && actualId) {
        // The query cache includes pending optimistic changes.
        const currentState = shouldShowBell ? reminded : favorited;

        if (favoriteActionDisabled || favoriteRetryAvailable) {
          actions.push({
            id: favoriteRetryAvailable ? 'favorite-retry' : 'favorite-loading',
            label: favoriteActionLabel,
            icon: favoriteActionBusy ? (
              <LoaderCircle size={20} className='animate-spin' />
            ) : (
              <RefreshCw size={20} />
            ),
            onClick: () => {
              if (!favoriteRetryAvailable) return;
              handleToggleFavorite({
                preventDefault() {},
                stopPropagation() {},
              } as React.MouseEvent);
            },
            disabled: favoriteActionDisabled,
            closeOnClick: !favoriteRetryAvailable,
          });
        } else if (from === 'search') {
          // 搜索结果：根据加载状态显示不同的选项
          const isLoaded = shouldShowBell
            ? remindedStatus !== undefined
            : searchFavorited !== null;

          if (isLoaded) {
            // 已加载完成，显示实际的状态
            const favoriteIcon = shouldShowBell ? (
              currentState ? (
                <BellRing
                  size={20}
                  className='fill-orange-600 stroke-orange-600'
                />
              ) : (
                <Bell
                  size={20}
                  className='fill-transparent stroke-orange-500'
                />
              )
            ) : currentState ? (
              <Heart size={20} className='fill-red-600 stroke-red-600' />
            ) : (
              <Heart size={20} className='fill-transparent stroke-red-500' />
            );

            const favoriteLabel = shouldShowBell
              ? currentState
                ? '取消想看'
                : '想看'
              : currentState
                ? '取消收藏'
                : '添加收藏';

            actions.push({
              id: 'favorite',
              label: favoriteLabel,
              icon: favoriteIcon,
              onClick: () => {
                const mockEvent = {
                  preventDefault: () => {},
                  stopPropagation: () => {},
                } as React.MouseEvent;
                handleToggleFavorite(mockEvent);
              },
              color: currentState ? ('danger' as const) : ('default' as const),
            });
          } else {
            // 正在加载中，显示占位项
            const loadingIcon = shouldShowBell ? (
              <Bell size={20} />
            ) : (
              <Heart size={20} />
            );
            const loadingLabel = shouldShowBell
              ? '想看加载中...'
              : '收藏加载中...';

            actions.push({
              id: 'favorite-loading',
              label: loadingLabel,
              icon: loadingIcon,
              onClick: () => {}, // 加载中时不响应点击
              disabled: true,
            });
          }
        } else {
          // 非搜索结果：直接显示收藏/提醒选项
          const favoriteIcon = shouldShowBell ? (
            currentState ? (
              <BellRing
                size={20}
                className='fill-orange-600 stroke-orange-600'
              />
            ) : (
              <Bell size={20} className='fill-transparent stroke-orange-500' />
            )
          ) : currentState ? (
            <Heart size={20} className='fill-red-600 stroke-red-600' />
          ) : (
            <Heart size={20} className='fill-transparent stroke-red-500' />
          );

          const favoriteLabel = shouldShowBell
            ? currentState
              ? '取消想看'
              : '想看'
            : currentState
              ? '取消收藏'
              : '添加收藏';

          actions.push({
            id: 'favorite',
            label: favoriteLabel,
            icon: favoriteIcon,
            onClick: () => {
              const mockEvent = {
                preventDefault: () => {},
                stopPropagation: () => {},
              } as React.MouseEvent;
              handleToggleFavorite(mockEvent);
            },
            color: currentState ? ('danger' as const) : ('default' as const),
          });
        }
      }

      // 删除播放记录操作
      if (
        config.showCheckCircle &&
        from === 'playrecord' &&
        actualSource &&
        actualId
      ) {
        actions.push({
          id: 'delete',
          label: '删除记录',
          icon: <Trash2 size={20} />,
          onClick: () => {
            const mockEvent = {
              preventDefault: () => {},
              stopPropagation: () => {},
            } as React.MouseEvent;
            handleDeleteRecord(mockEvent);
          },
          color: 'danger' as const,
        });
      }

      // 豆瓣链接操作
      if (config.showDoubanLink && actualDoubanId && actualDoubanId !== 0) {
        actions.push({
          id: 'douban',
          label: isBangumi ? 'Bangumi 详情' : '豆瓣详情',
          icon: <Link size={20} />,
          onClick: () => {
            const url = isBangumi
              ? `https://bgm.tv/subject/${actualDoubanId.toString()}`
              : `https://movie.douban.com/subject/${actualDoubanId.toString()}`;
            window.open(url, '_blank', 'noopener,noreferrer');
          },
          color: 'default' as const,
        });
      }

      return actions;
    }, [
      config,
      from,
      actualSource,
      actualId,
      favorited,
      reminded,
      remindedStatus,
      searchFavorited,
      favoriteActionDisabled,
      favoriteRetryAvailable,
      favoriteActionBusy,
      favoriteActionLabel,
      shouldShowBell,
      actualDoubanId,
      isBangumi,
      isAggregate,
      dynamicSourceNames,
      isUpcoming,
      origin,
      handleClick,
      handlePlayInNewTab,
      handleToggleFavorite,
      handleDeleteRecord,
      actualTitle,
    ]);

    return (
      <>
        <div
          className='@container group relative w-full rounded-lg bg-transparent cursor-pointer transition-all duration-300 ease-in-out hover:scale-[1.05] hover:z-30 hover:shadow-2xl'
          onClick={(event) => {
            if ((event.target as Element).closest('button:disabled')) return;
            handleClick();
          }}
          onMouseEnter={handlePrefetch}
          onFocus={handlePrefetch}
          {...longPressProps}
          style={
            {
              // 禁用所有默认的长按和选择效果
              WebkitUserSelect: 'none',
              userSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              // 禁用右键菜单和长按菜单
              pointerEvents: 'auto',
            } as React.CSSProperties
          }
          onContextMenu={(e) => {
            // 阻止默认右键菜单
            e.preventDefault();
            e.stopPropagation();

            // 右键弹出操作菜单
            setShowMobileActions(true);

            // 收藏状态已由 useIsFavoritedQuery 自动处理

            return false;
          }}
          onDragStart={(e) => {
            // 阻止拖拽
            e.preventDefault();
            return false;
          }}
        >
          {/* 海报容器 */}
          <div
            className={`relative aspect-[2/3] overflow-hidden rounded-lg ${origin === 'live' ? 'ring-1 ring-gray-300/80 dark:ring-gray-600/80' : ''}`}
            style={
              {
                WebkitUserSelect: 'none',
                userSelect: 'none',
                WebkitTouchCallout: 'none',
              } as React.CSSProperties
            }
            onContextMenu={(e) => {
              e.preventDefault();
              return false;
            }}
          >
            {/* 渐变光泽动画层 */}
            <div
              className='absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none z-10'
              style={{
                background:
                  'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.15) 45%, rgba(255,255,255,0.4) 50%, rgba(255,255,255,0.15) 55%, transparent 70%)',
                backgroundSize: '200% 100%',
                animation: 'card-shimmer 2.5s ease-in-out infinite',
              }}
            />

            {/* 骨架屏 */}
            {!isLoading && <ImagePlaceholder aspectRatio='aspect-[2/3]' />}
            {/* 图片 */}
            <Image
              src={processImageUrl(actualPoster)}
              alt={actualTitle}
              fill
              sizes='(max-width: 640px) 33vw, (max-width: 768px) 25vw, (max-width: 1024px) 20vw, 16vw'
              className={`${origin === 'live' ? 'object-contain' : 'object-cover'} transition-opacity duration-300 ease-out ${
                imageLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              referrerPolicy='no-referrer'
              loading={priority ? undefined : 'lazy'}
              priority={priority}
              quality={75}
              onLoad={() => {
                loadedImageUrls.add(processImageUrl(actualPoster));
                if (!imageLoaded) {
                  setIsLoading(true);
                  setImageLoaded(true);
                }
              }}
              onError={(e) => {
                // 图片加载失败时的处理
                const img = e.target as HTMLImageElement;
                if (origin === 'live') {
                  // 直播频道使用默认图标，不重试避免闪烁
                  img.src =
                    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"%3E%3Crect fill="%23374151" width="200" height="300"/%3E%3Cg fill="%239CA3AF"%3E%3Ccircle cx="100" cy="120" r="30"/%3E%3Cpath d="M60 160 Q60 140 80 140 L120 140 Q140 140 140 160 L140 200 Q140 220 120 220 L80 220 Q60 220 60 200 Z"/%3E%3C/g%3E%3Ctext x="100" y="260" font-family="Arial" font-size="14" fill="%239CA3AF" text-anchor="middle"%3E直播频道%3C/text%3E%3C/svg%3E';
                  setImageLoaded(true);
                } else if (!img.dataset.retried) {
                  // 非直播内容重试一次
                  img.dataset.retried = 'true';
                  setTimeout(() => {
                    img.src = processImageUrl(actualPoster);
                  }, 2000);
                } else {
                  // 重试失败，使用通用占位图
                  img.src =
                    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"%3E%3Crect fill="%23374151" width="200" height="300"/%3E%3Cg fill="%239CA3AF"%3E%3Cpath d="M100 80 L100 120 M80 100 L120 100" stroke="%239CA3AF" stroke-width="8" stroke-linecap="round"/%3E%3Crect x="60" y="140" width="80" height="100" rx="5" fill="none" stroke="%239CA3AF" stroke-width="4"/%3E%3Cpath d="M70 160 L90 180 L130 140" stroke="%239CA3AF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/%3E%3C/g%3E%3Ctext x="100" y="270" font-family="Arial" font-size="12" fill="%239CA3AF" text-anchor="middle"%3E暂无海报%3C/text%3E%3C/svg%3E';
                  setImageLoaded(true);
                }
              }}
              style={
                {
                  // 禁用图片的默认长按效果
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  WebkitTouchCallout: 'none',
                  pointerEvents: 'none', // 图片不响应任何指针事件
                } as React.CSSProperties
              }
              onContextMenu={(e) => {
                e.preventDefault();
                return false;
              }}
              onDragStart={(e) => {
                e.preventDefault();
                return false;
              }}
            />

            {/* 悬浮遮罩 - 玻璃态效果 */}
            <div
              className='absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent transition-all duration-300 ease-in-out opacity-0 group-hover:opacity-100 backdrop-blur-[2px]'
              style={
                {
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  WebkitTouchCallout: 'none',
                } as React.CSSProperties
              }
              onContextMenu={(e) => {
                e.preventDefault();
                return false;
              }}
            />

            {/* 播放按钮 / 即将上映提示 / 加载状态 */}
            {config.showPlayButton && (
              <div
                className={`absolute inset-0 flex items-center justify-center transition-all duration-300 ease-in-out ${
                  isNavigating
                    ? 'opacity-100 scale-100'
                    : 'opacity-0 delay-75 group-hover:opacity-100 group-hover:scale-100'
                }`}
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                {isNavigating ? (
                  // 🔥 加载状态 - 提供即时反馈
                  <div className='flex flex-col items-center gap-2 bg-black/60 backdrop-blur-md px-6 py-4 rounded-xl'>
                    <div className='w-10 h-10 border-4 border-green-500/30 border-t-green-500 rounded-full animate-spin' />
                    <span className='text-white font-bold text-sm whitespace-nowrap'>
                      加载中...
                    </span>
                  </div>
                ) : isUpcoming ? (
                  // 即将上映 - 显示敬请期待
                  <div className='flex flex-col items-center gap-2 bg-black/60 backdrop-blur-md px-6 py-4 rounded-xl'>
                    <span className='text-3xl'>📅</span>
                    <span className='text-white font-bold text-sm whitespace-nowrap'>
                      敬请期待
                    </span>
                  </div>
                ) : (
                  // 正常内容 - 显示播放按钮
                  <PlayCircleIcon
                    size={50}
                    strokeWidth={1.5}
                    className='text-white fill-transparent transition-all duration-300 ease-out hover:text-green-500 hover:scale-[1.15] drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]'
                    style={
                      {
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        WebkitTouchCallout: 'none',
                      } as React.CSSProperties
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      return false;
                    }}
                  />
                )}
              </div>
            )}

            {/* 操作按钮 - hover显示（非收藏页面） */}
            {(config.showHeart || config.showCheckCircle) &&
              from !== 'favorite' && (
                <div
                  data-button='true'
                  className='absolute bottom-3 right-3 flex gap-3 opacity-0 translate-y-2 transition-all duration-300 ease-in-out sm:group-hover:opacity-100 sm:group-hover:translate-y-0'
                  style={
                    {
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    return false;
                  }}
                >
                  {config.showCheckCircle && (
                    <Trash2
                      onClick={handleDeleteRecord}
                      size={20}
                      className='text-white transition-all duration-300 ease-out hover:stroke-red-500 hover:scale-[1.1]'
                      style={
                        {
                          WebkitUserSelect: 'none',
                          userSelect: 'none',
                          WebkitTouchCallout: 'none',
                        } as React.CSSProperties
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        return false;
                      }}
                    />
                  )}
                  {config.showHeart && (
                    <button
                      type='button'
                      onClick={handleToggleFavorite}
                      disabled={favoriteActionDisabled}
                      aria-busy={favoriteActionBusy}
                      aria-label={favoriteActionLabel}
                      title={favoriteActionLabel}
                      className='inline-flex disabled:cursor-wait disabled:opacity-60'
                    >
                      {favoriteActionBusy ? (
                        <LoaderCircle
                          size={20}
                          className='animate-spin text-white'
                        />
                      ) : favoriteRetryAvailable ? (
                        <RefreshCw size={20} className='text-white' />
                      ) : (
                        (() => {
                          if (shouldShowBell) {
                            // 即将上映或新上映：显示铃铛图标（使用 reminded 状态）
                            return reminded ? (
                              <BellRing
                                size={20}
                                className='fill-orange-600 stroke-orange-600 transition-all duration-300 ease-out hover:scale-[1.1]'
                                style={
                                  {
                                    WebkitUserSelect: 'none',
                                    userSelect: 'none',
                                    WebkitTouchCallout: 'none',
                                  } as React.CSSProperties
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  return false;
                                }}
                              />
                            ) : (
                              <Bell
                                size={20}
                                className='fill-transparent stroke-white hover:stroke-orange-400 transition-all duration-300 ease-out hover:scale-[1.1]'
                                style={
                                  {
                                    WebkitUserSelect: 'none',
                                    userSelect: 'none',
                                    WebkitTouchCallout: 'none',
                                  } as React.CSSProperties
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  return false;
                                }}
                              />
                            );
                          } else {
                            // 已上映：显示爱心图标（使用 favorited 状态）
                            return (
                              <Heart
                                size={20}
                                className={`transition-all duration-300 ease-out ${
                                  favorited
                                    ? 'fill-red-600 stroke-red-600'
                                    : 'fill-transparent stroke-white hover:stroke-red-400'
                                } hover:scale-[1.1]`}
                                style={
                                  {
                                    WebkitUserSelect: 'none',
                                    userSelect: 'none',
                                    WebkitTouchCallout: 'none',
                                  } as React.CSSProperties
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  return false;
                                }}
                              />
                            );
                          }
                        })()
                      )}
                    </button>
                  )}
                </div>
              )}

            {/* 收藏页面专用：固定显示的爱心/铃铛按钮 */}
            {from === 'favorite' && config.showHeart && (
              <button
                type='button'
                data-button='true'
                disabled={favoriteActionDisabled}
                aria-busy={favoriteActionBusy}
                aria-label={favoriteActionLabel}
                title={favoriteActionLabel}
                className='absolute bottom-2 right-2 z-30 disabled:cursor-wait disabled:opacity-60'
                onClick={handleToggleFavorite}
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                    cursor: 'pointer',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                {favoriteActionBusy ? (
                  <LoaderCircle size={16} className='animate-spin text-white' />
                ) : favoriteRetryAvailable ? (
                  <RefreshCw size={16} className='text-white' />
                ) : (
                  (() => {
                    return shouldShowBell ? (
                      <BellRing
                        size={16}
                        className='fill-orange-500 stroke-orange-500 transition-all duration-300 hover:scale-110 hover:fill-orange-600 hover:stroke-orange-600'
                      />
                    ) : (
                      <Heart
                        size={16}
                        className='fill-red-500 stroke-red-500 transition-all duration-300 hover:scale-110 hover:fill-red-600 hover:stroke-red-600'
                      />
                    );
                  })()
                )}
              </button>
            )}

            {/* 集数角标 - Netflix/DecoTV 风格 - 左上角 */}
            {/* 即将上映的内容不显示集数徽章（因为是占位符数据）*/}
            {/* 收藏页面：过滤掉99集的占位符显示，只显示真实集数 */}
            {actualEpisodes &&
              actualEpisodes > 1 &&
              !isUpcoming &&
              !(from === 'favorite' && actualEpisodes === 99) && (
                <div
                  className='absolute top-2 left-2 flex items-stretch overflow-hidden rounded-md shadow-lg transition-all duration-300 ease-out group-hover:scale-105 z-30'
                  style={
                    {
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    return false;
                  }}
                >
                  {currentEpisode ? (
                    <>
                      {/* 左侧：当前集 - 品牌色背景（红色） */}
                      <span className='flex items-center bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white'>
                        EP {String(currentEpisode).padStart(2, '0')}
                      </span>
                      {/* 右侧：总集数 - 半透明黑背景 */}
                      <span className='flex items-center bg-black/70 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium text-white/60'>
                        / {actualEpisodes}
                      </span>
                    </>
                  ) : (
                    /* 仅显示总集数 */
                    <span className='flex items-center bg-black/70 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/80'>
                      {actualEpisodes} 集
                    </span>
                  )}
                </div>
              )}

            {/* 年份徽章 - Netflix 风格 - 左上角第二位 */}
            {config.showYear &&
              actualYear &&
              actualYear !== 'unknown' &&
              actualYear.trim() !== '' && (
                <div
                  className={`absolute left-2 flex items-center bg-black/70 backdrop-blur-sm px-2 py-0.5 rounded-md shadow-lg text-white/80 text-[10px] font-medium transition-all duration-300 ease-out group-hover:scale-105 z-30 ${
                    actualEpisodes &&
                    actualEpisodes > 1 &&
                    !isUpcoming &&
                    !(from === 'favorite' && actualEpisodes === 99)
                      ? 'top-[38px]' // 有集数徽章时向下偏移
                      : 'top-2'
                  }`}
                  style={
                    {
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    return false;
                  }}
                >
                  {actualYear}
                </div>
              )}

            {/* 已完结徽章 - Netflix 风格 - 底部左侧 */}
            {remarks && isSeriesCompleted(remarks) && (
              <div
                className='absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 backdrop-blur-sm px-2 py-0.5 rounded-md shadow-lg text-white/80 text-[10px] font-medium transition-all duration-300 ease-out group-hover:scale-105 z-30'
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                <span className='text-green-400'>✓</span>
                <span>已完结</span>
              </div>
            )}

            {/* 上映状态徽章 - Netflix 风格 - 底部左侧 */}
            {hasReleaseTag &&
              (() => {
                // 根据状态选择颜色和文本
                let statusColor = 'text-orange-400';
                let statusText = remarks || '';

                if (remarks?.includes('已上映')) {
                  statusColor = 'text-green-400';
                } else if (remarks?.includes('今日上映')) {
                  statusColor = 'text-yellow-400';
                }

                return (
                  <div
                    className='absolute bottom-2 left-2 flex items-center gap-1 bg-black/70 backdrop-blur-sm px-2 py-0.5 rounded-md shadow-lg text-[10px] font-medium transition-all duration-300 ease-out group-hover:scale-105 z-30'
                    style={
                      {
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        WebkitTouchCallout: 'none',
                      } as React.CSSProperties
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      return false;
                    }}
                  >
                    <span className={statusColor}>●</span>
                    <span className='text-white/80'>{statusText}</span>
                  </div>
                );
              })()}

            {/* 评分徽章 - 动态颜色 - 🎯 使用容器查询替代媒体查询 */}
            {config.showRating && rate && ratingBadgeStyle && (
              <div
                className={`absolute top-2 right-2 ${ratingBadgeStyle.bgColor} ${ratingBadgeStyle.ringColor} ${ratingBadgeStyle.shadowColor} ${ratingBadgeStyle.textColor} ${ratingBadgeStyle.glowClass} text-xs font-bold rounded-full flex flex-col items-center justify-center transition-all duration-300 ease-out group-hover:scale-110 backdrop-blur-sm w-9 h-9 @[180px]:w-10 @[180px]:h-10`}
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                <Star size={10} className='fill-current mb-0.5' />
                <span className='text-[10px] @[180px]:text-xs font-extrabold leading-none'>
                  {rate}
                </span>
              </div>
            )}

            {/* 豆瓣链接 */}
            {config.showDoubanLink &&
              actualDoubanId &&
              actualDoubanId !== 0 && (
                <a
                  href={
                    isBangumi
                      ? `https://bgm.tv/subject/${actualDoubanId.toString()}`
                      : `https://movie.douban.com/subject/${actualDoubanId.toString()}`
                  }
                  target='_blank'
                  rel='noopener noreferrer'
                  onClick={(e) => e.stopPropagation()}
                  className='absolute top-2 left-2 opacity-0 -translate-x-2 transition-all duration-300 ease-in-out delay-100 sm:group-hover:opacity-100 sm:group-hover:translate-x-0'
                  style={
                    {
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    return false;
                  }}
                >
                  <div
                    className='bg-green-500 text-white text-xs font-bold w-7 h-7 rounded-full flex items-center justify-center shadow-md hover:bg-green-600 hover:scale-[1.1] transition-all duration-300 ease-out'
                    style={
                      {
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        WebkitTouchCallout: 'none',
                      } as React.CSSProperties
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      return false;
                    }}
                  >
                    <Link
                      size={16}
                      style={
                        {
                          WebkitUserSelect: 'none',
                          userSelect: 'none',
                          WebkitTouchCallout: 'none',
                          pointerEvents: 'none',
                        } as React.CSSProperties
                      }
                    />
                  </div>
                </a>
              )}

            {/* 聚合播放源指示器 - Netflix 统一风格 */}
            {isAggregate &&
              dynamicSourceNames &&
              dynamicSourceNames.length > 0 &&
              (() => {
                const uniqueSources = Array.from(new Set(dynamicSourceNames));
                const sourceCount = uniqueSources.length;

                return (
                  <div
                    className='absolute bottom-2 right-2 opacity-0 transition-all duration-300 ease-in-out delay-75 sm:group-hover:opacity-100'
                    style={
                      {
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        WebkitTouchCallout: 'none',
                      } as React.CSSProperties
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      return false;
                    }}
                  >
                    <div
                      className='relative group/sources'
                      style={
                        {
                          WebkitUserSelect: 'none',
                          userSelect: 'none',
                          WebkitTouchCallout: 'none',
                        } as React.CSSProperties
                      }
                    >
                      {/* 源数量徽章 */}
                      <div
                        className='bg-black/70 backdrop-blur-sm text-white text-[10px] font-bold px-2 py-0.5 rounded-md shadow-lg flex items-center gap-1 hover:scale-105 transition-all duration-300 cursor-pointer'
                        style={
                          {
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                            WebkitTouchCallout: 'none',
                          } as React.CSSProperties
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          return false;
                        }}
                      >
                        <span>{sourceCount}</span>
                        <span className='text-white/60'>源</span>
                      </div>

                      {/* 播放源详情悬浮框 */}
                      {(() => {
                        // 优先显示的播放源（常见的主流平台）
                        const prioritySources = [
                          '爱奇艺',
                          '腾讯视频',
                          '优酷',
                          '芒果TV',
                          '哔哩哔哩',
                          'Netflix',
                          'Disney+',
                        ];

                        // 按优先级排序播放源
                        const sortedSources = uniqueSources.sort((a, b) => {
                          const aIndex = prioritySources.indexOf(a);
                          const bIndex = prioritySources.indexOf(b);
                          if (aIndex !== -1 && bIndex !== -1)
                            return aIndex - bIndex;
                          if (aIndex !== -1) return -1;
                          if (bIndex !== -1) return 1;
                          return a.localeCompare(b);
                        });

                        const maxDisplayCount = 6; // 最多显示6个
                        const displaySources = sortedSources.slice(
                          0,
                          maxDisplayCount,
                        );
                        const hasMore = sortedSources.length > maxDisplayCount;
                        const remainingCount =
                          sortedSources.length - maxDisplayCount;

                        return (
                          <div
                            className='absolute bottom-full mb-2 opacity-0 invisible group-hover/sources:opacity-100 group-hover/sources:visible transition-all duration-200 ease-out delay-100 pointer-events-none z-40 right-0 sm:right-0 -translate-x-0 sm:translate-x-0'
                            style={
                              {
                                WebkitUserSelect: 'none',
                                userSelect: 'none',
                                WebkitTouchCallout: 'none',
                              } as React.CSSProperties
                            }
                            onContextMenu={(e) => {
                              e.preventDefault();
                              return false;
                            }}
                          >
                            <div
                              className='bg-gray-800/90 backdrop-blur-sm text-white text-xs sm:text-xs rounded-lg shadow-xl border border-white/10 p-1.5 sm:p-2 min-w-[100px] sm:min-w-[120px] max-w-[140px] sm:max-w-[200px] overflow-hidden'
                              style={
                                {
                                  WebkitUserSelect: 'none',
                                  userSelect: 'none',
                                  WebkitTouchCallout: 'none',
                                } as React.CSSProperties
                              }
                              onContextMenu={(e) => {
                                e.preventDefault();
                                return false;
                              }}
                            >
                              {/* 单列布局 */}
                              <div className='space-y-0.5 sm:space-y-1'>
                                {displaySources.map((sourceName, index) => (
                                  <div
                                    key={index}
                                    className='flex items-center gap-1 sm:gap-1.5'
                                  >
                                    <div className='w-0.5 h-0.5 sm:w-1 sm:h-1 bg-blue-400 rounded-full shrink-0'></div>
                                    <span
                                      className='truncate text-[10px] sm:text-xs leading-tight'
                                      title={sourceName}
                                    >
                                      {sourceName}
                                    </span>
                                  </div>
                                ))}
                              </div>

                              {/* 显示更多提示 */}
                              {hasMore && (
                                <div className='mt-1 sm:mt-2 pt-1 sm:pt-1.5 border-t border-gray-700/50'>
                                  <div className='flex items-center justify-center text-gray-400'>
                                    <span className='text-[10px] sm:text-xs font-medium'>
                                      +{remainingCount} 播放源
                                    </span>
                                  </div>
                                </div>
                              )}

                              {/* 小箭头 */}
                              <div className='absolute top-full right-2 sm:right-3 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[4px] sm:border-l-[6px] sm:border-r-[6px] sm:border-t-[6px] border-transparent border-t-gray-800/90'></div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}
          </div>

          {/* 进度条 */}
          {config.showProgress && progress !== undefined && (
            <div
              className='mt-1 h-1 w-full bg-gray-200 rounded-full overflow-hidden'
              style={
                {
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  WebkitTouchCallout: 'none',
                } as React.CSSProperties
              }
              onContextMenu={(e) => {
                e.preventDefault();
                return false;
              }}
            >
              <div
                className='h-full bg-green-500 transition-all duration-500 ease-out'
                style={
                  {
                    width: `${progress}%`,
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              />
            </div>
          )}

          {/* 标题与来源 */}
          <div
            className='mt-2 text-center'
            style={
              {
                WebkitUserSelect: 'none',
                userSelect: 'none',
                WebkitTouchCallout: 'none',
              } as React.CSSProperties
            }
            onContextMenu={(e) => {
              e.preventDefault();
              return false;
            }}
          >
            <div
              className='relative px-1'
              style={
                {
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  WebkitTouchCallout: 'none',
                } as React.CSSProperties
              }
            >
              {/* 背景高亮效果 */}
              <div className='absolute inset-0 bg-linear-to-r from-transparent via-green-50/0 to-transparent dark:via-green-900/0 group-hover:via-green-50/50 dark:group-hover:via-green-900/30 transition-all duration-300 rounded-md'></div>

              <span
                className='block text-xs @[140px]:text-sm font-bold line-clamp-2 text-gray-900 dark:text-gray-100 transition-all duration-300 ease-in-out group-hover:scale-[1.02] peer relative z-10 group-hover:bg-linear-to-r group-hover:from-green-600 group-hover:via-emerald-600 group-hover:to-teal-600 dark:group-hover:from-green-400 dark:group-hover:via-emerald-400 dark:group-hover:to-teal-400 group-hover:bg-clip-text group-hover:text-transparent group-hover:drop-shadow-[0_2px_8px_rgba(16,185,129,0.3)]'
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    lineHeight: '1.4',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                {actualTitle}
              </span>
              {/* 增强的 tooltip */}
              <div
                className='absolute bottom-full left-0 mb-2 px-3 py-2 bg-linear-to-br from-gray-800 to-gray-900 text-white text-xs rounded-lg shadow-xl border border-white/10 opacity-0 invisible peer-hover:opacity-100 peer-hover:visible transition-all duration-200 ease-out delay-100 pointer-events-none z-40 backdrop-blur-sm'
                style={
                  {
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    WebkitTouchCallout: 'none',
                    minWidth: '200px',
                    maxWidth: 'min(90vw, 400px)',
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    left: '50%',
                    transform: 'translateX(-50%)',
                  } as React.CSSProperties
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  return false;
                }}
              >
                <span className='font-medium leading-relaxed block text-center'>
                  {actualTitle}
                </span>
                <div
                  className='absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-transparent border-t-gray-800'
                  style={
                    {
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties
                  }
                ></div>
              </div>
            </div>

            {config.showSourceName &&
              source_name &&
              (() => {
                // 智能显示source_name：如果有上映状态标记，优先显示状态；否则显示来源
                let displayText = source_name;
                let themeColor = 'green'; // 默认绿色主题

                if (hasReleaseTag && remarks) {
                  // 有上映状态时，根据状态显示不同文本和颜色
                  if (remarks.includes('天后上映')) {
                    displayText = remarks; // 显示"X天后上映"
                    themeColor = 'orange';
                  } else if (remarks.includes('今日上映')) {
                    displayText = '今日上映';
                    themeColor = 'yellow';
                  } else if (remarks.includes('已上映')) {
                    displayText = remarks; // 显示"已上映X天"
                    themeColor = 'green';
                  }
                }

                // 根据主题颜色设置class
                const colorClasses = {
                  green:
                    'group-hover:border-green-500/80 group-hover:text-green-600 dark:group-hover:text-green-400 group-hover:shadow-green-500/20',
                  orange:
                    'group-hover:border-orange-500/80 group-hover:text-orange-600 dark:group-hover:text-orange-400 group-hover:shadow-orange-500/20',
                  yellow:
                    'group-hover:border-yellow-500/80 group-hover:text-yellow-600 dark:group-hover:text-yellow-400 group-hover:shadow-yellow-500/20',
                }[themeColor];

                const bgGradient = {
                  green:
                    'group-hover:via-green-50/80 dark:group-hover:via-green-500/20',
                  orange:
                    'group-hover:via-orange-50/80 dark:group-hover:via-orange-500/20',
                  yellow:
                    'group-hover:via-yellow-50/80 dark:group-hover:via-yellow-500/20',
                }[themeColor];

                const dotColor = {
                  green:
                    'group-hover:bg-green-500 dark:group-hover:bg-green-400 group-hover:shadow-[0_0_8px_rgba(16,185,129,0.6)]',
                  orange:
                    'group-hover:bg-orange-500 dark:group-hover:bg-orange-400 group-hover:shadow-[0_0_8px_rgba(249,115,22,0.6)]',
                  yellow:
                    'group-hover:bg-yellow-500 dark:group-hover:bg-yellow-400 group-hover:shadow-[0_0_8px_rgba(234,179,8,0.6)]',
                }[themeColor];

                const iconColor = {
                  green:
                    'group-hover:text-green-500 dark:group-hover:text-green-400',
                  orange:
                    'group-hover:text-orange-500 dark:group-hover:text-orange-400',
                  yellow:
                    'group-hover:text-yellow-500 dark:group-hover:text-yellow-400',
                }[themeColor];

                return (
                  <div
                    className='flex items-center justify-center mt-2'
                    style={
                      {
                        WebkitUserSelect: 'none',
                        userSelect: 'none',
                        WebkitTouchCallout: 'none',
                      } as React.CSSProperties
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      return false;
                    }}
                  >
                    <span
                      className={`relative inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border border-gray-300/60 dark:border-gray-600/60 text-gray-600 dark:text-gray-400 transition-all duration-300 ease-out overflow-hidden group-hover:shadow-md group-hover:scale-105 ${colorClasses}`}
                      style={
                        {
                          WebkitUserSelect: 'none',
                          userSelect: 'none',
                          WebkitTouchCallout: 'none',
                        } as React.CSSProperties
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        return false;
                      }}
                    >
                      {/* 背景渐变效果 */}
                      <span
                        className={`absolute inset-0 bg-linear-to-r from-transparent via-green-50/0 to-transparent dark:via-green-500/0 transition-all duration-300 ${bgGradient}`}
                      ></span>

                      {/* 左侧装饰点 */}
                      <span
                        className={`relative w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 transition-all duration-300 ${dotColor}`}
                      ></span>

                      {origin === 'live' && (
                        <Radio
                          size={12}
                          className={`relative inline-block transition-all duration-300 ${iconColor}`}
                        />
                      )}

                      <span className='relative font-semibold'>
                        {displayText}
                      </span>

                      {/* 右侧装饰点 */}
                      <span
                        className={`relative w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 transition-all duration-300 ${dotColor}`}
                      ></span>
                    </span>
                  </div>
                );
              })()}
          </div>
        </div>

        {/* 操作菜单 - 支持右键和长按触发 */}
        <MobileActionSheet
          isOpen={showMobileActions}
          onClose={() => setShowMobileActions(false)}
          title={actualTitle}
          poster={processImageUrl(actualPoster)}
          actions={mobileActions}
          sources={
            isAggregate && dynamicSourceNames
              ? Array.from(new Set(dynamicSourceNames))
              : undefined
          }
          isAggregate={isAggregate}
          sourceName={source_name}
          currentEpisode={currentEpisode}
          totalEpisodes={actualEpisodes}
          origin={origin}
          doubanId={actualDoubanId}
          videoTitle={actualTitle}
          videoYear={actualYear}
          isBangumi={isBangumi}
        />
      </>
    );
  },
);

export default memo(VideoCard);
