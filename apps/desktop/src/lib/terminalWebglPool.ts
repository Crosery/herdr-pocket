export const MAX_WEBGL_POOL = 14;
export const MAX_IDLE_WARM_SLOTS = 3;
export const IDLE_WARM_DECAY_MS = 45_000;

interface WebglPoolEntry {
  key: symbol;
  active: boolean;
  lastTouched: number;
  evict: () => void;
}

const pool = new Map<symbol, WebglPoolEntry>();
const pendingEvictTimers = new Map<symbol, ReturnType<typeof setTimeout>>();
const idleDecayTimers = new Map<symbol, ReturnType<typeof setTimeout>>();
let touchSeq = 0;

function cancelIdleDecay(key: symbol): void {
  const timer = idleDecayTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    idleDecayTimers.delete(key);
  }
}

function pruneExcessWarmSlots(): void {
  const inactive: WebglPoolEntry[] = [];
  for (const entry of pool.values()) {
    if (!entry.active) inactive.push(entry);
  }
  if (inactive.length <= MAX_IDLE_WARM_SLOTS) return;
  inactive.sort((a, b) => a.lastTouched - b.lastTouched);
  const toEvict = inactive.slice(0, inactive.length - MAX_IDLE_WARM_SLOTS);
  for (const victim of toEvict) {
    pool.delete(victim.key);
    cancelIdleDecay(victim.key);
    victim.evict();
  }
}

/** Returns the number of currently active or warm WebGL2 terminal contexts tracked by the pool. */
export function getActiveWebglPoolCount(): number {
  return pool.size;
}

/**
 * Acquires or reactivates a slot in the warm WebGL2 LRU pool.
 * Evicts at most one inactive LRU entry asynchronously so click-to-paint is never blocked by `addon.dispose()`.
 */
export function acquireWebglSlot(key: symbol, evict: () => void): boolean {
  const existing = pool.get(key);
  if (existing) {
    existing.active = true;
    existing.lastTouched = ++touchSeq;
    existing.evict = evict;
    cancelIdleDecay(key);
    return true;
  }

  if (pool.size >= MAX_WEBGL_POOL) {
    let victim: WebglPoolEntry | null = null;
    for (const entry of pool.values()) {
      if (entry.active) continue;
      if (!victim || entry.lastTouched < victim.lastTouched) {
        victim = entry;
      }
    }
    if (!victim) {
      const pendingTimer = pendingEvictTimers.get(key);
      if (pendingTimer !== undefined) {
        clearTimeout(pendingTimer);
        pendingEvictTimers.delete(key);
        evict();
      }
      return false;
    }
    pool.delete(victim.key);
    const victimKey = victim.key;
    const victimEvict = victim.evict;
    const oldTimer = pendingEvictTimers.get(victimKey);
    if (oldTimer !== undefined) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      if (pendingEvictTimers.get(victimKey) === timer) {
        pendingEvictTimers.delete(victimKey);
      }
      if (!pool.has(victimKey)) {
        victimEvict();
      }
    }, 0);
    pendingEvictTimers.set(victimKey, timer);
  }

  const canceled = pendingEvictTimers.get(key);
  if (canceled !== undefined) {
    clearTimeout(canceled);
    pendingEvictTimers.delete(key);
  }

  pool.set(key, {
    key,
    active: true,
    lastTouched: ++touchSeq,
    evict,
  });
  return true;
}

/** Marks a terminal's WebGL2 context as background-warm so switching back is an O(1) toggle. */
export function markWebglSlotInactive(key: symbol): void {
  const entry = pool.get(key);
  if (!entry) return;
  entry.active = false;
  entry.lastTouched = ++touchSeq;
  cancelIdleDecay(key);
  const timer = setTimeout(() => {
    idleDecayTimers.delete(key);
    const cur = pool.get(key);
    if (!cur || cur.active) return;
    pruneExcessWarmSlots();
  }, IDLE_WARM_DECAY_MS);
  (timer as { unref?: () => void }).unref?.();
  idleDecayTimers.set(key, timer);
}

/** Immediately removes a terminal's slot from the pool (on unmount or underlay DOM fallback). */
export function releaseWebglSlot(key: symbol): void {
  cancelIdleDecay(key);
  const pending = pendingEvictTimers.get(key);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingEvictTimers.delete(key);
  }
  pool.delete(key);
}

/** Clears pool state for deterministic unit tests. */
export function resetWebglPoolForTest(): void {
  for (const timer of idleDecayTimers.values()) {
    clearTimeout(timer);
  }
  idleDecayTimers.clear();
  for (const timer of pendingEvictTimers.values()) {
    clearTimeout(timer);
  }
  pendingEvictTimers.clear();
  pool.clear();
  touchSeq = 0;
}
