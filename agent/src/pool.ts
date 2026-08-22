/**
 * 有界并发映射。
 *
 * 打分请求彼此完全独立：串行跑 8 张要 37 秒（实测），而这 37 秒几乎全是等待。
 * 并发路数刻意留成配置项而不是写死——供应商的限流阈值是部署相关的事实，
 * 开满只会换来一串 429，再触发退避重试，反而更慢。
 * @module
 */

/**
 * 以最多 `limit` 路并发对 `items` 执行 `worker`，返回与输入等长、顺序一致的结果。
 *
 * `worker` 自己负责捕获异常：这里不吞错误，抛出会中止整批。
 *
 * @param items - 输入序列。
 * @param limit - 最大并发路数；小于 1 时按 1 处理。
 * @param worker - 处理单项的异步函数，接收元素与它的原始下标。
 * @returns 与 `items` 顺序对应的结果数组。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (!items.length) return results

  const lanes = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  async function runLane(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: lanes }, runLane))
  return results
}
