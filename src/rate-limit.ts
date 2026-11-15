/**
 * Client-side rate limiting over a rolling 60-second window, so requests wait
 * until they fit instead of being rejected with a 429 and retried by Pi's
 * fixed 2s/4s/8s backoff.
 *
 * One limiter per provider (the quota belongs to the API key). It only knows
 * about requests made by this Pi process; other processes using the same key
 * show up as 429s, which retryDelay() handles.
 *
 * The clock and sleep are injectable for tests. No Pi imports.
 */

export const WINDOW_MS = 60_000;

export interface RateLimits {
	/** Requests per minute; 0 for no limit. */
	requestRate: number;
	/** Tokens (input plus output) per minute; 0 for no limit. */
	tokenRate: number;
}

interface Entry {
	time: number;
	tokens: number;
	/** The server answered 429, so this request says nothing about when the window frees up. */
	rejected?: boolean;
}

export interface Reservation {
	/** The request's estimated input tokens, counted until settle() replaces it. */
	readonly estimate: number;
	/** Replace the estimate with what the server reported, and learn from it. */
	settle(usage: { totalTokens: number; promptTokens: number }): void;
	/** The request was rejected (429): keep it as a request, but not its tokens. */
	reject(): void;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export class RateLimiter {
	private entries: Entry[] = [];
	/** Learned from responses; starts at the usual ~4 characters per token. */
	private tokensPerChar = 0.25;

	private readonly now: () => number;
	private readonly sleep: Sleep;

	constructor(now: () => number = Date.now, sleep: Sleep = abortableSleep) {
		this.now = now;
		this.sleep = sleep;
	}

	estimateTokens(chars: number): number {
		return Math.ceil(chars * this.tokensPerChar);
	}

	/** Milliseconds until a request of `tokens` input tokens fits in the window (0 if it fits now). */
	waitTime(tokens: number, limits: RateLimits): number {
		this.prune();
		const now = this.now();
		let wait = 0;
		if (limits.requestRate > 0 && this.entries.length >= limits.requestRate) {
			// Enough of the oldest requests must leave the window to make room for one more.
			const mustExpire = this.entries[this.entries.length - limits.requestRate];
			wait = Math.max(wait, mustExpire.time + WINDOW_MS - now);
		}
		if (limits.tokenRate > 0) {
			// A request larger than the whole budget is let through once the window is empty.
			const need = Math.min(tokens, limits.tokenRate);
			let used = this.entries.reduce((sum, e) => sum + e.tokens, 0);
			for (const e of this.entries) {
				if (used + need <= limits.tokenRate) break;
				used -= e.tokens;
				wait = Math.max(wait, e.time + WINDOW_MS - now);
			}
		}
		return Math.max(0, wait);
	}

	/**
	 * Wait until a request fits, then count it. `onWait` is called with the
	 * remaining wait before each sleep (and with 0 when done waiting).
	 */
	async acquire(
		chars: number,
		limits: RateLimits,
		signal?: AbortSignal,
		onWait?: (ms: number) => void,
	): Promise<{ reservation: Reservation; waitedMs: number }> {
		const estimate = this.estimateTokens(chars);
		const start = this.now();
		let waited = false;
		for (;;) {
			const wait = this.waitTime(estimate, limits);
			// No await between this check and push(), so concurrent requests can't both take the last slot.
			if (wait === 0) break;
			waited = true;
			onWait?.(wait);
			// At most a second at a time, so onWait can show a countdown.
			await this.sleep(Math.min(wait, 1_000), signal);
		}
		if (waited) onWait?.(0);
		const entry: Entry = { time: this.now(), tokens: estimate };
		this.entries.push(entry);
		const reservation: Reservation = {
			estimate,
			settle: ({ totalTokens, promptTokens }) => {
				if (totalTokens > 0) entry.tokens = totalTokens;
				if (promptTokens > 0 && chars > 0) {
					const ratio = Math.min(1, Math.max(0.05, promptTokens / chars));
					this.tokensPerChar = (this.tokensPerChar + ratio) / 2;
				}
			},
			reject: () => {
				entry.tokens = 0;
				entry.rejected = true;
			},
		};
		return { reservation, waitedMs: this.now() - start };
	}

	/**
	 * How long to wait after a 429 before retrying. If this process has accepted
	 * requests in the window, wait until the oldest one leaves it, which frees the
	 * most room. Otherwise the quota is being used elsewhere, so back off.
	 */
	retryDelay(attempt: number): number {
		this.prune();
		const backoff = Math.min(5_000 * 2 ** attempt, WINDOW_MS);
		const oldest = this.entries.find((e) => !e.rejected);
		if (!oldest) return backoff;
		const untilOldestExpires = oldest.time + WINDOW_MS - this.now();
		return Math.max(1_000, Math.min(untilOldestExpires, WINDOW_MS));
	}

	/** What this process sent in the last 60 seconds. Tokens are real totals once a response reports them, estimates before. */
	usage(): { requests: number; tokens: number } {
		this.prune();
		return { requests: this.entries.length, tokens: this.entries.reduce((sum, e) => sum + e.tokens, 0) };
	}

	private prune(): void {
		const cutoff = this.now() - WINDOW_MS;
		while (this.entries.length && this.entries[0].time <= cutoff) this.entries.shift();
	}
}

/** The footer text, e.g. "xml-tools: 14/120 req · 182k/500k tok (60s)". A limit of 0 shows the count alone. */
export function formatTally(usage: { requests: number; tokens: number }, limits: RateLimits): string {
	const part = (n: number, limit: number, unit: string, fmt: (x: number) => string) =>
		limit > 0 ? `${fmt(n)}/${fmt(limit)} ${unit}` : `${fmt(n)} ${unit}`;
	return `xml-tools: ${part(usage.requests, limits.requestRate, "req", String)} · ${part(usage.tokens, limits.tokenRate, "tok", compact)} (60s)`;
}

/** 950, 1.2k, 182k, 1.5m */
function compact(n: number): string {
	const short = (x: number, unit: string) => `${x < 10 ? Number(x.toFixed(1)) : Math.round(x)}${unit}`;
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return short(n / 1_000, "k");
	return short(n / 1_000_000, "m");
}

/** Whether an error message is a temporary rate limit (not an exhausted quota, which retrying won't fix). */
export function isRateLimitError(message: string | undefined): boolean {
	if (!message) return false;
	if (/insufficient_quota|quota exceeded|out of budget|billing|usage limit reached/i.test(message)) return false;
	return /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i.test(message);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abortError = () => Object.assign(new Error("Request aborted"), { name: "AbortError" });
		if (signal?.aborted) return reject(abortError());
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
