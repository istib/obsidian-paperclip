import { requestUrl, RequestUrlParam } from "obsidian";

// ── Types ──────────────────────────────────────────────────────────

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

// ── Client ─────────────────────────────────────────────────────────

export class PaperclipApi {
	constructor(
		private baseUrl: string,
		private apiKey?: string,
	) {}

	updateConfig(baseUrl: string, apiKey?: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey) {
			headers["Authorization"] = `Bearer ${this.apiKey}`;
		}
		const params: RequestUrlParam = {
			url,
			method,
			headers,
			throw: false,
		};
		if (body) {
			// Strip undefined values; keep explicit nulls only for fields that need clearing
			const clean: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(body)) {
				if (v !== undefined) clean[k] = v;
			}
			params.body = JSON.stringify(clean);
		}
		const resp = await requestUrl(params);
		if (resp.status >= 400) {
			const msg =
				resp.json?.error ||
				resp.json?.message ||
				`HTTP ${resp.status}`;
			throw new Error(msg);
		}
		return resp.json as T;
	}

	// Companies
	async listCompanies(): Promise<Company[]> {
		return this.request<Company[]>("GET", "/api/companies");
	}

	// Issues
	async listIssues(
		companyId: string,
		filters?: IssueFilters,
	): Promise<Issue[]> {
		const params = new URLSearchParams();
		if (filters?.status) params.set("status", filters.status);
		if (filters?.assigneeAgentId)
			params.set("assigneeAgentId", filters.assigneeAgentId);
		if (filters?.projectId) params.set("projectId", filters.projectId);
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
