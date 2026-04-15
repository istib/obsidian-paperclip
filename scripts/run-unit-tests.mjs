import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-tests-"));

async function loadCompiledModules() {
	await esbuild.build({
		entryPoints: {
			ai: "src/ai.ts",
			"settings-data": "src/settings-data.ts",
		},
		outdir: tempDir,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node24",
	});

	const ai = await import(pathToFileURL(path.join(tempDir, "ai.js")).href);
	const settings = await import(
		pathToFileURL(path.join(tempDir, "settings-data.js")).href
	);
	return { ai, settings };
}

const modulesPromise = loadCompiledModules();

const tests = [];

function test(name, fn) {
	tests.push({ name, fn });
}

test("migrates legacy OpenAI settings into the new AI provider config", async () => {
	const { settings } = await modulesPromise;
	const migrated = settings.migratePaperclipSettings({
		openaiApiKey: "sk-legacy",
	});

	assert.equal(migrated.ai.providerId, "openai");
	assert.equal(migrated.ai.apiKey, "sk-legacy");
	assert.equal(migrated.ai.apiBaseUrl, "https://api.openai.com/v1");
	assert.equal(migrated.ai.model, "gpt-4o-mini");

	const preserved = settings.migratePaperclipSettings({
		openaiApiKey: "sk-old",
		ai: {
			providerId: "custom_compatible",
			customName: "Local gateway",
			apiBaseUrl: "http://localhost:1234/v1",
			model: "my-model",
			apiKey: "sk-current",
			extraHeaders: [{ name: "X-Test", value: "1" }],
		},
	});

	assert.equal(preserved.ai.providerId, "custom_compatible");
	assert.equal(preserved.ai.apiKey, "sk-current");
	assert.equal(preserved.ai.customName, "Local gateway");
});

test("normalizes compatible endpoint URLs", async () => {
	const { ai } = await modulesPromise;
	assert.equal(
		ai.buildOpenAICompatibleUrl("https://example.com/v1/"),
		"https://example.com/v1/chat/completions",
	);
	assert.equal(
		ai.buildOpenAICompatibleUrl("https://example.com/v1/chat/completions"),
		"https://example.com/v1/chat/completions",
	);
});

test("merges extra headers case-insensitively on top of bearer auth", async () => {
	const { ai } = await modulesPromise;
	const headers = ai.buildOpenAICompatibleHeaders({
		providerId: "custom_compatible",
		customName: "Gateway",
		apiBaseUrl: "http://localhost:4000/v1",
		model: "test-model",
		apiKey: "sk-test",
		extraHeaders: [
			{ name: "X-Api-Version", value: "2026-04-15" },
			{ name: "authorization", value: "Bearer override" },
		],
	});

	assert.equal(headers["Content-Type"], "application/json");
	assert.equal(headers.authorization, "Bearer override");
	assert.equal(headers["X-Api-Version"], "2026-04-15");
	assert.ok(!("Authorization" in headers));
});

test("parses compatible responses and extracts nested error messages", async () => {
	const { ai } = await modulesPromise;
	const parsed = ai.parseOpenAICompatibleSuggestion({
		choices: [
			{
				message: {
					content:
						"```json\n{\"title\":\"Test\",\"description\":\"Desc\",\"priority\":\"high\",\"assignee\":\"Ada\",\"project\":\"Core\"}\n```",
				},
			},
		],
	});

	assert.deepEqual(parsed, {
		title: "Test",
		description: "Desc",
		priority: "high",
		assignee: "Ada",
		project: "Core",
	});
	assert.equal(
		ai.extractAiErrorMessage({ error: { message: "Bad gateway" } }, 502),
		"Bad gateway",
	);
});

let passed = 0;

try {
	for (const { name, fn } of tests) {
		await fn();
		passed += 1;
		console.log(`ok - ${name}`);
	}
	console.log(`\n${passed} tests passed`);
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
