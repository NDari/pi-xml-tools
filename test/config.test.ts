import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
	DEFAULT_SETTINGS,
	formatOption,
	type Layers,
	OPTIONS,
	parseConfig,
	parseOptionText,
	providersFromEnv,
	resolveSettings,
	settingsFromEnv,
	settingsFromFlags,
	sourceOf,
} from "../src/config.ts";

const none = (): Layers => ({ settings: {}, env: {}, flags: {}, session: {} });

test("defaults apply when nothing is configured", () => {
	assert.deepEqual(resolveSettings(none()), DEFAULT_SETTINGS);
	for (const o of OPTIONS) assert.equal(sourceOf(o.key, none()), "default");
});

test("precedence: session > flags > env > settings > defaults", () => {
	const layers: Layers = {
		settings: { debugLog: "/settings.jsonl", decodeEntities: true, instructionsIn: "system" },
		env: { debugLog: "/env.jsonl", decodeEntities: "auto" },
		flags: { debugLog: "/flag.jsonl" },
		session: {},
	};
	let r = resolveSettings(layers);
	assert.equal(r.debugLog, "/flag.jsonl");
	assert.equal(r.decodeEntities, "auto");
	assert.equal(r.instructionsIn, "system");
	assert.equal(sourceOf("debugLog", layers), "flag");
	assert.equal(sourceOf("decodeEntities", layers), "env");
	assert.equal(sourceOf("instructionsIn", layers), "settings");
	// A session change wins over everything, including turning a value off.
	layers.session.debugLog = undefined;
	r = resolveSettings(layers);
	assert.equal(r.debugLog, undefined);
	assert.equal(sourceOf("debugLog", layers), "session");
});

test("settings.json values, and per-model entries are no longer accepted", () => {
	const config = parseConfig({
		instructionsIn: "system",
		decodeEntities: "auto",
		stopSequences: false,
		debugLog: "~/logs/xml.jsonl",
	});
	assert.deepEqual(config.warnings, []);
	assert.deepEqual(config.settings, {
		instructionsIn: "system",
		decodeEntities: "auto",
		stopSequences: false,
		debugLog: `${homedir()}/logs/xml.jsonl`,
	});
	assert.deepEqual(parseConfig({ debugLog: null }).settings, { debugLog: undefined });
	assert.deepEqual(parseConfig({ models: {} }).warnings, ["xmlTools.models is not a known setting."]);
	assert.deepEqual(parseConfig({ extraStop: ["x"] }).warnings, ["xmlTools.extraStop is not a known setting."]);
});

test("invalid settings.json values are skipped with a warning", () => {
	const config = parseConfig({ decodeEntities: "sometimes", instructionsIn: "assistant", stopSequences: "no", colour: "blue" });
	assert.deepEqual(config.settings, {});
	assert.equal(config.warnings.length, 4, config.warnings.join("\n"));
	assert.ok(config.warnings.includes('xmlTools.decodeEntities must be true, false or "auto".'));
	assert.deepEqual(parseConfig("auto").warnings, ['"xmlTools" in settings.json must be an object.']);
});

test("environment variables keep their existing meaning", () => {
	assert.deepEqual(settingsFromEnv({}), {});
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_STOP: "0" }).stopSequences, false);
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_STOP: "1" }).stopSequences, true);
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_DECODE_ENTITIES: "AUTO" }).decodeEntities, "auto");
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_DECODE_ENTITIES: "yes" }).decodeEntities, true);
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_INSTRUCTIONS_IN: "System" }).instructionsIn, "system");
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_DEBUG: " " }).debugLog, undefined);
	assert.equal(settingsFromEnv({ PI_XML_TOOLS_DEBUG: "~/x.jsonl" }).debugLog, `${homedir()}/x.jsonl`);
	assert.deepEqual(providersFromEnv({ PI_XML_TOOLS_PROVIDERS: "a, b,," }), ["a", "b"]);
});

test("option text form: strict parsing and round trip", () => {
	assert.deepEqual(parseOptionText("decodeEntities", "Auto"), { ok: true, value: "auto" });
	assert.deepEqual(parseOptionText("decodeEntities", "off"), { ok: true, value: false });
	assert.deepEqual(parseOptionText("stopSequences", "no"), { ok: true, value: false });
	assert.deepEqual(parseOptionText("instructionsIn", "SYSTEM"), { ok: true, value: "system" });
	assert.deepEqual(parseOptionText("debugLog", "  "), { ok: true, value: undefined });
	const bad = parseOptionText("instructionsIn", "assistant");
	assert.equal(bad.ok, false);
	assert.ok(!bad.ok && bad.error.includes("Use user, system."));
	assert.equal(parseOptionText("decodeEntities", "sometimes").ok, false);
	// Every choice parses and formats back to itself.
	for (const o of OPTIONS) {
		for (const choice of o.choices ?? []) {
			const p = parseOptionText(o.key, choice);
			assert.ok(p.ok);
			assert.equal(formatOption(o.key, p.value), choice);
		}
	}
	assert.equal(formatOption("debugLog", undefined), "");
});

test("flags are parsed strictly and report bad values", () => {
	const given: Record<string, string> = {
		"xml-tools-decode-entities": "auto",
		"xml-tools-stop": "maybe",
		"xml-tools-debug": "",
	};
	const { layer, warnings } = settingsFromFlags((name) => given[name]);
	assert.deepEqual(layer, { decodeEntities: "auto" });
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].startsWith("--xml-tools-stop: "));
});

test("every option has a description, an env var and a flag", () => {
	for (const o of OPTIONS) {
		assert.ok(o.description.length > 20, o.key);
		assert.ok(o.env.startsWith("PI_XML_TOOLS_"), o.key);
		assert.ok(o.flag.startsWith("xml-tools-"), o.key);
	}
	assert.deepEqual(OPTIONS.map((o) => o.key).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});
