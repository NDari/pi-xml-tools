import assert from "node:assert/strict";
import { test } from "node:test";
import { findNameInBody, parseArguments, serializeToolCall } from "../src/args.ts";

// Schemas matching Pi's built-in tools.
const bash = {
	type: "object",
	properties: { command: { type: "string" }, timeout: { type: "number" } },
	required: ["command"],
};
const read = {
	type: "object",
	properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
	required: ["path"],
};
const edit = {
	type: "object",
	properties: {
		path: { type: "string" },
		edits: {
			type: "array",
			items: {
				type: "object",
				properties: { oldText: { type: "string" }, newText: { type: "string" } },
				required: ["oldText", "newText"],
			},
		},
	},
	required: ["path", "edits"],
};

test("raw string with quotes, angle brackets and newlines", () => {
	const body = `
<parameter name="command">
grep -n "a < b && c > d" src/*.ts | head
echo 'done'
</parameter>
<parameter name="timeout">30</parameter>
`;
	const r = parseArguments(body, bash);
	assert.equal(r.error, undefined);
	assert.deepEqual(r.args, { command: `grep -n "a < b && c > d" src/*.ts | head\necho 'done'`, timeout: 30 });
});

test("numbers are converted by schema", () => {
	const r = parseArguments(`<parameter name="path">a.ts</parameter><parameter name="offset"> 10 </parameter>`, read);
	assert.deepEqual(r.args, { path: "a.ts", offset: 10 });
});

test("edit with <item> list keeps code raw", () => {
	const body = `
<parameter name="path">src/app.ts</parameter>
<parameter name="edits">
<item>
<oldText>
const x = "hello";
if (a < b) {}
</oldText>
<newText>
const x = "hi \\n there";
</newText>
</item>
<item>
<oldText>foo()</oldText>
<newText>bar()</newText>
</item>
</parameter>`;
	const r = parseArguments(body, edit);
	assert.equal(r.error, undefined);
	assert.deepEqual(r.args, {
		path: "src/app.ts",
		edits: [
			{ oldText: `const x = "hello";\nif (a < b) {}`, newText: `const x = "hi \\n there";` },
			{ oldText: "foo()", newText: "bar()" },
		],
	});
});

test("edit with JSON array also works", () => {
	const r = parseArguments(
		`<parameter name="path">a</parameter><parameter name="edits">[{"oldText":"a","newText":"b"}]</parameter>`,
		edit,
	);
	assert.deepEqual(r.args, { path: "a", edits: [{ oldText: "a", newText: "b" }] });
});

test("value containing the literal text </parameter> survives", () => {
	const body = `<parameter name="command">echo "</parameter>" > x</parameter>\n<parameter name="timeout">5</parameter>`;
	const r = parseArguments(body, bash);
	assert.deepEqual(r.args, { command: `echo "</parameter>" > x`, timeout: 5 });
});

test("CDATA is unwrapped", () => {
	const r = parseArguments(`<parameter name="command"><![CDATA[echo <hi>]]></parameter>`, bash);
	assert.deepEqual(r.args, { command: "echo <hi>" });
});

test("child-tag style fallback", () => {
	const r = parseArguments(`\n<path>a.ts</path>\n<limit>5</limit>\n`, read);
	assert.deepEqual(r.args, { path: "a.ts", limit: 5 });
});

test("JSON body fallback, plain and name/arguments style", () => {
	assert.deepEqual(parseArguments(`{"command":"ls"}`, bash).args, { command: "ls" });
	assert.deepEqual(parseArguments(`{"name":"bash","arguments":{"command":"ls"}}`, bash).args, { command: "ls" });
	assert.equal(findNameInBody(`{"name":"bash","arguments":{}}`), "bash");
	assert.equal(findNameInBody(`<name>read</name>`), "read");
});

test("garbage body reports an error", () => {
	const r = parseArguments(`please run ls`, bash);
	assert.ok(r.error);
});

test("partial parsing only returns closed parameters", () => {
	const r = parseArguments(`<parameter name="path">a.ts</parameter><parameter name="content">half`, undefined, true);
	assert.deepEqual(r.args, { path: "a.ts" });
});

test("serialize -> parse round trip", () => {
	const cases: [string, any, Record<string, unknown>][] = [
		["bash", bash, { command: "cd x && ls\necho \"<done>\"", timeout: 3 }],
		["read", read, { path: "a.ts", offset: 1, limit: 20 }],
		[
			"edit",
			edit,
			{
				path: "a.ts",
				edits: [
					{ oldText: "line1\nline2", newText: "x" },
					{ oldText: "y", newText: "z\n  indented" },
				],
			},
		],
	];
	for (const [name, schema, args] of cases) {
		const xml = serializeToolCall(name, args);
		const body = xml.slice(xml.indexOf(">") + 1, xml.lastIndexOf("</tool_call>"));
		const r = parseArguments(body, schema);
		assert.equal(r.error, undefined, xml);
		assert.deepEqual(r.args, args, xml);
	}
});
