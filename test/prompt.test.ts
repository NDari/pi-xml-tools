import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToolInstructions } from "../src/prompt.ts";

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
