/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import {
  DanmuApiError,
  fetchDanmuComments,
  getDanmuApiConfig,
  getDanmuApiErrorMessage,
  getDanmuEpisodes,
  normalizeDanmuVideoUrl,
  searchDanmuAnimes,
} from '@/lib/danmu-api';
import { fetchDoubanWithVerification } from '@/lib/douban-anti-crawler';
import {
  getDbQueryCount,
  recordRequest,
  resetDbQueryCount,
} from '@/lib/performance-monitor';
import {
  DEFAULT_USER_AGENT,
  getRandomUserAgentWithInfo,
  getSecChUaHeaders,
} from '@/lib/user-agent';

interface PlatformUrl {
  platform: string;
  url: string;
}

function isRemovedVideoUrl(value: string): boolean {
  try {
    const target = value.trim();
    const hostname = new URL(
      target.startsWith('//') ? `https:${target}` : target,
    ).hostname
      .toLowerCase()
      .replace(/\.$/, '');
    return [
      'bilibili.com',
      'b23.tv',
      'youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
    ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

interface DanmuApiResponse {
  code: number;
  name: string;
  danum: number;
  danmuku: any[];
}

interface DanmuItem {
  text: string;
  time: number;
  color?: string;
  mode?: number;
}

function createTimedRequest(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

function cancelledResponse() {
  return NextResponse.json(
    { error: '弹幕请求已取消', danmu: [], total: 0 },
    { status: 499 },
  );
}

function limitDanmu(danmu: DanmuItem[]): DanmuItem[] {
  const limit = 20000;
  if (danmu.length <= limit) return danmu;
  // Keep samples across the complete, time-sorted episode, including both ends.
  return Array.from(
    { length: limit },
    (_, index) => danmu[Math.round((index * (danmu.length - 1)) / (limit - 1))],
  );
}

// 从自定义弹幕API获取弹幕（主用）
async function fetchDanmuFromCustomAPI(
  title: string,
  episode?: string | null,
  year?: string | null,
  signal?: AbortSignal,
): Promise<{ danmu: DanmuItem[]; source: string } | null> {
  signal?.throwIfAborted();
  const config = await getDanmuApiConfig();
  signal?.throwIfAborted();

  if (!config.enabled || !config.apiUrl) {
    console.log('🔇 弹幕API未启用或未配置');
    return null;
  }

  const request = createTimedRequest(config.timeout * 1000, signal);

  try {
    request.signal.throwIfAborted();
    // 第一步：搜索动漫/视频（只用标题搜索，不带年份，年份用于后续匹配筛选）
    console.log(`🔍 [弹幕API] 搜索: "${title}"`);
    const animes = await searchDanmuAnimes(config, title, request.signal);
    request.signal.throwIfAborted();

    if (animes.length === 0) {
      console.log(`📭 [弹幕API] 未找到匹配: "${title}"`);
      return null;
    }

    console.log(`🎬 [弹幕API] 找到 ${animes.length} 个匹配结果`);

    // 选择最佳匹配（优先年份匹配，再匹配标题）
    let bestMatch = animes[0];
    for (const anime of animes) {
      const animeTitle = anime.animeTitle?.toLowerCase() || '';
      const searchTitle = title.toLowerCase();
      const titleMatches =
        animeTitle.includes(searchTitle) ||
        searchTitle.includes(animeTitle.split('(')[0].trim());

      // 如果有年份参数，优先选择年份匹配的结果
      if (year && animeTitle.includes(year) && titleMatches) {
        bestMatch = anime;
        break;
      }
      if (titleMatches) {
        bestMatch = anime;
        if (!year) break; // 没有年份参数时，找到标题匹配就停止
      }
    }

    console.log(
      `✅ [弹幕API] 选择: "${bestMatch.animeTitle}" (ID: ${bestMatch.animeId})`,
    );

    // 优先复用搜索返回的剧集，旧接口才额外查询详情。
    const episodes = await getDanmuEpisodes(config, bestMatch, request.signal);
    request.signal.throwIfAborted();
    if (episodes.length === 0) {
      console.log(`📭 [弹幕API] 无剧集数据`);
      return null;
    }

    console.log(`📋 [弹幕API] 共 ${episodes.length} 集`);

    // 选择对应集数
    let targetEpisode = episodes[0];
    if (episode) {
      const episodeNum = parseInt(episode);
      if (episodeNum > 0 && episodeNum <= episodes.length) {
        targetEpisode = episodes[episodeNum - 1];
        console.log(
          `🎯 [弹幕API] 选择第${episode}集: ${targetEpisode.episodeTitle}`,
        );
      }
    }

    // 第三步：获取弹幕
    console.log(`💬 [弹幕API] 获取弹幕: episodeId=${targetEpisode.episodeId}`);
    const commentData = await fetchDanmuComments(
      config,
      targetEpisode,
      request.signal,
    );
    request.signal.throwIfAborted();

    // API 返回格式有两种:
    // 1. 搜索/详情: { success: true, ... } 或 { errorCode: 0, ... }
    // 2. 弹幕数据: { count: 31217, comments: [...] } - 没有 errorCode 字段
    // 检测有效弹幕的逻辑：有 comments 数组且不为空
    if (
      !commentData.comments ||
      !Array.isArray(commentData.comments) ||
      commentData.comments.length === 0
    ) {
      console.log(`📭 [弹幕API] 无弹幕数据 (count: ${commentData.count || 0})`);
      return null;
    }

    console.log(`🎉 [弹幕API] 获取到 ${commentData.comments.length} 条弹幕`);

    // 🚀 激进性能优化策略 - 与XML API保持一致
    // 核心问题: 大量弹幕导致内存占用和计算密集
    // 解决方案: 智能分段加载 + 动态密度控制 + 预计算优化

    const SEGMENT_DURATION = 300; // 5分钟分段
    const MAX_DANMU_PER_SEGMENT = 500; // 每段最大弹幕数
    const BATCH_SIZE = 200; // 减小批处理大小，更频繁让出控制权

    const timeSegments: { [key: number]: DanmuItem[] } = {};
    let totalProcessed = 0;
    let batchCount = 0;
    const comments = commentData.comments;

    for (const item of comments) {
      request.signal.throwIfAborted();
      try {
        // p 格式: "time,mode,color,[source]"
        const pParts = (item.p || '').split(',');
        const time = parseFloat(pParts[0]) || item.t || 0;
        const mode = parseInt(pParts[1]) || 0;
        const colorInt = parseInt(pParts[2]) || 16777215;
        const text = (item.m || '').trim();

        // 🔥 激进预过滤: 更严格的质量控制
        if (
          text.length === 0 ||
          text.length > 50 || // 更严格的长度限制
          text.length < 2 || // 过短弹幕通常是无意义的
          /^[^\u4e00-\u9fa5a-zA-Z0-9]+$/.test(text) || // 纯符号弹幕
          text.includes('弹幕正在赶来') ||
          text.includes('观影愉快') ||
          text.includes('视频不错') ||
          text.includes('666') ||
          /^\d+$/.test(text) || // 纯数字弹幕
          /^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(text)
        ) {
          // 纯标点符号
          continue;
        }

        // 时间范围和有效性检查
        if (time < 0 || time > 86400 || !Number.isFinite(time)) continue;

        // 🎯 智能分段: 按时间分段存储，便于按需加载
        const segmentIndex = Math.floor(time / SEGMENT_DURATION);
        if (!timeSegments[segmentIndex]) {
          timeSegments[segmentIndex] = [];
        }

        // 🎯 密度控制: 每段限制弹幕数量，优先保留质量高的
        if (timeSegments[segmentIndex].length >= MAX_DANMU_PER_SEGMENT) {
          // 如果当前段已满，随机替换（保持弹幕多样性）
          if (Math.random() < 0.1) {
            // 10%概率替换
            const randomIndex = Math.floor(
              Math.random() * timeSegments[segmentIndex].length,
            );
            timeSegments[segmentIndex][randomIndex] = {
              text,
              time,
              color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
              mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
            };
          }
          continue;
        }

        timeSegments[segmentIndex].push({
          text,
          time,
          color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
          mode: mode === 4 ? 1 : mode === 5 ? 2 : 0, // 4=顶部, 5=顶部, 其他=滚动
        });

        totalProcessed++;
        batchCount++;

        // 🔄 更频繁的批量处理控制
        if (batchCount >= BATCH_SIZE) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          batchCount = 0;

          // 进度反馈
          if (totalProcessed % 1000 === 0) {
            console.log(
              `📊 [弹幕API] 已处理 ${totalProcessed} 条弹幕，分段数: ${Object.keys(timeSegments).length}`,
            );
          }
        }
      } catch {
        // 跳过解析失败的弹幕
      }
    }

    request.signal.throwIfAborted();
    // 🎯 将分段数据重新整合为时间排序的数组
    console.log(
      `📈 [弹幕API] 分段统计: 共 ${Object.keys(timeSegments).length} 个时间段`,
    );

    const danmuList: DanmuItem[] = [];
    for (const segmentIndex of Object.keys(timeSegments).sort(
      (a, b) => parseInt(a) - parseInt(b),
    )) {
      const segment = timeSegments[parseInt(segmentIndex)];
      // 段内按时间排序
      segment.sort((a, b) => a.time - b.time);
      danmuList.push(...segment);
    }

    // 🚀 智能采样：如果弹幕数量过多，采用均匀采样
    const finalDanmu = limitDanmu(danmuList);

    console.log(`✅ [弹幕API] 处理后 ${finalDanmu.length} 条优质弹幕`);

    if (finalDanmu.length === 0) return null;

    return {
      danmu: finalDanmu,
      source: `弹幕API (${bestMatch.animeTitle})`,
    };
  } catch (error) {
    signal?.throwIfAborted();
    const message = getDanmuApiErrorMessage(error);
    console.error(`❌ [弹幕API] 请求失败: ${message}`);
    throw error instanceof DanmuApiError ? error : new DanmuApiError(message);
  } finally {
    request.cleanup();
  }
}

// 弹幕去重函数
function deduplicateDanmu(danmuList: DanmuItem[]): DanmuItem[] {
  const seenMap = new Map<string, boolean>();
  const uniqueDanmu: DanmuItem[] = [];

  for (const danmu of danmuList) {
    // 创建唯一标识：时间(保留2位小数) + 文本内容 + 颜色
    const normalizedText = danmu.text.trim().toLowerCase();
    const timeKey = Math.round(danmu.time * 100) / 100;
    const uniqueKey = `${timeKey}_${normalizedText}_${danmu.color || 'default'}`;

    if (!seenMap.has(uniqueKey)) {
      seenMap.set(uniqueKey, true);
      uniqueDanmu.push(danmu);
    }
  }

  // 按时间排序
  uniqueDanmu.sort((a, b) => a.time - b.time);

  console.log(`🎯 弹幕去重: ${danmuList.length} -> ${uniqueDanmu.length} 条`);
  return uniqueDanmu;
}

// 从caiji.cyou API搜索视频链接
async function searchFromCaijiAPI(
  title: string,
  episode?: string | null,
  signal?: AbortSignal,
): Promise<PlatformUrl[]> {
  const request = createTimedRequest(15000, signal);
  try {
    request.signal.throwIfAborted();
    console.log(
      `🔎 在caiji.cyou搜索: "${title}", 集数: ${episode || '未指定'}`,
    );

    // 尝试多种标题格式进行搜索
    const searchTitles = [
      title, // 原始标题
      title.replace(/·/g, ''), // 移除中间点
      title.replace(/·/g, ' '), // 中间点替换为空格
      title.replace(/·/g, '-'), // 中间点替换为连字符
    ];

    // 去重
    const uniqueTitles = Array.from(new Set(searchTitles));
    console.log(
      `🔍 尝试搜索标题变体: ${uniqueTitles.map((t) => `"${t}"`).join(', ')}`,
    );

    for (const searchTitle of uniqueTitles) {
      request.signal.throwIfAborted();
      console.log(`🔎 搜索标题: "${searchTitle}"`);
      const searchUrl = `https://www.caiji.cyou/api.php/provide/vod/?wd=${encodeURIComponent(searchTitle)}`;
      const response = await fetch(searchUrl, {
        signal: request.signal,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });

      if (!response.ok) {
        console.log(`❌ 搜索"${searchTitle}"失败:`, response.status);
        continue; // 尝试下一个标题
      }

      const data: any = await response.json();
      request.signal.throwIfAborted();
      if (!data.list || data.list.length === 0) {
        console.log(`📭 搜索"${searchTitle}"未找到内容`);
        continue; // 尝试下一个标题
      }

      console.log(`🎬 搜索"${searchTitle}"找到 ${data.list.length} 个匹配结果`);

      // 智能选择最佳匹配结果
      let bestMatch: any = null;
      let exactMatch: any = null;

      for (const result of data.list) {
        console.log(
          `📋 候选: "${result.vod_name}" (类型: ${result.type_name})`,
        );

        // 标题完全匹配（优先级最高）
        if (result.vod_name === searchTitle || result.vod_name === title) {
          console.log(`🎯 找到完全匹配: "${result.vod_name}"`);
          exactMatch = result;
          break;
        }

        // 跳过明显不合适的内容
        const isUnwanted =
          result.vod_name.includes('解说') ||
          result.vod_name.includes('预告') ||
          result.vod_name.includes('花絮') ||
          result.vod_name.includes('动态漫') ||
          result.vod_name.includes('之精彩');

        if (isUnwanted) {
          console.log(`❌ 跳过不合适内容: "${result.vod_name}"`);
          continue;
        }

        // 选择第一个合适的结果
        if (!bestMatch) {
          bestMatch = result;
          console.log(`✅ 选择为候选: "${result.vod_name}"`);
        }
      }

      // 优先使用完全匹配，否则使用最佳匹配
      const selectedResult = exactMatch || bestMatch;

      if (selectedResult) {
        console.log(
          `✅ 使用搜索结果"${searchTitle}": "${selectedResult.vod_name}"`,
        );
        // 找到结果就处理并返回，不再尝试其他标题变体
        return await processSelectedResult(
          selectedResult,
          episode,
          request.signal,
        );
      }
    }

    console.log('📭 所有标题变体都未找到匹配内容');
    return [];
  } catch (error) {
    signal?.throwIfAborted();
    console.error('❌ Caiji API搜索失败:', error);
    return [];
  } finally {
    request.cleanup();
  }
}

// 处理选中的结果
async function processSelectedResult(
  selectedResult: any,
  episode?: string | null,
  signal?: AbortSignal,
): Promise<PlatformUrl[]> {
  try {
    signal?.throwIfAborted();
    console.log(`🔄 处理选中的结果: "${selectedResult.vod_name}"`);
    const firstResult: any = selectedResult;
    const detailUrl = `https://www.caiji.cyou/api.php/provide/vod/?ac=detail&ids=${firstResult.vod_id}`;

    const detailResponse = await fetch(detailUrl, {
      signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (!detailResponse.ok) return [];

    const detailData: any = await detailResponse.json();
    signal?.throwIfAborted();
    if (!detailData.list || detailData.list.length === 0) return [];

    const videoInfo: any = detailData.list[0];
    console.log(`🎭 视频详情: "${videoInfo.vod_name}" (${videoInfo.vod_year})`);

    const urls: PlatformUrl[] = [];

    // 解析播放链接
    if (videoInfo.vod_play_url) {
      const playUrls = videoInfo.vod_play_url.split('#');
      console.log(`📺 找到 ${playUrls.length} 集`);

      // 如果指定了集数，尝试找到对应集数的链接
      let targetUrl = '';
      if (episode && parseInt(episode) > 0) {
        const episodeNum = parseInt(episode);
        // 支持多种集数格式: "20$", "第20集$", "E20$", "EP20$" 等
        const targetEpisode = playUrls.find((url: string) => {
          return (
            url.startsWith(`${episodeNum}$`) ||
            url.startsWith(`第${episodeNum}集$`) ||
            url.startsWith(`E${episodeNum}$`) ||
            url.startsWith(`EP${episodeNum}$`)
          );
        });
        if (targetEpisode) {
          targetUrl = targetEpisode.split('$')[1];
          console.log(`🎯 找到第${episode}集: ${targetUrl}`);
        } else {
          console.log(`❌ 未找到第${episode}集的链接`);
        }
      }

      // 如果没有指定集数或找不到指定集数，使用第一集
      if (!targetUrl && playUrls.length > 0) {
        targetUrl = playUrls[0].split('$')[1];
        console.log(`📺 使用第1集: ${targetUrl}`);
      }

      if (targetUrl && !isRemovedVideoUrl(targetUrl)) {
        // 根据URL判断平台
        let platform = 'unknown';
        if (targetUrl.includes('v.qq.com') || targetUrl.includes('qq.com')) {
          platform = 'tencent_caiji';
        } else if (targetUrl.includes('iqiyi.com')) {
          platform = 'iqiyi_caiji';
        } else if (
          targetUrl.includes('youku.com') ||
          targetUrl.includes('v.youku.com')
        ) {
          platform = 'youku_caiji';
        } else if (
          targetUrl.includes('mgtv.com') ||
          targetUrl.includes('w.mgtv.com')
        ) {
          platform = 'mgtv_caiji';
        }

        // 统一修复所有平台的链接格式：将.htm转换为.html
        if (targetUrl.endsWith('.htm')) {
          targetUrl = targetUrl.replace(/\.htm$/, '.html');
          console.log(`🔧 修复${platform}链接格式: ${targetUrl}`);
        }

        console.log(`🎯 识别平台: ${platform}, URL: ${targetUrl}`);

        urls.push({
          platform: platform,
          url: targetUrl,
        });
      }
    }

    console.log(`✅ Caiji API返回 ${urls.length} 个播放链接`);
    return urls;
  } catch (error) {
    signal?.throwIfAborted();
    console.error('❌ Caiji API搜索失败:', error);
    return [];
  }
}

// 用户代理池 - 防止被封IP
// 请求限制器 - 防止被封IP
let lastDoubanRequestTime = 0;
const MIN_DOUBAN_REQUEST_INTERVAL = 1000; // 1秒最小间隔

function waitForDelay(delay: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function randomDelay(
  min = 500,
  max = 1500,
  signal?: AbortSignal,
): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return waitForDelay(delay, signal);
}

// 从豆瓣页面提取平台视频链接（使用反爬虫验证，与 douban/details 保持一致）
async function extractPlatformUrls(
  doubanId: string,
  episode?: string | null,
  signal?: AbortSignal,
): Promise<PlatformUrl[]> {
  signal?.throwIfAborted();
  if (!doubanId) return [];

  try {
    // 请求限流：确保请求间隔 - 防止被封IP
    const now = Date.now();
    const timeSinceLastRequest = now - lastDoubanRequestTime;
    if (timeSinceLastRequest < MIN_DOUBAN_REQUEST_INTERVAL) {
      await waitForDelay(
        MIN_DOUBAN_REQUEST_INTERVAL - timeSinceLastRequest,
        signal,
      );
    }
    signal?.throwIfAborted();
    lastDoubanRequestTime = Date.now();

    // 添加随机延时 - 防止被封IP
    signal?.throwIfAborted();
    await randomDelay(300, 1000, signal);
    signal?.throwIfAborted();

    const target = `https://movie.douban.com/subject/${doubanId}/`;
    console.log(
      `🔍 [弹幕] 从豆瓣提取视频链接 (ID: ${doubanId})，使用反爬虫验证...`,
    );

    let html: string | null = null;

    // 优先级 1: 使用反爬虫验证
    const antiCrawlerRequest = createTimedRequest(15000, signal);
    try {
      const antiCrawlerResponse = await fetchDoubanWithVerification(target, {
        signal: antiCrawlerRequest.signal,
      });
      antiCrawlerRequest.signal.throwIfAborted();
      if (antiCrawlerResponse.ok) {
        const responseHtml = await antiCrawlerResponse.text();
        antiCrawlerRequest.signal.throwIfAborted();
        // 检查是否为 challenge 页面
        if (
          !responseHtml.includes('sha512') ||
          !responseHtml.includes('process(cha)')
        ) {
          html = responseHtml;
          console.log(`✅ [弹幕] 反爬验证成功，页面长度: ${html.length}`);
        } else {
          console.log(`⚠️ [弹幕] 反爬验证返回了 challenge 页面`);
        }
      }
    } catch (e) {
      signal?.throwIfAborted();
      console.log(`⚠️ [弹幕] 反爬验证失败:`, e);
    } finally {
      antiCrawlerRequest.cleanup();
    }

    // 优先级 2: 带完整浏览器指纹的请求（与 douban/details 一致）
    if (!html) {
      signal?.throwIfAborted();
      console.log(`🔄 [弹幕] 尝试带浏览器指纹的请求...`);
      const { ua, browser, platform } = getRandomUserAgentWithInfo();
      const secChHeaders = getSecChUaHeaders(browser, platform);

      const fingerprintRequest = createTimedRequest(15000, signal);

      try {
        const response = await fetch(target, {
          signal: fingerprintRequest.signal,
          headers: {
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Cache-Control': 'max-age=0',
            DNT: '1',
            ...secChHeaders,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': ua,
            ...(Math.random() > 0.5
              ? { Referer: 'https://www.douban.com/' }
              : {}),
          },
        });

        if (response.ok) {
          html = await response.text();
          fingerprintRequest.signal.throwIfAborted();
          console.log(`📄 [弹幕] 豆瓣页面HTML长度: ${html.length}`);
        } else {
          console.log(`❌ [弹幕] 豆瓣页面请求失败: ${response.status}`);
          return [];
        }
      } finally {
        fingerprintRequest.cleanup();
      }
    }

    signal?.throwIfAborted();
    if (!html || html.length < 1000) {
      console.log(`❌ [弹幕] 豆瓣页面内容异常`);
      return [];
    }

    const urls: PlatformUrl[] = [];

    // 提取豆瓣跳转链接中的各种视频平台URL

    // 腾讯视频
    const doubanLinkMatches = html.match(
      /play_link:\s*"[^"]*v\.qq\.com[^"]*"/g,
    );
    if (doubanLinkMatches && doubanLinkMatches.length > 0) {
      console.log(`🎬 找到 ${doubanLinkMatches.length} 个腾讯视频链接`);

      // 如果指定了集数，尝试找到对应集数的链接
      let selectedMatch = doubanLinkMatches[0]; // 默认使用第一个
      if (episode && doubanLinkMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= doubanLinkMatches.length) {
          selectedMatch = doubanLinkMatches[episodeNum - 1];
          console.log(`🎯 选择第${episode}集腾讯视频链接`);
        }
      }

      const urlMatch = selectedMatch.match(/https%3A%2F%2Fv\.qq\.com[^"&]*/);
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        console.log(`🔗 腾讯视频链接: ${decodedUrl}`);
        urls.push({ platform: 'tencent', url: decodedUrl });
      }
    }

    // 爱奇艺
    const iqiyiMatches = html.match(/play_link:\s*"[^"]*iqiyi\.com[^"]*"/g);
    if (iqiyiMatches && iqiyiMatches.length > 0) {
      console.log(`📺 找到 ${iqiyiMatches.length} 个爱奇艺链接`);

      // 如果指定了集数，尝试找到对应集数的链接
      let selectedMatch = iqiyiMatches[0]; // 默认使用第一个
      if (episode && iqiyiMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= iqiyiMatches.length) {
          selectedMatch = iqiyiMatches[episodeNum - 1];
          console.log(`🎯 选择第${episode}集爱奇艺链接`);
        }
      }

      const urlMatch = selectedMatch.match(
        /https?%3A%2F%2F[^"&]*iqiyi\.com[^"&]*/,
      );
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        console.log(`🔗 爱奇艺链接: ${decodedUrl}`);
        urls.push({ platform: 'iqiyi', url: decodedUrl });
      }
    }

    // 优酷
    const youkuMatches = html.match(/play_link:\s*"[^"]*youku\.com[^"]*"/g);
    if (youkuMatches && youkuMatches.length > 0) {
      console.log(`🎞️ 找到 ${youkuMatches.length} 个优酷链接`);

      // 如果指定了集数，尝试找到对应集数的链接
      let selectedMatch = youkuMatches[0]; // 默认使用第一个
      if (episode && youkuMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= youkuMatches.length) {
          selectedMatch = youkuMatches[episodeNum - 1];
          console.log(`🎯 选择第${episode}集优酷链接`);
        }
      }

      const urlMatch = selectedMatch.match(
        /https?%3A%2F%2F[^"&]*youku\.com[^"&]*/,
      );
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        console.log(`🔗 优酷链接: ${decodedUrl}`);
        urls.push({ platform: 'youku', url: decodedUrl });
      }
    }

    // 直接提取腾讯视频链接
    const qqMatches = html.match(/https:\/\/v\.qq\.com\/x\/cover\/[^"'\s]+/g);
    if (qqMatches && qqMatches.length > 0) {
      console.log(`🎭 找到直接腾讯链接: ${qqMatches[0]}`);
      urls.push({
        platform: 'tencent_direct',
        url: qqMatches[0].split('?')[0],
      });
    }

    // 转换移动版链接为PC版链接（弹幕库API需要PC版）
    const convertedUrls = urls.map((urlObj) => {
      let convertedUrl = urlObj.url;

      // 优酷移动版转PC版
      if (convertedUrl.includes('m.youku.com/alipay_video/id_')) {
        convertedUrl = convertedUrl.replace(
          /https:\/\/m\.youku\.com\/alipay_video\/id_([^.]+)\.html/,
          'https://v.youku.com/v_show/id_$1.html',
        );
        console.log(`🔄 优酷移动版转PC版: ${convertedUrl}`);
      }

      // 爱奇艺移动版转PC版
      if (convertedUrl.includes('m.iqiyi.com/')) {
        convertedUrl = convertedUrl.replace('m.iqiyi.com', 'www.iqiyi.com');
        console.log(`🔄 爱奇艺移动版转PC版: ${convertedUrl}`);
      }

      // 腾讯视频移动版转PC版
      if (convertedUrl.includes('m.v.qq.com/')) {
        convertedUrl = convertedUrl.replace('m.v.qq.com', 'v.qq.com');
        console.log(`🔄 腾讯移动版转PC版: ${convertedUrl}`);
      }

      return { ...urlObj, url: convertedUrl };
    });

    console.log(`✅ 总共提取到 ${convertedUrls.length} 个平台链接`);
    return convertedUrls;
  } catch (error) {
    signal?.throwIfAborted();
    console.error('❌ 提取平台链接失败:', error);
    return [];
  }
}

// 从XML API获取弹幕数据（支持多个备用URL）
async function fetchDanmuFromXMLAPI(
  videoUrl: string,
  signal?: AbortSignal,
): Promise<DanmuItem[]> {
  const xmlApiUrls = ['https://fc.lyz05.cn', 'https://danmu.smone.us'];

  // 尝试每个API URL
  for (let i = 0; i < xmlApiUrls.length; i++) {
    signal?.throwIfAborted();
    const baseUrl = xmlApiUrls[i];
    const apiName = i === 0 ? '主用XML API' : `备用XML API ${i}`;
    const timeout = 15000; // 15秒超时
    const request = createTimedRequest(timeout, signal);

    try {
      request.signal.throwIfAborted();
      const apiUrl = `${baseUrl}/?url=${encodeURIComponent(videoUrl)}`;
      console.log(`🌐 正在请求${apiName}:`, apiUrl);

      const response = await fetch(apiUrl, {
        signal: request.signal,
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'application/xml, text/xml, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      console.log(
        `📡 ${apiName}响应状态:`,
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        console.log(`❌ ${apiName}响应失败:`, response.status);
        continue; // 尝试下一个API
      }

      const responseText = await response.text();
      request.signal.throwIfAborted();
      console.log(`📄 ${apiName}原始响应长度:`, responseText.length);

      // 使用正则表达式解析XML（Node.js兼容）
      const danmakuRegex = /<d p="([^"]*)"[^>]*>([^<]*)<\/d>/g;
      const danmuList: DanmuItem[] = [];
      let match;

      // 🚀 激进性能优化策略 - 基于ArtPlayer源码深度分析
      // 核心问题: 大量弹幕导致内存占用和计算密集
      // 解决方案: 智能分段加载 + 动态密度控制 + 预计算优化

      const SEGMENT_DURATION = 300; // 5分钟分段
      const MAX_DANMU_PER_SEGMENT = 500; // 每段最大弹幕数
      // const MAX_CONCURRENT_DANMU = 50; // 同时显示的最大弹幕数 - 在前端控制
      const BATCH_SIZE = 200; // 减小批处理大小，更频繁让出控制权

      const timeSegments: { [key: number]: DanmuItem[] } = {};
      let totalProcessed = 0;
      let batchCount = 0;

      while ((match = danmakuRegex.exec(responseText)) !== null) {
        request.signal.throwIfAborted();
        try {
          const pAttr = match[1];
          const text = match[2];

          if (!pAttr || !text) continue;

          // 🔥 激进预过滤: 更严格的质量控制
          const trimmedText = text.trim();
          if (
            trimmedText.length === 0 ||
            trimmedText.length > 50 || // 更严格的长度限制
            trimmedText.length < 2 || // 过短弹幕通常是无意义的
            /^[^\u4e00-\u9fa5a-zA-Z0-9]+$/.test(trimmedText) || // 纯符号弹幕
            trimmedText.includes('弹幕正在赶来') ||
            trimmedText.includes('视频不错') ||
            trimmedText.includes('666') ||
            /^\d+$/.test(trimmedText) || // 纯数字弹幕
            /^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(trimmedText)
          ) {
            // 纯标点符号
            continue;
          }

          // XML格式解析
          const params = pAttr.split(',');
          if (params.length < 4) continue;

          const time = parseFloat(params[0]) || 0;
          const mode = parseInt(params[1]) || 0;
          const colorInt = parseInt(params[3]) || 16777215;

          // 时间范围和有效性检查
          if (time < 0 || time > 86400 || !Number.isFinite(time)) continue;

          // 🎯 智能分段: 按时间分段存储，便于按需加载
          const segmentIndex = Math.floor(time / SEGMENT_DURATION);
          if (!timeSegments[segmentIndex]) {
            timeSegments[segmentIndex] = [];
          }

          // 🎯 密度控制: 每段限制弹幕数量，优先保留质量高的
          if (timeSegments[segmentIndex].length >= MAX_DANMU_PER_SEGMENT) {
            // 如果当前段已满，随机替换（保持弹幕多样性）
            if (Math.random() < 0.1) {
              // 10%概率替换
              const randomIndex = Math.floor(
                Math.random() * timeSegments[segmentIndex].length,
              );
              timeSegments[segmentIndex][randomIndex] = {
                text: trimmedText,
                time: time,
                color:
                  '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
                mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
              };
            }
            continue;
          }

          timeSegments[segmentIndex].push({
            text: trimmedText,
            time: time,
            color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
            mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
          });

          totalProcessed++;
          batchCount++;

          // 🔄 更频繁的批量处理控制
          if (batchCount >= BATCH_SIZE) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            batchCount = 0;

            // 进度反馈，避免用户以为卡死
            if (totalProcessed % 1000 === 0) {
              console.log(
                `📊 已处理 ${totalProcessed} 条弹幕，分段数: ${Object.keys(timeSegments).length}`,
              );
            }
          }
        } catch (error) {
          console.error(`❌ 解析第${totalProcessed}条XML弹幕失败:`, error);
        }
      }

      request.signal.throwIfAborted();
      // 🎯 将分段数据重新整合为时间排序的数组
      console.log(
        `📈 分段统计: 共 ${Object.keys(timeSegments).length} 个时间段`,
      );

      for (const segmentIndex of Object.keys(timeSegments).sort(
        (a, b) => parseInt(a) - parseInt(b),
      )) {
        const segment = timeSegments[parseInt(segmentIndex)];
        // 段内按时间排序，提高播放时的查找效率
        segment.sort((a, b) => a.time - b.time);
        danmuList.push(...segment);
      }

      console.log(`📊 ${apiName}找到 ${danmuList.length} 条弹幕数据`);

      if (danmuList.length === 0) {
        console.log(`📭 ${apiName}未返回弹幕数据`);
        console.log(
          `🔍 ${apiName}响应前500字符:`,
          responseText.substring(0, 500),
        );
        continue; // 尝试下一个API
      }

      // 🎯 优化后的最终处理，避免重复操作
      // 由于上面已经分段排序，这里只需要简单去重和最终验证
      const filteredDanmu = danmuList.filter(
        (item) =>
          !item.text.includes('官方弹幕库') && !item.text.includes('哔哩哔哩'), // 额外过滤平台相关内容
      );

      const finalDanmu = limitDanmu(filteredDanmu);

      console.log(`✅ ${apiName}优化处理完成: ${finalDanmu.length} 条优质弹幕`);

      // 🎯 优化统计信息，减少不必要的计算
      if (finalDanmu.length > 0) {
        const firstTime = finalDanmu[0].time;
        const lastTime = finalDanmu[finalDanmu.length - 1].time;
        const duration = lastTime - firstTime;

        console.log(
          `📊 ${apiName}弹幕概览: ${Math.floor(firstTime / 60)}:${String(Math.floor(firstTime % 60)).padStart(2, '0')} - ${Math.floor(lastTime / 60)}:${String(Math.floor(lastTime % 60)).padStart(2, '0')} (${Math.floor(duration / 60)}分钟)`,
        );

        // 只在弹幕较少时显示详细统计
        if (finalDanmu.length <= 1000) {
          console.log(
            `📋 ${apiName}弹幕样例:`,
            finalDanmu
              .slice(0, 5)
              .map(
                (item) =>
                  `${Math.floor(item.time / 60)}:${String(Math.floor(item.time % 60)).padStart(2, '0')} "${item.text.substring(0, 15)}"`,
              )
              .join(', '),
          );
        }
      }

      return finalDanmu; // 成功获取优化后的弹幕
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.error(`❌ ${apiName}请求超时 (${timeout / 1000}秒):`, videoUrl);
      } else {
        console.error(`❌ ${apiName}请求失败:`, error);
      }
      // 继续尝试下一个API
    } finally {
      request.cleanup();
    }
  }

  // 所有API都失败了
  console.log('❌ 所有XML API都无法获取弹幕数据');
  return [];
}

// 从danmu.icu获取弹幕数据
async function fetchDanmuFromAPI(
  videoUrl: string,
  signal?: AbortSignal,
): Promise<DanmuItem[]> {
  signal?.throwIfAborted();
  // 根据平台设置不同的超时时间
  let timeout = 20000; // 默认20秒
  if (videoUrl.includes('iqiyi.com')) {
    timeout = 30000; // 爱奇艺30秒
  } else if (videoUrl.includes('youku.com')) {
    timeout = 25000; // 优酷25秒
  } else if (videoUrl.includes('mgtv.com') || videoUrl.includes('w.mgtv.com')) {
    timeout = 25000; // 芒果TV25秒
  }

  const request = createTimedRequest(timeout, signal);
  console.log(`⏰ 设置超时时间: ${timeout / 1000}秒`);

  try {
    request.signal.throwIfAborted();
    const apiUrl = `https://api.danmu.icu/?url=${encodeURIComponent(videoUrl)}`;
    console.log('🌐 正在请求弹幕API:', apiUrl);

    const response = await fetch(apiUrl, {
      signal: request.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://danmu.icu/',
      },
    });

    console.log('📡 API响应状态:', response.status, response.statusText);

    if (!response.ok) {
      console.log('❌ API响应失败:', response.status);
      return [];
    }

    const responseText = await response.text();
    request.signal.throwIfAborted();
    console.log('📄 API原始响应:', responseText.substring(0, 500) + '...');

    let data: DanmuApiResponse;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ JSON解析失败:', parseError);
      console.log('响应内容:', responseText.substring(0, 200));
      return [];
    }

    if (!data.danmuku || !Array.isArray(data.danmuku)) return [];

    // 转换为Artplayer格式
    // API返回格式: [时间, 位置, 颜色, "", 文本, "", "", "字号"]
    console.log(`获取到 ${data.danmuku.length} 条原始弹幕数据`);

    const danmuList = limitDanmu(
      data.danmuku
        .map((item: any[]) => {
          // 正确解析时间 - 第一个元素就是时间(秒)
          const time = parseFloat(item[0]) || 0;
          const text = (item[4] || '').toString().trim();
          const color = item[2] || '#FFFFFF';

          // 转换位置: top=1顶部, bottom=2底部, right=0滚动
          let mode = 0;
          if (item[1] === 'top') mode = 1;
          else if (item[1] === 'bottom') mode = 2;
          else mode = 0; // right 或其他都是滚动

          return {
            text: text,
            time: time,
            color: color,
            mode: mode,
          };
        })
        .filter((item) => {
          const valid =
            item.text.length > 0 &&
            !item.text.includes('弹幕正在赶来') &&
            !item.text.includes('官方弹幕库') &&
            item.time >= 0;
          return valid;
        })
        .sort((a, b) => a.time - b.time),
    ); // 按时间排序

    // 显示时间分布统计
    const timeStats = danmuList.reduce(
      (acc, item) => {
        const timeRange = Math.floor(item.time / 60); // 按分钟分组
        acc[timeRange] = (acc[timeRange] || 0) + 1;
        return acc;
      },
      {} as Record<number, number>,
    );

    console.log('📊 弹幕时间分布(按分钟):', timeStats);
    console.log(
      '📋 前10条弹幕:',
      danmuList
        .slice(0, 10)
        .map((item) => `${item.time}s: "${item.text.substring(0, 20)}"`),
    );

    return danmuList;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(`❌ 弹幕API请求超时 (${timeout / 1000}秒):`, videoUrl);
      console.log('💡 建议: 爱奇艺、优酷和芒果TV的弹幕API响应较慢，请稍等片刻');
    } else {
      console.error('❌ 获取弹幕失败:', error);
    }
    return [];
  } finally {
    request.cleanup();
  }
}

// 通过 episodeId 直接获取弹幕（手动匹配模式）
async function fetchDanmuByEpisodeId(
  episodeId: number,
  episodeUrl?: string,
  signal?: AbortSignal,
): Promise<{ danmu: DanmuItem[]; source: string }> {
  signal?.throwIfAborted();
  const config = await getDanmuApiConfig();
  signal?.throwIfAborted();

  if (!config.enabled || !config.apiUrl) {
    throw new DanmuApiError('弹幕API未启用');
  }

  const request = createTimedRequest(config.timeout * 1000, signal);

  try {
    request.signal.throwIfAborted();
    console.log(`[手动匹配] 获取弹幕: episodeId=${episodeId}`);
    const commentData = await fetchDanmuComments(
      config,
      { episodeId, url: episodeUrl },
      request.signal,
    );
    request.signal.throwIfAborted();

    if (commentData.comments.length === 0) {
      console.log(`[手动匹配] 无弹幕数据`);
      return { danmu: [], source: '手动匹配' };
    }

    console.log(`[手动匹配] 获取到 ${commentData.comments.length} 条弹幕`);

    // 复用同样的弹幕处理逻辑
    const SEGMENT_DURATION = 300;
    const MAX_DANMU_PER_SEGMENT = 500;
    const BATCH_SIZE = 200;

    const timeSegments: { [key: number]: DanmuItem[] } = {};
    let batchCount = 0;

    for (const item of commentData.comments) {
      request.signal.throwIfAborted();
      try {
        const pParts = (item.p || '').split(',');
        const time = parseFloat(pParts[0]) || item.t || 0;
        const mode = parseInt(pParts[1]) || 0;
        const colorInt = parseInt(pParts[2]) || 16777215;
        const text = (item.m || '').trim();

        if (
          text.length === 0 ||
          text.length > 50 ||
          text.length < 2 ||
          /^[^\u4e00-\u9fa5a-zA-Z0-9]+$/.test(text) ||
          text.includes('弹幕正在赶来') ||
          text.includes('观影愉快') ||
          text.includes('视频不错') ||
          text.includes('666') ||
          /^\d+$/.test(text) ||
          /^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(text)
        ) {
          continue;
        }

        if (time < 0 || time > 86400 || !Number.isFinite(time)) continue;

        const segmentIndex = Math.floor(time / SEGMENT_DURATION);
        if (!timeSegments[segmentIndex]) {
          timeSegments[segmentIndex] = [];
        }

        if (timeSegments[segmentIndex].length >= MAX_DANMU_PER_SEGMENT) {
          if (Math.random() < 0.1) {
            const randomIndex = Math.floor(
              Math.random() * timeSegments[segmentIndex].length,
            );
            timeSegments[segmentIndex][randomIndex] = {
              text,
              time,
              color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
              mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
            };
          }
          continue;
        }

        timeSegments[segmentIndex].push({
          text,
          time,
          color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
          mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
        });

        batchCount++;

        if (batchCount >= BATCH_SIZE) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          batchCount = 0;
        }
      } catch {
        // skip
      }
    }

    request.signal.throwIfAborted();
    const danmuList: DanmuItem[] = [];
    for (const segmentIndex of Object.keys(timeSegments).sort(
      (a, b) => parseInt(a) - parseInt(b),
    )) {
      const segment = timeSegments[parseInt(segmentIndex)];
      segment.sort((a, b) => a.time - b.time);
      danmuList.push(...segment);
    }

    const finalDanmu = limitDanmu(danmuList);

    console.log(`[手动匹配] 处理后 ${finalDanmu.length} 条弹幕`);

    return {
      danmu: finalDanmu,
      source: `手动匹配 (episodeId:${episodeId})`,
    };
  } finally {
    request.cleanup();
  }
}

export async function GET(request: NextRequest) {
  if (request.signal.aborted) return cancelledResponse();
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed;
  resetDbQueryCount();

  const { searchParams } = new URL(request.url);
  const doubanId = searchParams.get('douban_id');
  const title = searchParams.get('title');
  const year = searchParams.get('year');
  const episode = searchParams.get('episode'); // 新增集数参数
  const manualEpisodeId = searchParams.get('episode_id'); // 手动匹配 episodeId
  const manualEpisodeUrl = searchParams.get('episode_url');

  console.log('=== 弹幕API请求参数 ===');
  console.log('豆瓣ID:', doubanId);
  console.log('标题:', title);
  console.log('年份:', year);
  console.log('集数:', episode);
  if (manualEpisodeId) console.log('手动匹配episodeId:', manualEpisodeId);

  // 手动匹配模式：直接通过 episodeId 获取弹幕
  if (manualEpisodeId) {
    const episodeIdNum = Number(manualEpisodeId);
    if (!Number.isSafeInteger(episodeIdNum) || episodeIdNum <= 0) {
      return NextResponse.json(
        { error: 'episode_id 无效', danmu: [], total: 0 },
        { status: 400 },
      );
    }

    const episodeUrl = normalizeDanmuVideoUrl(manualEpisodeUrl);
    if (manualEpisodeUrl && !episodeUrl) {
      return NextResponse.json(
        { error: 'episode_url 必须是有效的 HTTP(S) 地址', danmu: [], total: 0 },
        { status: 400 },
      );
    }

    try {
      const result = await fetchDanmuByEpisodeId(
        episodeIdNum,
        episodeUrl,
        request.signal,
      );
      request.signal.throwIfAborted();
      const uniqueDanmu = deduplicateDanmu(result.danmu);

      const successResponse = {
        danmu: uniqueDanmu,
        platforms: [
          {
            platform: 'manual_match',
            source: result.source,
            count: uniqueDanmu.length,
          },
        ],
        total: uniqueDanmu.length,
      };
      const responseSize = Buffer.byteLength(
        JSON.stringify(successResponse),
        'utf8',
      );

      recordRequest({
        timestamp: startTime,
        method: 'GET',
        path: '/api/danmu-external',
        statusCode: 200,
        duration: Date.now() - startTime,
        memoryUsed:
          (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
        dbQueries: getDbQueryCount(),
        requestSize: 0,
        responseSize,
        filter: `episode_id:${episodeIdNum}|danmu:${uniqueDanmu.length}|source:manual_match`,
      });

      return NextResponse.json(successResponse);
    } catch (error) {
      if (request.signal.aborted) return cancelledResponse();
      const message = getDanmuApiErrorMessage(error);
      console.error(`[手动匹配] 获取弹幕失败: ${message}`);
      return NextResponse.json(
        { error: message, danmu: [], total: 0 },
        { status: 502 },
      );
    }
  }

  if (!doubanId && !title) {
    const errorResponse = {
      error: 'Missing required parameters: douban_id or title',
    };
    const errorSize = Buffer.byteLength(JSON.stringify(errorResponse), 'utf8');

    recordRequest({
      timestamp: startTime,
      method: 'GET',
      path: '/api/danmu-external',
      statusCode: 400,
      duration: Date.now() - startTime,
      memoryUsed: (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
      dbQueries: getDbQueryCount(),
      requestSize: 0,
      responseSize: errorSize,
    });

    return NextResponse.json(errorResponse, { status: 400 });
  }

  try {
    let primaryError: DanmuApiError | undefined;
    // 🚀 优先使用弹幕API（主用）
    if (title) {
      console.log('🚀 [主用] 尝试从弹幕API获取弹幕...');
      let customResult: Awaited<ReturnType<typeof fetchDanmuFromCustomAPI>> =
        null;
      try {
        customResult = await fetchDanmuFromCustomAPI(
          title,
          episode,
          year,
          request.signal,
        );
        request.signal.throwIfAborted();
      } catch (error) {
        request.signal.throwIfAborted();
        primaryError =
          error instanceof DanmuApiError
            ? error
            : new DanmuApiError(getDanmuApiErrorMessage(error));
      }

      if (customResult && customResult.danmu.length > 0) {
        console.log(
          `✅ [主用] 弹幕API成功获取 ${customResult.danmu.length} 条弹幕`,
        );

        // 去重处理
        const uniqueDanmu = deduplicateDanmu(customResult.danmu);

        const successResponse = {
          danmu: uniqueDanmu,
          platforms: [
            {
              platform: 'danmu_api',
              source: customResult.source,
              count: uniqueDanmu.length,
            },
          ],
          total: uniqueDanmu.length,
        };
        const responseSize = Buffer.byteLength(
          JSON.stringify(successResponse),
          'utf8',
        );

        recordRequest({
          timestamp: startTime,
          method: 'GET',
          path: '/api/danmu-external',
          statusCode: 200,
          duration: Date.now() - startTime,
          memoryUsed:
            (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
          dbQueries: getDbQueryCount(),
          requestSize: 0,
          responseSize,
          filter: `title:${title}|episode:${episode || 'none'}|danmu:${uniqueDanmu.length}|source:danmu_api`,
        });

        return NextResponse.json(successResponse);
      }

      console.log('⚠️ [主用] 弹幕API无结果，尝试备用方案...');
    }

    // 🔄 备用方案：豆瓣 + XML/JSON API
    request.signal.throwIfAborted();
    let platformUrls: PlatformUrl[] = [];

    // 从豆瓣页面提取链接
    if (doubanId) {
      console.log('🔍 [备用] 从豆瓣页面提取链接...');
      platformUrls = await extractPlatformUrls(
        doubanId,
        episode,
        request.signal,
      );
      request.signal.throwIfAborted();
      console.log('📝 豆瓣提取结果:', platformUrls);
    }

    // 如果豆瓣没有结果，使用caiji.cyou API
    if (platformUrls.length === 0 && title) {
      console.log('🔍 [备用] 使用Caiji API搜索...');
      const caijiUrls = await searchFromCaijiAPI(
        title,
        episode,
        request.signal,
      );
      request.signal.throwIfAborted();
      if (caijiUrls.length > 0) {
        platformUrls = caijiUrls;
        console.log('📺 Caiji API结果:', platformUrls);
      }
    }

    // 如果找不到任何链接，直接返回空结果，不使用测试数据
    // （删除了不合适的fallback测试链接逻辑）

    if (platformUrls.length === 0) {
      if (primaryError) throw primaryError;
      console.log('❌ 未找到任何视频平台链接，返回空弹幕结果');
      console.log('💡 建议: 检查标题是否正确，或者该内容可能暂不支持弹幕');

      const emptyResponse = {
        danmu: [],
        platforms: [],
        total: 0,
        message: `未找到"${title}"的视频平台链接，无法获取弹幕数据`,
      };
      const responseSize = Buffer.byteLength(
        JSON.stringify(emptyResponse),
        'utf8',
      );

      recordRequest({
        timestamp: startTime,
        method: 'GET',
        path: '/api/danmu-external',
        statusCode: 200,
        duration: Date.now() - startTime,
        memoryUsed:
          (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
        dbQueries: getDbQueryCount(),
        requestSize: 0,
        responseSize,
        filter: `title:${title}|episode:${episode || 'none'}`,
      });

      return NextResponse.json(emptyResponse);
    }

    const seenUrls = new Set<string>();
    platformUrls = platformUrls.filter(({ url }) => {
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });

    // 并发获取多个平台的弹幕（使用XML API + JSON API备用）
    const danmuPromises = platformUrls.map(async ({ platform, url }) => {
      request.signal.throwIfAborted();
      console.log(`🔄 处理平台: ${platform}, URL: ${url}`);

      // 首先尝试XML API (主用)
      let danmu = await fetchDanmuFromXMLAPI(url, request.signal);
      request.signal.throwIfAborted();
      console.log(`📊 ${platform} XML API获取到 ${danmu.length} 条弹幕`);

      // 如果XML API失败或结果很少，尝试JSON API作为备用
      if (danmu.length === 0) {
        console.log(`🔄 ${platform} XML API无结果，尝试JSON API备用...`);
        const jsonDanmu = await fetchDanmuFromAPI(url, request.signal);
        request.signal.throwIfAborted();
        console.log(`📊 ${platform} JSON API获取到 ${jsonDanmu.length} 条弹幕`);

        if (jsonDanmu.length > 0) {
          danmu = jsonDanmu;
          console.log(
            `✅ ${platform} 使用JSON API备用数据: ${danmu.length} 条弹幕`,
          );
        }
      } else {
        console.log(`✅ ${platform} 使用XML API数据: ${danmu.length} 条弹幕`);
      }

      return { platform, danmu, url };
    });

    const results = await Promise.allSettled(danmuPromises);
    request.signal.throwIfAborted();

    // 合并所有成功的弹幕数据
    let allDanmu: DanmuItem[] = [];
    const platformInfo: any[] = [];

    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.danmu.length > 0) {
        allDanmu = allDanmu.concat(result.value.danmu);
        platformInfo.push({
          platform: result.value.platform,
          url: result.value.url,
          count: result.value.danmu.length,
        });
      }
    });

    // 按时间排序
    allDanmu.sort((a, b) => a.time - b.time);

    // 🚀 优化去重处理：更精确的重复检测
    const uniqueDanmu: DanmuItem[] = [];
    const seenMap = new Map<string, boolean>();

    // 批量处理去重，避免阻塞
    const DEDUP_BATCH_SIZE = 100;
    for (let i = 0; i < allDanmu.length; i += DEDUP_BATCH_SIZE) {
      request.signal.throwIfAborted();
      const batch = allDanmu.slice(i, i + DEDUP_BATCH_SIZE);

      batch.forEach((danmu) => {
        // 创建更精确的唯一标识：时间(保留2位小数) + 文本内容 + 颜色
        const normalizedText = danmu.text.trim().toLowerCase();
        const timeKey = Math.round(danmu.time * 100) / 100; // 精确到0.01秒
        const uniqueKey = `${timeKey}_${normalizedText}_${danmu.color || 'default'}`;

        if (!seenMap.has(uniqueKey)) {
          seenMap.set(uniqueKey, true);
          uniqueDanmu.push(danmu);
        }
      });

      // 让出执行权，避免阻塞
      if (i % (DEDUP_BATCH_SIZE * 5) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    console.log(
      `🎯 弹幕去重优化: ${allDanmu.length} -> ${uniqueDanmu.length} 条`,
    );
    request.signal.throwIfAborted();
    if (uniqueDanmu.length === 0 && primaryError) throw primaryError;

    const finalDanmu = limitDanmu(uniqueDanmu);
    const successResponse = {
      danmu: finalDanmu,
      platforms: platformInfo,
      total: finalDanmu.length,
    };
    const responseSize = Buffer.byteLength(
      JSON.stringify(successResponse),
      'utf8',
    );

    recordRequest({
      timestamp: startTime,
      method: 'GET',
      path: '/api/danmu-external',
      statusCode: 200,
      duration: Date.now() - startTime,
      memoryUsed: (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
      dbQueries: getDbQueryCount(),
      requestSize: 0,
      responseSize,
      filter: `title:${title}|episode:${episode || 'none'}|danmu:${finalDanmu.length}`,
    });

    return NextResponse.json(successResponse);
  } catch (error) {
    if (request.signal.aborted) return cancelledResponse();
    const statusCode = error instanceof DanmuApiError ? 502 : 500;
    const message =
      error instanceof DanmuApiError
        ? getDanmuApiErrorMessage(error)
        : '获取外部弹幕失败';
    console.error(`外部弹幕获取失败: ${message}`);

    const errorResponse = {
      error: message,
      danmu: [],
      total: 0,
    };
    const errorSize = Buffer.byteLength(JSON.stringify(errorResponse), 'utf8');

    recordRequest({
      timestamp: startTime,
      method: 'GET',
      path: '/api/danmu-external',
      statusCode,
      duration: Date.now() - startTime,
      memoryUsed: (process.memoryUsage().heapUsed - startMemory) / 1024 / 1024,
      dbQueries: getDbQueryCount(),
      requestSize: 0,
      responseSize: errorSize,
      filter: `title:${title}|episode:${episode || 'none'}`,
    });

    return NextResponse.json(errorResponse, { status: statusCode });
  }
}
