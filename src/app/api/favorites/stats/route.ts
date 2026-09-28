/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/favorites/stats
 *
 * 管理员专用：统计所有用户的收藏数据
 * 用于性能监控和容量规划
 */
export async function GET(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    const authInfo = await getVerifiedAuthInfo(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 只允许站长（管理员）访问
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: 'Forbidden: Admin only' },
        { status: 403 }
      );
    }

    console.log('[收藏统计] 开始统计所有用户的收藏数据...');
    const overallStartTime = Date.now();

    // 获取所有用户列表
    const config = await getConfig();
    const identities = await db.getAllUserIdentities();
    const allUsers = Array.from(new Map(identities.map(identity => [identity.uid, identity])).values())
      .filter(identity => identity.uid === authInfo.uid || config.UserConfig.Users.some(user =>
        !user.banned && (user.uid ? user.uid === identity.uid : user.username === identity.username)
      ));

    console.log(`[收藏统计] 找到 ${allUsers.length} 个活跃用户`);

    // 统计每个用户的收藏数
    const stats = await Promise.all(
      allUsers.map(async ({ uid, username }) => {
        const startTime = Date.now();
        try {
          const favorites = await db.getAllFavorites(uid);
          const count = Object.keys(favorites).length;
          const duration = Date.now() - startTime;

          console.log(
            `[收藏统计] ${username}: ${count} 个收藏, 查询耗时: ${(duration / 1000).toFixed(2)}s`
          );

          return {
            uid,
            username,
            count,
            queryTime: duration,
            status: 'success'
          };
        } catch (error) {
          console.error(`[收藏统计] 获取用户 ${username} 的收藏失败:`, error);
          return {
            uid,
            username,
            count: 0,
            queryTime: Date.now() - startTime,
            status: 'error',
            error: String(error)
          };
        }
      })
    );

    // 按收藏数排序（从多到少）
    stats.sort((a, b) => b.count - a.count);

    // 计算收藏数量分布
    const distribution = {
      '0-10': stats.filter(s => s.count >= 0 && s.count <= 10).length,
      '11-50': stats.filter(s => s.count >= 11 && s.count <= 50).length,
      '51-100': stats.filter(s => s.count >= 51 && s.count <= 100).length,
      '101-200': stats.filter(s => s.count >= 101 && s.count <= 200).length,
      '201-500': stats.filter(s => s.count >= 201 && s.count <= 500).length,
      '500+': stats.filter(s => s.count > 500).length,
    };

    // 计算性能分布（按查询耗时）
    const performanceDistribution = {
      '< 5s': stats.filter(s => s.queryTime < 5000).length,
      '5-15s': stats.filter(s => s.queryTime >= 5000 && s.queryTime < 15000).length,
      '15-25s': stats.filter(s => s.queryTime >= 15000 && s.queryTime < 25000).length,
      '> 25s': stats.filter(s => s.queryTime >= 25000).length,
    };

    // 计算总体统计
    const totalFavorites = stats.reduce((sum, s) => sum + s.count, 0);
    const avgFavorites = stats.length > 0 ? (totalFavorites / stats.length).toFixed(2) : 0;
    const maxFavorites = stats.length > 0 ? stats[0].count : 0;
    const minFavorites = stats.length > 0 ? stats[stats.length - 1].count : 0;

    // 找出最慢的查询
    const slowestQueries = [...stats]
      .sort((a, b) => b.queryTime - a.queryTime)
      .slice(0, 5)
      .map(s => ({
        username: s.username,
        count: s.count,
        queryTime: `${(s.queryTime / 1000).toFixed(2)}s`
      }));

    const overallDuration = Date.now() - overallStartTime;
    console.log(
      `[收藏统计] 统计完成，总耗时: ${(overallDuration / 1000).toFixed(2)}s`
    );

    // 性能预警
    const warnings: string[] = [];
    if (stats.some(s => s.queryTime > 25000)) {
      warnings.push('有用户的收藏查询超过 25 秒，接近超时阈值');
    }
    if (stats.some(s => s.count > 200)) {
      warnings.push('有用户收藏数超过 200，建议考虑分页加载');
    }
    if (performanceDistribution['> 25s'] > stats.length * 0.1) {
      warnings.push('超过 10% 的用户查询耗时 > 25 秒，建议优化数据结构');
    }

    return NextResponse.json({
      // 总体统计
      summary: {
        total_users: stats.length,
        total_favorites: totalFavorites,
        avg_favorites: avgFavorites,
        max_favorites: maxFavorites,
        min_favorites: minFavorites,
        stats_duration: `${(overallDuration / 1000).toFixed(2)}s`
      },

      // 收藏数量分布
      distribution,

      // 性能分布
      performance: performanceDistribution,

      // 最慢的查询
      slowest_queries: slowestQueries,

      // 所有用户详情
      users: stats,

      // 性能预警
      warnings: warnings.length > 0 ? warnings : undefined,

      // 优化建议
      recommendations: generateRecommendations(stats, performanceDistribution)
    });
  } catch (err) {
    console.error('[收藏统计] 统计失败:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * 根据统计数据生成优化建议
 */
function generateRecommendations(
  stats: Array<{ count: number; queryTime: number }>,
  perfDist: Record<string, number>
): string[] {
  const recommendations: string[] = [];

  // 根据性能分布给出建议
  if (perfDist['> 25s'] === 0 && perfDist['15-25s'] === 0) {
    recommendations.push('✅ 性能表现优秀！当前方案完全满足需求，无需优化。');
  } else if (perfDist['> 25s'] === 0 && perfDist['15-25s'] <= stats.length * 0.1) {
    recommendations.push('✅ 性能良好。少数用户查询较慢但仍在可接受范围内。');
  } else if (perfDist['> 25s'] > 0 && perfDist['> 25s'] <= stats.length * 0.05) {
    recommendations.push('⚠️ 极少数用户查询接近超时，可考虑微调超时时间到 45 秒。');
  } else if (perfDist['> 25s'] > stats.length * 0.05) {
    recommendations.push('❌ 较多用户查询超过 25 秒，强烈建议优化数据结构（使用 Hash 或分页）。');
  }

  // 根据收藏数量给出建议
  const hasLargeCollections = stats.some(s => s.count > 200);
  if (hasLargeCollections) {
    recommendations.push('💡 发现大量收藏的用户，建议实施分页加载优化用户体验。');
  }

  // 根据查询耗时和收藏数的关系给出建议
  const avgTimePerItem = stats.length > 0
    ? stats.reduce((sum, s) => sum + (s.count > 0 ? s.queryTime / s.count : 0), 0) / stats.length
    : 0;

  if (avgTimePerItem > 100) {
    recommendations.push(
      `⚠️ 平均每个收藏查询耗时 ${avgTimePerItem.toFixed(0)}ms，建议优化为 Hash 结构减少网络请求。`
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('暂无特别建议，继续监控即可。');
  }

  return recommendations;
}
