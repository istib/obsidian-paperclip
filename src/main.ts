import { Notice, Plugin, requestUrl } from "obsidian";
import { PaperclipApi } from "./api";
import {
	PaperclipSettings,
	DEFAULT_SETTINGS,
	PaperclipSettingTab,
} from "./settings";
import { PaperclipView, VIEW_TYPE, BOARD_VIEW_TYPE } from "./views/PaperclipView";
import { CreateIssueModal } from "./views/CreateIssueModal";
import { SearchIssueModal } from "./views/SearchIssueModal";
import type { Agent, Project } from "./api";

export default class PaperclipPlugin extends Plugin {
	settings: PaperclipSettings = DEFAULT_SETTINGS;
	api: PaperclipApi = new PaperclipApi(DEFAULT_SETTINGS.apiBaseUrl);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.api = new PaperclipApi(
			this.settings.apiBaseUrl,
			this.settings.apiKey || undefined,
		);

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
				displayText: "Paperclip Board",
				boardView: true,
			}),
		);

		// Ribbon icon
		this.addRibbonIcon("paperclip", "Open Paperclip", () => {
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.api.updateConfig(
			this.settings.apiBaseUrl,
			this.settings.apiKey || undefined,
		);
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
			const companyId =
				this.settings.defaultCompanyId || companies[0]?.id;
			if (!companyId) {
				new Notice("Paperclip: no companies found");
				return;
			}
		const agents = await this.api.listAgents(companyId);
			const projects = await this.api.listProjects(companyId);
			const activeFile = this.app.workspace.getActiveFile();

			new CreateIssueModal(
				this.app,
				agents,
				projects,
				activeFile?.path ?? null,
				"",
			async (result) => {
					try {
						const created = await this.api.createIssue(companyId, {
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
		const openaiKey = this.settings.openaiApiKey;
		if (!openaiKey) {
			new Notice("Set your OpenAI API key in Paperclip settings first");
			return;
		}

		try {
			// Resolve company, agents, projects
			let agents: Agent[] = [];
			let projects: Project[] = [];
			let companyId = "";

			const view = this.getOpenPaperclipView();
			if (view) {
				agents = view.getAgents();
				projects = view.getProjects();
				companyId = view.getSelectedCompanyId();
			}
			if (!companyId) {
				const companies = await this.api.listCompanies();
				companyId = this.settings.defaultCompanyId || companies[0]?.id;
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

			// Build agent + project lists for the LLM
			const agentList = agents
				.map((a) => `- ${a.name} (${a.role}): ${a.capabilities || "general"}`)
				.join("\n");
			const projectList = projects
				.filter((p) => !p.archivedAt)
				.map((p) => `- ${p.name}`)
				.join("\n");

		const hasSelection = !!selection;

			// Derive review output path
			const dotIdx = filePath.lastIndexOf(".");
			const reviewPath =
				dotIdx > 0
					? `${filePath.slice(0, dotIdx)} - Review${filePath.slice(dotIdx)}`
					: `${filePath} - Review`;

			const noticeMsg: Record<string, string> = {
				work: hasSelection ? "Creating issue from selection…" : "Creating issue from document…",
				review: "Preparing review request…",
				auto: "Analyzing document…",
			};
			new Notice(noticeMsg[intent]);

			const userContent = hasSelection
				? `## Selected text\n${selection}\n\n## Full file (${filePath})\n${fileContent.slice(0, 12000)}`
				: `## Full document (${filePath})\n${fileContent.slice(0, 12000)}`;

			const intentPrompts: Record<string, string> = {
				work: hasSelection
					? `You create actionable Paperclip issues from highlighted text. Focus on the selection but use the full file for context. The issue should describe concrete work to be done.`
					: `You create actionable Paperclip issues from documents. Analyze the document and create an issue for the most important work that needs to be done based on its content (implementation, follow-up, next steps, etc).`,
				review: `You create Paperclip review issues. The user wants a thorough review of this document. The review should be written into a new file at \`${reviewPath}\`. Include in the description: what to review, what to look for, and where to write the output.`,
				auto: `You analyze documents and create the most appropriate Paperclip issue. Determine whether the document needs: follow-up work, a review, implementation, or something else. Then create the best-fit issue. If it looks like meeting notes or a report, create follow-up actions. If it looks like a spec or plan, create implementation tasks. If it looks like a draft, suggest a review.`,
			};

			const resp = await requestUrl({
				url: "https://api.openai.com/v1/chat/completions",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${openaiKey}`,
				},
				body: JSON.stringify({
					model: "gpt-4o-mini",
					temperature: 0.3,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "system",
							content: `${intentPrompts[intent]}

Return JSON with:
- "title": concise issue title (max 80 chars)
- "description": markdown description with clear acceptance criteria. Reference the source file.
- "priority": one of "critical", "high", "medium", "low"
- "assignee": the exact name of the best-fit agent from the list below, or null
- "project": the exact name of the best-fit project from the list below, or null

Available agents:
${agentList}

Available projects:
${projectList}

File: ${filePath}`,
						},
						{
							role: "user",
							content: userContent,
						},
					],
				}),
			});

			const parsed = JSON.parse(
				resp.json.choices[0].message.content,
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
				agents,
				projects,
				activeFile?.path ?? null,
				"",
			async (result) => {
					try {
						const created = await this.api.createIssue(companyId, {
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
				const companyId =
					this.settings.defaultCompanyId || companies[0]?.id;
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
