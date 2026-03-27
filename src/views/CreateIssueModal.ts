import { App, Modal, Setting } from "obsidian";
import type { Agent, Project } from "../api";

export const ASSIGN_ME_ID = "__me__";

export interface CreateIssueResult {
	title: string;
	description: string;
	priority: string;
	assigneeAgentId?: string;
	assignToMe?: boolean;
	projectId?: string;
}

export interface CreateIssuePrefill {
	title?: string;
	description?: string;
	priority?: string;
	assigneeAgentId?: string;
	projectId?: string;
}

export class CreateIssueModal extends Modal {
	private issueTitle = "";
	private description = "";
	private priority = "medium";
	private selectedAgentId = "";
	private selectedProjectId = "";
	private includeFilePath = false;
	private agents: Agent[];
	private projects: Project[];
	private activeFilePath: string | null;
	private onSubmit: (result: CreateIssueResult) => Promise<void>;

	constructor(
		app: App,
		agents: Agent[],
		projects: Project[],
		activeFilePath: string | null,
		defaultProjectId: string,
		onSubmit: (result: CreateIssueResult) => Promise<void>,
		prefill?: CreateIssuePrefill,
	) {
		super(app);
		this.agents = agents;
		this.projects = projects;
		this.activeFilePath = activeFilePath;
		this.selectedProjectId = prefill?.projectId ?? defaultProjectId;
		this.onSubmit = onSubmit;

		// Apply prefill
		if (prefill) {
			this.issueTitle = prefill.title ?? "";
			this.description = prefill.description ?? "";
			this.priority = prefill.priority ?? "medium";
			if (prefill.assigneeAgentId) this.selectedAgentId = prefill.assigneeAgentId;
		}

		// Default to the CEO-role agent if no prefill assignee
		if (!this.selectedAgentId) {
			const ceo = agents.find((a) => a.role === "ceo");
			if (ceo) this.selectedAgentId = ceo.id;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paperclip-create-modal");
	contentEl.createEl("h3", { text: "Create issue" });

		// 1. Title
		new Setting(contentEl)
			.setName("Title")
			.addText((text) =>
				text
					.setPlaceholder("Issue title")
					.setValue(this.issueTitle)
					.onChange((v) => {
						this.issueTitle = v;
					}),
			);

		// 2. Description
		new Setting(contentEl)
			.setName("Description")
			.addTextArea((ta) => {
				ta.setPlaceholder("Describe the issue…")
					.setValue(this.description)
					.onChange((v) => {
						this.description = v;
					});
				ta.inputEl.rows = 6;
				ta.inputEl.addClass("paperclip-comment-textarea");
			});

		// 3. Project
		if (this.projects.length > 0) {
			new Setting(contentEl)
				.setName("Project")
				.addDropdown((dd) => {
					dd.addOption("", "— no project —");
					for (const p of this.projects.filter((p) => !p.archivedAt)) {
						dd.addOption(p.id, p.name);
					}
					dd.setValue(this.selectedProjectId);
					dd.onChange((v) => {
						this.selectedProjectId = v;
					});
				});
		}

		// 4. Assign to
		new Setting(contentEl)
			.setName("Assign to")
			.addDropdown((dd) => {
				dd.addOption(ASSIGN_ME_ID, "👤 assign to me");
				dd.addOption("", "— unassigned —");
				for (const a of this.agents) {
					dd.addOption(a.id, `${a.name} (${a.role})`);
				}
				dd.setValue(this.selectedAgentId);
				dd.onChange((v) => {
					this.selectedAgentId = v;
				});
			});

		// 4. Include file path as context
		new Setting(contentEl)
			.setName("Include current file as context")
			.setDesc(this.activeFilePath ?? "No file open")
			.addToggle((toggle) => {
				toggle.setValue(this.includeFilePath);
				if (!this.activeFilePath) {
					toggle.setDisabled(true);
				} else {
					toggle.onChange((v) => {
						this.includeFilePath = v;
					});
				}
			});

		// 5. Priority
		new Setting(contentEl)
			.setName("Priority")
			.addDropdown((dd) => {
				dd.addOption("critical", "Critical");
				dd.addOption("high", "High");
				dd.addOption("medium", "Medium");
				dd.addOption("low", "Low");
				dd.setValue(this.priority);
				dd.onChange((v) => {
					this.priority = v;
				});
			});

		// Submit
		let submitting = false;
		const doSubmit = async () => {
			if (submitting || !this.issueTitle.trim()) return;
			submitting = true;

			let desc = this.description;
			if (this.includeFilePath && this.activeFilePath) {
				const ctx = `\n\n---\n**Context:** \`${this.activeFilePath}\``;
				desc = desc ? desc + ctx : ctx.trim();
			}

		const isMe = this.selectedAgentId === ASSIGN_ME_ID;
		try {
				await this.onSubmit({
					title: this.issueTitle,
					description: desc,
					priority: this.priority,
					assigneeAgentId: isMe ? undefined : (this.selectedAgentId || undefined),
					assignToMe: isMe,
					projectId: this.selectedProjectId || undefined,
				});
			} finally {
				this.close();
			}
		};

	new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create issue")
				.setCta()
				.onClick(() => { void doSubmit(); }),
		);

		// Cmd+Enter to submit
		contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void doSubmit();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
