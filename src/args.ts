/**
 * Converts the body of a <tool_call> block into a JSON arguments object,
 * guided by the tool's JSON Schema, and serializes arguments back into the
 * same XML form (used when replaying earlier tool calls to the model).
 *
 * Accepted body formats (most to least preferred):
 *   1. <parameter name="x">value</parameter> ...
 *   2. <x>value</x> ...            (child tags named after the parameters)
 *   3. {"x": ...}                  (a JSON object, optionally {"name":..,"arguments":{..}})
 *
 * Values are converted by schema type: strings are taken raw (no escaping),
 * numbers/booleans are parsed, arrays use <item> children or JSON, objects use
 * child tags or JSON.
 */

type Schema = Record<string, any>;
export type JsonObject = Record<string, unknown>;

export interface ParsedArguments {
	args: JsonObject;
	/** Set when the body could not be converted cleanly. */
	error?: string;
}

const PARAM_OPEN = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>/g;
const CDATA = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/;

/** Parse a tool call body against the tool's parameter schema. */
export function parseArguments(body: string, schema: Schema | undefined, partial = false): ParsedArguments {
	const params = extractParameterTags(body, partial);
	if (params.length > 0) return convertProperties(params, schema);

	const props = Object.keys(schema?.properties ?? {});
	if (props.length > 0) {
		const children = extractChildTags(body, props, partial);
		if (children.length > 0) return convertProperties(children, schema);
	}

	const trimmed = body.trim();
	if (trimmed === "") return { args: {} };
	if (trimmed.startsWith("{")) {
		try {
			let parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const inner = parsed.arguments ?? parsed.parameters ?? parsed.args;
				if (inner && typeof inner === "object" && !Array.isArray(inner) && typeof parsed.name === "string") {
					parsed = inner;
				} else if (typeof inner === "string" && typeof parsed.name === "string") {
					parsed = JSON.parse(inner);
				}
				return { args: parsed as JsonObject };
			}
		} catch (e) {
			if (partial) return { args: {} };
			return { args: {}, error: `Tool call body looked like JSON but did not parse: ${(e as Error).message}` };
		}
	}
	if (partial) return { args: {} };
	return {
		args: {},
		error: 'Could not find any <parameter name="..."> tags in the tool call.',
	};
}

/** Find a tool name in the body when the opening tag had no name attribute. */
export function findNameInBody(body: string): string | undefined {
	const tag = /<(?:name|tool_name|tool|function)>\s*([\w.:-]+)\s*<\//.exec(body);
	if (tag) return tag[1];
	const fn = /<function\s*=\s*["']?([\w.:-]+)/.exec(body);
	if (fn) return fn[1];
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed?.name === "string") return parsed.name;
		} catch {
			/* ignore */
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

interface RawProperty {
	name: string;
	raw: string;
}

/**
 * Extract <parameter name="x">...</parameter> pairs. A value ends at the LAST
 * </parameter> before the next <parameter name=...> opening, so a value that
 * itself contains the text "</parameter>" still survives.
 */
function extractParameterTags(body: string, partial: boolean): RawProperty[] {
	const opens: { name: string; start: number; contentStart: number }[] = [];
	PARAM_OPEN.lastIndex = 0;
	for (let m = PARAM_OPEN.exec(body); m; m = PARAM_OPEN.exec(body)) {
		opens.push({ name: m[1], start: m.index, contentStart: m.index + m[0].length });
	}
	const result: RawProperty[] = [];
	for (let i = 0; i < opens.length; i++) {
		const limit = i + 1 < opens.length ? opens[i + 1].start : body.length;
		const segment = body.slice(opens[i].contentStart, limit);
		const close = segment.lastIndexOf("</parameter>");
		if (close === -1) {
			if (partial) continue;
			// Unterminated final parameter: take the rest of the body.
			result.push({ name: opens[i].name, raw: segment });
			continue;
		}
		result.push({ name: opens[i].name, raw: segment.slice(0, close) });
	}
	return result;
}

/**
 * Extract <name>...</name> children for a known set of names. Like
 * extractParameterTags, a value ends at the last matching close tag before the
 * next known opening tag.
 */
function extractChildTags(body: string, names: string[], partial: boolean): RawProperty[] {
	if (names.length === 0) return [];
	const pattern = new RegExp(`<(${names.map(escapeRegExp).join("|")})\\s*>`, "g");
	const opens: { name: string; start: number; contentStart: number }[] = [];
	// Only count top-level openings: skip any opening that falls inside an
	// already-open element of the same scope.
	let searchFrom = 0;
	for (;;) {
		pattern.lastIndex = searchFrom;
		const m = pattern.exec(body);
		if (!m) break;
		const name = m[1];
		const contentStart = m.index + m[0].length;
		opens.push({ name, start: m.index, contentStart });
		// Jump past this element's matching close (first close at same depth).
		const end = findMatchingClose(body, name, contentStart);
		searchFrom = end === -1 ? body.length : end;
	}
	const result: RawProperty[] = [];
	for (let i = 0; i < opens.length; i++) {
		const { name, contentStart } = opens[i];
		const limit = i + 1 < opens.length ? opens[i + 1].start : body.length;
		const segment = body.slice(contentStart, limit);
		const close = segment.lastIndexOf(`</${name}>`);
		if (close === -1) {
			if (partial) continue;
			result.push({ name, raw: segment });
			continue;
		}
		result.push({ name, raw: segment.slice(0, close) });
	}
	return result;
}

/** Index just past the close tag matching an element opened before `from`, honoring nesting of the same tag. */
function findMatchingClose(body: string, name: string, from: number): number {
	const re = new RegExp(`<(/?)${escapeRegExp(name)}\\s*>`, "g");
	re.lastIndex = from;
	let depth = 1;
	for (let m = re.exec(body); m; m = re.exec(body)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return m.index + m[0].length;
	}
	return -1;
}

/** Split top-level <item>...</item> elements, honoring nesting. */
function extractItems(raw: string): string[] | undefined {
	const re = /<(\/?)item\s*>/g;
	const items: string[] = [];
	let depth = 0;
	let start = -1;
	for (let m = re.exec(raw); m; m = re.exec(raw)) {
		if (!m[1]) {
			if (depth === 0) start = m.index + m[0].length;
			depth++;
		} else if (depth > 0) {
			depth--;
			if (depth === 0) items.push(raw.slice(start, m.index));
		}
	}
	if (items.length === 0) return undefined;
	return items;
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function convertProperties(props: RawProperty[], schema: Schema | undefined): ParsedArguments {
	const args: JsonObject = {};
	const errors: string[] = [];
	const properties: Record<string, Schema> = schema?.properties ?? {};
	for (const { name, raw } of props) {
		const { value, error } = convertValue(raw, properties[name]);
		if (error) errors.push(`${name}: ${error}`);
		if (name in args) {
			// Repeated parameter: collect into an array.
			const prev = args[name];
			args[name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
		} else {
			args[name] = value;
		}
	}
	return errors.length ? { args, error: errors.join("; ") } : { args };
}

interface Converted {
	value: unknown;
	error?: string;
}

/** Strip one leading and one trailing newline, so block-style values come out clean. */
function trimBlock(raw: string): string {
	let s = raw;
	if (s.startsWith("\r\n")) s = s.slice(2);
	else if (s.startsWith("\n")) s = s.slice(1);
	if (s.endsWith("\r\n")) s = s.slice(0, -2);
	else if (s.endsWith("\n")) s = s.slice(0, -1);
	return s;
}

function schemaTypes(schema: Schema | undefined): string[] {
	if (!schema) return [];
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type;
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants)) return variants.flatMap((v: Schema) => schemaTypes(v));
	if (schema.enum || schema.const !== undefined) {
		const sample = schema.enum?.[0] ?? schema.const;
		return [typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string"];
	}
	if (schema.properties) return ["object"];
	if (schema.items) return ["array"];
	return [];
}

function pickVariant(schema: Schema | undefined, type: string): Schema | undefined {
	if (!schema) return undefined;
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants)) return variants.find((v: Schema) => schemaTypes(v).includes(type)) ?? schema;
	return schema;
}

export function convertValue(rawValue: string, schema: Schema | undefined): Converted {
	const cdata = CDATA.exec(rawValue);
	const raw = cdata ? cdata[1] : rawValue;
	const types = schemaTypes(schema);
	const trimmed = raw.trim();

	// Structured values first: an explicit structure wins when the schema allows it.
	if (types.includes("array")) {
		const items = extractItems(raw);
		if (items) {
			const itemSchema = pickVariant(schema, "array")?.items;
			const values: unknown[] = [];
			const errors: string[] = [];
			items.forEach((item, i) => {
				const r = convertValue(item, itemSchema);
				values.push(r.value);
				if (r.error) errors.push(`item ${i + 1}: ${r.error}`);
			});
			return errors.length ? { value: values, error: errors.join("; ") } : { value: values };
		}
		if (trimmed.startsWith("[")) {
			const parsed = tryJson(trimmed);
			if (parsed.ok) return { value: parsed.value };
			if (!types.includes("string")) return { value: trimmed, error: `invalid JSON array (${parsed.error})` };
		}
	}
	if (types.includes("object")) {
		if (trimmed.startsWith("{")) {
			const parsed = tryJson(trimmed);
			if (parsed.ok) return { value: parsed.value };
			if (!types.includes("string")) return { value: trimmed, error: `invalid JSON object (${parsed.error})` };
		}
		const objSchema = pickVariant(schema, "object");
		const names = Object.keys(objSchema?.properties ?? {});
		const children = extractChildTags(raw, names, false);
		if (children.length > 0) {
			const r = convertProperties(children, objSchema);
			return { value: r.args, error: r.error };
		}
		// Allow <parameter name=".."> inside an object, too.
		const params = extractParameterTags(raw, false);
		if (params.length > 0) {
			const r = convertProperties(params, objSchema);
			return { value: r.args, error: r.error };
		}
	}
	if (types.includes("string")) return { value: trimBlock(raw) };
	if (types.includes("integer") || types.includes("number")) {
		const n = Number(trimmed);
		if (trimmed !== "" && Number.isFinite(n)) return { value: n };
	}
	if (types.includes("boolean")) {
		if (/^true$/i.test(trimmed)) return { value: true };
		if (/^false$/i.test(trimmed)) return { value: false };
	}
	if (types.includes("null") && (trimmed === "" || trimmed === "null")) return { value: null };

	if (types.length === 0) {
		// No schema: JSON-looking values become JSON, everything else stays a string.
		if (/^(?:[[{]|-?\d|true$|false$|null$)/.test(trimmed)) {
			const parsed = tryJson(trimmed);
			if (parsed.ok) return { value: parsed.value };
		}
		return { value: trimBlock(raw) };
	}
	// Type mismatch: hand the raw text through and let Pi's validation report it to the model.
	const parsed = tryJson(trimmed);
	if (parsed.ok) return { value: parsed.value };
	return { value: trimBlock(raw) };
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Serialization (for replaying earlier calls in the conversation)
// ---------------------------------------------------------------------------

/** Render a value in the same format the model is asked to write. */
export function serializeValue(value: unknown, indent = ""): string {
	if (typeof value === "string") return value.includes("\n") ? `\n${value}\n${indent}` : value;
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
			const inner = value
				.map((v) => `${indent}<item>\n${serializeObjectChildren(v as JsonObject, indent)}${indent}</item>\n`)
				.join("");
			return `\n${inner}${indent}`;
		}
		return JSON.stringify(value);
	}
	return JSON.stringify(value);
}

function serializeObjectChildren(obj: JsonObject, indent: string): string {
	return Object.entries(obj)
		.map(([k, v]) => {
			if (typeof v === "string") {
				return v.includes("\n") ? `${indent}<${k}>\n${v}\n${indent}</${k}>\n` : `${indent}<${k}>${v}</${k}>\n`;
			}
			return `${indent}<${k}>${JSON.stringify(v)}</${k}>\n`;
		})
		.join("");
}

export function serializeToolCall(name: string, args: JsonObject): string {
	const params = Object.entries(args ?? {})
		.map(([k, v]) => `<parameter name="${k}">${serializeValue(v)}</parameter>`)
		.join("\n");
	return `<tool_call name="${name}">\n${params}${params ? "\n" : ""}</tool_call>`;
}
