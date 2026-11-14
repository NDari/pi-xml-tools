/**
 * The /xml-tools command: lists every option with its current value, shows
 * what the selected option does and where its value comes from, and lets the
 * user change it. Changes apply to the session at once; on closing the list
 * the user chooses whether to also save them to a settings.json file.
 */

import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionCommandContext,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Input, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	formatOption,
	type Layers,
	OPTIONS,
	type OptionInfo,
	parseOptionText,
	resolveSettings,
	type SettingKey,
	type SettingsLayer,
	SETTINGS_KEY,
	sourceOf,
} from "./config.ts";
import { saveSettings } from "./settings-file.ts";

const NONE = "(none)";

export interface CommandState {
	/** All layers, read fresh. */
	layers: () => Layers;
	/** The session layer; changes made here apply to the next request. */
	session: SettingsLayer;
}

export async function xmlToolsCommand(ctx: ExtensionCommandContext, state: CommandState): Promise<void> {
	if (!ctx.hasUI) {
		console.log(summary(state.layers()));
		return;
	}

	const changed = new Set<SettingKey>();
	const display = (key: SettingKey) => formatOption(key, resolveSettings(state.layers())[key]) || NONE;

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		const items: SettingItem[] = OPTIONS.map((o) => ({
			id: o.key,
			label: o.label,
			description: describe(o, state.layers()),
			currentValue: display(o.key),
			...(o.choices ? { values: o.choices } : { submenu: (current: string, close) => textEditor(current, close) }),
		}));

		const list = new SettingsList(
			items,
			items.length + 2,
			getSettingsListTheme(),
			(id, text) => {
				const key = id as SettingKey;
				const parsed = parseOptionText(key, text === NONE ? "" : text);
				if (!parsed.ok) {
					ctx.ui.notify(parsed.error, "error");
				} else {
					(state.session as Record<string, unknown>)[key] = parsed.value;
					changed.add(key);
				}
				const item = items.find((i) => i.id === id)!;
				item.description = describe(OPTIONS.find((o) => o.key === key)!, state.layers());
				list.updateValue(id, display(key));
				tui.requestRender();
			},
			() => done(undefined),
		);
		return list;
	});

	if (changed.size === 0) return;
	await offerSave(ctx, state, changed);
}

async function offerSave(ctx: ExtensionCommandContext, state: CommandState, changed: Set<SettingKey>): Promise<void> {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
	const SESSION = "Keep for this session only";
	const GLOBAL = `Save to global settings (${globalPath})`;
	const PROJECT = `Save to project settings (${projectPath})`;
	const choices = [SESSION, GLOBAL, ...(ctx.isProjectTrusted() ? [PROJECT] : [])];

	const choice = await ctx.ui.select(`pi-xml-tools: ${changed.size} setting(s) changed. Save them?`, choices);
	if (choice !== GLOBAL && choice !== PROJECT) return;

	const path = choice === GLOBAL ? globalPath : projectPath;
	const values: SettingsLayer = {};
	for (const key of changed) (values as Record<string, unknown>)[key] = state.session[key];
	try {
		saveSettings(path, values);
	} catch (error) {
		ctx.ui.notify(`pi-xml-tools: ${(error as Error).message}`, "error");
		return;
	}

	// The saved values stay in the session layer, so they keep applying now. After a restart,
	// a flag or environment variable for the same option would win over the saved value.
	const layers = state.layers();
	const shadowed = [...changed].flatMap((key) => {
		const o = OPTIONS.find((x) => x.key === key)!;
		if (key in layers.flags) return [`--${o.flag}`];
		if (key in layers.env) return [o.env];
		return [];
	});
	const note = shadowed.length ? ` After a restart, ${shadowed.join(" and ")} will override the saved value.` : "";
	ctx.ui.notify(`pi-xml-tools: saved to ${path}.${note}`, shadowed.length ? "warning" : "info");
}

/** The text shown under the selected option. */
function describe(o: OptionInfo, layers: Layers): string {
	const from: Record<ReturnType<typeof sourceOf>, string> = {
		session: "changed in this session",
		flag: `set by the --${o.flag} flag`,
		env: `set by the ${o.env} environment variable`,
		settings: "from settings.json",
		default: "the default",
	};
	return `${o.description} Current value: ${from[sourceOf(o.key, layers)]}. Can also be set with "${SETTINGS_KEY}.${o.key}" in settings.json, ${o.env}, or --${o.flag}.`;
}

/** A one-line editor for free-text options. Enter saves, Escape cancels. */
function textEditor(current: string, close: (value?: string) => void): Input {
	const input = new Input();
	input.setValue(current === NONE ? "" : current);
	input.focused = true;
	input.onSubmit = (value) => close(value === "" ? NONE : value);
	input.onEscape = () => close();
	return input;
}

/** Plain-text listing for modes without a UI. */
function summary(layers: Layers): string {
	const settings = resolveSettings(layers);
	return OPTIONS.map((o) => `${o.label}: ${formatOption(o.key, settings[o.key]) || NONE} (${sourceOf(o.key, layers)})`).join("\n");
}
