## [0.2.0]

- Changed: Pi's system prompt and the tool instructions are now sent at the start of the first user message, inside `<instructions>` tags, instead of as a system message. Some gateways (GenAI's Gemini endpoint among them) drop, override or reject client system messages. Set `instructionsIn` to `system` (in `/xml-tools`, `settings.json`, `--xml-tools-instructions-in` or `PI_XML_TOOLS_INSTRUCTIONS_IN`) for the old behavior.
- Added: calls written as a markdown code block tagged `tool_call` are parsed, both ```` ```tool_call name="x"> ```` and ```` ```tool_call ```` followed by `<tool name="x">`, as well as a JSON body inside the fence. Gemma 3 writes calls this way.
- Added: `PI_XML_TOOLS_DECODE_ENTITIES` decodes `&lt; &gt; &amp; &quot; &apos;` in string values, for models that XML-escape them. `auto` decodes only values that look fully escaped; `1` always decodes. Off by default.
- Added: a `/xml-tools` command that lists every option with its current value, what it does and where the value comes from. Changes apply to the next request and can be saved to the global or project `settings.json`.
- Added: options can be set in Pi's `settings.json` under `xmlTools`, and with `--xml-tools-*` flags for one run. Environment variables still work. Precedence, highest first: `/xml-tools` changes, flags, environment variables, `settings.json`. Invalid values are reported in a warning when the session starts.
- Added: `PI_XML_TOOLS_DEBUG=<path>` (or `debugLog`, or `--xml-tools-debug <path>`) appends one JSON line per request with the payload sent, the raw response text and the parsed tool calls.
- Removed: `PI_XML_TOOLS_EXTRA_STOP`. None of the models tested needed extra stop sequences. The server-side `stop: ["<tool_result"]` (`stopSequences`) is unchanged.
- Changed: the tool list in the prompt uses `### name` headings instead of `<tool name="...">` tags, which models copied into their calls. The prompt also says explicitly not to wrap calls in code fences or XML-escape values.

## [0.1.0]

- Initial version: XML prompt-based tool calling for OpenAI-compatible models without native tool support.
