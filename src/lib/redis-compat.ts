/**
 * Redis 兼容适配层
 *
 * 解决 node-redis（驼峰命名）和 @upstash/redis（全小写命名）的 API 差异。
 * Kvrocks 在本项目中通过 node-redis 连接。
 * 通过 Proxy 自动将驼峰方法名转为全小写，并处理 hSet 参数格式差异。
 *
 * 方法名差异示例:
 *   node-redis         →  @upstash/redis
 *   sIsMember           →  sismember
 *   hGetAll             →  hgetall
 *   hSet                →  hset
 *   hIncrBy             →  hincrby
 *   lPush               →  lpush
 *   lRange              →  lrange
 *   sRem                →  srem
 *   sAdd                →  sadd
 *   sMembers            →  smembers
 */

function camelToLower(str: string): string {
  return str.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Execute one Lua operation using the raw client's own EVAL signature. */
export function evalCompat(
  rawClient: unknown,
  script: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  const client = rawClient as Record<string, unknown> | null;
  if (!client || typeof client.eval !== 'function') {
    throw new Error('当前存储客户端不支持 Redis EVAL 原子操作');
  }

  if (typeof client.hGetAll === 'function') {
    // node-redis, including the Kvrocks adapter.
    return Reflect.apply(client.eval, client, [
      script,
      { keys, arguments: args },
    ]);
  }
  if (typeof client.hgetall === 'function') {
    // @upstash/redis: eval(script, keys, args).
    return Reflect.apply(client.eval, client, [script, keys, args]);
  }
  throw new Error('无法识别 Redis 客户端的 EVAL 参数格式');
}

export function createCompatClient(rawClient: unknown): any {
  return new Proxy(rawClient as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return target[prop as unknown as string];

      // 方法原样存在（node-redis 驼峰风格）
      if (typeof target[prop] === 'function') {
        return (...args: unknown[]) =>
          (target[prop] as (...a: unknown[]) => unknown)(...args);
      }

      // 转全小写后存在（@upstash/redis 全小写风格）
      const lower = camelToLower(prop);
      if (lower !== prop && typeof target[lower] === 'function') {
        // 特殊处理: hSet(key, field, value) 三参数 → hset(key, {field: value})
        // @upstash/redis 的 hset 不接受三参数形式
        if (lower === 'hset') {
          return (key: string, ...rest: unknown[]) => {
            if (rest.length === 2 && typeof rest[0] === 'string') {
              return (
                target.hset as (
                  k: string,
                  v: Record<string, unknown>,
                ) => unknown
              )(key, {
                [rest[0]]: rest[1],
              });
            }
            return (target.hset as (k: string, ...a: unknown[]) => unknown)(
              key,
              ...rest,
            );
          };
        }

        return (...args: unknown[]) =>
          (target[lower] as (...a: unknown[]) => unknown)(...args);
      }

      return target[prop];
    },
  });
}
