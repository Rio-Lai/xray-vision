/**
 * The object detector's time per run over its first second (#110): it decides how often the
 * detector runs (every 2nd new frame when that leaves room, else every 3rd as before), and whether
 * Lite2 would cost frame rate here (the engine then swaps in Lite0, which is measured again).
 */

/** The first runs build GPU programs and are slow: not counted. */
const WARMUP_RUNS = 2;
const MEASURE_MS = 1000;
const MIN_SAMPLES = 5;
/** Median per run above this: Lite2 would cost frame rate on this machine. */
export const LITE2_MAX_MS = 30;
/** Median per run at or below this (with the hands, still inside one camera frame): every 2nd frame. */
export const EVERY_2ND_MAX_MS = 16;

export class DetectorTiming {
  /** Run on every 2nd or every 3rd new camera frame; 3 until measured. */
  every: 2 | 3 = 3;
  /** Median ms per run over the first second; 0 while measuring. */
  medianMs = 0;
  private runs = 0;
  private since = -1;
  private samples: number[] = [];

  reset(): void {
    this.every = 3;
    this.medianMs = 0;
    this.runs = 0;
    this.since = -1;
    this.samples.length = 0;
  }

  /** Records one run; true once, when the first second has been measured (medianMs, every set). */
  record(ms: number, now: number): boolean {
    this.runs += 1;
    if (this.medianMs > 0 || this.runs <= WARMUP_RUNS) return false;
    if (this.since < 0) this.since = now;
    this.samples.push(ms);
    if (now - this.since < MEASURE_MS || this.samples.length < MIN_SAMPLES) return false;
    this.samples.sort((a, b) => a - b);
    this.medianMs = Math.max(0.01, this.samples[this.samples.length >> 1]);
    this.every = this.medianMs <= EVERY_2ND_MAX_MS ? 2 : 3;
    return true;
  }

  describe(): string {
    if (this.medianMs <= 0) return 'measuring its first second (every 3rd frame meanwhile)';
    return `median ${this.medianMs.toFixed(1)} ms/run over its first second -> every ${this.every === 2 ? '2nd' : '3rd'} frame (2nd if <= ${EVERY_2ND_MAX_MS} ms)`;
  }
}
