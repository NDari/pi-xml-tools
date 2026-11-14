import assert from "node:assert/strict";
import { test } from "node:test";
import { type SplitEvent, ToolCallSplitter } from "../src/parser.ts";

/** Feed text in random-sized chunks and return normalized events. */
function run(text: string, seed: number): { text: string; calls: { name: string; body: string; complete: boolean }[]; halted: boolean; order: string[] } {
	let s = seed;
	const rand = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
	const sp = new ToolCallSplitter();
	const events: SplitEvent[] = [];
	let i = 0;
	while (i < text.length) {
		const n = 1 + Math.floor(rand() * 7);
		events.push(...sp.push(text.slice(i, i + n)));
		i += n;
	}
	events.push(...sp.finish());
	let out = "";
	const calls: { name: string; body: string; complete: boolean }[] = [];
	const order: string[] = [];
	let halted = false;
	let bodyFromDeltas = "";
	for (const e of events) {
		if (e.type === "text") {
			out += e.text;
			if (order[order.length - 1] !== "text") order.push("text");
		}
		if (e.type === "tool_start") bodyFromDeltas = "";
		if (e.type === "tool_delta") {
			bodyFromDeltas += e.delta;
			assert.equal(e.body, bodyFromDeltas);
			assert.ok(!e.body.includes("</tool_call"), "body must never contain a fragment of the close tag");
		}
		if (e.type === "tool_end") {
			assert.equal(e.body, bodyFromDeltas);
			calls.push({ name: e.name, body: e.body, complete: e.complete });
			order.push("tool");
		}
		if (e.type === "halt") halted = true;
		if (e.type === "text") assert.ok(!e.text.includes("<tool_call ") && !e.text.includes("<tool_call>"), "no tags leak into text");
		if (e.type === "text") assert.ok(!/```tool_call[\s>]/.test(e.text), "no tool_call fence leaks into text");
	}
	return { text: out, calls, halted, order };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

test("plain text passes through unchanged", () => {
	const t = "Hello <b>world</b>, a < b and tool_call is a word. <tool_calls> too.";
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, t);
		assert.equal(r.calls.length, 0);
	}
});

test("text, call, text", () => {
	const t = `Let me look.\n<tool_call name="bash">\n<parameter name="command">ls -la</parameter>\n</tool_call>\nDone.`;
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "Let me look.\n\nDone.");
		assert.deepEqual(r.calls, [{ name: "bash", body: `\n<parameter name="command">ls -la</parameter>\n`, complete: true }]);
		assert.deepEqual(r.order, ["text", "tool", "text"]);
	}
});

test("multiple calls, single quotes, extra attributes", () => {
	const t = `<tool_call name='read' id="1"><parameter name="path">a.ts</parameter></tool_call>\n<tool_call name="read"><parameter name="path">b.ts</parameter></tool_call>`;
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.deepEqual(
			r.calls.map((c) => c.name),
			["read", "read"],
		);
		assert.equal(r.text.trim(), "");
	}
});

test("halts when the model starts inventing a result", () => {
	const t = `<tool_call name="bash"><parameter name="command">ls</parameter></tool_call>\n<tool_result name="bash">fake</tool_result> more`;
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.calls.length, 1);
		assert.equal(r.halted, true);
		assert.ok(!r.text.includes("fake"));
	}
});

test("unterminated call at end of stream is reported incomplete", () => {
	const t = `ok <tool_call name="write"><parameter name="path">x</parameter><parameter name="content">abc`;
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.calls.length, 1);
		assert.equal(r.calls[0].complete, false);
		assert.ok(r.calls[0].body.endsWith("abc"));
	}
});

test("name given in body instead of attribute", () => {
	const r = run(`<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>`, 7);
	assert.equal(r.calls[0].name, "");
	assert.ok(r.calls[0].body.includes('"bash"'));
});

test("trailing '<tool_call' prefix at end of stream becomes text", () => {
	const r = run("see <tool_ca", 3);
	assert.equal(r.text, "see <tool_ca");
});

// Fenced forms below are verbatim Gemma 3 (12B and 27B) output seen with llama.cpp.

test("fenced call with attributes on the fence line", () => {
	const t = '```tool_call name="edit">\n<parameter name="path">app.ts</parameter>\n<parameter name="edits">\n<item>\n<oldText>hello</oldText>\n<newText>hi</newText>\n</item>\n</parameter>\n</tool_call>\n```';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "");
		assert.equal(r.calls.length, 1);
		assert.equal(r.calls[0].name, "edit");
		assert.equal(r.calls[0].complete, true);
		assert.ok(r.calls[0].body.startsWith('\n<parameter name="path">'));
	}
});

test("fenced call with an inner <tool name> wrapper", () => {
	const t = '```tool_call\n<tool name="edit">\n<parameter name="path">app.ts</parameter>\n</tool>\n```';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "");
		assert.deepEqual(r.calls, [{ name: "", body: '<tool name="edit">\n<parameter name="path">app.ts</parameter>\n', complete: true }]);
	}
});

test("fenced call with an inner <tool_call> tag", () => {
	const t = '```tool_call\n<tool_call name="read">\n<parameter name="path">a.ts</parameter>\n</tool_call>\n```';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "");
		assert.equal(r.calls.length, 1);
		assert.ok(r.calls[0].body.includes('<tool_call name="read">'));
	}
});

test("fenced JSON call ends at the closing fence", () => {
	const t = '```tool_call\n{"name": "bash", "arguments": {"command": "ls"}}\n```\nafter';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "\nafter");
		assert.deepEqual(r.calls, [{ name: "", body: '{"name": "bash", "arguments": {"command": "ls"}}', complete: true }]);
	}
});

test("text around a fenced call keeps its own content", () => {
	const t = 'Sure.\n```tool_call name="read">\n<parameter name="path">a</parameter>\n</tool_call>\n```\nDone.';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, "Sure.\n\nDone.");
		assert.deepEqual(r.order, ["text", "tool", "text"]);
	}
});

test("triple backticks inside a fenced XML value don't end the call", () => {
	const t = '```tool_call name="write">\n<parameter name="content">\n```js\nx()\n```\n</parameter>\n</tool_call>\n```';
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.calls.length, 1);
		assert.ok(r.calls[0].body.includes("```js\nx()\n```"));
		assert.equal(r.text, "");
	}
});

test("ordinary code fences pass through as text", () => {
	const t = "Example:\n```ts\nconst x = 1;\n```\nand ```tool_calls``` too.";
	for (const seed of SEEDS) {
		const r = run(t, seed);
		assert.equal(r.text, t);
		assert.equal(r.calls.length, 0);
	}
});
