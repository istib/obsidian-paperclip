import { App, TFile } from "obsidian";

export const FILE_EXT_RE = /\.(md|txt|pdf|png|jpg|jpeg|gif|csv|json|yaml|yml|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html|py|go|rs|rb|swift|vue|svelte|sh|bash|zsh|sql|toml|ini|xml|svg|canvas|c|cpp|h|hpp|java|kt|r|lua|zig|ex|exs|erl|hs|ml|tf|env|log|conf|cfg|properties)$/i;

function findVaultFile(app: App, raw: string): TFile | null {
	const cleaned = raw.trim().replace(/^\.[/\\]/, "");
	if (!cleaned) return null;

	const lower = cleaned.toLowerCase();
	const files = app.vault.getFiles();

	const exactPath = files.find((file) => file.path.toLowerCase() === lower);
	if (exactPath) return exactPath;

	const exactName = files.find((file) => file.name.toLowerCase() === lower);
	if (exactName) return exactName;

	const exactBase = files.find((file) => file.basename.toLowerCase() === lower);
	if (exactBase) return exactBase;

	const suffixPath = files.find((file) => file.path.toLowerCase().endsWith(`/${lower}`));
	if (suffixPath) return suffixPath;

	return null;
}

export function resolveVaultPath(app: App, raw: string): string | null {
	let cleaned = raw.replace(/^\.[/\\]/, "").replace(/[:@#](\d+[-–]?\d*)$/, "").trim();
	if (!cleaned) return null;

	const directMatch = findVaultFile(app, cleaned);
	if (directMatch) return directMatch.path;

	const resolved = app.metadataCache.getFirstLinkpathDest(cleaned, "");
	if (resolved) return resolved.path;

	return null;
}

export function extractReferencedVaultFiles(app: App, sources: string[]): string[] {
	const candidates = new Set<string>();

	for (const src of sources) {
		if (!src) continue;

		const backtickRe = /(?<!`)(`[^`]+`)(?!`)/g;
		let match: RegExpExecArray | null;
		while ((match = backtickRe.exec(src)) !== null) {
			candidates.add(match[1].slice(1, -1).trim());
		}

		const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		while ((match = wikiRe.exec(src)) !== null) {
			candidates.add(match[1].trim());
		}

		const words = src.split(/[\s,;(){}"'<>[\]]+/);
		for (const word of words) {
			const clean = word.replace(/^[`*_~]+|[`*_~.,:!?]+$/g, "");
			if (clean && (clean.includes("/") || FILE_EXT_RE.test(clean))) {
				candidates.add(clean);
			}
		}
	}

	const resolvedPaths = new Set<string>();
	for (const candidate of candidates) {
		const resolved = resolveVaultPath(app, candidate);
		if (resolved) resolvedPaths.add(resolved);
	}

	return [...resolvedPaths].sort();
}

function scoreFileMatch(path: string, basename: string, query: string): number {
	if (!query) return 0;

	const lowerPath = path.toLowerCase();
	const lowerBase = basename.toLowerCase();

	if (lowerPath === query || lowerBase === query) return 0;
	if (lowerPath.startsWith(query) || lowerBase.startsWith(query)) return 1;
	if (lowerPath.includes(`/${query}`)) return 2;
	if (lowerPath.includes(query) || lowerBase.includes(query)) return 3;

	return 4;
}

export function getVaultFileSuggestions(app: App, query: string, limit = 20): TFile[] {
	const normalized = query.trim().toLowerCase();
	const files = app.vault.getFiles();

	return files
		.filter((file) => {
			if (!normalized) return true;
			const path = file.path.toLowerCase();
			const base = file.basename.toLowerCase();
			const name = file.name.toLowerCase();
			return path.includes(normalized) || base.includes(normalized) || name.includes(normalized);
		})
		.sort((a, b) => {
			const scoreDiff =
				scoreFileMatch(a.path, a.basename, normalized) -
				scoreFileMatch(b.path, b.basename, normalized);
			if (scoreDiff !== 0) return scoreDiff;

			const depthDiff = a.path.split("/").length - b.path.split("/").length;
			if (depthDiff !== 0) return depthDiff;

			return a.path.localeCompare(b.path);
		})
		.slice(0, limit);
}

export function insertWikiLink(
	value: string,
	rangeStart: number,
	rangeEnd: number,
	filePath: string,
): { value: string; cursor: number } {
	const insertion = `[[${filePath}]]`;
	const nextValue = value.slice(0, rangeStart) + insertion + value.slice(rangeEnd);
	return {
		value: nextValue,
		cursor: rangeStart + insertion.length,
	};
}

export function appendContextFileLink(
	app: App,
	description: string,
	filePath: string,
): string {
	const normalizedDescription = description.trimEnd();
	if (extractReferencedVaultFiles(app, [normalizedDescription]).includes(filePath)) {
		return normalizedDescription;
	}

	const contextLine = `- [[${filePath}]]`;
	if (!normalizedDescription) {
		return `## Context\n${contextLine}`;
	}

	if (/(^|\n)## Context\s*$/m.test(normalizedDescription)) {
		return `${normalizedDescription}\n${contextLine}`;
	}

	return `${normalizedDescription}\n\n## Context\n${contextLine}`;
}
