import type { AuthMode } from "./auth";
import {
	DEFAULT_AI_SETTINGS,
	type AiSettings,
	normalizeAiSettings,
	sanitizeAiSettings,
} from "./ai";

export interface PaperclipSettings {
	apiBaseUrl: string;
	authMode: AuthMode;
	apiKey: string;
	sessionCookie: string;
	sessionEmail: string;
	sessionUserDisplay: string;
	customAuthHeaderName: string;
	customAuthHeaderValue: string;
	defaultCompanyId: string;
	refreshIntervalSec: number;
	ai: AiSettings;
}

export const DEFAULT_SETTINGS: PaperclipSettings = {
	apiBaseUrl: "http://localhost:3100",
	authMode: "none",
	apiKey: "",
	sessionCookie: "",
	sessionEmail: "",
	sessionUserDisplay: "",
	customAuthHeaderName: "",
	customAuthHeaderValue: "",
	defaultCompanyId: "",
	refreshIntervalSec: 60,
	ai: DEFAULT_AI_SETTINGS,
};

function toRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

export function migratePaperclipSettings(loaded: unknown): PaperclipSettings {
	const record = toRecord(loaded) ?? {};
	const settings: PaperclipSettings = {
		...DEFAULT_SETTINGS,
		...record,
		ai: DEFAULT_AI_SETTINGS,
	};

	if (!("authMode" in record)) {
		settings.authMode = settings.apiKey ? "bearer" : "none";
	}

	if ("ai" in record) {
		settings.ai = normalizeAiSettings(record.ai);
	} else {
		const legacyKey =
			typeof record.openaiApiKey === "string" ? record.openaiApiKey.trim() : "";
		settings.ai = legacyKey
			? { ...DEFAULT_AI_SETTINGS, apiKey: legacyKey }
			: { ...DEFAULT_AI_SETTINGS };
	}

	return settings;
}

export function serializePaperclipSettings(
	settings: PaperclipSettings,
): PaperclipSettings {
	return {
		...settings,
		ai: sanitizeAiSettings(settings.ai),
	};
}
