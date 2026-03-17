import { DistributedCache, type CacheOptions } from '../index';

// Mock Redis-like interface
function createMockRedis() {
  const store = new Map<string, string>();

  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _options?: { EX?: number }) => {
      store.set(key, value);
    }),
    del: jest.fn(async (key: string) => { store.delete(key); }),
    setnx: jest.fn(async (key: string, value: string) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    }),
    expire: jest.fn(async (_key: string, _seconds: number) => {}),
  };
}

describe('Distributed Cache Pattern', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: DistributedCache;

  beforeEach(() => {
    redis = createMockRedis();
    cache = new DistributedCache(redis, {
      l1Ttl: 5000,
      l2Ttl: 60000,
      l1MaxSize: 5,
    });
  });

  describe('set and get basics', () => {
    it('should set a value in both L1 and L2', async () => {
      await cache.set('key1', { name: 'Alice' });

      expect(redis.set).toHaveBeenCalledWith(
        'key1',
        JSON.stringify({ name: 'Alice' }),
        { EX: 60 }, // l2Ttl 60000ms = 60s
      );

      // Subsequent get should come from L1 (no redis.get call needed)
      const result = await cache.get('key1', async () => ({ name: 'Fallback' }));
      expect(result).toEqual({ name: 'Alice' });
    });

    it('should return L1 cached value without hitting L2', async () => {
      await cache.set('k', 'v');
      redis.get.mockClear();

      const value = await cache.get('k', async () => 'origin');
      expect(value).toBe('v');
      // L1 hit means redis.get should not be called
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe('L2 fallback', () => {
    it('should fall back to L2 when L1 is expired', async () => {
      // Use a cache with very short L1 TTL
      const shortCache = new DistributedCache(redis, {
        l1Ttl: 1, // 1ms -- will expire almost immediately
        l2Ttl: 60000,
      });

      await shortCache.set('key', 'value');

      // Wait for L1 to expire
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortCache.get('key', async () => 'origin');
      expect(result).toBe('value'); // from L2
      expect(redis.get).toHaveBeenCalledWith('key');
    });
  });

  describe('origin fetcher', () => {
    it('should call the fetcher on a complete cache miss', async () => {
      const fetcher = jest.fn(async () => ({ data: 'from-origin' }));

      const result = await cache.get('missing-key', fetcher);

      expect(result).toEqual({ data: 'from-origin' });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Value should now be cached in L2
      expect(redis.set).toHaveBeenCalled();
    });

    it('should use stampede protection lock when fetching from origin', async () => {
      const fetcher = jest.fn(async () => 'fresh');

      await cache.get('new-key', fetcher);

      // setnx should have been called for the lock
      expect(redis.setnx).toHaveBeenCalledWith('lock:new-key', '1');
      // Lock should be cleaned up
      expect(redis.del).toHaveBeenCalledWith('lock:new-key');
    });
  });

  describe('invalidation', () => {
    it('should invalidate a key from both L1 and L2', async () => {
      await cache.set('key1', 'value1');
      await cache.invalidate('key1');

      expect(redis.del).toHaveBeenCalledWith('key1');

      // After invalidation, fetcher should be called
      const fetcher = jest.fn(async () => 'new-value');
      const result = await cache.get('key1', fetcher);
      expect(fetcher).toHaveBeenCalled();
    });

    it('should invalidate keys matching a pattern from L1', async () => {
      await cache.set('user:1:profile', 'p1');
      await cache.set('user:2:profile', 'p2');
      await cache.set('product:1', 'prod');

      await cache.invalidatePattern('user:*');

      // user keys should be invalidated from L1
      // product key should still be in L1
      const stats = cache.getStats();
      expect(stats.l1Size).toBe(1); // only product:1 remains
    });
  });

  describe('L1 eviction', () => {
    it('should evict the oldest entry when L1 reaches max size', async () => {
      // l1MaxSize is 5
      for (let i = 0; i < 6; i++) {
        await cache.set(`key-${i}`, `val-${i}`);
      }

      const stats = cache.getStats();
      expect(stats.l1Size).toBe(5); // capped at max
      expect(stats.l1MaxSize).toBe(5);
    });
  });

  describe('getStats', () => {
    it('should report current L1 size and max size', async () => {
      expect(cache.getStats()).toEqual({ l1Size: 0, l1MaxSize: 5 });

      await cache.set('a', 1);
      await cache.set('b', 2);

      expect(cache.getStats()).toEqual({ l1Size: 2, l1MaxSize: 5 });
    });
  });

  describe('custom options per get/set call', () => {
    it('should allow overriding TTL options per call', async () => {
      await cache.set('custom', 'val', { l2Ttl: 120000 });

      expect(redis.set).toHaveBeenCalledWith(
        'custom',
        JSON.stringify('val'),
        { EX: 120 }, // 120000ms = 120s
      );
    });
  });

  describe('stale-while-revalidate', () => {
    it('should return stale L1 value and trigger background revalidation', async () => {
      // Create cache with SWR enabled and very short L1 TTL
      const swrCache = new DistributedCache(redis, {
        l1Ttl: 1,
        l2Ttl: 60000,
        staleWhileRevalidate: true,
      });

      await swrCache.set('swr-key', 'original');

      // Wait for L1 to expire (but entry still exists as stale)
      await new Promise((r) => setTimeout(r, 10));

      // Redis also has no data (simulate L2 miss too)
      redis.store.delete('swr-key');

      const fetcher = jest.fn(async () => 'updated');
      const result = await swrCache.get('swr-key', fetcher);

      // Should return the stale value immediately
      expect(result).toBe('original');

      // Give the background revalidation a moment to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(fetcher).toHaveBeenCalled();
    });
  });
});
