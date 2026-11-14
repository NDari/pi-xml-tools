import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveSettings } from "../src/settings-file.ts";

function withDir(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pi-xml-tools-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("merges into an existing settings.json and keeps everything else", () => {
	withDir((dir) => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "gruvbox-dark", packages: ["npm:x"], xmlTools: { stopSequences: false } }));
		saveSettings(path, { decodeEntities: "auto", debugLog: undefined });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			theme: "gruvbox-dark",
			packages: ["npm:x"],
			xmlTools: { stopSequences: false, decodeEntities: "auto", debugLog: null },
		});
		assert.deepEqual(readdirSync(dir), ["settings.json"], "no temp file left behind");
	});
});

test("creates the file and its directory when missing", () => {
	withDir((dir) => {
		const path = join(dir, ".pi", "settings.json");
		saveSettings(path, { instructionsIn: "system" });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { xmlTools: { instructionsIn: "system" } });
	});
});

test("leaves an invalid file untouched", () => {
	withDir((dir) => {
		const path = join(dir, "settings.json");
		writeFileSync(path, "{ not json");
		assert.throws(() => saveSettings(path, { decodeEntities: true }), /not valid JSON, so it was not changed/);
		assert.equal(readFileSync(path, "utf8"), "{ not json");
		writeFileSync(path, "[1, 2]");
		assert.throws(() => saveSettings(path, { decodeEntities: true }), /does not contain a JSON object/);
	});
});
