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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createXmlToolsStream, settingsFromEnv } from "./src/stream.ts";

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
	const fromEnv = (process.env.PI_XML_TOOLS_PROVIDERS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const providers = [...new Set([...findXmlToolProviders(readModelsJson()), ...fromEnv])];
	const streamSimple = createXmlToolsStream(settingsFromEnv());

	for (const name of providers) {
		pi.registerProvider(name, { api: XML_TOOLS_API, streamSimple });
	}

	if (providers.length === 0) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`pi-xml-tools: no provider uses "api": "${XML_TOOLS_API}" in models.json, so XML tool calling is inactive.`,
				"warning",
			);
		});
	}
}
