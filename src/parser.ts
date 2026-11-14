/**
 * Incremental splitter for model output. Feed it text chunks as they stream
 * in; it separates ordinary text from <tool_call ...>...</tool_call> blocks
 * without ever showing a half-written tag as text.
 *
 * It also watches for the model starting to invent a tool result
 * ("<tool_result"), which means it has finished calling tools and is about to
 * hallucinate. Everything from that point on is discarded and `halt` is
 * reported so the caller can stop the request.
 *
 * Some models (Gemma 3 among them) write the call as a markdown code block
 * whose language tag is "tool_call" instead of as a tag:
 *
 *   ```tool_call name="edit">            ```tool_call
 *   <parameter ...>...</parameter>       <tool name="edit">
 *   </tool_call>                         <parameter ...>...</parameter>
 *   ```                                  </tool>
 *                                        ```
 *
 * These fenced forms are accepted too. The body ends at </tool_call> or
 * </tool> (or, for a JSON body, at the closing fence), and the closing fence
 * after it is dropped.
 */

export const OPEN = "<tool_call";
export const CLOSE = "</tool_call>";
export const FENCE_OPEN = "```tool_call";
const FENCE = "```";
const FENCE_CLOSE = "\n```";
const TOOL_CLOSE = "</tool>";
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
const FENCE_NAME_ATTR = /\b(?:name|tool|function)\s*=\s*["']?([\w.:-]+)/;

export class ToolCallSplitter {
	private buffer = "";
	private inTool = false;
	private headerDone = false;
	private name = "";
	private body = "";
	private halted = false;
	/** The current call was opened with a ```tool_call fence. */
	private fenced = false;
	/** A fenced call just ended; drop its closing ``` if it follows. */
	private pendingFenceClose = false;

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
				if (this.pendingFenceClose) {
					const rest = this.buffer.replace(/^\s+/, "");
					if (rest.startsWith(FENCE)) {
						this.buffer = rest.slice(FENCE.length);
						this.pendingFenceClose = false;
						continue;
					}
					// Only whitespace or part of "```" so far: wait for more.
					if (!final && FENCE.startsWith(rest)) return;
					this.pendingFenceClose = false;
				}
				const fenceOpen = findOpen(this.buffer, FENCE_OPEN);
				const tagOpen = findOpen(this.buffer, OPEN);
				const fenced = fenceOpen !== -1 && (tagOpen === -1 || fenceOpen < tagOpen);
				const open = fenced ? fenceOpen : tagOpen;
				const halt = findFirst(this.buffer, HALT_MARKERS).index;
				if (halt !== -1 && (open === -1 || halt < open)) {
					if (halt > 0) events.push({ type: "text", text: this.buffer.slice(0, halt) });
					this.buffer = "";
					this.halted = true;
					events.push({ type: "halt" });
					return;
				}
				if (open === -1) {
					// Hold back anything that might be the start of a marker.
					const keep = final ? 0 : partialMarkerSuffix(this.buffer, [OPEN, FENCE_OPEN, ...HALT_MARKERS]);
					const emit = this.buffer.slice(0, this.buffer.length - keep);
					if (emit) events.push({ type: "text", text: emit });
					this.buffer = this.buffer.slice(this.buffer.length - keep);
					return;
				}
				if (open > 0) events.push({ type: "text", text: this.buffer.slice(0, open) });
				this.buffer = this.buffer.slice(open);
				this.inTool = true;
				this.fenced = fenced;
				this.headerDone = false;
				this.name = "";
				this.body = "";
				continue;
			}

			if (!this.headerDone) {
				// A fenced header ends at ">" (```tool_call name="x">) or at the end of the fence line.
				const end = this.fenced ? firstOf(this.buffer, [">", "\n"], FENCE_OPEN.length) : this.buffer.indexOf(">");
				if (end === -1) return;
				const header = this.buffer.slice(0, end + 1);
				this.name = (this.fenced ? FENCE_NAME_ATTR.exec(header) : NAME_ATTR.exec(header))?.[1] ?? "";
				this.headerDone = true;
				this.buffer = this.buffer.slice(end + 1);
				events.push({ type: "tool_start", name: this.name });
				continue;
			}

			const closers = this.closers();
			const { index: close, marker } = findFirst(this.buffer, closers);
			if (close === -1) {
				// Keep a possible partial closer back so the body never ends in a fragment of it.
				const keep = final ? 0 : partialMarkerSuffix(this.buffer, this.fenced ? [CLOSE, TOOL_CLOSE, FENCE_CLOSE] : [CLOSE]);
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
			this.buffer = this.buffer.slice(close + marker.length);
			this.inTool = false;
			this.pendingFenceClose = this.fenced && marker !== FENCE_CLOSE;
		}
	}

	/** Markers that end the current call's body. */
	private closers(): string[] {
		if (!this.fenced) return [CLOSE];
		const head = (this.body + this.buffer).trimStart();
		if (head === "") return [];
		// XML inside the fence ends at its closing tag; anything else (JSON) ends at the closing fence.
		return head.startsWith("<") ? [CLOSE, TOOL_CLOSE] : [FENCE_CLOSE];
	}
}

/** Position of `marker` followed by whitespace, ">" or end of buffer (so "<tool_calls" doesn't match). */
function findOpen(s: string, marker: string): number {
	let from = 0;
	for (;;) {
		const i = s.indexOf(marker, from);
		if (i === -1) return -1;
		const next = s[i + marker.length];
		// At the very end we can't tell yet; partialMarkerSuffix holds it back until the next chunk.
		if (next === undefined) return -1;
		if (next === ">" || /\s/.test(next)) return i;
		from = i + 1;
	}
}

function findFirst(s: string, markers: string[]): { index: number; marker: string } {
	let best = -1;
	let marker = "";
	for (const m of markers) {
		const i = s.indexOf(m);
		if (i !== -1 && (best === -1 || i < best)) {
			best = i;
			marker = m;
		}
	}
	return { index: best, marker };
}

/** Position of the first of `markers` at or after `from`, or -1. */
function firstOf(s: string, markers: string[], from: number): number {
	const { index } = findFirst(s.slice(from), markers);
	return index === -1 ? -1 : from + index;
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
