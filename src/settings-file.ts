/**
 * Saves options into a Pi settings.json file under "xmlTools". Pi has no API
 * for extensions to write settings, so this edits the file directly: it reads
 * the file again right before writing (to keep anything Pi or the user changed
 * meanwhile), merges only the given keys, and replaces the file atomically
 * (temp file + rename). A file that isn't valid JSON is left untouched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SETTINGS_KEY, type SettingsLayer, toSettingsJson } from "./config.ts";

export function saveSettings(path: string, values: SettingsLayer): void {
	let root: Record<string, unknown> = {};
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		if (text.trim() !== "") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch (e) {
				throw new Error(`${path} is not valid JSON, so it was not changed (${(e as Error).message}).`);
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error(`${path} does not contain a JSON object, so it was not changed.`);
			}
			root = parsed as Record<string, unknown>;
		}
	}
	const current = root[SETTINGS_KEY];
	const existing = typeof current === "object" && current !== null && !Array.isArray(current) ? current : {};
	root[SETTINGS_KEY] = { ...existing, ...toSettingsJson(values) };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
