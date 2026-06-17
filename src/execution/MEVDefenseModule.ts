import { makeLogger } from '../utils/logger';
import type { ConfigurationService } from '../config/index';
import type { EventBus } from '../events/EventBus';
import type { Order, Transaction, TwapParams } from '../types/index';
import { sleep } from '../utils/sleep';

const logger = makeLogger();

export class MEVDefenseModule {
  private readonly config: ConfigurationService;
  private readonly bus:    EventBus;

  constructor(config: ConfigurationService, bus: EventBus) {
    this.config = config;
    this.bus    = bus;
  }

  shouldSplit(order: Order): boolean {
    return order.size > this.config.get().twap.thresholdUsd;
  }

  buildTwapPlan(order: Order): TwapParams {
    const cfg   = this.config.get().twap;
    const N     = cfg.chunkCount;
    const total = order.size;

    // Step 1: Generate raw random chunks
    const rawChunks: number[] = [];
    for (let i = 0; i < N; i++) {
      rawChunks.push((total / N) * this.randomBetween(cfg.minChunkPct, cfg.maxChunkPct));
    }

    // Step 2: Normalize so they sum exactly to total
    const chunkSizes = this.normalizeSizes(rawChunks, total);

    // Step 3: Generate N-1 random intervals, last is 0
    const intervals: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      intervals.push(Math.round(this.randomBetween(cfg.minIntervalMs, cfg.maxIntervalMs)));
    }
    intervals.push(0);

    return {
      totalSize:   total,
      chunkSizes,
      intervals,
      submittedAt: [],
      chunksTotal: N,
      chunksDone:  0,
    };
  }

  async executeTwap(
    order:    Order,
    twap:     TwapParams,
    submitFn: (chunk: Order) => Promise<Transaction>
  ): Promise<Transaction[]> {
    const results: Transaction[] = [];

    for (let i = 0; i < twap.chunksTotal; i++) {
      const chunkSize = twap.chunkSizes[i];
      if (chunkSize === undefined) {
        throw new Error(`Missing chunk size at index ${i}`);
      }

      const chunk: Order = { ...order, size: chunkSize, id: `${order.id}-chunk${i}` };

      try {
        const tx = await submitFn(chunk);
        twap.submittedAt[i] = Date.now();
        twap.chunksDone++;
        results.push(tx);

        this.bus.emit('mev:chunk_submitted', {
          orderId: order.id,
          chunk:   i,
          size:    chunkSize,
          txHash:  tx.hash,
        });

        logger.info('TWAP chunk submitted', {
          orderId: order.id, chunk: i, size: chunkSize, txHash: tx.hash,
        });

        // Sleep between chunks (last interval is 0)
        const interval = twap.intervals[i] ?? 0;
        if (interval > 0) await sleep(interval);

      } catch (e) {
        this.bus.emit('mev:chunk_failed', {
          orderId: order.id,
          chunk:   i,
          error:   String(e),
        });
        logger.error('TWAP chunk failed', { orderId: order.id, chunk: i, error: String(e) });
        throw e;
      }
    }

    this.bus.emit('mev:twap_complete', { orderId: order.id, totalChunks: twap.chunksTotal });
    logger.info('TWAP execution complete', { orderId: order.id, totalChunks: twap.chunksTotal });

    return results;
  }

  private randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private normalizeSizes(raw: number[], total: number): number[] {
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum === 0) return raw.map(() => total / raw.length);
    return raw.map(v => (v / sum) * total);
  }
}
