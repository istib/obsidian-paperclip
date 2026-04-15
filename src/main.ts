import { Notice, Plugin, requestUrl } from "obsidian";
import { PaperclipApi } from "./api";
import {
	DEFAULT_SETTINGS,
	migratePaperclipSettings,
	serializePaperclipSettings,
	type PaperclipSettings,
} from "./settings-data";
import { PaperclipSettingTab } from "./settings";
import { PaperclipView, VIEW_TYPE, BOARD_VIEW_TYPE } from "./views/PaperclipView";
import { CreateIssueModal } from "./views/CreateIssueModal";
import { SearchIssueModal } from "./views/SearchIssueModal";
import type { Agent, Company, Project } from "./api";
import {
	AiSuggestionService,
	createAiBackendRegistry,
	validateAiSettings,
} from "./ai";

export default class PaperclipPlugin extends Plugin {
	settings: PaperclipSettings = DEFAULT_SETTINGS;
	api: PaperclipApi = new PaperclipApi({
		baseUrl: DEFAULT_SETTINGS.apiBaseUrl,
		authMode: DEFAULT_SETTINGS.authMode,
		apiKey: DEFAULT_SETTINGS.apiKey,
		sessionCookie: DEFAULT_SETTINGS.sessionCookie,
		customAuthHeaderName: DEFAULT_SETTINGS.customAuthHeaderName,
		customAuthHeaderValue: DEFAULT_SETTINGS.customAuthHeaderValue,
	});
	private readonly aiSuggestionService = new AiSuggestionService(
		createAiBackendRegistry(requestUrl),
	);

	private resolveCompanyId(companies: Company[]): string {
		if (companies.length === 0) return "";
		const savedCompanyId = this.settings.defaultCompanyId;
		if (
			savedCompanyId &&
			companies.some((company) => company.id === savedCompanyId)
		) {
			return savedCompanyId;
		}
		return companies[0]?.id ?? "";
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.api = new PaperclipApi(this.buildApiConfig());

		// Register the sidebar issue browser and full-page board
		this.registerView(
			VIEW_TYPE,
			(leaf) => new PaperclipView(leaf, this, {
				viewType: VIEW_TYPE,
				displayText: "Paperclip",
			}),
		);
		this.registerView(
			BOARD_VIEW_TYPE,
			(leaf) => new PaperclipView(leaf, this, {
				viewType: BOARD_VIEW_TYPE,
				displayText: "Paperclip board",
				boardView: true,
			}),
		);

		// Ribbon icon
		this.addRibbonIcon("paperclip", "Open paperclip", () => {
			void this.activateIssueBrowser();
		});

		// Commands
		this.addCommand({
			id: "open-issue-browser",
			name: "Open issue browser",
			callback: () => { void this.activateIssueBrowser(); },
		});

		this.addCommand({
			id: "open-board",
			name: "Open kanban board",
			callback: () => { void this.activateBoardView(); },
		});

		this.addCommand({
			id: "create-issue",
			name: "Create issue",
			callback: () => { void this.openCreateIssue(); },
		});

		this.addCommand({
			id: "search-issue",
			name: "Search issues",
			callback: () => { void this.openSearchIssues(); },
		});

		this.addCommand({
			id: "work-on-document",
			name: "Work on this document (AI)",
			checkCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) void this.createIssueWithAI("", "work");
				return true;
			},
		});

		this.addCommand({
			id: "review-document",
			name: "Review this document (AI)",
			checkCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) void this.createIssueWithAI("", "review");
				return true;
			},
		});

		this.addCommand({
			id: "smart-action",
			name: "Smart action (AI)",
			editorCallback: (editor) => {
				const sel = editor.getSelection()?.trim() || "";
				void this.createIssueWithAI(sel, "auto");
			},
		});

		// Register editor context menu
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const sel = editor.getSelection()?.trim() || "";
				const file = this.app.workspace.getActiveFile();
				if (!file) return;

				if (sel) {
					menu.addItem((item) => {
						item.setTitle("📎 create issue from selection")
							.setIcon("paperclip")
							.onClick(() => { void this.createIssueWithAI(sel, "work"); });
					});
				} else {
					menu.addItem((item) => {
						item.setTitle("📎 work on this document")
							.setIcon("paperclip")
							.onClick(() => { void this.createIssueWithAI("", "work"); });
					});
					menu.addItem((item) => {
						item.setTitle("📎 review this document")
							.setIcon("eye")
							.onClick(() => { void this.createIssueWithAI("", "review"); });
					});
				}
			}),
		);

		// Settings tab
		this.addSettingTab(new PaperclipSettingTab(this.app, this));
	}

	onunload(): void {
		// View cleanup is handled by Obsidian automatically
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		this.settings = migratePaperclipSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(serializePaperclipSettings(this.settings));
		this.api.updateConfig(this.buildApiConfig());
	}

	async testAiProvider(): Promise<void> {
		const validationError = validateAiSettings(this.settings.ai);
		if (validationError) {
			throw new Error(validationError);
		}
		await this.aiSuggestionService.testProvider(this.settings.ai);
	}

	async refreshOpenPaperclipViews(companyId?: string): Promise<void> {
		const leaves = [
			...this.app.workspace.getLeavesOfType(VIEW_TYPE),
			...this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE),
		];

		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof PaperclipView)) continue;
			if (companyId && view.getSelectedCompanyId() !== companyId) continue;
			await view.refreshData();
		}
	}

	getSessionStatusLabel(): string {
		if (this.settings.authMode !== "session") {
			return "Session auth is not enabled";
		}
		if (!this.settings.sessionCookie) {
			return "Not signed in";
		}
		if (this.settings.sessionUserDisplay) {
			return `Signed in as ${this.settings.sessionUserDisplay}`;
		}
		return "Session cookie saved";
	}

	async signInWithSession(email: string, password: string): Promise<void> {
		const session = await this.api.signInEmail(email, password);
		this.settings.authMode = "session";
		this.settings.sessionEmail = email;
		this.settings.sessionCookie = this.api.getSessionCookie();
		this.settings.sessionUserDisplay =
			session.user.email ?? session.user.name ?? session.user.id;
		await this.saveSettings();
		new Notice(`Signed in to Paperclip as ${this.settings.sessionUserDisplay}`);
	}

	async refreshSessionStatus(): Promise<void> {
		if (!this.settings.sessionCookie) {
			this.settings.sessionUserDisplay = "";
			await this.saveSettings();
			new Notice("No Paperclip session is stored");
			return;
		}
		const session = await this.api.getSession();
		if (!session) {
			this.settings.sessionCookie = "";
			this.settings.sessionUserDisplay = "";
			await this.saveSettings();
			new Notice("Paperclip session is no longer valid");
			return;
		}
		this.settings.sessionCookie = this.api.getSessionCookie();
		this.settings.sessionUserDisplay =
			session.user.email ?? session.user.name ?? session.user.id;
		await this.saveSettings();
		new Notice(`Paperclip session is valid for ${this.settings.sessionUserDisplay}`);
	}

	async signOutSession(): Promise<void> {
		await this.api.signOutSession();
		this.settings.sessionCookie = "";
		this.settings.sessionUserDisplay = "";
		await this.saveSettings();
		new Notice("Signed out of Paperclip");
	}

	private buildApiConfig() {
		return {
			baseUrl: this.settings.apiBaseUrl,
			authMode: this.settings.authMode,
			apiKey: this.settings.apiKey,
			sessionCookie: this.settings.sessionCookie,
			customAuthHeaderName: this.settings.customAuthHeaderName,
			customAuthHeaderValue: this.settings.customAuthHeaderValue,
		};
	}

	private async openCreateIssue(): Promise<void> {
		// If a Paperclip view exists, delegate to it (it has agents cached)
		const view = this.getOpenPaperclipView();
		if (view) {
			view.openCreateIssueModal();
			return;
		}

		// Standalone: fetch agents and open modal directly
		try {
			const companies = await this.api.listCompanies();
			const companyId = this.resolveCompanyId(companies);
			if (!companyId) {
				new Notice("Paperclip: no companies found");
				return;
			}
		const agents = await this.api.listAgents(companyId);
			const projects = await this.api.listProjects(companyId);
			const activeFile = this.app.workspace.getActiveFile();

			new CreateIssueModal(
				this.app,
				companies,
				companyId,
				agents,
				projects,
				activeFile?.path ?? null,
				"",
				async (selectedCompanyId) => ({
					agents: await this.api.listAgents(selectedCompanyId),
					projects: await this.api.listProjects(selectedCompanyId),
				}),
				async (result) => {
					try {
						const created = await this.api.createIssue(result.companyId, {
							title: result.title,
							description: result.description,
							priority: result.priority,
							status: "todo",
							assigneeAgentId: result.assignToMe ? undefined : result.assigneeAgentId,
							projectId: result.projectId,
						});
						if (result.assignToMe) {
							await this.api.updateIssue(created.id, { assigneeUserId: "local-board" });
						}
						new Notice("Issue created");
						await this.refreshOpenPaperclipViews(result.companyId);
				} catch (e) {
					new Notice(`Failed to create issue: ${String(e)}`);
				}
				},
			).open();
		} catch (e) {
			new Notice(`Paperclip: ${String(e)}`);
		}
	}

	private async createIssueWithAI(
		selection: string,
		intent: "work" | "review" | "auto" = "auto",
	): Promise<void> {
		const validationError = validateAiSettings(this.settings.ai);
		if (validationError) {
			new Notice(validationError);
			return;
		}

		try {
			// Resolve company, agents, projects
			let agents: Agent[] = [];
			let projects: Project[] = [];
			let companies: Company[] = [];
			let companyId = "";

			const view = this.getOpenPaperclipView();
			if (view) {
				agents = view.getAgents();
				projects = view.getProjects();
				companyId = view.getSelectedCompanyId();
			}
			if (!companyId) {
				companies = await this.api.listCompanies();
				companyId = this.resolveCompanyId(companies);
			}
			if (companies.length === 0) {
				companies = await this.api.listCompanies();
				companyId = this.resolveCompanyId(companies);
			}
			if (!companyId) {
				new Notice("Paperclip: no companies found");
				return;
			}
			if (agents.length === 0) agents = await this.api.listAgents(companyId);
			if (projects.length === 0) projects = await this.api.listProjects(companyId);

			const activeFile = this.app.workspace.getActiveFile();
			const filePath = activeFile?.path ?? "unknown";

			// Read full file content
			let fileContent = "";
			if (activeFile) {
				try {
					fileContent = await this.app.vault.read(activeFile);
				} catch {
					// fall back gracefully
				}
			}

			const hasSelection = !!selection;

			const noticeMsg: Record<string, string> = {
				work: hasSelection ? "Creating issue from selection…" : "Creating issue from document…",
				review: "Preparing review request…",
				auto: "Analyzing document…",
			};
			new Notice(noticeMsg[intent]);

			const parsed = await this.aiSuggestionService.suggestIssue(
				this.settings.ai,
				{
					intent,
					selection,
					filePath,
					fileContent,
					agents: agents.map((agent) => ({
						name: agent.name,
						role: agent.role,
						capabilities: agent.capabilities,
					})),
					projects: projects
						.filter((project) => !project.archivedAt)
						.map((project) => ({ name: project.name })),
				},
			);

			// Resolve agent name to ID
			const matchedAgent = parsed.assignee
				? agents.find(
						(a) => a.name.toLowerCase() === parsed.assignee.toLowerCase(),
					)
				: null;

			// Resolve project name to ID
			const matchedProject = parsed.project
				? projects.find(
						(p) => p.name.toLowerCase() === parsed.project.toLowerCase(),
					)
				: null;

			// Open pre-filled create modal
			new CreateIssueModal(
				this.app,
				companies,
				companyId,
				agents,
				projects,
				activeFile?.path ?? null,
				"",
				async (selectedCompanyId) => ({
					agents: await this.api.listAgents(selectedCompanyId),
					projects: await this.api.listProjects(selectedCompanyId),
				}),
				async (result) => {
					try {
						const created = await this.api.createIssue(result.companyId, {
							title: result.title,
							description: result.description,
							priority: result.priority,
							status: "todo",
							assigneeAgentId: result.assignToMe ? undefined : result.assigneeAgentId,
							projectId: result.projectId,
						});
						if (result.assignToMe) {
							await this.api.updateIssue(created.id, { assigneeUserId: "local-board" });
						}
						new Notice("Issue created");
						await this.refreshOpenPaperclipViews(result.companyId);
				} catch (e) {
					new Notice(`Failed to create issue: ${String(e)}`);
				}
				},
				{
					title: parsed.title ?? "",
					description: parsed.description ?? "",
					priority: parsed.priority ?? "medium",
					assigneeAgentId: matchedAgent?.id ?? "",
					projectId: matchedProject?.id ?? "",
				},
			).open();
		} catch (e) {
			new Notice(`AI issue creation failed: ${String(e)}`);
		}
	}

	private async openSearchIssues(): Promise<void> {
		try {
			// Prefer cached issues from any open Paperclip view
			let issues = this.getOpenPaperclipView()?.getIssues() ?? [];

			// Fall back to a fresh fetch if the view isn't open / cache is empty
			if (issues.length === 0) {
				const companies = await this.api.listCompanies();
				const companyId = this.resolveCompanyId(companies);
				if (!companyId) {
					new Notice("Paperclip: no companies found");
					return;
				}
				issues = await this.api.listIssues(companyId);
			}

		new SearchIssueModal(this.app, issues, (issue) => {
				void this.activateIssueBrowser().then(() => {
					const viewLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
					if (viewLeaves.length > 0) {
						(viewLeaves[0].view as PaperclipView).selectIssue(issue);
					}
				});
			}).open();
		} catch (e) {
			new Notice(`Paperclip: ${String(e)}`);
		}
	}

	private getOpenPaperclipView(): PaperclipView | null {
		const leaves = [
			...this.app.workspace.getLeavesOfType(VIEW_TYPE),
			...this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE),
		];
		const view = leaves[0]?.view;
		return view instanceof PaperclipView ? view : null;
	}

	async activateIssueBrowser(sourceView?: PaperclipView): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			if (sourceView) {
				await (existing[0].view as PaperclipView).syncContextFrom(sourceView);
			}
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			if (sourceView && leaf.view instanceof PaperclipView) {
				await leaf.view.syncContextFrom(sourceView);
			}
			await this.app.workspace.revealLeaf(leaf);
		}
	}

	async activateBoardView(sourceView?: PaperclipView): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE);
		if (existing.length > 0) {
			if (sourceView) {
				await (existing[0].view as PaperclipView).syncContextFrom(sourceView);
			}
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		if (leaf) {
			await leaf.setViewState({ type: BOARD_VIEW_TYPE, active: true });
			if (sourceView && leaf.view instanceof PaperclipView) {
				await leaf.view.syncContextFrom(sourceView);
			}
			await this.app.workspace.revealLeaf(leaf);
		}
	}
}
