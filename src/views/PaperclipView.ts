import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, MarkdownRenderer, FileSystemAdapter } from "obsidian";
import type PaperclipPlugin from "../main";
import type { Company, Issue, Agent, Comment, Project, CreateIssueData } from "../api";
import {
	FILE_EXT_RE as VAULT_FILE_EXT_RE,
	extractReferencedVaultFiles,
	resolveVaultPath as resolveVaultPathHelper,
} from "../utils/vaultContext";
import { AssignModal, ASSIGN_TO_ME } from "./AssignModal";
import { CreateIssueModal } from "./CreateIssueModal";
import { ProjectModal } from "./ProjectModal";

export const VIEW_TYPE = "paperclip-view";
export const BOARD_VIEW_TYPE = "paperclip-board-view";

type StatusFilter = "active" | "all" | "done";
type GroupBy = "status" | "project" | "assignee";
type SortBy = "updated" | "created" | "priority";

const KANBAN_STATUSES = [
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"blocked",
	"done",
	"cancelled",
];

export class PaperclipView extends ItemView {
	plugin: PaperclipPlugin;
	private readonly viewTypeName: string;
	private readonly displayText: string;
	private readonly boardView: boolean;

	private companies: Company[] = [];
	private agents: Agent[] = [];
	private projects: Project[] = [];
	private issues: Issue[] = [];
	private selectedCompanyId = "";
	private selectedProjectId = "";
	private statusFilter: StatusFilter = "all";
	private groupBy: GroupBy = "status";
	private sortBy: SortBy = "updated";
	private selectedIssue: Issue | null = null;
	private comments: Comment[] = [];
	private refreshTimer: number | null = null;
	/** Track which issues had activeRun on last poll, keyed by issue id */
	private previouslyRunning: Map<string, { identifier: string; agentId: string }> = new Map();
	/** Cache of contributing agent IDs per issue */
	private contributors: Map<string, string[]> = new Map();
	/** Track collapsed section groups in list view */
	private collapsedGroups: Set<string> = new Set();
	/** Whether the inline comment form is currently open */
	private commentFormOpen = false;
	/** Whether the activity thread is expanded (true) or folded with previews (false) */
	private activityExpanded = false;
	/** Comments individually expanded while the thread is collapsed */
	private expandedCommentIds: Set<string> = new Set();
	/** Whether the issue description is fully expanded */
	private descriptionExpanded = false;
	/** Issues related to the currently active file */
	private relatedIssues: Issue[] = [];
	/** Path of the file whose related issues are currently loaded */
	private relatedFilePath: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		plugin: PaperclipPlugin,
		options?: {
			viewType?: string;
			displayText?: string;
			boardView?: boolean;
		},
	) {
		super(leaf);
		this.plugin = plugin;
		this.viewTypeName = options?.viewType ?? VIEW_TYPE;
		this.displayText = options?.displayText ?? "Paperclip";
		this.boardView = options?.boardView ?? false;
		this.statusFilter = this.boardView ? "all" : "active";
	}

	// Public accessors for main.ts AI features
	getAgents(): Agent[] { return this.agents; }
	getProjects(): Project[] { return this.projects; }
	getSelectedCompanyId(): string { return this.selectedCompanyId; }
	getSelectedProjectId(): string { return this.selectedProjectId; }
	getSortBy(): SortBy { return this.sortBy; }
	getIssues(): Issue[] { return this.issues; }

	async syncContextFrom(other: PaperclipView): Promise<void> {
		this.selectedCompanyId = other.getSelectedCompanyId();
		this.selectedProjectId = other.getSelectedProjectId();
		this.sortBy = other.getSortBy();
		this.selectedIssue = null;
		if (!this.selectedCompanyId) return;
		await this.loadAgents();
		await this.loadProjects();
		await this.loadIssues();
		if (this.boardView) this.loadContributors();
		this.render();
	}

	/** Open the detail view for a specific issue */
	selectIssue(issue: Issue): void {
		this.selectedIssue = issue;
		this.descriptionExpanded = false;
		void this.loadComments(issue.id).then(() => this.render());
	}

	getViewType(): string {
		return this.viewTypeName;
	}

	getDisplayText(): string {
		return this.displayText;
	}

	getIcon(): string {
		return "paperclip";
	}

	async onOpen(): Promise<void> {
		await this.loadCompanies();
		if (this.boardView) this.loadContributors();
		this.render();
		this.startAutoRefresh();

	// Track active file changes for related issues
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				void this.onActiveFileChange();
			}),
		);
		// Trigger initial check
		void this.onActiveFileChange();
	}

	onClose(): void {
		this.stopAutoRefresh();
	}

	// ── Data loading ───────────────────────────────────────────────

	private async loadCompanies(): Promise<void> {
		try {
			this.companies = await this.plugin.api.listCompanies();
			if (
				this.plugin.settings.defaultCompanyId &&
				!this.selectedCompanyId
			) {
				this.selectedCompanyId =
					this.plugin.settings.defaultCompanyId;
			}
			if (
				!this.selectedCompanyId &&
				this.companies.length > 0
			) {
				this.selectedCompanyId = this.companies[0].id;
			}
			if (this.selectedCompanyId) {
				await this.loadAgents();
				await this.loadProjects();
				await this.loadIssues();
				if (this.boardView) this.loadContributors();
			}
	} catch (e) {
			new Notice(`Paperclip: failed to load companies — ${String(e)}`);
		}
	}

	private async loadAgents(): Promise<void> {
		if (!this.selectedCompanyId) return;
		try {
			this.agents = await this.plugin.api.listAgents(
				this.selectedCompanyId,
			);
		} catch {
			this.agents = [];
		}
	}

	private async loadProjects(): Promise<void> {
		if (!this.selectedCompanyId) return;
		try {
			this.projects = await this.plugin.api.listProjects(
				this.selectedCompanyId,
			);
		} catch {
			this.projects = [];
		}
	}

	private async loadIssues(): Promise<void> {
		if (!this.selectedCompanyId) return;
		try {
			const statusMap: Record<StatusFilter, string | undefined> = {
				active: "backlog,todo,in_progress,blocked,in_review",
				done: "done,cancelled",
				all: undefined,
			};
			this.issues = await this.plugin.api.listIssues(
				this.selectedCompanyId,
				{
					status: statusMap[this.statusFilter],
					projectId: this.selectedProjectId || undefined,
				},
			);
		} catch (e) {
			new Notice(`Paperclip: failed to load issues — ${String(e)}`);
			this.issues = [];
		}
	}

	private async onActiveFileChange(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const path = file?.path ?? null;
		if (path === this.relatedFilePath) return;
		this.relatedFilePath = path;
		if (!path || !this.selectedCompanyId) {
			this.relatedIssues = [];
			this.render();
			return;
		}
		await this.loadRelatedIssues(path);
		this.render();
	}

	private async loadRelatedIssues(filePath: string): Promise<void> {
		// Extract meaningful search terms from the file path
		const basename = filePath.split("/").pop() ?? filePath;
		const name = basename.replace(/\.[^.]+$/, ""); // strip extension
		if (!name || name.length < 3) {
			this.relatedIssues = [];
			return;
		}
		try {
			const results = await this.plugin.api.listIssues(
				this.selectedCompanyId,
				{ q: name },
			);
			// Exclude issues already visible in main list to avoid duplication confusion
			this.relatedIssues = results;
		} catch {
			this.relatedIssues = [];
		}
	}

	private async loadComments(issueId: string): Promise<void> {
		try {
			this.comments = await this.plugin.api.listComments(issueId);
		} catch {
			this.comments = [];
		}
	}

	private agentName(agentId: string | null): string {
		if (!agentId) return "Unassigned";
		const agent = this.agents.find((a) => a.id === agentId);
		return agent ? agent.name : agentId.slice(0, 8);
	}

	private agentInitials(agentId: string): string {
		const name = this.agentName(agentId);
		return name
			.split(/\s+/)
			.map((w) => w[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
	}

	/** Load comment authors for all current issues (fire-and-forget, re-renders when done) */
	private loadContributors(): void {
		const ids = this.issues.map((i) => i.id);
		void Promise.all(
			ids.map(async (id) => {
				try {
					const comments = await this.plugin.api.listComments(id);
					const agentIds = new Set<string>();
					// Include assignee + comment authors
					const issue = this.issues.find((i) => i.id === id);
					if (issue?.assigneeAgentId) agentIds.add(issue.assigneeAgentId);
					if (issue?.activeRun?.agentId) agentIds.add(issue.activeRun.agentId);
					for (const c of comments) {
						if (c.authorAgentId) agentIds.add(c.authorAgentId);
					}
					this.contributors.set(id, [...agentIds]);
				} catch {
					// ignore per-issue failures
				}
			}),
		).then(() => this.render());
	}

	private projectName(projectId: string | null): string | null {
		if (!projectId) return null;
		const proj = this.projects.find((p) => p.id === projectId);
		return proj ? proj.name : null;
	}

	private relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return "just now";
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const days = Math.floor(hr / 24);
		if (days < 30) return `${days}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	// ── Auto-refresh ───────────────────────────────────────────────

	private snapshotRunning(): void {
		this.previouslyRunning.clear();
		for (const issue of this.issues) {
			if (issue.activeRun && issue.activeRun.status === "running") {
				this.previouslyRunning.set(issue.id, {
					identifier: issue.identifier,
					agentId: issue.activeRun.agentId,
				});
			}
		}
	}

	private detectFinishedRuns(): void {
		for (const [id, prev] of this.previouslyRunning) {
			const current = this.issues.find((i) => i.id === id);
			const stillRunning =
				current?.activeRun &&
				current.activeRun.status === "running";
			if (!stillRunning) {
				const agentLabel = this.agentName(prev.agentId);
				const status = current ? current.status : "unknown";
				new Notice(
					`📎 ${prev.identifier} finished — ${agentLabel} → ${status.replace("_", " ")}`,
					8000,
				);
			}
		}
	}

	private startAutoRefresh(): void {
		this.stopAutoRefresh();
		const sec = this.plugin.settings.refreshIntervalSec;
		if (sec > 0) {
			this.refreshTimer = window.setInterval(() => {
				void this.doRefresh();
			}, sec * 1000);
			this.registerInterval(this.refreshTimer);
		}
	}

	private async doRefresh(): Promise<void> {
		this.snapshotRunning();
		await this.loadIssues();
		if (this.boardView) this.loadContributors();
		this.detectFinishedRuns();
		if (this.selectedIssue) {
			// Refresh the selected issue from latest data
			const updated = this.issues.find(
				(i) => i.id === this.selectedIssue!.id,
			);
			if (updated) this.selectedIssue = updated;
			await this.loadComments(this.selectedIssue.id);
		}
		// Don't re-render while the user is composing a comment
		if (!this.commentFormOpen) {
			this.render();
		}
	}

	private stopAutoRefresh(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	// ── Rendering ──────────────────────────────────────────────────

	private sortIssues(issues: Issue[]): Issue[] {
		const priorityOrder: Record<string, number> = {
			critical: 0, high: 1, medium: 2, low: 3,
		};
		const arr = [...issues];
		switch (this.sortBy) {
			case "created":
				return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
			case "priority":
				return arr.sort((a, b) =>
					(priorityOrder[a.priority ?? "low"] ?? 3) - (priorityOrder[b.priority ?? "low"] ?? 3));
			default: // "updated"
				return arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		}
	}

	render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("paperclip-container");
		container.toggleClass("paperclip-container-board", this.boardView);
		container.toggleClass("paperclip-container-browser", !this.boardView);

		if (this.selectedIssue) {
			this.renderDetail(container);
		} else if (this.boardView) {
			this.renderHeader(container);
			this.renderKanban(container);
		} else {
			this.renderHeader(container);
			this.renderRelatedIssues(container);
			this.renderListBody(container);
		}
	}

	private renderPreservingScroll(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const previousScrollTop = container.scrollTop;
		this.render();
		window.requestAnimationFrame(() => {
			container.scrollTop = previousScrollTop;
		});
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: "paperclip-header" });

		// Company selector
		const select = header.createEl("select", {
			cls: "paperclip-company-select dropdown",
		});
		for (const c of this.companies) {
			const opt = select.createEl("option", { text: c.name });
			opt.value = c.id;
			if (c.id === this.selectedCompanyId) opt.selected = true;
		}
		select.addEventListener("change", () => {
			this.selectedCompanyId = select.value;
			this.selectedProjectId = "";
			this.selectedIssue = null;
			void this.loadAgents()
				.then(() => this.loadProjects())
				.then(() => this.loadIssues())
				.then(() => this.render());
		});

		// Project filter
		if (this.projects.length > 0) {
			const projSelect = header.createEl("select", {
				cls: "paperclip-project-select dropdown",
			});
			const allOpt = projSelect.createEl("option", { text: "All projects" });
			allOpt.value = "";
			if (!this.selectedProjectId) allOpt.selected = true;
			for (const p of this.projects.filter((p) => !p.archivedAt)) {
				const opt = projSelect.createEl("option", { text: p.name });
				opt.value = p.id;
				if (p.id === this.selectedProjectId) opt.selected = true;
			}
			projSelect.addEventListener("change", () => {
				this.selectedProjectId = projSelect.value;
				void this.loadIssues().then(() => this.render());
			});
		}

		// Status filter tabs + group-by toggle (only in browser view)
		if (!this.boardView) {
			const tabs = header.createDiv({ cls: "paperclip-tabs" });
			const filters: { label: string; value: StatusFilter }[] = [
				{ label: "Active", value: "active" },
				{ label: "Done", value: "done" },
				{ label: "All", value: "all" },
			];
			for (const f of filters) {
				const tab = tabs.createEl("button", {
					text: f.label,
					cls: `paperclip-tab${this.statusFilter === f.value ? " is-active" : ""}`,
				});
				tab.addEventListener("click", () => {
					this.statusFilter = f.value;
					void this.loadIssues().then(() => this.render());
				});
			}
			// Group-by toggle
			const groupTabs = header.createDiv({ cls: "paperclip-tabs" });
			const groupOptions: { label: string; value: GroupBy }[] = [
				{ label: "By status", value: "status" },
				{ label: "By project", value: "project" },
				{ label: "By assignee", value: "assignee" },
			];
			for (const g of groupOptions) {
				const tab = groupTabs.createEl("button", {
					text: g.label,
					cls: `paperclip-tab${this.groupBy === g.value ? " is-active" : ""}`,
				});
				tab.addEventListener("click", () => {
					this.groupBy = g.value;
					this.render();
				});
			}
		}

		// Action buttons row
		const headerActions = header.createDiv({ cls: "paperclip-header-actions" });

		// Sort button
		const sortMeta: Record<SortBy, { icon: string; label: string }> = {
			updated:  { icon: "clock",                label: "Sort: recently updated" },
			created:  { icon: "calendar",             label: "Sort: recently created" },
			priority: { icon: "arrow-up-narrow-wide", label: "Sort: priority" },
		};
		const sortBtn = headerActions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": sortMeta[this.sortBy].label },
		});
		setIcon(sortBtn, sortMeta[this.sortBy].icon);
		sortBtn.addEventListener("click", () => {
			const cycle: SortBy[] = ["updated", "created", "priority"];
			this.sortBy = cycle[(cycle.indexOf(this.sortBy) + 1) % cycle.length];
			this.render();
		});

		const switchViewBtn = headerActions.createEl("button", {
			cls: "clickable-icon",
			attr: {
				"aria-label": this.boardView
					? "Open issue browser"
					: "Open board",
			},
		});
		setIcon(switchViewBtn, this.boardView ? "list" : "kanban");
		switchViewBtn.addEventListener("click", () => {
			if (this.boardView) {
				void this.plugin.activateIssueBrowser(this);
			} else {
				void this.plugin.activateBoardView(this);
			}
		});

		// New issue button
		const newBtn = headerActions.createEl("button", {
			cls: "paperclip-new-issue clickable-icon",
			attr: { "aria-label": "New issue" },
		});
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => {
			this.openCreateIssueModal();
		});

		// Refresh button
		const refreshBtn = headerActions.createEl("button", {
			cls: "paperclip-refresh clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			void this.loadIssues().then(() => {
				if (this.boardView) this.loadContributors();
				this.render();
				new Notice("Paperclip: refreshed");
			});
		});
	}

	private renderRelatedIssues(container: HTMLElement): void {
		if (this.relatedIssues.length === 0 || !this.relatedFilePath) return;

		const basename = this.relatedFilePath.split("/").pop() ?? this.relatedFilePath;
		const name = basename.replace(/\.[^.]+$/, "");

		const section = container.createDiv({ cls: "paperclip-related" });
		const groupKey = "related:file";
		const collapsed = this.collapsedGroups.has(groupKey);

		const header = section.createDiv({
			cls: `paperclip-related-header paperclip-collapsible${collapsed ? " is-collapsed" : ""}`,
		});
		const chevron = header.createSpan({ cls: "paperclip-collapse-icon" });
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
		const icon = header.createSpan({ cls: "paperclip-related-icon" });
		setIcon(icon, "file-text");
		header.createSpan({ text: `${name}`, cls: "paperclip-related-name" });
		header.createSpan({
			text: `${this.relatedIssues.length}`,
			cls: "paperclip-related-count",
		});

		header.addEventListener("click", () => {
			if (this.collapsedGroups.has(groupKey)) {
				this.collapsedGroups.delete(groupKey);
			} else {
				this.collapsedGroups.add(groupKey);
			}
			this.render();
		});

		if (!collapsed) {
			const list = section.createDiv({ cls: "paperclip-issue-list" });
			for (const issue of this.relatedIssues) {
				this.renderIssueRow(list, issue);
			}
		}
	}

	private renderListBody(container: HTMLElement): void {
		const list = container.createDiv({ cls: "paperclip-issue-list" });
		if (this.issues.length === 0) {
			list.createDiv({
				cls: "paperclip-empty",
				text: "No issues found",
			});
			return;
		}

		const sorted = this.sortIssues(this.issues);

	if (this.groupBy === "status") {
			const statusOrder = KANBAN_STATUSES;
			const groups = new Map<string, Issue[]>();
			for (const issue of sorted) {
				if (!groups.has(issue.status)) groups.set(issue.status, []);
				groups.get(issue.status)!.push(issue);
			}
			for (const status of statusOrder) {
				const groupIssues = groups.get(status);
				if (!groupIssues || groupIssues.length === 0) continue;
				this.renderCollapsibleGroup(
					list, `status:${status}`,
					`${status.replace("_", " ")} (${groupIssues.length})`,
					groupIssues,
				);
			}
		} else if (this.groupBy === "assignee") {
			const groups = new Map<string, Issue[]>();
			for (const issue of sorted) {
				const key = issue.assigneeAgentId ?? "__unassigned__";
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(issue);
			}
			for (const [agentId, groupIssues] of groups) {
				const name = agentId === "__unassigned__"
					? "Unassigned"
					: this.agentName(agentId);
				this.renderCollapsibleGroup(
					list, `agent:${agentId}`,
					`${name} (${groupIssues.length})`,
					groupIssues,
				);
			}
		} else if (this.groupBy === "project" && !this.selectedProjectId && this.projects.length > 0) {
			const groups = new Map<string, Issue[]>();
			for (const issue of sorted) {
				const key = issue.projectId ?? "__none__";
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(issue);
			}
			for (const [projectId, groupIssues] of groups) {
				const name = projectId === "__none__"
					? "No project"
					: this.projectName(projectId) ?? "Unknown project";
				this.renderCollapsibleGroup(
					list, `proj:${projectId}`,
					name,
					groupIssues,
				);
			}
		} else {
			for (const issue of sorted) {
				this.renderIssueRow(list, issue);
			}
		}
	}

	private renderCollapsibleGroup(
		container: HTMLElement,
		groupKey: string,
		label: string,
		issues: Issue[],
	): void {
		const collapsed = this.collapsedGroups.has(groupKey);
		const header = container.createDiv({
			cls: `paperclip-project-header paperclip-collapsible${collapsed ? " is-collapsed" : ""}`,
		});
		const chevron = header.createSpan({ cls: "paperclip-collapse-icon" });
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
		header.createSpan({ text: label });
		header.addEventListener("click", () => {
			if (this.collapsedGroups.has(groupKey)) {
				this.collapsedGroups.delete(groupKey);
			} else {
				this.collapsedGroups.add(groupKey);
			}
			this.render();
		});
		if (!collapsed) {
			for (const issue of issues) {
				this.renderIssueRow(container, issue);
			}
		}
	}

	private renderIssueRow(container: HTMLElement, issue: Issue): void {
		const isRunning =
			issue.activeRun !== null &&
			issue.activeRun?.status === "running";
		const rowCls = `paperclip-issue-row${isRunning ? " is-running" : ""}`;
		const row = container.createDiv({ cls: rowCls });
		row.addEventListener("click", () => {
			this.selectedIssue = issue;
			void this.loadComments(issue.id).then(() => this.render());
		});

		const left = row.createDiv({ cls: "paperclip-issue-left" });
		if (isRunning) {
			left.createSpan({ cls: "paperclip-running-dot" });
		}
		left.createSpan({
			cls: "paperclip-issue-id",
			text: issue.identifier,
		});
		left.createSpan({
			cls: "paperclip-issue-title",
			text: issue.title,
		});

		const right = row.createDiv({ cls: "paperclip-issue-right" });
		if (isRunning) {
			right.createSpan({
				cls: "paperclip-running-label",
				text: this.agentName(issue.activeRun!.agentId) + " working…",
			});
		}
		right.createSpan({
			cls: `paperclip-status paperclip-status-${issue.status}`,
			text: issue.status.replace("_", " "),
		});
		if (issue.priority) {
			const priIcon = right.createSpan({
				cls: `paperclip-priority paperclip-priority-${issue.priority}`,
				attr: { "aria-label": issue.priority },
			});
			const iconMap: Record<string, string> = {
				critical: "chevrons-up",
				high: "chevron-up",
				medium: "minus",
				low: "chevron-down",
			};
			setIcon(priIcon, iconMap[issue.priority] ?? "minus");
		}
		right.createSpan({
			cls: "paperclip-assignee",
			text: this.agentName(issue.assigneeAgentId),
		});
	}

	// ── Kanban ─────────────────────────────────────────────────────

	private renderKanban(container: HTMLElement): void {
		const board = container.createDiv({ cls: "kb-board" });

		for (const status of KANBAN_STATUSES) {
			const colIssues = this.sortIssues(
				this.issues.filter((i) => i.status === status),
			);

			const col = board.createDiv({ cls: "kb-col" });
			col.dataset.status = status;

			// Column header
			const colHeader = col.createDiv({ cls: "kb-col-header" });
			colHeader.createSpan({
				cls: `kb-col-title`,
				text: status.replace("_", " "),
			});
			colHeader.createSpan({
				cls: "kb-col-count",
				text: String(colIssues.length),
			});

			// Drop zone
			const colBody = col.createDiv({ cls: "kb-col-body" });
			colBody.addEventListener("dragover", (e) => {
				e.preventDefault();
				colBody.addClass("kb-drag-over");
			});
			colBody.addEventListener("dragleave", () => {
				colBody.removeClass("kb-drag-over");
			});
		colBody.addEventListener("drop", (e) => {
				e.preventDefault();
				colBody.removeClass("kb-drag-over");
				const issueId = e.dataTransfer?.getData("text/plain");
				if (!issueId) return;
				const issue = this.issues.find((i) => i.id === issueId);
				if (!issue || issue.status === status) return;
				void this.plugin.api.updateIssue(issueId, { status }).then(() => {
					issue.status = status;
					new Notice(`${issue.identifier} → ${status.replace("_", " ")}`);
					this.render();
				}).catch((err: unknown) => {
					new Notice(`Failed: ${String(err)}`);
				});
			});

			// Cards
			for (const issue of colIssues) {
				this.renderKanbanCard(colBody, issue);
			}
		}
	}

	private renderKanbanCard(container: HTMLElement, issue: Issue): void {
		const isRunning =
			issue.activeRun !== null && issue.activeRun?.status === "running";
		const card = container.createDiv({
			cls: `kb-card${isRunning ? " is-running" : ""}`,
		});
		card.draggable = true;
		card.dataset.issueId = issue.id;

		// Drag handlers
		card.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData("text/plain", issue.id);
			card.addClass("kb-dragging");
		});
		card.addEventListener("dragend", () => {
			card.removeClass("kb-dragging");
		});

		// Click to open detail
		card.addEventListener("click", () => {
			this.selectedIssue = issue;
			void this.loadComments(issue.id).then(() => this.render());
		});

		// Card top row: identifier + priority
		const topRow = card.createDiv({ cls: "kb-card-top" });
		if (isRunning) {
			topRow.createSpan({ cls: "paperclip-running-dot" });
		}
		topRow.createSpan({ cls: "kb-card-id", text: issue.identifier });
		if (issue.priority) {
			const priIcon = topRow.createSpan({
				cls: `paperclip-priority paperclip-priority-${issue.priority}`,
			});
			const iconMap: Record<string, string> = {
				critical: "chevrons-up",
				high: "chevron-up",
				medium: "minus",
				low: "chevron-down",
			};
			setIcon(priIcon, iconMap[issue.priority] ?? "minus");
		}

		// Title
		card.createDiv({ cls: "kb-card-title", text: issue.title });

		// Project label
		const proj = this.projectName(issue.projectId);
		if (proj) {
			card.createDiv({ cls: "kb-card-project", text: proj });
		}

		// Bottom row: contributor avatars
		const bottomRow = card.createDiv({ cls: "kb-card-bottom" });
		const contribs = this.contributors.get(issue.id) ?? [];
		if (contribs.length > 0) {
			const avatars = bottomRow.createDiv({ cls: "kb-avatars" });
			for (const agentId of contribs.slice(0, 5)) {
				const av = avatars.createSpan({
					cls: "kb-avatar",
					text: this.agentInitials(agentId),
				});
				av.title = this.agentName(agentId);
			}
			if (contribs.length > 5) {
				avatars.createSpan({
					cls: "kb-avatar kb-avatar-more",
					text: `+${contribs.length - 5}`,
				});
			}
		} else if (issue.assigneeAgentId) {
			// Fallback: show assignee only
			const avatars = bottomRow.createDiv({ cls: "kb-avatars" });
			const av = avatars.createSpan({
				cls: "kb-avatar",
				text: this.agentInitials(issue.assigneeAgentId),
			});
			av.title = this.agentName(issue.assigneeAgentId);
		}

		if (isRunning) {
			bottomRow.createSpan({
				cls: "paperclip-running-label",
				text: "working…",
			});
		}
	}

	private renderDetail(container: HTMLElement): void {
		const issue = this.selectedIssue!;

		// Back button
		const nav = container.createDiv({ cls: "paperclip-detail-nav" });
		const backBtn = nav.createEl("button", {
			text: "← back",
			cls: "paperclip-back",
		});
		backBtn.addEventListener("click", () => {
			this.selectedIssue = null;
			this.render();
		});

		// Active run banner
		const isRunning =
			issue.activeRun !== null &&
			issue.activeRun?.status === "running";
		if (isRunning) {
			const banner = container.createDiv({ cls: "paperclip-run-banner" });
			banner.createSpan({ cls: "paperclip-running-dot" });
			const bannerText = banner.createSpan({ cls: "paperclip-run-banner-text" });
			bannerText.setText(
				`${this.agentName(issue.activeRun!.agentId)} is working on this — started ${this.relativeTime(issue.activeRun!.startedAt)}`,
			);
		}

		// Issue header (click to rename)
		const hdr = container.createDiv({ cls: "paperclip-detail-header" });
		const titleEl = hdr.createEl("h3", {
			cls: "paperclip-detail-title",
		});
		titleEl.createSpan({ cls: "paperclip-issue-id", text: issue.identifier + "  " });
		const titleText = titleEl.createSpan({ text: issue.title, cls: "paperclip-title-editable" });
		titleText.title = "Click to rename";
		titleText.addEventListener("click", () => {
			this.startTitleEdit(issue, titleEl);
		});

		// Properties table
		const props = container.createDiv({ cls: "paperclip-detail-props" });

		// Status
		const statusRow = props.createDiv({ cls: "paperclip-prop-row" });
		statusRow.createSpan({ cls: "paperclip-prop-label", text: "Status" });
		const statusChip = statusRow.createSpan({
			cls: `paperclip-status paperclip-status-${issue.status} paperclip-status-clickable`,
			text: issue.status.replace("_", " "),
		});
		statusChip.title = "Click to change status";
		statusChip.addEventListener("click", () => {
			this.openStatusMenu(issue, statusChip);
		});

		// Priority
		const priRow = props.createDiv({ cls: "paperclip-prop-row" });
		priRow.createSpan({ cls: "paperclip-prop-label", text: "Priority" });
		const priChip = priRow.createSpan({
			cls: "paperclip-assignee-chip",
			text: issue.priority ?? "none",
		});
		priChip.title = "Click to change priority";
		priChip.addEventListener("click", () => {
			this.openPriorityMenu(issue, priChip);
		});

		// Assignee
		const assignRow = props.createDiv({ cls: "paperclip-prop-row" });
		assignRow.createSpan({ cls: "paperclip-prop-label", text: "Assignee" });
		const isAssignedToMe = issue.assigneeAgentId === null && issue.assigneeUserId === "local-board";
		const assigneeChip = assignRow.createSpan({
			cls: "paperclip-assignee-chip",
			text: isAssignedToMe ? "You" : this.agentName(issue.assigneeAgentId),
		});
		assigneeChip.addEventListener("click", () => {
			this.openAssignModal(issue);
		});
		assigneeChip.title = "Click to reassign";

		// Project
		const projRow = props.createDiv({ cls: "paperclip-prop-row" });
		projRow.createSpan({ cls: "paperclip-prop-label", text: "Project" });
		const projChip = projRow.createSpan({
			cls: "paperclip-assignee-chip",
			text: this.projectName(issue.projectId) ?? "None",
		});
		projChip.addEventListener("click", () => {
			this.openProjectModal(issue);
		});
		projChip.title = "Click to change project";

		// Description
		if (issue.description) {
			const descriptionSection = container.createDiv({ cls: "paperclip-description" });
			const descBody = descriptionSection.createDiv({
				cls: `paperclip-description-body${this.descriptionExpanded ? "" : " is-collapsed"}`,
			});
			void MarkdownRenderer.render(
				this.app,
				issue.description,
				descBody,
				"",
				this,
			);
			this.linkifyVaultPaths(descBody);

			const lineCount = issue.description.split(/\r?\n/).length;
			const isLongDescription = lineCount > 4 || issue.description.length > 320;
			if (isLongDescription) {
				const toggle = descriptionSection.createEl("button", {
					cls: "paperclip-description-toggle",
					text: this.descriptionExpanded ? "Show less" : "Show more",
				});
				toggle.addEventListener("click", () => {
					this.descriptionExpanded = !this.descriptionExpanded;
					this.renderPreservingScroll();
				});
			}
		}

		// Action buttons
		const actions = container.createDiv({ cls: "paperclip-actions" });

		// "Add comment" toggle button
		const addCommentBtn = actions.createEl("button", {
			text: "Add comment",
			cls: "paperclip-add-comment-btn mod-cta",
		});

		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			void this.loadIssues().then(async () => {
				const updated = this.issues.find((i) => i.id === issue.id);
				if (updated) this.selectedIssue = updated;
				await this.loadComments(issue.id);
				this.render();
				new Notice("Refreshed");
			});
		});

		const openWebBtn = actions.createEl("button", {
			cls: "paperclip-open-web clickable-icon",
			attr: { "aria-label": "Open in web UI" },
		});
		setIcon(openWebBtn, "external-link");
		openWebBtn.addEventListener("click", () => {
			const url = `${this.plugin.settings.apiBaseUrl}/issues/${issue.identifier}`;
			window.open(url, "_blank");
		});

		// Inline comment form (hidden by default)
		const formWrapper = container.createDiv({ cls: "paperclip-inline-comment-wrapper is-hidden" });
		addCommentBtn.addEventListener("click", () => {
			const isHidden = formWrapper.hasClass("is-hidden");
			formWrapper.toggleClass("is-hidden", !isHidden);
			addCommentBtn.setText(isHidden ? "Cancel" : "Add comment");
			addCommentBtn.toggleClass("mod-cta", isHidden);
			addCommentBtn.toggleClass("mod-warning", !isHidden);
			this.commentFormOpen = isHidden;
			if (isHidden) {
				const ta = formWrapper.querySelector("textarea");
				if (ta) ta.focus();
			}
		});
		this.renderInlineCommentForm(formWrapper, issue);

		// Referenced files from comments
		this.renderReferencedFiles(container, issue);

		// Comments thread
		const thread = container.createDiv({ cls: "paperclip-comments" });

		// Header row with toggle
		const threadHeader = thread.createDiv({ cls: "paperclip-comments-header" });
		threadHeader.createEl("h4", { text: `Activity (${this.comments.length})` });
		if (this.comments.length > 0) {
			const toggleBtn = threadHeader.createEl("button", {
				cls: "paperclip-activity-toggle clickable-icon",
				attr: { "aria-label": this.activityExpanded ? "Collapse" : "Expand" },
			});
			setIcon(toggleBtn, this.activityExpanded ? "chevrons-down-up" : "chevrons-up-down");
			toggleBtn.addEventListener("click", () => {
				this.activityExpanded = !this.activityExpanded;
				this.expandedCommentIds.clear();
				this.render();
			});
		}

		if (this.comments.length === 0) {
			thread.createDiv({
				cls: "paperclip-empty",
				text: "No activity yet",
			});
		} else {
			for (const c of this.comments) {
				const isAgent = !!c.authorAgentId;
				const author = isAgent
					? this.agentName(c.authorAgentId)
					: c.authorUserId === "local-board" ? "You" : c.authorUserId || "Board";
				const initials = author
					.split(/\s+/)
					.map((w) => w[0])
					.join("")
					.toUpperCase()
					.slice(0, 2);

				const commentExpanded = this.activityExpanded || this.expandedCommentIds.has(c.id);
				const card = thread.createDiv({
					cls: `paperclip-comment ${isAgent ? "is-agent" : "is-user"}${commentExpanded ? "" : " is-folded"}`,
				});

				// Click folded comment to expand just that one.
				// Expanded comments should not collapse on ordinary clicks, so text selection works normally.
				if (!this.activityExpanded && !commentExpanded) {
					card.addClass("paperclip-comment-clickable");
					card.addEventListener("click", () => {
						this.toggleExpandedComment(c.id);
					});
				}

				// Avatar + header row
				const cHeader = card.createDiv({ cls: "paperclip-comment-header" });
				if (!this.activityExpanded && commentExpanded) {
					cHeader.addClass("paperclip-comment-clickable");
					cHeader.addEventListener("click", () => {
						this.toggleExpandedComment(c.id);
					});
				}
				const avatar = cHeader.createSpan({
					cls: `paperclip-comment-avatar ${isAgent ? "is-agent" : "is-user"}`,
					text: initials,
				});
				avatar.title = author;
				const plain = c.body
					.replace(/```[\s\S]*?```/g, " ")
					.replace(/`[^`]+`/g, (m) => m.slice(1, -1))
					.replace(/[[\]#*_~>!|-]+/g, "")
					.replace(/\n+/g, " ")
					.trim();
				const preview = plain.length > 120 ? plain.slice(0, 120) + "\u2026" : plain;
				const headerText = cHeader.createDiv({
					cls: `paperclip-comment-meta${commentExpanded ? "" : " is-folded"}`,
				});
				if (commentExpanded) {
					headerText.createSpan({
						cls: "paperclip-comment-author",
						text: author,
					});
				} else if (preview) {
					headerText.createSpan({
						cls: "paperclip-comment-preview",
						text: preview,
					});
				}
				const dateSpan = headerText.createSpan({
					cls: "paperclip-comment-date",
					text: this.relativeTime(c.createdAt),
				});
				dateSpan.title = new Date(c.createdAt).toLocaleString();
				const headerActions = cHeader.createDiv({ cls: "paperclip-comment-actions" });
				if (commentExpanded) {
					const copyBtn = headerActions.createEl("button", {
						cls: "paperclip-comment-action clickable-icon",
						attr: { "aria-label": "Copy comment" },
					});
					setIcon(copyBtn, "copy");
					copyBtn.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						void this.copyCommentBody(c.body);
					});
				}
				if (!this.activityExpanded) {
					const toggleBtn = headerActions.createEl("button", {
						cls: "paperclip-comment-action clickable-icon",
						attr: { "aria-label": commentExpanded ? "Collapse comment" : "Expand comment" },
					});
					setIcon(toggleBtn, commentExpanded ? "chevron-up" : "chevron-down");
					toggleBtn.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						this.toggleExpandedComment(c.id);
					});
				}

				if (commentExpanded) {
					// Full rendered markdown body
					const cBody = card.createDiv({ cls: "paperclip-comment-body" });
					cBody.addEventListener("click", (e) => {
						e.stopPropagation();
					});
					cBody.addEventListener("mousedown", (e) => {
						e.stopPropagation();
					});
					void MarkdownRenderer.render(
						this.app,
						c.body,
						cBody,
						"",
						this,
					);
					this.linkifyVaultPaths(cBody);
				} else {
					// Folded preview is rendered inline in the header row.
				}
			}
		}
	}

	private toggleExpandedComment(commentId: string): void {
		if (this.expandedCommentIds.has(commentId)) {
			this.expandedCommentIds.delete(commentId);
		} else {
			this.expandedCommentIds.add(commentId);
		}
		this.renderPreservingScroll();
	}

	private async copyCommentBody(body: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(body);
			new Notice("Comment copied");
		} catch {
			new Notice("Failed to copy comment");
		}
	}

	private renderInlineCommentForm(container: HTMLElement, issue: Issue): void {
		let commentBody = "";

		// Default to the latest agent on this issue: most recent agent commenter, or current assignee
		let defaultAgentId = "";
		for (let i = this.comments.length - 1; i >= 0; i--) {
			if (this.comments[i].authorAgentId) {
				defaultAgentId = this.comments[i].authorAgentId!;
				break;
			}
		}
		if (!defaultAgentId && issue.assigneeAgentId) {
			defaultAgentId = issue.assigneeAgentId;
		}
		let selectedAgentId = defaultAgentId;

		const form = container.createDiv({ cls: "paperclip-inline-comment" });

		// Agent assign dropdown
		if (this.agents.length > 0) {
			const assignRow = form.createDiv({ cls: "paperclip-inline-assign" });
			assignRow.createSpan({ cls: "paperclip-inline-assign-label", text: "Assign to" });
			const dd = assignRow.createEl("select", { cls: "paperclip-inline-assign-select dropdown" });
			const noChange = dd.createEl("option", { text: "— no change —" });
			noChange.value = "";
			for (const a of this.agents) {
				const opt = dd.createEl("option", { text: `${a.name} (${a.role})` });
				opt.value = a.id;
			}
			if (defaultAgentId) dd.value = defaultAgentId;
			dd.addEventListener("change", () => { selectedAgentId = dd.value; });
		}

		// Textarea with @mention autocomplete
		const textareaWrapper = form.createDiv({ cls: "paperclip-textarea-wrapper" });
		const textarea = textareaWrapper.createEl("textarea", {
			cls: "paperclip-inline-textarea",
			attr: { placeholder: "Write a comment…", rows: "3" },
		});

		// Autocomplete dropdown for @mentions
		const acDropdown = textareaWrapper.createDiv({ cls: "paperclip-mention-ac is-hidden" });
		let acIndex = 0;
		let acMatches: Agent[] = [];

		const dismissAc = () => {
			acDropdown.addClass("is-hidden");
			acMatches = [];
		};

		const applyAc = (agent: Agent) => {
			const val = textarea.value;
			const cursor = textarea.selectionStart;
			// Find the @ that started this mention
			const before = val.slice(0, cursor);
			const atIdx = before.lastIndexOf("@");
			if (atIdx === -1) { dismissAc(); return; }
			const after = val.slice(cursor);
			const insertion = `@${agent.name} `;
			textarea.value = val.slice(0, atIdx) + insertion + after;
			commentBody = textarea.value;
			const newCursor = atIdx + insertion.length;
			textarea.setSelectionRange(newCursor, newCursor);
			textarea.focus();
			dismissAc();
		};

		const renderAc = () => {
			acDropdown.empty();
			if (acMatches.length === 0) { dismissAc(); return; }
			acDropdown.removeClass("is-hidden");
			for (let i = 0; i < acMatches.length; i++) {
				const agent = acMatches[i];
				const item = acDropdown.createDiv({
					cls: `paperclip-mention-ac-item${i === acIndex ? " is-selected" : ""}`,
					text: `${agent.name} (${agent.role})`,
				});
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					applyAc(agent);
				});
			}
		};

		textarea.addEventListener("input", () => {
			commentBody = textarea.value;
			if (this.agents.length === 0) return;
			const cursor = textarea.selectionStart;
			const before = textarea.value.slice(0, cursor);
			const match = before.match(/@(\w*)$/);
			if (match) {
				const query = match[1].toLowerCase();
				acMatches = this.agents.filter((a) => a.name.toLowerCase().startsWith(query));
				acIndex = 0;
				renderAc();
			} else {
				dismissAc();
			}
		});

		textarea.addEventListener("keydown", (e) => {
			// Stop propagation so Obsidian doesn't intercept standard editor keys
			// (Cmd+Left/Right, Cmd+A, Option+arrows, Shift+arrows, etc.)
			e.stopPropagation();
			if (acMatches.length === 0) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				acIndex = (acIndex + 1) % acMatches.length;
				renderAc();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				acIndex = (acIndex - 1 + acMatches.length) % acMatches.length;
				renderAc();
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				applyAc(acMatches[acIndex]);
			} else if (e.key === "Escape") {
				dismissAc();
			}
		});

		textarea.addEventListener("blur", () => {
			// Small delay so mousedown on dropdown item fires first
			window.setTimeout(() => dismissAc(), 150);
		});

		// Submit button
		const submitBtn = form.createEl("button", {
			text: "Post comment",
			cls: "paperclip-inline-submit mod-cta",
		});
		submitBtn.addEventListener("click", () => {
			if (!commentBody.trim()) return;
			submitBtn.disabled = true;
			submitBtn.setText("Posting…");

			const action = selectedAgentId
				? this.plugin.api.updateIssue(issue.id, {
						assigneeAgentId: selectedAgentId,
						assigneeUserId: null,
						comment: commentBody,
					}).then(async () => {
						issue.assigneeAgentId = selectedAgentId;
						// Bounce status: backlog → in_progress so the agent picks it up
						await this.plugin.api.updateIssue(issue.id, { status: "backlog" });
						await this.plugin.api.updateIssue(issue.id, { status: "in_progress" });
						issue.status = "in_progress";
						const agentLabel = this.agentName(selectedAgentId);
						new Notice(`Comment posted & assigned to ${agentLabel}`);
					})
				: this.plugin.api.addComment(issue.id, commentBody).then(() => {
						new Notice("Comment posted");
					});

			this.commentFormOpen = false;
			void action
				.then(() => this.loadComments(issue.id))
				.then(() => this.render())
				.catch((e: unknown) => {
					new Notice(`Failed: ${String(e)}`);
					submitBtn.disabled = false;
					submitBtn.setText("Post comment");
				});
		});
	}

	private static readonly FILE_EXT_RE = VAULT_FILE_EXT_RE;

	/** Try to resolve a candidate string to a vault file path; returns the path or null */
	private resolveVaultPath(raw: string): string | null {
		return resolveVaultPathHelper(this.app, raw);
	}

	/** Extract unique vault file paths referenced in comments and the issue description */
	private collectReferencedFiles(issue: Issue): string[] {
		const sources: string[] = [];
		if (issue.description) sources.push(issue.description);
		for (const comment of this.comments) sources.push(comment.body);
		return extractReferencedVaultFiles(this.app, sources);
	}

	private renderReferencedFiles(container: HTMLElement, issue: Issue): void {
		const files = this.collectReferencedFiles(issue);
		if (files.length === 0) return;

		const section = container.createDiv({ cls: "paperclip-ref-files" });
		section.createEl("h4", { text: `Referenced Files (${files.length})` });
		const list = section.createEl("ul", { cls: "paperclip-ref-files-list" });
		for (const filePath of files) {
			const li = list.createEl("li");
			const link = li.createEl("a", {
				cls: "paperclip-ref-file-link",
				text: filePath,
				href: "#",
			});
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(filePath, "");
			});
		}
	}

	/** Convert file paths in rendered markdown into clickable file links */
	private linkifyVaultPaths(el: HTMLElement): void {
		const codeEls = el.querySelectorAll("code");
		for (const code of Array.from(codeEls)) {
			const text = code.textContent ?? "";
			const resolved = this.resolveFileReference(text);
			if (!resolved) continue;
			code.addClass("paperclip-vault-link");
			code.title = `Open ${resolved.target}`;
			code.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.openResolvedFileReference(resolved);
			});
		}

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				const parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest("code, pre, a")) return NodeFilter.FILTER_REJECT;
				const text = node.textContent ?? "";
				return this.findVaultPathMatches(text).length > 0
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_REJECT;
			},
		});

		const textNodes: Text[] = [];
		let current = walker.nextNode();
		while (current) {
			textNodes.push(current as Text);
			current = walker.nextNode();
		}

		for (const textNode of textNodes) {
			const source = textNode.textContent ?? "";
			const matches = this.findVaultPathMatches(source);
			if (matches.length === 0) continue;

			const fragment = document.createDocumentFragment();
			let cursor = 0;
			for (const match of matches) {
				if (match.start > cursor) {
					fragment.appendChild(document.createTextNode(source.slice(cursor, match.start)));
				}
				const link = document.createElement("a");
				link.href = "#";
				link.className = "paperclip-ref-file-link";
				link.textContent = match.display;
				link.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.openResolvedFileReference(match);
				});
				fragment.appendChild(link);
				cursor = match.end;
			}
			if (cursor < source.length) {
				fragment.appendChild(document.createTextNode(source.slice(cursor)));
			}
			textNode.parentNode?.replaceChild(fragment, textNode);
		}
	}

	private findVaultPathMatches(
		text: string,
	): Array<{ start: number; end: number; display: string; target: string; kind: "vault" | "external" }> {
		const matches: Array<{ start: number; end: number; display: string; target: string; kind: "vault" | "external" }> = [];
		const patterns = [
			/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
			/(^|[\s(>])((?:\.?\/)?[^\s()[\]{}<>`",;]+\/[^\s()[\]{}<>`",;]+)(?=$|[\s),:;!?<])/g,
			/(^|[\s(>])((?:\.?\/)?[^\s()[\]{}<>`",;]+(?:\/[^\s()[\]{}<>`",;]+)*\.[A-Za-z0-9_-]+)(?=$|[\s),.:;!?<])/g,
			/(^|[\s(>])((?:\/|~\/)[^\s()[\]{}<>`",;]+)(?=$|[\s),:;!?<])/g,
		];

		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(text)) !== null) {
				const candidate = pattern === patterns[0] ? match[1].trim() : match[2].trim();
				const resolved = this.resolveFileReference(candidate);
				if (!resolved) continue;

				const start = pattern === patterns[0]
					? match.index
					: match.index + match[1].length;
				const display = pattern === patterns[0]
					? (match[2]?.trim() || match[1].trim())
					: match[2].trim();
				const end = start + (pattern === patterns[0] ? match[0].length : match[2].length);

				if (matches.some((existing) => !(end <= existing.start || start >= existing.end))) {
					continue;
				}

				matches.push({ start, end, display, ...resolved });
			}
		}

		return matches.sort((a, b) => a.start - b.start);
	}

	private resolveFileReference(raw: string): { target: string; kind: "vault" | "external" } | null {
		const cleaned = raw
			.replace(/^\.[/\\]/, "")
			.replace(/[:@#](\d+[-–]?\d*)$/, "")
			.trim();
		if (!cleaned) return null;

		const vaultPath = this.resolveVaultPath(cleaned);
		if (vaultPath) {
			return { target: vaultPath, kind: "vault" };
		}

		const externalPath = this.resolveExternalFilePath(cleaned);
		if (externalPath) {
			return { target: externalPath, kind: "external" };
		}

		return null;
	}

	private resolveExternalFilePath(raw: string): string | null {
		if (!this.looksLikeFileReference(raw)) return null;

		const requireFn = (window as Window & { require?: NodeJS.Require }).require;
		if (!requireFn) return null;

		try {
			const path = requireFn("path") as typeof import("path");
			const fs = requireFn("fs") as typeof import("fs");
			const expandedRaw = raw.startsWith("~/")
				? path.join(requireFn("os").homedir(), raw.slice(2))
				: raw;
			const candidates = new Set<string>();
			if (path.isAbsolute(expandedRaw)) {
				candidates.add(path.normalize(expandedRaw));
			} else {
				const basePath = this.getVaultBasePath();
				if (basePath) candidates.add(path.normalize(path.join(basePath, expandedRaw)));
				candidates.add(path.normalize(expandedRaw));
			}

			for (const candidate of candidates) {
				if (!fs.existsSync(candidate)) continue;
				try {
					if (fs.statSync(candidate).isFile()) return candidate;
				} catch {
					continue;
				}
			}
		} catch {
			return null;
		}

		return null;
	}

	private looksLikeFileReference(raw: string): boolean {
		return (
			raw.includes("/") ||
			raw.includes("\\") ||
			raw.startsWith("~/") ||
			/^[A-Za-z]:[\\/]/.test(raw) ||
			PaperclipView.FILE_EXT_RE.test(raw)
		);
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	private async openResolvedFileReference(
		ref: { target: string; kind: "vault" | "external" },
	): Promise<void> {
		if (ref.kind === "vault") {
			await this.app.workspace.openLinkText(ref.target, "");
			return;
		}

		const requireFn = (window as Window & { require?: NodeJS.Require }).require;
		if (!requireFn) {
			new Notice("Opening external files is not available here");
			return;
		}

		try {
			const electron = requireFn("electron") as { shell?: { openPath: (path: string) => Promise<string> } };
			const result = await electron.shell?.openPath(ref.target);
			if (result) {
				new Notice(`Failed to open file: ${result}`);
			}
		} catch (e) {
			new Notice(`Failed to open file: ${String(e)}`);
		}
	}

	private startTitleEdit(issue: Issue, container: HTMLElement): void {
		container.empty();
		container.createSpan({ cls: "paperclip-issue-id", text: issue.identifier + "  " });
		const input = container.createEl("input", {
			cls: "paperclip-title-input",
			type: "text",
			value: issue.title,
		});
		input.focus();
		input.select();

		const save = async () => {
			const newTitle = input.value.trim();
			if (!newTitle || newTitle === issue.title) {
				this.render();
				return;
			}
		try {
			await this.plugin.api.updateIssue(issue.id, { title: newTitle });
			issue.title = newTitle;
			const idx = this.issues.findIndex((i) => i.id === issue.id);
			if (idx >= 0) this.issues[idx] = { ...this.issues[idx], title: newTitle };
			new Notice("Title updated");
		} catch (e) {
			new Notice(`Failed: ${String(e)}`);
		}
			this.render();
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void save();
			} else if (e.key === "Escape") {
				this.render();
			}
		});
		input.addEventListener("blur", () => { void save(); });
	}

	// ── Modal helpers ──────────────────────────────────────────────────

	openCreateIssueModal(): void {
		const activeFile = this.app.workspace.getActiveFile();
		const filePath = activeFile ? activeFile.path : null;

		new CreateIssueModal(
			this.app,
			this.agents,
			this.projects,
			filePath,
			this.selectedProjectId,
			async (result) => {
				try {
					const data: Record<string, unknown> = {
						title: result.title,
						description: result.description,
						priority: result.priority,
						status: "todo",
					};
					if (result.assignToMe) {
						// Will set assigneeUserId after creation
					} else if (result.assigneeAgentId) {
						data.assigneeAgentId = result.assigneeAgentId;
					}
					if (result.projectId) {
						data.projectId = result.projectId;
					}
					const created = await this.plugin.api.createIssue(
						this.selectedCompanyId,
						data as CreateIssueData,
					);
					if (result.assignToMe) {
						await this.plugin.api.updateIssue(created.id, {
							assigneeUserId: "local-board",
						});
					}
					new Notice("Issue created");
					await this.loadIssues();
					this.render();
			} catch (e) {
				new Notice(`Failed to create issue: ${String(e)}`);
			}
		},
		).open();
	}

	private openPriorityMenu(issue: Issue, anchor: HTMLElement): void {
		const menu = new Menu();
		const priorities = ["critical", "high", "medium", "low"];
		const labels: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
		for (const p of priorities) {
			menu.addItem((item) => {
				item.setTitle(labels[p])
					.setChecked(issue.priority === p)
					.onClick(() => {
						if (issue.priority === p) return;
						void this.plugin.api.updateIssue(issue.id, {
							priority: p,
						}).then(() => {
							issue.priority = p;
							new Notice(`Priority → ${labels[p]}`);
							this.render();
						}).catch((e: unknown) => {
							new Notice(`Failed: ${String(e)}`);
						});
					});
			});
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private openStatusMenu(issue: Issue, anchor: HTMLElement): void {
		const menu = new Menu();
		const statuses = [
			"backlog",
			"todo",
			"in_progress",
			"in_review",
			"blocked",
			"done",
			"cancelled",
		];
		const statusLabel = (s: string) => {
			const words = s.split("_");
			return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
		};
		for (const s of statuses) {
			menu.addItem((item) => {
				item.setTitle(statusLabel(s))
					.setChecked(issue.status === s)
					.onClick(() => {
						if (issue.status === s) return;
						void this.plugin.api.updateIssue(issue.id, {
							status: s,
						}).then(() => {
							issue.status = s;
							new Notice(`Status → ${statusLabel(s)}`);
							this.render();
						}).catch((e: unknown) => {
							new Notice(`Failed: ${String(e)}`);
						});
					});
			});
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private openProjectModal(issue: Issue): void {
		new ProjectModal(
			this.app,
			this.projects,
			(project) => {
				void this.plugin.api.updateIssue(issue.id, {
					projectId: project?.id ?? null,
					projectWorkspaceId: null,
				}).then(() => {
					issue.projectId = project?.id ?? null;
					new Notice(
						project
							? `Project: ${project.name}`
							: "Project removed",
					);
					this.render();
				}).catch((e: unknown) => {
					new Notice(`Failed to set project: ${String(e)}`);
				});
			},
			async (name) => {
				const p = await this.plugin.api.createProject(
					this.selectedCompanyId,
					name,
				);
				this.projects.push(p);
				return p;
			},
		).open();
	}

	private openAssignModal(issue: Issue): void {
		new AssignModal(this.app, this.agents, (agent, special) => {
			const doAssign = special === ASSIGN_TO_ME
				? this.plugin.api.updateIssue(issue.id, {
						assigneeAgentId: null,
						assigneeUserId: "local-board",
					}).then(() => {
						issue.assigneeAgentId = null;
						issue.assigneeUserId = "local-board";
						new Notice("Assigned to you");
					})
				: this.plugin.api.updateIssue(issue.id, {
						assigneeAgentId: agent?.id ?? null,
						assigneeUserId: null,
					}).then(() => {
						issue.assigneeAgentId = agent?.id ?? null;
						issue.assigneeUserId = null;
						new Notice(
							agent
								? `Assigned to ${agent.name}`
								: "Unassigned",
						);
					});
			void doAssign.then(() => {
				const idx = this.issues.findIndex((i) => i.id === issue.id);
				if (idx >= 0) this.issues[idx] = { ...issue };
				if (this.selectedIssue?.id === issue.id) {
					this.selectedIssue = { ...issue };
				}
				this.render();
		}).catch((e: unknown) => {
			new Notice(`Failed to assign: ${String(e)}`);
		});
		}).open();
	}
}
