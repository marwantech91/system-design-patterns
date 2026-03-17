/**
 * Distributed Cache Pattern
 *
 * Multi-tier caching strategy:
 * - L1: In-memory (per-process, fastest, smallest)
 * - L2: Redis (shared across processes, fast, larger)
 * - Origin: Database/API (slowest, source of truth)
 *
 * Includes cache invalidation, stampede protection, and TTL management.
 */

export interface CacheOptions {
  l1Ttl?: number;       // In-memory TTL (ms), default 30s
  l2Ttl?: number;       // Redis TTL (ms), default 5min
  staleWhileRevalidate?: boolean;
  lockTimeout?: number; // Stampede protection lock timeout
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  stale?: boolean;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<void>;
  del(key: string): Promise<void>;
  setnx(key: string, value: string): Promise<boolean>;
  expire(key: string, seconds: number): Promise<void>;
}

export class DistributedCache {
  private l1: Map<string, CacheEntry<unknown>> = new Map();
  private l1MaxSize: number;
  private redis: RedisLike;
  private defaults: Required<CacheOptions>;

  constructor(redis: RedisLike, opts?: { l1MaxSize?: number } & CacheOptions) {
    this.redis = redis;
    this.l1MaxSize = opts?.l1MaxSize ?? 1000;
    this.defaults = {
      l1Ttl: opts?.l1Ttl ?? 30_000,
      l2Ttl: opts?.l2Ttl ?? 300_000,
      staleWhileRevalidate: opts?.staleWhileRevalidate ?? true,
      lockTimeout: opts?.lockTimeout ?? 5000,
    };
  }

  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    const opts = { ...this.defaults, ...options };

    // L1: Check in-memory cache
    const l1Entry = this.l1.get(key) as CacheEntry<T> | undefined;
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      return l1Entry.value;
    }

    // L2: Check Redis
    const l2Data = await this.redis.get(key);
    if (l2Data) {
      const parsed = JSON.parse(l2Data) as T;
      this.setL1(key, parsed, opts.l1Ttl);
      return parsed;
    }

    // Stale-while-revalidate: return stale L1 while fetching fresh
    if (opts.staleWhileRevalidate && l1Entry) {
      this.revalidate(key, fetcher, opts);
      return l1Entry.value;
    }

    // Cache miss — fetch from origin with stampede protection
    return this.fetchWithLock(key, fetcher, opts);
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const opts = { ...this.defaults, ...options };

    this.setL1(key, value, opts.l1Ttl);

    await this.redis.set(key, JSON.stringify(value), {
      EX: Math.ceil(opts.l2Ttl / 1000),
    });
  }

  async invalidate(key: string): Promise<void> {
    this.l1.delete(key);
    await this.redis.del(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // L1: clear matching keys
    const regex = new RegExp(pattern.replace('*', '.*'));
    for (const key of this.l1.keys()) {
      if (regex.test(key)) {
        this.l1.delete(key);
      }
    }
    // L2: would use SCAN + DEL in production Redis
  }

  private setL1<T>(key: string, value: T, ttl: number): void {
    // Evict oldest entries if at capacity
    if (this.l1.size >= this.l1MaxSize) {
      const firstKey = this.l1.keys().next().value;
      if (firstKey) this.l1.delete(firstKey);
    }

    this.l1.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  /**
   * Stampede protection: only one process fetches from origin.
   * Others wait for the result to appear in cache.
   */
  private async fetchWithLock<T>(
    key: string,
    fetcher: () => Promise<T>,
    opts: Required<CacheOptions>
  ): Promise<T> {
    const lockKey = `lock:${key}`;
    const acquired = await this.redis.setnx(lockKey, '1');

    if (acquired) {
      await this.redis.expire(lockKey, Math.ceil(opts.lockTimeout / 1000));

      try {
        const value = await fetcher();
        await this.set(key, value, opts);
        return value;
      } finally {
        await this.redis.del(lockKey);
      }
    }

    // Wait and retry from cache
    await new Promise((r) => setTimeout(r, 100));
    return this.get(key, fetcher, opts);
  }

  private async revalidate<T>(
    key: string,
    fetcher: () => Promise<T>,
    opts: Required<CacheOptions>
  ): Promise<void> {
    // Fire and forget
    fetcher()
      .then((value) => this.set(key, value, opts))
      .catch((err) => console.error(`Revalidation failed for ${key}:`, err));
  }

  getStats(): { l1Size: number; l1MaxSize: number } {
    return { l1Size: this.l1.size, l1MaxSize: this.l1MaxSize };
  }
}
