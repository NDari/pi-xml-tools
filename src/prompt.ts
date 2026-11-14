/**
 * Prompt side of the bridge:
 *   - renders the tool-use instructions and tool list into the system prompt
 *   - rewrites the conversation so earlier tool calls and tool results appear
 *     as the same XML text the model is asked to write
 *
 * This is the file to edit if your model responds better to different
 * wording. Keep the tag names in sync with parser.ts (<tool_call>,
 * <parameter>, <item>, <tool_result>).
 */

import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { serializeToolCall, type JsonObject } from "./args.ts";

export function renderToolInstructions(tools: Tool[]): string {
	const toolList = tools.map(renderTool).join("\n\n");
	return `# Tool use

You can call tools to act on the user's machine. To call a tool, write a tool call block in exactly this format:

<tool_call name="TOOL_NAME">
<parameter name="PARAMETER_NAME">VALUE</parameter>
</tool_call>

How to write values:
- Strings are written raw, exactly as they should be received. Do not quote them, do not JSON-escape them, and do not XML-escape characters such as < > &. Multi-line text and code go directly between the tags.
- Numbers and booleans are written plainly, e.g. 42 or true.
- A list of objects is written with one <item> per element and one tag per field inside it, for example:
<parameter name="edits">
<item>
<oldText>exact text to replace</oldText>
<newText>replacement text</newText>
</item>
</parameter>
- Any other list or object may be written as JSON.
- Leave out optional parameters you don't need.

Rules:
- You may make several tool calls in one reply, one block after another.
- After your last tool call, stop writing and wait. The results arrive in the next message inside <tool_result> blocks. Never write a <tool_result> block yourself and never guess what a tool returned.
- Only write a tool_call block when you actually want to call that tool. Do not put tool_call blocks inside code fences, examples or explanations.
- If no tool is needed, just answer normally.

## Available tools

${toolList}

## Example

<tool_call name="${exampleToolName(tools)}">
${exampleParameters(tools)}
</tool_call>`;
}

function renderTool(tool: Tool): string {
	const schema = (tool.parameters ?? {}) as Record<string, any>;
	const required = new Set<string>(schema.required ?? []);
	const props = Object.entries<Record<string, any>>(schema.properties ?? {});
	const params = props.length
		? props.map(([name, p]) => renderParam(name, p, required.has(name))).join("\n")
		: "(no parameters)";
	return `<tool name="${tool.name}">
${tool.description.trim()}
Parameters:
${params}
</tool>`;
}

function renderParam(name: string, schema: Record<string, any>, required: boolean, indent = "- "): string {
	const desc = schema.description ? `: ${String(schema.description).trim()}` : "";
	let line = `${indent}${name} (${typeLabel(schema)}, ${required ? "required" : "optional"})${desc}`;
	const itemSchema = schema.items;
	if (itemSchema?.properties) {
		const itemRequired = new Set<string>(itemSchema.required ?? []);
		const fields = Object.entries<Record<string, any>>(itemSchema.properties)
			.map(([n, p]) => renderParam(n, p, itemRequired.has(n), "    - "))
			.join("\n");
		line += `\n  Each item has:\n${fields}`;
	} else if (schema.properties) {
		const objRequired = new Set<string>(schema.required ?? []);
		const fields = Object.entries<Record<string, any>>(schema.properties)
			.map(([n, p]) => renderParam(n, p, objRequired.has(n), "    - "))
			.join("\n");
		line += `\n  Fields:\n${fields}`;
	}
	return line;
}

function typeLabel(schema: Record<string, any>): string {
	if (schema.enum) return `one of: ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
	if (schema.const !== undefined) return `exactly ${JSON.stringify(schema.const)}`;
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants)) return variants.map(typeLabel).join(" or ");
	if (schema.type === "array") {
		const item = schema.items;
		if (item?.properties) return "list of objects";
		return `list of ${item ? typeLabel(item) : "values"}`;
	}
	if (Array.isArray(schema.type)) return schema.type.join(" or ");
	return schema.type ?? (schema.properties ? "object" : "any");
}

function exampleToolName(tools: Tool[]): string {
	return tools.find((t) => t.name === "read")?.name ?? tools[0]?.name ?? "tool_name";
}

function exampleParameters(tools: Tool[]): string {
	const read = tools.find((t) => t.name === "read");
	if (read) return `<parameter name="path">src/index.ts</parameter>`;
	const first = tools[0];
	const props = Object.keys((first?.parameters as any)?.properties ?? {});
	return props.length ? `<parameter name="${props[0]}">...</parameter>` : "";
}

// ---------------------------------------------------------------------------
// Transcript rewriting
// ---------------------------------------------------------------------------

export interface RewriteOptions {
	/** Whether the model accepts images. If false, images are replaced by a short note. */
	supportsImages: boolean;
}

/**
 * Rewrite non-system messages so they contain no native tool calls or tool
 * results. Assistant tool calls become <tool_call> text; tool results become
 * <tool_result> blocks in a user message. Consecutive user messages are merged
 * because some OpenAI-compatible gateways (Gemini's among them) reject or
 * mishandle back-to-back user turns.
 */
export function rewriteMessages(messages: Message[], opts: RewriteOptions): Message[] {
	const answered = new Set<string>();
	for (const m of messages) if (m.role === "toolResult") answered.add(m.toolCallId);

	const out: Message[] = [];
	const pushUser = (content: (TextContent | ImageContent)[], timestamp: number) => {
		if (content.length === 0) return;
		const last = out[out.length - 1];
		if (last && last.role === "user") {
			const prev: (TextContent | ImageContent)[] =
				typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
			last.content = mergeText(prev, content);
			return;
		}
		out.push({ role: "user", content, timestamp } satisfies UserMessage);
	};

	for (const message of messages) {
		switch (message.role) {
			case "system":
				// Folded into the leading system prompt by the caller.
				break;
			case "user": {
				const content: (TextContent | ImageContent)[] =
					typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
				pushUser(filterImages(content, opts), message.timestamp);
				break;
			}
			case "assistant": {
				const text = renderAssistant(message);
				if (!text.trim()) break;
				out.push({ ...message, content: [{ type: "text", text }] });
				const missing = message.content.filter((b) => b.type === "toolCall" && !answered.has(b.id));
				for (const call of missing) {
					if (call.type !== "toolCall") continue;
					pushUser(
						[
							{
								type: "text",
								text: `<tool_result name="${call.name}" status="error">\nNo result was recorded for this call (it was interrupted or skipped).\n</tool_result>`,
							},
						],
						message.timestamp,
					);
				}
				break;
			}
			case "toolResult":
				pushUser(renderToolResult(message as ToolResultMessage, opts), message.timestamp);
				break;
		}
	}
	return out;
}

function renderAssistant(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.trim()) parts.push(block.text.trim());
		} else if (block.type === "toolCall") {
			parts.push(serializeToolCall(block.name, (block.arguments ?? {}) as JsonObject));
		}
		// Thinking blocks are not replayed.
	}
	return parts.join("\n\n");
}

function renderToolResult(message: ToolResultMessage, opts: RewriteOptions): (TextContent | ImageContent)[] {
	const status = message.isError ? "error" : "ok";
	const text = message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = message.content.filter((c): c is ImageContent => c.type === "image");
	const note = images.length && !opts.supportsImages ? `\n[${images.length} image(s) omitted: this model does not accept images]` : "";
	const out: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `<tool_result name="${message.toolName}" status="${status}">\n${text}${note}\n</tool_result>`,
		},
	];
	if (opts.supportsImages) out.push(...images);
	return out;
}

function filterImages(content: (TextContent | ImageContent)[], opts: RewriteOptions): (TextContent | ImageContent)[] {
	if (opts.supportsImages) return content;
	return content.map((c) => (c.type === "image" ? { type: "text", text: "[image omitted]" } : c));
}

/** Concatenate two content lists, joining adjacent text parts with a blank line. */
function mergeText(
	a: (TextContent | ImageContent)[],
	b: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	const result = [...a];
	for (const part of b) {
		const last = result[result.length - 1];
		if (part.type === "text" && last?.type === "text") {
			result[result.length - 1] = { type: "text", text: `${last.text}\n\n${part.text}` };
		} else {
			result.push(part);
		}
	}
	return result;
}
