import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptionText, parseConfig, settingsFromEnv, DEFAULT_SETTINGS } from "../src/config.ts";
import { formatTally, isRateLimitError, RateLimiter, WINDOW_MS } from "../src/rate-limit.ts";

/** A limiter on a fake clock: sleep() just moves time forward. */
function fake() {
	let now = 1_000_000;
	const slept: number[] = [];
	const limiter = new RateLimiter(
		() => now,
		async (ms) => {
			slept.push(ms);
			now += ms;
		},
	);
	return { limiter, slept, advance: (ms: number) => (now += ms), now: () => now };
}

const totalSlept = (slept: number[]) => slept.reduce((a, b) => a + b, 0);

test("requests under the limits go out without waiting", async () => {
	const { limiter, slept } = fake();
	for (let i = 0; i < 5; i++) await limiter.acquire(400, { requestRate: 5, tokenRate: 10_000 });
	assert.deepEqual(slept, []);
});

test("request rate: the next request waits until the oldest leaves the window", async () => {
	const { limiter, slept, advance } = fake();
	const limits = { requestRate: 2, tokenRate: 0 };
	await limiter.acquire(4, limits);
	advance(10_000);
	await limiter.acquire(4, limits);
	const { waitedMs } = await limiter.acquire(4, limits);
	// The first request was 10s before the second, so the third waits the remaining 50s.
	assert.equal(waitedMs, 50_000);
	assert.equal(totalSlept(slept), 50_000);
	assert.ok(slept.every((ms) => ms <= 1_000), "sleeps in steps of at most a second, for the countdown");
});

test("token rate: waits until enough tokens leave the window", async () => {
	const { limiter, advance } = fake();
	const limits = { requestRate: 0, tokenRate: 1_000 };
	// 2,400 chars is about 600 tokens at the starting 4 chars per token.
	await limiter.acquire(2_400, limits);
	advance(20_000);
	const { waitedMs } = await limiter.acquire(2_400, limits);
	assert.equal(waitedMs, 40_000);
});

test("a request bigger than the whole token budget goes out once the window is empty", async () => {
	const { limiter, advance } = fake();
	const limits = { requestRate: 0, tokenRate: 100 };
	assert.equal((await limiter.acquire(4_000, limits)).waitedMs, 0);
	advance(1_000);
	assert.equal((await limiter.acquire(4_000, limits)).waitedMs, WINDOW_MS - 1_000);
});

test("settle replaces the estimate with real usage and calibrates the next estimate", async () => {
	const { limiter } = fake();
	const limits = { requestRate: 0, tokenRate: 0 };
	const { reservation } = await limiter.acquire(1_000, limits);
	assert.equal(reservation.estimate, 250);
	// The server says the prompt was 500 tokens: 0.5 tokens per char, averaged with 0.25.
	reservation.settle({ totalTokens: 600, promptTokens: 500 });
	assert.equal(limiter.estimateTokens(1_000), 375);
	// The real total (600, not the 250 estimate) now counts against the window.
	assert.equal(limiter.waitTime(0, { requestRate: 0, tokenRate: 600 }), 0);
	assert.ok(limiter.waitTime(1, { requestRate: 0, tokenRate: 600 }) > 0);
});

test("a rejected request still counts as a request but not its tokens", async () => {
	const { limiter } = fake();
	const { reservation } = await limiter.acquire(4_000, { requestRate: 0, tokenRate: 0 });
	reservation.reject();
	assert.equal(limiter.waitTime(1_000, { requestRate: 0, tokenRate: 1_000 }), 0);
	assert.ok(limiter.waitTime(0, { requestRate: 1, tokenRate: 0 }) > 0);
});

test("0 means no limit", async () => {
	const { limiter, slept } = fake();
	for (let i = 0; i < 300; i++) await limiter.acquire(1_000_000, { requestRate: 0, tokenRate: 0 });
	assert.deepEqual(slept, []);
});

test("retry delay after a 429: until the oldest request leaves the window, else back off", async () => {
	const { limiter, advance } = fake();
	assert.equal(limiter.retryDelay(0), 5_000);
	assert.equal(limiter.retryDelay(1), 10_000);
	assert.equal(limiter.retryDelay(5), WINDOW_MS);
	await limiter.acquire(4, { requestRate: 0, tokenRate: 0 });
	advance(45_000);
	assert.equal(limiter.retryDelay(0), 15_000);
	advance(14_500);
	assert.equal(limiter.retryDelay(0), 1_000, "never retries sooner than a second");
	// A request the server just rejected doesn't count: back off instead of waiting a full minute for it.
	const { limiter: fresh } = fake();
	const { reservation } = await fresh.acquire(4, { requestRate: 0, tokenRate: 0 });
	reservation.reject();
	assert.equal(fresh.retryDelay(0), 5_000);
});

test("waiting can be cancelled", async () => {
	const limiter = new RateLimiter();
	const limits = { requestRate: 1, tokenRate: 0 };
	await limiter.acquire(4, limits);
	const controller = new AbortController();
	const pending = limiter.acquire(4, limits, controller.signal);
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
});

test("which errors count as a temporary rate limit", () => {
	assert.equal(isRateLimitError('429: {"error":{"message":"Too many requests"}}'), true);
	assert.equal(isRateLimitError("429 status code (no body)"), true);
	assert.equal(isRateLimitError("Rate limit reached for requests"), true);
	assert.equal(isRateLimitError('429: {"error":{"code":"insufficient_quota"}}'), false, "exhausted quota is not retried");
	assert.equal(isRateLimitError("request id 14290 failed"), false);
	assert.equal(isRateLimitError("500: internal error"), false);
	assert.equal(isRateLimitError(undefined), false);
});

test("requestRate and tokenRate options", () => {
	assert.equal(DEFAULT_SETTINGS.requestRate, 120);
	assert.equal(DEFAULT_SETTINGS.tokenRate, 500_000);
	assert.deepEqual(parseOptionText("tokenRate", "500k"), { ok: true, value: 500_000 });
	assert.deepEqual(parseOptionText("tokenRate", "1.5m"), { ok: true, value: 1_500_000 });
	assert.deepEqual(parseOptionText("requestRate", "0"), { ok: true, value: 0 });
	assert.equal(parseOptionText("requestRate", "-1").ok, false);
	assert.equal(parseOptionText("requestRate", "fast").ok, false);
	assert.deepEqual(settingsFromEnv({ PI_XML_TOOLS_REQUEST_RATE: "60", PI_XML_TOOLS_TOKEN_RATE: "250k" }), {
		requestRate: 60,
		tokenRate: 250_000,
	});
	assert.deepEqual(parseConfig({ requestRate: 60, tokenRate: 0 }).settings, { requestRate: 60, tokenRate: 0 });
	assert.deepEqual(parseConfig({ tokenRate: "500k" }).warnings, ["xmlTools.tokenRate must be a whole number of 0 or more (0 for no limit)."]);
});

test("usage and the footer tally", async () => {
	const { limiter, advance } = fake();
	const limits = { requestRate: 120, tokenRate: 500_000 };
	assert.deepEqual(limiter.usage(), { requests: 0, tokens: 0 });
	const { reservation } = await limiter.acquire(4_000, limits);
	reservation.settle({ totalTokens: 182_000, promptTokens: 1_000 });
	await limiter.acquire(400, limits);
	const usage = limiter.usage();
	assert.equal(usage.requests, 2);
	assert.equal(formatTally(usage, limits), "xml-tools: 2/120 req · 182k/500k tok (60s)");
	assert.equal(formatTally({ requests: 3, tokens: 1_250 }, { requestRate: 0, tokenRate: 1_500_000 }), "xml-tools: 3 req · 1.3k/1.5m tok (60s)");
	assert.equal(formatTally({ requests: 1, tokens: 950 }, { requestRate: 0, tokenRate: 0 }), "xml-tools: 1 req · 950 tok (60s)");
	// Requests leave the tally as they leave the window.
	advance(WINDOW_MS);
	assert.deepEqual(limiter.usage(), { requests: 0, tokens: 0 });
});
