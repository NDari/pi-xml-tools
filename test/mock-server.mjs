// Minimal OpenAI-compatible streaming server that behaves like a model with no
// native tool support: it only ever returns text. Scripted by conversation state.
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const port = Number(process.argv[2] ?? 8765);
const target = process.argv[3]; // file the edit step should modify
const log = process.argv[4] ?? "/tmp/mock-requests.jsonl";
writeFileSync(log, "");

function lastUserText(body) {
	const users = body.messages.filter((m) => m.role === "user");
	const last = users[users.length - 1];
	if (!last) return "";
	return typeof last.content === "string" ? last.content : last.content.map((p) => p.text ?? "").join("");
}

function script(body) {
	const u = lastUserText(body);
	if (u.includes('<tool_result name="edit" status="ok">')) return "All done. The check passed and the file is updated.";
	if (u.includes('<tool_result name="bash" status="ok">') && u.includes("hello-2")) {
		return `The check printed hello-2. Now updating the file.
<tool_call name="edit">
<parameter name="path">${target}</parameter>
<parameter name="edits">
<item>
<oldText>
const greeting = "hello";
</oldText>
<newText>
const greeting = "hi \\"there\\" <friend> & co";
</newText>
</item>
</parameter>
</tool_call>`;
	}
	// First turn. Includes an invented result to exercise the halt path (this mock ignores `stop`).
	return `I'll run the check first.
<tool_call name="bash">
<parameter name="command">echo hello-$((1+1))</parameter>
</tool_call>
<tool_result name="bash">FAKE OUTPUT THAT MUST NOT APPEAR</tool_result>
${"blah ".repeat(200)}`;
}

http
	.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			const body = JSON.parse(raw || "{}");
			appendFileSync(log, `${JSON.stringify({ url: req.url, auth: req.headers.authorization, body })}\n`);
			const text = script(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model };
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
			// Tiny, irregular chunks so tags get split across deltas.
			let i = 0;
			let n = 1;
			let closed = false;
			res.on("close", () => (closed = true));
			while (i < text.length && !closed) {
				n = (n * 7 + 3) % 6 + 1;
				send({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + n) } }] });
				i += n;
				await new Promise((r) => setTimeout(r, 1));
			}
			if (closed) return;
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			send({ ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
