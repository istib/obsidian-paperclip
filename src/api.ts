import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type { AuthMode } from "./auth";

// ── Types ──────────────────────────────────────────────────────────

export interface PaperclipApiConfig {
	baseUrl: string;
	authMode: AuthMode;
	apiKey: string;
	sessionCookie: string;
	customAuthHeaderName: string;
	customAuthHeaderValue: string;
}

export interface AuthSession {
	session: {
		id: string;
		userId: string;
	};
	user: {
		id: string;
		email: string | null;
		name: string | null;
	};
}

export interface Company {
	id: string;
	name: string;
	description: string | null;
	status: string;
	issuePrefix: string;
	brandColor: string | null;
	logoUrl: string | null;
}

export interface ActiveRun {
	id: string;
	status: string;
	agentId: string;
	invocationSource: string | null;
	triggerDetail: string | null;
	startedAt: string;
	finishedAt: string | null;
}

export interface Issue {
	id: string;
	companyId: string;
	projectId: string | null;
	parentId: string | null;
	title: string;
	description: string | null;
	status: string;
	priority: string | null;
	assigneeAgentId: string | null;
	assigneeUserId: string | null;
	identifier: string;
	issueNumber: number;
	labels: string[];
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
	activeRun: ActiveRun | null;
}

export interface Agent {
	id: string;
	companyId: string;
	name: string;
	role: string;
	title: string | null;
	icon: string | null;
	status: string;
	capabilities: string | null;
}

export interface Project {
	id: string;
	companyId: string;
	name: string;
	description: string | null;
	status: string;
	color: string | null;
	leadAgentId: string | null;
	archivedAt: string | null;
}

export interface Comment {
	id: string;
	issueId: string;
	body: string;
	authorAgentId: string | null;
	authorUserId: string | null;
	createdAt: string;
}

export interface IssueFilters {
	status?: string;
	assigneeAgentId?: string;
	projectId?: string;
	q?: string;
}

export interface CreateIssueData {
	title: string;
	description?: string;
	status?: string;
	priority?: string;
	assigneeAgentId?: string;
	projectId?: string;
	parentId?: string;
}

export interface UpdateIssuePatch {
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	assigneeAgentId?: string | null;
	assigneeUserId?: string | null;
	projectId?: string | null;
	projectWorkspaceId?: string | null;
	comment?: string;
}

interface RequestOptions {
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
	skipConfiguredAuth?: boolean;
	sessionCookieOverride?: string;
}

export class PaperclipAuthError extends Error {
	readonly status = 401;

	constructor(message: string) {
		super(message);
		this.name = "PaperclipAuthError";
	}
}

function sanitizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function getHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const needle = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === needle) return value;
	}
	return undefined;
}

function splitSetCookieHeader(headerValue: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inExpires = false;

	for (let i = 0; i < headerValue.length; i++) {
		const next = headerValue.slice(i, i + 8).toLowerCase();
		if (next === "expires=") {
			inExpires = true;
			i += 7;
			continue;
		}
		const char = headerValue[i];
		if (inExpires && char === ";") {
			inExpires = false;
			continue;
		}
		if (char !== "," || inExpires) continue;
		const remainder = headerValue.slice(i + 1);
		if (/^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(remainder)) {
			parts.push(headerValue.slice(start, i).trim());
			start = i + 1;
		}
	}

	const tail = headerValue.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

function mergeCookieHeader(
	existingHeader: string,
	setCookieHeader: string | undefined,
): string {
	const cookies = new Map<string, string>();

	for (const pair of existingHeader.split(";")) {
		const trimmed = pair.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		cookies.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
	}

	if (setCookieHeader) {
		for (const cookie of splitSetCookieHeader(setCookieHeader)) {
			const pair = cookie.split(";", 1)[0]?.trim();
			if (!pair) continue;
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			if (value) {
				cookies.set(name, value);
			} else {
				cookies.delete(name);
			}
		}
	}

	return Array.from(cookies.entries())
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function extractErrorMessage(payload: unknown, status: number): string {
	if (!payload || typeof payload !== "object") return `HTTP ${status}`;
	const record = payload as Record<string, unknown>;
	const errorValue = record.error;
	if (typeof errorValue === "string" && errorValue) return errorValue;
	if (errorValue && typeof errorValue === "object") {
		const message = (errorValue as Record<string, unknown>).message;
		if (typeof message === "string" && message) return message;
	}
	const message = record.message;
	if (typeof message === "string" && message) return message;
	return `HTTP ${status}`;
}

function joinAuthMessage(baseMessage: string, serverMessage: string): string {
	if (!serverMessage || serverMessage === "HTTP 401" || serverMessage === baseMessage) {
		return baseMessage;
	}
	return `${baseMessage} (${serverMessage})`;
}

function toAuthSession(value: unknown): AuthSession | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const nested = record.data;
	if (nested && typeof nested === "object") return toAuthSession(nested);

	const sessionValue = record.session;
	const userValue = record.user;
	if (!sessionValue || typeof sessionValue !== "object") return null;
	if (!userValue || typeof userValue !== "object") return null;

	const session = sessionValue as Record<string, unknown>;
	const user = userValue as Record<string, unknown>;
	if (typeof session.id !== "string" || typeof session.userId !== "string") {
		return null;
	}
	if (typeof user.id !== "string") return null;

	return {
		session: {
			id: session.id,
			userId: session.userId,
		},
		user: {
			id: user.id,
			email: typeof user.email === "string" ? user.email : null,
			name: typeof user.name === "string" ? user.name : null,
		},
	};
}

// ── Client ─────────────────────────────────────────────────────────

export class PaperclipApi {
	private config: PaperclipApiConfig;

	constructor(config: PaperclipApiConfig) {
		this.config = {
			...config,
			baseUrl: sanitizeBaseUrl(config.baseUrl),
		};
	}

	updateConfig(config: PaperclipApiConfig) {
		this.config = {
			...config,
			baseUrl: sanitizeBaseUrl(config.baseUrl),
		};
	}

	getSessionCookie(): string {
		return this.config.sessionCookie;
	}

	private buildHeaders(
		options?: Pick<RequestOptions, "headers" | "skipConfiguredAuth" | "sessionCookieOverride">,
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(options?.headers ?? {}),
		};

		if (options?.skipConfiguredAuth) return headers;

		if (this.config.authMode === "bearer" && this.config.apiKey) {
			headers["Authorization"] = `Bearer ${this.config.apiKey}`;
		}

		if (
			this.config.authMode === "custom_header" &&
			this.config.customAuthHeaderName &&
			this.config.customAuthHeaderValue
		) {
			headers[this.config.customAuthHeaderName] =
				this.config.customAuthHeaderValue;
		}

		const sessionCookie =
			options?.sessionCookieOverride ?? this.config.sessionCookie;
		if (this.config.authMode === "session" && sessionCookie) {
			headers["Cookie"] = sessionCookie;
		}

		return headers;
	}

	private maybeUpdateSessionCookie(
		path: string,
		responseHeaders: Record<string, string>,
	) {
		if (
			this.config.authMode !== "session" &&
			!path.startsWith("/api/auth/")
		) {
			return;
		}
		const setCookie = getHeader(responseHeaders, "set-cookie");
		if (!setCookie) return;
		this.config.sessionCookie = mergeCookieHeader(
			this.config.sessionCookie,
			setCookie,
		);
	}

	private async requestRaw(
		method: string,
		path: string,
		options?: RequestOptions,
	): Promise<RequestUrlResponse> {
		const params: RequestUrlParam = {
			url: `${this.config.baseUrl}${path}`,
			method,
			headers: this.buildHeaders(options),
			throw: false,
		};
		if (options?.body) {
			const clean: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(options.body)) {
				if (value !== undefined) clean[key] = value;
			}
			params.body = JSON.stringify(clean);
		}

		const response = await requestUrl(params);
		this.maybeUpdateSessionCookie(path, response.headers);
		return response;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		const resp = await this.requestRaw(method, path, { body });
		if (resp.status >= 400) {
			if (resp.status === 401) {
				const serverMessage = extractErrorMessage(resp.json, resp.status);
				if (this.config.authMode === "session" && !this.config.sessionCookie) {
					throw new PaperclipAuthError(
						joinAuthMessage(
							"Sign in from plugin settings to access this server",
							serverMessage,
						),
					);
				}
				if (this.config.authMode === "session") {
					throw new PaperclipAuthError(
						joinAuthMessage(
							"Session expired or unauthorized. Sign in again from plugin settings",
							serverMessage,
						),
					);
				}
				if (this.config.authMode === "bearer") {
					throw new PaperclipAuthError(
						joinAuthMessage(
							"Bearer token missing or unauthorized. Update Paperclip auth settings",
							serverMessage,
						),
					);
				}
				if (this.config.authMode === "custom_header") {
					throw new PaperclipAuthError(
						joinAuthMessage(
							"Custom auth header missing or unauthorized. Update Paperclip auth settings",
							serverMessage,
						),
					);
				}
				throw new PaperclipAuthError(
					joinAuthMessage(
						"Server requires authentication. Update Paperclip auth mode in plugin settings",
						serverMessage,
					),
				);
			}
			throw new Error(extractErrorMessage(resp.json, resp.status));
		}
		return resp.json as T;
	}

	// Auth
	async getSession(): Promise<AuthSession | null> {
		if (!this.config.sessionCookie) return null;
		const resp = await this.requestRaw("GET", "/api/auth/get-session");
		if (resp.status === 401) return null;
		if (resp.status >= 400) {
			throw new Error(extractErrorMessage(resp.json, resp.status));
		}
		return toAuthSession(resp.json);
	}

	async signInEmail(
		email: string,
		password: string,
	): Promise<AuthSession> {
		const resp = await this.requestRaw("POST", "/api/auth/sign-in/email", {
			body: { email, password },
			skipConfiguredAuth: true,
		});
		if (resp.status >= 400) {
			throw new Error(extractErrorMessage(resp.json, resp.status));
		}
		const session = await this.getSession();
		if (!session) {
			throw new Error("Signed in, but no session cookie was stored");
		}
		return session;
	}

	async signOutSession(): Promise<void> {
		if (!this.config.sessionCookie) return;
		const resp = await this.requestRaw("POST", "/api/auth/sign-out", {
			body: {},
		});
		if (resp.status >= 400 && resp.status !== 401) {
			throw new Error(extractErrorMessage(resp.json, resp.status));
		}
		this.config.sessionCookie = "";
	}

	// Companies
	async listCompanies(): Promise<Company[]> {
		const companies = await this.request<Company[]>("GET", "/api/companies");
		return companies.filter((company) => company.status === "active");
	}

	// Issues
	async listIssues(
		companyId: string,
		filters?: IssueFilters,
	): Promise<Issue[]> {
		const params = new URLSearchParams();
		if (filters?.status) params.set("status", filters.status);
		if (filters?.assigneeAgentId) {
			params.set("assigneeAgentId", filters.assigneeAgentId);
		}
		if (filters?.projectId) params.set("projectId", filters.projectId);
		if (filters?.q) params.set("q", filters.q);
		const qs = params.toString();
		const path = `/api/companies/${companyId}/issues${qs ? `?${qs}` : ""}`;
		return this.request<Issue[]>("GET", path);
	}

	async getIssue(issueId: string): Promise<Issue> {
		return this.request<Issue>("GET", `/api/issues/${issueId}`);
	}

	async createIssue(
		companyId: string,
		data: CreateIssueData,
	): Promise<Issue> {
		return this.request<Issue>(
			"POST",
			`/api/companies/${companyId}/issues`,
			data as unknown as Record<string, unknown>,
		);
	}

	async updateIssue(
		issueId: string,
		patch: UpdateIssuePatch,
	): Promise<Issue> {
		return this.request<Issue>(
			"PATCH",
			`/api/issues/${issueId}`,
			patch as unknown as Record<string, unknown>,
		);
	}

	// Comments
	async listComments(issueId: string): Promise<Comment[]> {
		return this.request<Comment[]>(
			"GET",
			`/api/issues/${issueId}/comments`,
		);
	}

	async addComment(issueId: string, body: string): Promise<Comment> {
		return this.request<Comment>(
			"POST",
			`/api/issues/${issueId}/comments`,
			{ body },
		);
	}

	// Agents
	async listAgents(companyId: string): Promise<Agent[]> {
		return this.request<Agent[]>(
			"GET",
			`/api/companies/${companyId}/agents`,
		);
	}

	// Projects
	async listProjects(companyId: string): Promise<Project[]> {
		return this.request<Project[]>(
			"GET",
			`/api/companies/${companyId}/projects`,
		);
	}

	async createProject(
		companyId: string,
		name: string,
	): Promise<Project> {
		return this.request<Project>(
			"POST",
			`/api/companies/${companyId}/projects`,
			{ name, status: "planned" },
		);
	}
}
