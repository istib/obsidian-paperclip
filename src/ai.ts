export type AiProviderId =
	| "openai"
	| "compatible_gateway"
	| "custom_compatible";

export interface AiExtraHeader {
	name: string;
	value: string;
}

export interface AiSettings {
	providerId: AiProviderId;
	customName: string;
	apiBaseUrl: string;
	model: string;
	apiKey: string;
	extraHeaders: AiExtraHeader[];
}

export interface IssueDraftSuggestion {
	title: string;
	description: string;
	priority: string;
	assignee: string | null;
	project: string | null;
}

export interface IssueDraftAgentSummary {
	name: string;
	role: string;
	capabilities: string | null;
}

export interface IssueDraftProjectSummary {
	name: string;
}

export interface IssueDraftRequest {
	intent: "work" | "review" | "auto";
	selection: string;
	filePath: string;
	fileContent: string;
	agents: IssueDraftAgentSummary[];
	projects: IssueDraftProjectSummary[];
}

export interface RequestLikeParams {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	throw?: boolean;
}

export interface RequestLikeResponse {
	status: number;
	json: unknown;
}

export type RequestLike = (
	params: RequestLikeParams,
) => Promise<RequestLikeResponse>;

export interface AiBackend {
	suggestIssue(
		settings: AiSettings,
		request: IssueDraftRequest,
	): Promise<IssueDraftSuggestion>;
	testConnection(settings: AiSettings): Promise<void>;
}

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
	openai: "OpenAI",
	compatible_gateway: "Compatible gateway",
	custom_compatible: "Custom compatible",
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export const DEFAULT_AI_SETTINGS: AiSettings = {
	providerId: "openai",
	customName: "",
	apiBaseUrl: OPENAI_BASE_URL,
	model: DEFAULT_MODEL,
	apiKey: "",
	extraHeaders: [],
};

function normalizePriority(value: unknown): string {
	if (typeof value !== "string") return "medium";
	const normalized = value.trim().toLowerCase();
	return ["critical", "high", "medium", "low"].includes(normalized)
		? normalized
		: "medium";
}

function normalizeProviderId(value: unknown): AiProviderId {
	if (
		value === "openai" ||
		value === "compatible_gateway" ||
		value === "custom_compatible"
	) {
		return value;
	}
	return DEFAULT_AI_SETTINGS.providerId;
}

function toRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function normalizeHeaderValue(value: unknown): AiExtraHeader | null {
	const record = toRecord(value);
	if (!record) return null;
	const name =
		typeof record.name === "string" ? record.name.trim() : "";
	const headerValue =
		typeof record.value === "string" ? record.value : "";
	if (!name || !headerValue) return null;
	return { name, value: headerValue };
}

function setHeader(
	headers: Record<string, string>,
	name: string,
	value: string,
): void {
	const normalizedName = name.trim();
	if (!normalizedName) return;
	const existing = Object.keys(headers).find(
		(key) => key.toLowerCase() === normalizedName.toLowerCase(),
	);
	if (existing) delete headers[existing];
	headers[normalizedName] = value;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			const record = toRecord(part);
			if (!record) return "";
			return typeof record.text === "string" ? record.text : "";
		})
		.join("");
}

function stripJsonFence(value: string): string {
	const trimmed = value.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced ? fenced[1].trim() : trimmed;
}

function buildReviewPath(filePath: string): string {
	const dotIdx = filePath.lastIndexOf(".");
	return dotIdx > 0
		? `${filePath.slice(0, dotIdx)} - Review${filePath.slice(dotIdx)}`
		: `${filePath} - Review`;
}

export function sanitizeAiSettings(settings: AiSettings): AiSettings {
	return {
		providerId: normalizeProviderId(settings.providerId),
		customName: settings.customName.trim(),
		apiBaseUrl: settings.apiBaseUrl.trim(),
		model: settings.model.trim(),
		apiKey: settings.apiKey.trim(),
		extraHeaders: Array.isArray(settings.extraHeaders)
			? settings.extraHeaders
					.map(normalizeHeaderValue)
					.filter((value): value is AiExtraHeader => value !== null)
			: [],
	};
}

export function normalizeAiSettings(value: unknown): AiSettings {
	const record = toRecord(value);
	if (!record) return { ...DEFAULT_AI_SETTINGS };
	const providerId = normalizeProviderId(record.providerId);
	const defaults = applyAiProviderPreset(DEFAULT_AI_SETTINGS, providerId);
	return sanitizeAiSettings({
		providerId,
		customName:
			typeof record.customName === "string"
				? record.customName
				: defaults.customName,
		apiBaseUrl:
			typeof record.apiBaseUrl === "string"
				? record.apiBaseUrl
				: defaults.apiBaseUrl,
		model:
			typeof record.model === "string" ? record.model : defaults.model,
		apiKey:
			typeof record.apiKey === "string" ? record.apiKey : defaults.apiKey,
		extraHeaders: Array.isArray(record.extraHeaders)
			? record.extraHeaders
					.map(normalizeHeaderValue)
					.filter((item): item is AiExtraHeader => item !== null)
			: defaults.extraHeaders,
	});
}

export function applyAiProviderPreset(
	current: AiSettings,
	providerId: AiProviderId,
): AiSettings {
	const preservedKey = current.apiKey;
	const preservedHeaders = Array.isArray(current.extraHeaders)
		? current.extraHeaders
		: [];
	if (providerId === "openai") {
		return {
			providerId,
			customName: "",
			apiBaseUrl: OPENAI_BASE_URL,
			model: DEFAULT_MODEL,
			apiKey: preservedKey,
			extraHeaders: preservedHeaders,
		};
	}
	if (providerId === "compatible_gateway") {
		return {
			providerId,
			customName: current.customName || "Compatible gateway",
			apiBaseUrl: current.apiBaseUrl || "http://localhost:4000/v1",
			model: current.model || DEFAULT_MODEL,
			apiKey: preservedKey,
			extraHeaders: preservedHeaders,
		};
	}
	return {
		providerId,
		customName: current.customName || "Custom compatible",
		apiBaseUrl: current.apiBaseUrl,
		model: current.model || DEFAULT_MODEL,
		apiKey: preservedKey,
		extraHeaders: preservedHeaders,
	};
}

export function validateAiSettings(settings: AiSettings): string | null {
	const normalized = sanitizeAiSettings(settings);
	if (!normalized.apiKey) {
		return "Set your AI provider API key in plugin settings first";
	}
	if (!normalized.apiBaseUrl) {
		return "Set your AI provider base URL in plugin settings first";
	}
	if (!normalized.model) {
		return "Set your AI provider model in plugin settings first";
	}
	return null;
}

export function buildOpenAICompatibleUrl(apiBaseUrl: string): string {
	const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
	if (!normalized) return "";
	if (normalized.endsWith("/chat/completions")) return normalized;
	return `${normalized}/chat/completions`;
}

export function buildOpenAICompatibleHeaders(
	settings: AiSettings,
): Record<string, string> {
	const normalized = sanitizeAiSettings(settings);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (normalized.apiKey) {
		setHeader(headers, "Authorization", `Bearer ${normalized.apiKey}`);
	}
	for (const header of normalized.extraHeaders) {
		setHeader(headers, header.name, header.value);
	}
	return headers;
}

export function extractAiErrorMessage(
	payload: unknown,
	status: number,
): string {
	const record = toRecord(payload);
	if (!record) return `HTTP ${status}`;
	if (typeof record.message === "string" && record.message) {
		return record.message;
	}
	const errorValue = record.error;
	if (typeof errorValue === "string" && errorValue) return errorValue;
	const nestedError = toRecord(errorValue);
	if (nestedError) {
		if (typeof nestedError.message === "string" && nestedError.message) {
			return nestedError.message;
		}
		if (typeof nestedError.code === "string" && nestedError.code) {
			return nestedError.code;
		}
	}
	return `HTTP ${status}`;
}

export function parseOpenAICompatibleSuggestion(
	payload: unknown,
): IssueDraftSuggestion {
	const record = toRecord(payload);
	const choices = Array.isArray(record?.choices) ? record.choices : [];
	const firstChoice = toRecord(choices[0]);
	const message = toRecord(firstChoice?.message);
	const rawContent = extractTextContent(message?.content);
	if (!rawContent) {
		throw new Error("AI provider returned an empty response");
	}
	const parsed = JSON.parse(stripJsonFence(rawContent));
	const suggestion = toRecord(parsed);
	if (!suggestion) {
		throw new Error("AI provider returned invalid JSON");
	}
	return {
		title:
			typeof suggestion.title === "string" ? suggestion.title.trim() : "",
		description:
			typeof suggestion.description === "string"
				? suggestion.description.trim()
				: "",
		priority: normalizePriority(suggestion.priority),
		assignee:
			typeof suggestion.assignee === "string" &&
			suggestion.assignee.trim()
				? suggestion.assignee.trim()
				: null,
		project:
			typeof suggestion.project === "string" && suggestion.project.trim()
				? suggestion.project.trim()
				: null,
	};
}

function buildIssuePrompts(request: IssueDraftRequest): {
	system: string;
	user: string;
} {
	const hasSelection = !!request.selection;
	const reviewPath = buildReviewPath(request.filePath);
	const agentList = request.agents
		.map(
			(agent) =>
				`- ${agent.name} (${agent.role}): ${agent.capabilities || "general"}`,
		)
		.join("\n");
	const projectList = request.projects.map((project) => `- ${project.name}`).join("\n");

	const intentPrompts: Record<IssueDraftRequest["intent"], string> = {
		work: hasSelection
			? "You create actionable Paperclip issues from highlighted text. Focus on the selection but use the full file for context. The issue should describe concrete work to be done."
			: "You create actionable Paperclip issues from documents. Analyze the document and create an issue for the most important work that needs to be done based on its content (implementation, follow-up, next steps, or cleanup).",
		review:
			`You create Paperclip review issues. The user wants a thorough review of this document. The review should be written into a new file at \`${reviewPath}\`. Include in the description what to review, what to look for, and where to write the output.`,
		auto:
			"You analyze documents and create the most appropriate Paperclip issue. Determine whether the document needs follow-up work, a review, implementation, or something else. If it looks like meeting notes or a report, create follow-up actions. If it looks like a spec or plan, create implementation tasks. If it looks like a draft, suggest a review.",
	};

	return {
		system: `${intentPrompts[request.intent]}

Return only valid JSON with:
- "title": concise issue title (max 80 chars)
- "description": markdown description with clear acceptance criteria and a reference to the source file
- "priority": one of "critical", "high", "medium", "low"
- "assignee": the exact name of the best-fit agent from the list below, or null
- "project": the exact name of the best-fit project from the list below, or null

Available agents:
${agentList || "- none"}

Available projects:
${projectList || "- none"}

File: ${request.filePath}`,
		user: hasSelection
			? `## Selected text
${request.selection}

## Full file (${request.filePath})
${request.fileContent.slice(0, 12000)}`
			: `## Full document (${request.filePath})
${request.fileContent.slice(0, 12000)}`,
	};
}

class OpenAICompatibleBackend implements AiBackend {
	constructor(private readonly request: RequestLike) {}

	async suggestIssue(
		settings: AiSettings,
		request: IssueDraftRequest,
	): Promise<IssueDraftSuggestion> {
		const validationError = validateAiSettings(settings);
		if (validationError) throw new Error(validationError);
		const prompts = buildIssuePrompts(request);
		const response = await this.request({
			url: buildOpenAICompatibleUrl(settings.apiBaseUrl),
			method: "POST",
			headers: buildOpenAICompatibleHeaders(settings),
			throw: false,
			body: JSON.stringify({
				model: sanitizeAiSettings(settings).model,
				temperature: 0.3,
				messages: [
					{ role: "system", content: prompts.system },
					{ role: "user", content: prompts.user },
				],
			}),
		});
		if (response.status >= 400) {
			throw new Error(extractAiErrorMessage(response.json, response.status));
		}
		return parseOpenAICompatibleSuggestion(response.json);
	}

	async testConnection(settings: AiSettings): Promise<void> {
		const validationError = validateAiSettings(settings);
		if (validationError) throw new Error(validationError);
		const response = await this.request({
			url: buildOpenAICompatibleUrl(settings.apiBaseUrl),
			method: "POST",
			headers: buildOpenAICompatibleHeaders(settings),
			throw: false,
			body: JSON.stringify({
				model: sanitizeAiSettings(settings).model,
				temperature: 0,
				max_tokens: 8,
				messages: [{ role: "user", content: "Reply with OK." }],
			}),
		});
		if (response.status >= 400) {
			throw new Error(extractAiErrorMessage(response.json, response.status));
		}
	}
}

export function createAiBackendRegistry(
	request: RequestLike,
): Record<AiProviderId, AiBackend> {
	const compatibleBackend = new OpenAICompatibleBackend(request);
	return {
		openai: compatibleBackend,
		compatible_gateway: compatibleBackend,
		custom_compatible: compatibleBackend,
	};
}

export class AiSuggestionService {
	constructor(
		private readonly registry: Record<AiProviderId, AiBackend>,
	) {}

	async suggestIssue(
		settings: AiSettings,
		request: IssueDraftRequest,
	): Promise<IssueDraftSuggestion> {
		const backend = this.registry[settings.providerId];
		if (!backend) throw new Error("Unsupported AI provider");
		return backend.suggestIssue(settings, request);
	}

	async testProvider(settings: AiSettings): Promise<void> {
		const backend = this.registry[settings.providerId];
		if (!backend) throw new Error("Unsupported AI provider");
		await backend.testConnection(settings);
	}
}
