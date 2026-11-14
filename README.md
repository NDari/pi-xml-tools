# pi-xml-tools

A Pi extension that gives tool calling to OpenAI-compatible models that don't support native tool calls.

The model is told about Pi's tools in its system prompt and calls them by writing XML blocks. The extension parses those blocks out of the streaming response, and Pi runs the tools exactly as it would for a model with native tool support. Earlier tool calls and their results are replayed to the model in the same XML form.

```
<tool_call name="edit">
<parameter name="path">src/app.ts</parameter>
<parameter name="edits">
<item>
<oldText>const x = 1;</oldText>
<newText>const x = 2;</newText>
</item>
</parameter>
</tool_call>
```

String values are written raw, with no JSON escaping. Models get code edits wrong much less often this way than when the code has to be embedded in a JSON string.

## Requirements

- Pi 1.5.x, the `@earendil-works/pi-coding-agent` packages. Built and tested against 1.5.2. Run `pi --version` to check yours.
- There are no runtime dependencies, so nothing needs to be downloaded from npm when you install it.

## Install

From your internal git host:

```bash
pi install git:your-git-host/your-org/pi-xml-tools
```

From a local checkout:

```bash
pi install ./pi-xml-tools
```

To try it for one session without installing:

```bash
pi -e ./pi-xml-tools
```

## Configure

In `~/.pi/agent/models.json`, change the `api` of the provider you already have set up from `openai-completions` to `openai-xml-tools`. Leave everything else as it is (baseUrl, apiKey, models):

```json
{
  "providers": {
    "genai": {
      "baseUrl": "https://your-genai-endpoint/v1",
      "apiKey": "$GENAI_API_KEY",
      "api": "openai-xml-tools",
      "models": [
        {
          "id": "gemini-4-argon",
          "name": "Gemini 4 Argon",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

You can also set `"api": "openai-xml-tools"` on individual models instead of on the whole provider. When the extension starts, it finds every provider that uses this API and attaches itself to them. If it finds none, it shows a warning when the session starts.

### Options

The easiest way to see and change options is the `/xml-tools` command inside Pi. It lists every option with its current value. The selected option shows what it does and where its current value comes from. Enter changes it: options with fixed values cycle through them, and text options open an input. Changes apply to the next request. When you close the list, you can keep the changes for this session only, or save them to your global or project `settings.json`.

Options can also be set in three other places, highest precedence first:

1. **Flags** for one run, for example `pi --xml-tools-decode-entities auto`.
2. **Environment variables**, for example `PI_XML_TOOLS_DECODE_ENTITIES=auto`.
3. **`settings.json`**, under an `xmlTools` key: `~/.pi/agent/settings.json` for all projects, or a project's `.pi/settings.json`, which Pi merges in only when the project is trusted. Pi loads this file when it starts, so restart Pi after editing it by hand.

Changes made with `/xml-tools` take precedence over all three for the rest of the session. After a restart, a flag or environment variable for the same option wins over a value saved to `settings.json`, and `/xml-tools` warns about that when you save. Invalid values are skipped and reported in a warning when the session starts.

```json
{
  "xmlTools": {
    "instructionsIn": "user",
    "decodeEntities": "auto"
  }
}
```

| Setting | Flag | Environment variable | Default | Effect |
|---|---|---|---|---|
| `instructionsIn` | `--xml-tools-instructions-in` | `PI_XML_TOOLS_INSTRUCTIONS_IN` | `"user"` | Where Pi's system prompt and the tool instructions go. `"user"` puts them at the start of the first user message, inside `<instructions>` tags, and sends no system message, because some gateways drop, override or reject client system messages (GenAI's Gemini endpoint does). `"system"` sends them as a normal system message. |
| `decodeEntities` | `--xml-tools-decode-entities` | `PI_XML_TOOLS_DECODE_ENTITIES` | `false` | Decodes `&lt; &gt; &amp; &quot; &apos;` in string values, for models that XML-escape them even when told not to (Gemma 3 does). `"auto"` (recommended for such models) decodes a value only when it has entities and no raw `<`, `>` or `&`, so code and HTML with real markup are left alone. `true` always decodes, which also changes values that really contain those entities. Values in `<![CDATA[...]]>` are never decoded. |
| `stopSequences` | `--xml-tools-stop` | `PI_XML_TOOLS_STOP` | `true` | Sends `stop: ["<tool_result"]` with each request so the server stops the model before it writes a made-up tool result. Set to `false` if your gateway rejects the `stop` field. The extension also cuts made-up results off on its side, so it still works without this. |
| `debugLog` | `--xml-tools-debug` | `PI_XML_TOOLS_DEBUG` | none | Path to a file (a leading `~/` is expanded; `null` or empty turns it off). One JSON line is appended per request with the exact payload sent, the raw response text (including any opening tags and anything after a halt), and the parsed tool calls with their errors. The payload holds the whole conversation, so the file can get large and contains whatever was in your session. Auth headers are not included. |
| none | none | `PI_XML_TOOLS_PROVIDERS` | none | Comma-separated provider names to attach to, in addition to those found in models.json. This can't be a setting, because Pi's settings can't be read yet when providers are registered. |

Flags and `/xml-tools` take the text forms shown in the list (`user`/`system`, `false`/`auto`/`true`, `true`/`false`). Environment variables also accept `1`/`0`, `yes`/`no` and `on`/`off`.

## How it works

1. **Request.** Pi's tool definitions are rendered into the system prompt (see `src/prompt.ts`), which by default is sent at the start of the first user message rather than as a system message (see `instructionsIn` under Options). Earlier tool calls become `<tool_call>` text in the assistant turns, and tool results become `<tool_result>` blocks in user turns. Consecutive user messages are merged into one. The request then goes through Pi's built-in OpenAI Chat Completions client, so auth, retries, usage, cost and cancellation behave the same as with any other provider. No `tools` field is sent.
2. **Response.** Text is streamed to Pi as it arrives (`src/parser.ts`). A partly written tag is held back until the extension can tell whether it's a tag, so tags never flash up as text. Each `<tool_call>` block becomes a real Pi tool call, with its arguments converted to the right types using the tool's JSON Schema (`src/args.ts`).
3. **Made-up results.** If the model starts writing `<tool_result` itself, the extension stops the request and discards the rest of the text.
4. **Malformed calls.** If a call can't be parsed, Pi sends an error result back to the model that shows what it wrote and what was wrong, so the model can try again.

The parser also accepts a few formats models tend to fall back to: `<path>...</path>` child tags, a JSON object body, `{"name": ..., "arguments": {...}}`, and `<![CDATA[...]]>` values. It also accepts a call written as a markdown code block tagged `tool_call` (```` ```tool_call name="edit"> ```` or ```` ```tool_call ```` followed by `<tool name="edit">`), which Gemma 3 does often.

## Tuning for your model

All of the wording the model sees is in `src/prompt.ts`, in `renderToolInstructions()`. If the model keeps making the same mistake, start there. If you change the tag names, change them in `src/parser.ts` and `src/args.ts` as well.

## Testing

```bash
npm test   # unit tests: parser with randomized chunk splits, argument conversion, round-trips
```

`test/mock-server.mjs` is a fake OpenAI-compatible streaming server that returns scripted text only, like a model without tool support. Use it to check the whole loop on a machine without API access:

```bash
node test/mock-server.mjs 8765 /path/to/scratch/app.ts /tmp/requests.jsonl &
# Point a models.json provider at http://127.0.0.1:8765/v1 with "api": "openai-xml-tools", then:
pi -e ./pi-xml-tools --no-session --model genai/gemini-4-argon -p "Run the check, then update the greeting." < /dev/null
```

The scratch file must contain `const greeting = "hello";`. Each request is logged to the `.jsonl` file so you can see exactly what was sent.

## Known limitations

- A value that contains the literal text `</tool_call>`, for example when the model edits this extension's own source, ends the call early. In the same way, `<item>` or a field tag such as `</oldText>` inside an edit's text can confuse the item parser. In those cases the model can write the value as JSON or wrap it in CDATA.
- Thinking blocks are not replayed to the model on later turns.
- The tool descriptions are added to every request, which costs input tokens. Prompt-based tool calling always has this cost.
