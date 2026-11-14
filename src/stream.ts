/**
 * The Pi stream function. It rewrites the request so the model sees tools as
 * prompt text, sends it through Pi's own OpenAI Chat Completions
 * implementation (so auth, retries, usage and cancellation behave exactly like
 * a built-in provider), and turns the <tool_call> text that streams back into
 * real Pi tool-call events.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { findNameInBody, parseArguments } from "./args.ts";
import { HALT_MARKERS, type SplitEvent, ToolCallSplitter } from "./parser.ts";
import { renderToolInstructions, rewriteMessages } from "./prompt.ts";

export interface XmlToolsSettings {
	/** Add `stop: ["<tool_result"]` to requests so the server stops the model before it invents a result. */
	useStopSequences: boolean;
	/** Extra stop sequences to send. */
	extraStop: string[];
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): XmlToolsSettings {
	const off = /^(0|false|no|off)$/i;
	return {
		useStopSequences: !off.test(env.PI_XML_TOOLS_STOP ?? ""),
		extraStop: (env.PI_XML_TOOLS_EXTRA_STOP ?? "")
			.split("|")
			.map((s) => s.trim())
			.filter(Boolean),
	};
}

/** Build the rewritten, tool-free request context. Exported for tests. */
export function buildRequestContext(model: Model<Api>, context: TranscriptContext): { context: TranscriptContext; tools: Tool[] } {
	const tools = getCurrentTools(context.messages);
	const basePrompt = getCurrentSystemPrompt(context.messages);
	const systemPrompt = tools.length ? [basePrompt, renderToolInstructions(tools)].filter(Boolean).join("\n\n") : basePrompt;
	const messages = rewriteMessages(collapseSystemMessages(context).messages, {
		supportsImages: model.input.includes("image"),
	});
	return { context: normalizeContext({ systemPrompt, messages, tools: [] }), tools };
}

let callCounter = 0;
function newCallId(): string {
	callCounter = (callCounter + 1) % 1_000_000;
	return `xml_${Date.now().toString(36)}_${callCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createXmlToolsStream(settings: XmlToolsSettings = settingsFromEnv()) {
	return function streamXmlTools(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		(async () => {
			// Our own controller so we can cut the request short when the model starts inventing tool results.
			const controller = new AbortController();
			const outerSignal = options?.signal;
			const onOuterAbort = () => controller.abort(outerSignal?.reason);
			if (outerSignal?.aborted) controller.abort(outerSignal.reason);
			else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

			let started = false;
			let finished = false;
			const end = () => {
				outerSignal?.removeEventListener("abort", onOuterAbort);
				stream.end();
			};
			const fail = (reason: "error" | "aborted", message: string) => {
				if (finished) return;
				finished = true;
				closeOpenBlocks();
				output.stopReason = reason;
				output.errorMessage = message;
				stream.push({ type: "error", reason, error: output });
				end();
			};

			// ---- block bookkeeping -------------------------------------------------
			let textIndex = -1; // open text block
			let thinkingIndex = -1;
			let toolIndex = -1; // open tool call block
			const tools: Tool[] = [];
			const toolSchema = (name: string) => tools.find((t) => t.name === name)?.parameters as Record<string, any> | undefined;

			const appendText = (text: string) => {
				if (!text) return;
				if (textIndex === -1) {
					// Don't open a block for whitespace alone (e.g. the newlines between two tool calls).
					text = text.replace(/^\s+/, "");
					if (!text) return;
					output.content.push({ type: "text", text: "" });
					textIndex = output.content.length - 1;
					stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				}
				const block = output.content[textIndex] as TextContent;
				block.text += text;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
			};
			const closeText = () => {
				if (textIndex === -1) return;
				const block = output.content[textIndex] as TextContent;
				block.text = block.text.replace(/\s+$/, "");
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
				textIndex = -1;
			};
			const closeThinking = () => {
				if (thinkingIndex === -1) return;
				const block = output.content[thinkingIndex] as ThinkingContent;
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: output });
				thinkingIndex = -1;
			};
			const finishToolCall = (name: string, body: string, complete: boolean) => {
				if (toolIndex === -1) return;
				const block = output.content[toolIndex] as ToolCall;
				const finalName = name || findNameInBody(body) || block.name;
				block.name = finalName;
				const parsed = parseArguments(body, toolSchema(finalName));
				block.arguments = parsed.args as ToolCall["arguments"];
				const problems: string[] = [];
				if (!finalName) problems.push('The tool call has no name. Write <tool_call name="TOOL_NAME">.');
				if (!complete) problems.push("The tool call was cut off before </tool_call>.");
				if (parsed.error) problems.push(parsed.error);
				if (problems.length) {
					block.argumentsError = `${problems.join(" ")} Received:\n${body.slice(0, 2000)}`;
				} else {
					delete block.argumentsError;
				}
				stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: block, partial: output });
				toolIndex = -1;
			};
			function closeOpenBlocks() {
				closeText();
				closeThinking();
				if (toolIndex !== -1) {
					const block = output.content[toolIndex] as ToolCall;
					stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall: block, partial: output });
					toolIndex = -1;
				}
			}

			const handle = (events: SplitEvent[]) => {
				for (const ev of events) {
					switch (ev.type) {
						case "text":
							closeThinking();
							appendText(ev.text);
							break;
						case "tool_start": {
							closeText();
							closeThinking();
							const block: ToolCall = { type: "toolCall", id: newCallId(), name: ev.name, arguments: {} };
							output.content.push(block);
							toolIndex = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
							break;
						}
						case "tool_delta": {
							if (toolIndex === -1) break;
							const block = output.content[toolIndex] as ToolCall;
							if (!block.name) block.name = findNameInBody(ev.body) ?? "";
							// Best-effort live arguments so Pi can render progress.
							block.arguments = parseArguments(ev.body, toolSchema(block.name), true).args as ToolCall["arguments"];
							stream.push({ type: "toolcall_delta", contentIndex: toolIndex, delta: ev.delta, partial: output });
							break;
						}
						case "tool_end":
							finishToolCall(ev.name, ev.body, ev.complete);
							break;
						case "halt":
							break;
					}
				}
			};

			try {
				const { context: requestContext, tools: currentTools } = buildRequestContext(model, context);
				tools.push(...currentTools);
				const splitter = new ToolCallSplitter();

				const innerModel = { ...model, api: "openai-completions" } as Model<"openai-completions">;
				const innerOptions: SimpleStreamOptions = {
					...options,
					signal: controller.signal,
					onPayload: async (payload, m) => {
						let next = ((await options?.onPayload?.(payload, m)) ?? payload) as Record<string, any>;
						if (tools.length && settings.useStopSequences) {
							const existing: string[] = Array.isArray(next.stop) ? next.stop : next.stop ? [next.stop] : [];
							const stop = [...new Set([...existing, ...HALT_MARKERS.slice(0, 1), ...settings.extraStop])];
							next = { ...next, stop };
						}
						// Never send native tool fields: this model doesn't support them.
						const { tools: _t, tool_choice: _c, parallel_tool_calls: _p, ...rest } = next;
						return rest;
					},
				};

				const inner = openAICompletionsApi().streamSimple(innerModel, requestContext, innerOptions);
				let lastUsage = output.usage;
				for await (const event of inner) {
					if (finished) break;
					switch (event.type) {
						case "start":
							started = true;
							stream.push({ type: "start", partial: output });
							break;
						case "text_delta":
							lastUsage = event.partial.usage;
							handle(splitter.push(event.delta));
							if (splitter.isHalted) {
								// The model began writing a tool result itself. Everything we need is already parsed.
								handle(splitter.finish());
								closeOpenBlocks();
								output.usage = { ...lastUsage };
								output.responseId = event.partial.responseId;
								output.responseModel = event.partial.responseModel;
								output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
								finished = true;
								stream.push({ type: "done", reason: output.stopReason, message: output });
								controller.abort();
								end();
							}
							break;
						case "thinking_start":
							closeText();
							output.content.push({ type: "thinking", thinking: "" });
							thinkingIndex = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
							break;
						case "thinking_delta":
							if (thinkingIndex === -1) break;
							(output.content[thinkingIndex] as ThinkingContent).thinking += event.delta;
							stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: event.delta, partial: output });
							break;
						case "thinking_end": {
							if (thinkingIndex === -1) break;
							const src = event.partial.content[event.contentIndex];
							if (src?.type === "thinking" && src.thinkingSignature) {
								(output.content[thinkingIndex] as ThinkingContent).thinkingSignature = src.thinkingSignature;
							}
							closeThinking();
							break;
						}
						case "done": {
							handle(splitter.finish());
							closeOpenBlocks();
							const msg = event.message;
							output.usage = msg.usage;
							output.responseId = msg.responseId;
							output.responseModel = msg.responseModel;
							output.rawStopReason = msg.rawStopReason;
							const hasCalls = output.content.some((b) => b.type === "toolCall");
							output.stopReason = hasCalls ? "toolUse" : event.reason === "toolUse" ? "stop" : event.reason;
							finished = true;
							stream.push({ type: "done", reason: output.stopReason, message: output });
							end();
							break;
						}
						case "error": {
							handle(splitter.finish());
							output.usage = event.error.usage;
							fail(event.reason, event.error.errorMessage ?? "Request failed");
							break;
						}
						default:
							// text_start/text_end/toolcall_* from the inner stream are re-derived above.
							break;
					}
				}
				if (!finished) {
					fail(outerSignal?.aborted ? "aborted" : "error", "Stream ended without a final event");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!started) {
					finished = true;
					output.stopReason = outerSignal?.aborted ? "aborted" : "error";
					output.errorMessage = message;
					stream.push({ type: "error", reason: output.stopReason, error: output });
					end();
				} else {
					fail(outerSignal?.aborted ? "aborted" : "error", message);
				}
			}
		})();

		return stream;
	};
}
