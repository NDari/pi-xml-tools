import assert from "node:assert/strict";
import { test } from "node:test";
import { prependToFirstUser, renderToolInstructions } from "../src/prompt.ts";

test("tool list uses headings, not <tool> tags, and warns against code fences", () => {
	const text = renderToolInstructions([
		{
			name: "read",
			description: "Read a file.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		} as any,
	]);
	assert.ok(text.includes("### read\nRead a file."));
	assert.ok(!text.includes("<tool name="), "models copied <tool name> into their calls");
	assert.ok(text.includes("Never wrap it in a code fence (```)."));
	assert.ok(text.includes('<tool_call name="read">\n<parameter name="path">src/index.ts</parameter>\n</tool_call>'));
});

test("instructions are prepended to the first user message only", () => {
	const messages: any[] = [
		{ role: "user", content: "Read README.md", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 3 },
	];
	const out = prependToFirstUser(messages, "SYSTEM PROMPT\n# Tool use");
	assert.deepEqual(out[0].content, [{ type: "text", text: "<instructions>\nSYSTEM PROMPT\n# Tool use\n</instructions>\n\nRead README.md" }]);
	assert.equal(out[2], messages[2], "later user messages are untouched");
	assert.equal(messages[0].content, "Read README.md", "input is not mutated");
	// Images stay after the instructions and the user's text.
	const img = { type: "image", data: "x", mimeType: "image/png" };
	const withImage = prependToFirstUser([{ role: "user", content: [{ type: "text", text: "look" }, img], timestamp: 1 } as any], "P");
	assert.deepEqual(withImage[0].content, [{ type: "text", text: "<instructions>\nP\n</instructions>\n\nlook" }, img]);
	// Nothing to add, or no user message yet.
	assert.equal(prependToFirstUser(messages, undefined), messages);
	assert.equal(prependToFirstUser([], "P")[0].role, "user");
});
