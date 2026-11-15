/**
 * pi-xml-tools: prompt-based tool calling for OpenAI-compatible models that
 * don't support native tool calls.
 *
 * Setup: in ~/.pi/agent/models.json, set "api": "openai-xml-tools" on the
 * provider (or on individual models) that should use it. Everything else
 * (baseUrl, apiKey, models) stays as it is. This extension finds those
 * providers at startup and attaches the XML tool-calling stream to them.
 *
 * Providers can also be listed explicitly with PI_XML_TOOLS_PROVIDERS=a,b.
 *
 * Options come from settings.json ("xmlTools"), PI_XML_TOOLS_* environment
 * variables, --xml-tools-* flags and the /xml-tools command; see src/config.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { xmlToolsCommand } from "./src/command.ts";
import {
	type Layers,
	OPTIONS,
	type ParsedConfig,
	parseConfig,
	providersFromEnv,
	resolveSettings,
	SETTINGS_KEY,
	type SettingsLayer,
	settingsFromEnv,
	settingsFromFlags,
} from "./src/config.ts";
import { createXmlToolsStream } from "./src/stream.ts";

export const XML_TOOLS_API = "openai-xml-tools";

/** Provider names in models.json that use the xml-tools API at provider or model level. */
export function findXmlToolProviders(modelsJson: unknown): string[] {
	const providers = (modelsJson as { providers?: Record<string, any> })?.providers ?? {};
	return Object.entries(providers)
		.filter(
			([, p]) =>
				p?.api === XML_TOOLS_API ||
				(Array.isArray(p?.models) && p.models.some((m: any) => m?.api === XML_TOOLS_API)),
		)
		.map(([name]) => name);
}

function readModelsJson(): unknown {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	for (const o of OPTIONS) {
		const values = o.choices ? ` (${o.choices.join(", ")})` : "";
		pi.registerFlag(o.flag, { description: `${o.description}${values}`, type: "string" });
	}

	// pi.getSettings() returns what Pi loaded at startup, so settings.json edits need a restart
	// (/xml-tools changes apply at once through the session layer). It can't be called while
	// extensions load, so these only run later.
	const readConfig = (): ParsedConfig => {
		try {
			return parseConfig((pi.getSettings() as Record<string, unknown>)[SETTINGS_KEY]);
		} catch (error) {
			return { settings: {}, warnings: [`could not read settings (${(error as Error).message}).`] };
		}
	};
	const env = settingsFromEnv();
	const session: SettingsLayer = {};
	const layers = (): Layers => ({
		settings: readConfig().settings,
		env,
		flags: settingsFromFlags((name) => pi.getFlag(name)).layer,
		session,
	});

	const providers = [...new Set([...findXmlToolProviders(readModelsJson()), ...providersFromEnv()])];
	// The latest session context, so the stream can show rate-limit waits in the status bar.
	let statusUi: { setStatus(key: string, text: string | undefined): void } | undefined;
	const streamSimple = createXmlToolsStream(() => resolveSettings(layers()), {
		onStatus: (text) => statusUi?.setStatus("xml-tools", text),
	});
	for (const name of providers) {
		pi.registerProvider(name, { api: XML_TOOLS_API, streamSimple });
	}

	pi.registerCommand("xml-tools", {
		description: "View and change pi-xml-tools options",
		handler: (_args, ctx) => xmlToolsCommand(ctx, { layers, session }),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) statusUi = ctx.ui;
		// notify() is a no-op without a UI (print and JSON modes), so fall back to stderr there.
		const warn = (message: string) => (ctx.hasUI ? ctx.ui.notify(message, "warning") : console.error(message));
		const warnings = [...readConfig().warnings, ...settingsFromFlags((name) => pi.getFlag(name)).warnings];
		if (warnings.length) warn(`pi-xml-tools: ignoring invalid settings: ${warnings.join(" ")}`);
		if (providers.length === 0) {
			warn(`pi-xml-tools: no provider uses "api": "${XML_TOOLS_API}" in models.json, so XML tool calling is inactive.`);
		}
	});
}
