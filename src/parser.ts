/**
 * Incremental splitter for model output. Feed it text chunks as they stream
 * in; it separates ordinary text from <tool_call ...>...</tool_call> blocks
 * without ever showing a half-written tag as text.
 *
 * It also watches for the model starting to invent a tool result
 * ("<tool_result"), which means it has finished calling tools and is about to
 * hallucinate. Everything from that point on is discarded and `halt` is
 * reported so the caller can stop the request.
 */

export const OPEN = "<tool_call";
export const CLOSE = "</tool_call>";
export const HALT_MARKERS = ["<tool_result", "<tool_response"];

export type SplitEvent =
	| { type: "text"; text: string }
	/** The opening tag is complete. `name` may be empty if it is given inside the body instead. */
	| { type: "tool_start"; name: string }
	/** More of the current call's body arrived. `body` is everything so far (without the opening tag). */
	| { type: "tool_delta"; delta: string; body: string }
	/** The call is complete (or the stream ended inside it, `complete: false`). */
	| { type: "tool_end"; name: string; body: string; complete: boolean }
	| { type: "halt" };

const NAME_ATTR = /^<tool_call(?:\s+[^>]*?\b(?:name|tool|function)\s*=\s*["']?([\w.:-]+)["']?)?[^>]*>/;

export class ToolCallSplitter {
	private buffer = "";
	private inTool = false;
	private headerDone = false;
	private name = "";
	private body = "";
	private halted = false;

	get isHalted(): boolean {
		return this.halted;
	}

	push(chunk: string): SplitEvent[] {
		if (this.halted) return [];
		this.buffer += chunk;
		const events: SplitEvent[] = [];
		this.drain(events, false);
		return events;
	}

	/** Call once when the stream ends. */
	finish(): SplitEvent[] {
		if (this.halted) return [];
		const events: SplitEvent[] = [];
		this.drain(events, true);
		if (this.inTool) {
			if (!this.headerDone) {
				// Never got past "<tool_call ...": treat as text.
				events.push({ type: "text", text: this.buffer });
			} else {
				events.push({ type: "tool_end", name: this.name, body: this.body + this.buffer, complete: false });
			}
		} else if (this.buffer) {
			events.push({ type: "text", text: this.buffer });
		}
		this.buffer = "";
		this.inTool = false;
		return events;
	}

	private drain(events: SplitEvent[], final: boolean): void {
		for (;;) {
			if (this.halted) return;
			if (!this.inTool) {
				const open = findOpen(this.buffer);
				const halt = findFirst(this.buffer, HALT_MARKERS);
				if (halt !== -1 && (open === -1 || halt < open)) {
					if (halt > 0) events.push({ type: "text", text: this.buffer.slice(0, halt) });
					this.buffer = "";
					this.halted = true;
					events.push({ type: "halt" });
					return;
				}
				if (open === -1) {
					// Hold back anything that might be the start of a marker.
					const keep = final ? 0 : partialMarkerSuffix(this.buffer, [OPEN, ...HALT_MARKERS]);
					const emit = this.buffer.slice(0, this.buffer.length - keep);
					if (emit) events.push({ type: "text", text: emit });
					this.buffer = this.buffer.slice(this.buffer.length - keep);
					return;
				}
				if (open > 0) events.push({ type: "text", text: this.buffer.slice(0, open) });
				this.buffer = this.buffer.slice(open);
				this.inTool = true;
				this.headerDone = false;
				this.name = "";
				this.body = "";
				continue;
			}

			if (!this.headerDone) {
				const gt = this.buffer.indexOf(">");
				if (gt === -1) return;
				const header = this.buffer.slice(0, gt + 1);
				this.name = NAME_ATTR.exec(header)?.[1] ?? "";
				this.headerDone = true;
				this.buffer = this.buffer.slice(gt + 1);
				events.push({ type: "tool_start", name: this.name });
				continue;
			}

			const close = this.buffer.indexOf(CLOSE);
			if (close === -1) {
				// Keep a possible partial "</tool_call>" back so the body never ends in a fragment of it.
				const keep = final ? 0 : partialMarkerSuffix(this.buffer, [CLOSE]);
				const delta = this.buffer.slice(0, this.buffer.length - keep);
				if (delta) {
					this.body += delta;
					events.push({ type: "tool_delta", delta, body: this.body });
				}
				this.buffer = this.buffer.slice(this.buffer.length - keep);
				return;
			}
			const delta = this.buffer.slice(0, close);
			if (delta) {
				this.body += delta;
				events.push({ type: "tool_delta", delta, body: this.body });
			}
			events.push({ type: "tool_end", name: this.name, body: this.body, complete: true });
			this.buffer = this.buffer.slice(close + CLOSE.length);
			this.inTool = false;
		}
	}
}

/** Position of "<tool_call" followed by whitespace, ">" or end of buffer (so "<tool_calls" doesn't match). */
function findOpen(s: string): number {
	let from = 0;
	for (;;) {
		const i = s.indexOf(OPEN, from);
		if (i === -1) return -1;
		const next = s[i + OPEN.length];
		// At the very end we can't tell yet; partialMarkerSuffix holds it back until the next chunk.
		if (next === undefined) return -1;
		if (next === ">" || /\s/.test(next)) return i;
		from = i + 1;
	}
}

function findFirst(s: string, markers: string[]): number {
	let best = -1;
	for (const m of markers) {
		const i = s.indexOf(m);
		if (i !== -1 && (best === -1 || i < best)) best = i;
	}
	return best;
}

/** Length of the longest suffix of `s` that is a prefix of any marker (including a complete trailing marker). */
function partialMarkerSuffix(s: string, markers: string[]): number {
	let best = 0;
	for (const m of markers) {
		const max = Math.min(m.length, s.length);
		for (let len = max; len > best; len--) {
			if (s.endsWith(m.slice(0, len))) {
				best = len;
				break;
			}
		}
	}
	return best;
}
