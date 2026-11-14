/**
 * Options, and the layers they come from (highest precedence first):
 *   1. this session    changed with the /xml-tools command
 *   2. CLI flags        --xml-tools-<option> <value>
 *   3. environment      PI_XML_TOOLS_*
 *   4. settings.json    "xmlTools": { ... }
 *   5. built-in defaults
 *
 * settings.json is Pi's own file: ~/.pi/agent/settings.json, merged with the
 * project's .pi/settings.json (only when the project is trusted). Pi loads it at
 * startup, so edits to the file need a restart; /xml-tools applies changes
 * immediately and can also save them.
 *
 * Which providers to attach to is not an option here: Pi's settings can't be
 * read while extensions load, which is when providers are registered.
 *
 * No Pi imports, so this file can be unit tested on its own.
 */

import { homedir } from "node:os";

export type DecodeEntities = boolean | "auto";
export type InstructionsIn = "user" | "system";

export interface XmlToolsSettings {
	/** Where the system prompt (Pi's prompt plus the tool instructions) goes. */
	instructionsIn: InstructionsIn;
	/** Decode XML entities (&amp; etc.) in string values, for models that escape them. See ParseOptions in args.ts. */
	decodeEntities: DecodeEntities;
	/** Add `stop: ["<tool_result"]` to requests so the server stops the model before it invents a result. */
	stopSequences: boolean;
	/** If set, append one JSON line per request to this file: the payload sent, the raw response text, and the parsed calls. */
	debugLog?: string;
}

export type SettingKey = keyof XmlToolsSettings;
/** One layer of settings; unset fields fall through to the layer below. */
export type SettingsLayer = Partial<XmlToolsSettings>;

export const DEFAULT_SETTINGS: XmlToolsSettings = {
	instructionsIn: "user",
	decodeEntities: false,
	stopSequences: true,
	debugLog: undefined,
};

/** The settings.json key this extension reads. */
export const SETTINGS_KEY = "xmlTools";

export interface OptionInfo {
	key: SettingKey;
	/** Short name for the /xml-tools list. */
	label: string;
	/** What the option does. Shown in /xml-tools when the option is selected, and in --help. */
	description: string;
	env: string;
	flag: string;
	/** Fixed values, as text. Options without them take free text. */
	choices?: string[];
}

/** Every option, in the order /xml-tools shows them. */
export const OPTIONS: OptionInfo[] = [
	{
		key: "instructionsIn",
		label: "Instructions in",
		description:
			"Where Pi's system prompt and the tool instructions are sent. user: at the start of the first user message, which works with gateways that drop, override or reject system messages. system: as a normal system message.",
		env: "PI_XML_TOOLS_INSTRUCTIONS_IN",
		flag: "xml-tools-instructions-in",
		choices: ["user", "system"],
	},
	{
		key: "decodeEntities",
		label: "Decode XML entities",
		description:
			"Turns &lt; &gt; &amp; &quot; &apos; in tool arguments back into < > & \" ', for models that XML-escape values (Gemma 3 does). auto: only values that contain entities and no raw < > or &, so real HTML is left alone. true: always, which also changes values that really contain entities. false: never.",
		env: "PI_XML_TOOLS_DECODE_ENTITIES",
		flag: "xml-tools-decode-entities",
		choices: ["false", "auto", "true"],
	},
	{
		key: "stopSequences",
		label: "Stop sequences",
		description:
			'Sends stop: ["<tool_result"] so the server stops the model before it writes a made-up tool result. Turn off if your gateway rejects the stop field; the extension also cuts made-up results off itself.',
		env: "PI_XML_TOOLS_STOP",
		flag: "xml-tools-stop",
		choices: ["true", "false"],
	},
	{
		key: "debugLog",
		label: "Debug log file",
		description:
			"Appends one JSON line per request to this file: the payload sent, the raw response text and the parsed tool calls. It contains the whole conversation. Empty to turn it off.",
		env: "PI_XML_TOOLS_DEBUG",
		flag: "xml-tools-debug",
	},
];

export function optionInfo(key: SettingKey): OptionInfo {
	return OPTIONS.find((o) => o.key === key)!;
}

// ---------------------------------------------------------------------------
// Text form, used by flags and /xml-tools
// ---------------------------------------------------------------------------

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;

export type ParsedValue = { ok: true; value: XmlToolsSettings[SettingKey] } | { ok: false; error: string };

/** Parse an option's text form (as typed in a flag or /xml-tools). Strict: unknown values are errors. */
export function parseOptionText(key: SettingKey, text: string): ParsedValue {
	const t = text.trim();
	const bad = (): ParsedValue => ({
		ok: false,
		error: `${optionInfo(key).label}: "${text}" is not valid. Use ${optionInfo(key).choices?.join(", ")}.`,
	});
	switch (key) {
		case "instructionsIn":
			return /^(user|system)$/i.test(t) ? { ok: true, value: t.toLowerCase() as InstructionsIn } : bad();
		case "decodeEntities":
			if (/^auto$/i.test(t)) return { ok: true, value: "auto" };
			if (ON.test(t)) return { ok: true, value: true };
			if (OFF.test(t)) return { ok: true, value: false };
			return bad();
		case "stopSequences":
			if (ON.test(t)) return { ok: true, value: true };
			if (OFF.test(t)) return { ok: true, value: false };
			return bad();
		case "debugLog":
			return { ok: true, value: t === "" ? undefined : expandHome(t) };
	}
}

/** The text form of a value; the inverse of parseOptionText. Empty means "none". */
export function formatOption(key: SettingKey, value: XmlToolsSettings[SettingKey]): string {
	if (value === undefined) return "";
	return String(value);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface Layers {
	settings: SettingsLayer;
	env: SettingsLayer;
	flags: SettingsLayer;
	session: SettingsLayer;
}

export type Source = "session" | "flag" | "env" | "settings" | "default";

export function resolveSettings(layers: Layers): XmlToolsSettings {
	return { ...DEFAULT_SETTINGS, ...layers.settings, ...layers.env, ...layers.flags, ...layers.session };
}

/** Which layer an option's effective value comes from. */
export function sourceOf(key: SettingKey, layers: Layers): Source {
	if (key in layers.session) return "session";
	if (key in layers.flags) return "flag";
	if (key in layers.env) return "env";
	if (key in layers.settings) return "settings";
	return "default";
}

/** Read the PI_XML_TOOLS_* variables. Unset variables are left out so lower layers apply. Lenient, as before. */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): SettingsLayer {
	const out: SettingsLayer = {};
	const get = (name: string) => {
		const v = env[name]?.trim();
		return v === undefined || v === "" ? undefined : v;
	};
	const stop = get("PI_XML_TOOLS_STOP");
	if (stop !== undefined) out.stopSequences = !OFF.test(stop);
	const decode = get("PI_XML_TOOLS_DECODE_ENTITIES");
	if (decode !== undefined) out.decodeEntities = /^auto$/i.test(decode) ? "auto" : ON.test(decode);
	const where = get("PI_XML_TOOLS_INSTRUCTIONS_IN");
	if (where !== undefined) out.instructionsIn = /^system$/i.test(where) ? "system" : "user";
	const debug = get("PI_XML_TOOLS_DEBUG");
	if (debug !== undefined) out.debugLog = expandHome(debug);
	return out;
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	return splitList(env.PI_XML_TOOLS_PROVIDERS ?? "", ",");
}

/** Build the flag layer. `getFlag` returns undefined (or "") for flags that weren't given. */
export function settingsFromFlags(getFlag: (name: string) => unknown): { layer: SettingsLayer; warnings: string[] } {
	const layer: SettingsLayer = {};
	const warnings: string[] = [];
	for (const o of OPTIONS) {
		const raw = getFlag(o.flag);
		if (typeof raw !== "string" || raw === "") continue;
		const parsed = parseOptionText(o.key, raw);
		if (parsed.ok) (layer as Record<string, unknown>)[o.key] = parsed.value;
		else warnings.push(`--${o.flag}: ${parsed.error}`);
	}
	return { layer, warnings };
}

export interface ParsedConfig {
	settings: SettingsLayer;
	/** Problems found, worded for the user. */
	warnings: string[];
}

/** Parse the `xmlTools` object from settings.json. Invalid values are skipped with a warning. */
export function parseConfig(raw: unknown): ParsedConfig {
	const result: ParsedConfig = { settings: {}, warnings: [] };
	if (raw === undefined || raw === null) return result;
	if (!isObject(raw)) {
		result.warnings.push(`"${SETTINGS_KEY}" in settings.json must be an object.`);
		return result;
	}
	const out = result.settings;
	for (const [key, value] of Object.entries(raw)) {
		const warn = (msg: string) => result.warnings.push(`${SETTINGS_KEY}.${key} ${msg}`);
		switch (key) {
			case "instructionsIn":
				if (value === "user" || value === "system") out.instructionsIn = value;
				else warn('must be "user" or "system".');
				break;
			case "decodeEntities":
				if (typeof value === "boolean" || value === "auto") out.decodeEntities = value;
				else warn('must be true, false or "auto".');
				break;
			case "stopSequences":
				if (typeof value === "boolean") out.stopSequences = value;
				else warn("must be true or false.");
				break;
			case "debugLog":
				if (value === null || value === "") out.debugLog = undefined;
				else if (typeof value === "string") out.debugLog = expandHome(value);
				else warn("must be a file path or null.");
				break;
			default:
				warn("is not a known setting.");
		}
	}
	return result;
}

/** The settings.json form of a layer (undefined becomes null, so "off" is saved explicitly). */
export function toSettingsJson(layer: SettingsLayer): Record<string, unknown> {
	return Object.fromEntries(Object.entries(layer).map(([k, v]) => [k, v === undefined ? null : v]));
}

// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function splitList(s: string, sep: string): string[] {
	return s
		.split(sep)
		.map((x) => x.trim())
		.filter(Boolean);
}

function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}
