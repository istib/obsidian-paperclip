import { App, Modal, Setting } from "obsidian";
import type { Issue, Agent } from "../api";

export interface CommentResult {
	body: string;
	assignAgentId?: string;
}

export class CommentModal extends Modal {
	private body = "";
	private selectedAgentId = "";
	private onSubmit: (result: CommentResult) => Promise<void>;
	private issue: Issue;
	private agents: Agent[];

	constructor(
		app: App,
		issue: Issue,
		agents: Agent[],
		onSubmit: (result: CommentResult) => Promise<void>,
	) {
		super(app);
		this.issue = issue;
		this.agents = agents;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", {
			text: `Comment on ${this.issue.identifier}`,
		});

		// Assign agent dropdown
		if (this.agents.length > 0) {
			const currentName = this.issue.assigneeAgentId
				? this.agents.find((a) => a.id === this.issue.assigneeAgentId)?.name ?? "Unknown"
				: "Unassigned";
			new Setting(contentEl)
				.setName("Assign to agent")
				.setDesc(`Currently: ${currentName}`)
				.addDropdown((dd) => {
					dd.addOption("", "— no change —");
					for (const a of this.agents) {
						dd.addOption(a.id, `${a.name} (${a.role})`);
					}
					dd.setValue(this.selectedAgentId);
					dd.onChange((v) => {
						this.selectedAgentId = v;
					});
				});
		}

		// Agent mention hint
		if (this.agents.length > 0) {
			const hint = contentEl.createDiv({ cls: "paperclip-mention-hint" });
			hint.createSpan({ text: "Mention agents: " });
			for (const a of this.agents) {
				const chip = hint.createEl("button", {
					text: `@${a.name}`,
					cls: "paperclip-mention-chip",
				});
				chip.addEventListener("click", () => {
					this.body += ` @${a.name} `;
					textarea.setValue(this.body);
				});
			}
		}

		// Textarea
		let textarea: ReturnType<typeof Setting.prototype.addTextArea extends (cb: (t: infer T) => void) => unknown ? T : never>;
		new Setting(contentEl)
			.setName("Comment body")
			.setDesc("Write markdown with agent mentions.")
			.addTextArea((ta) => {
				textarea = ta;
				ta.setPlaceholder("Write your comment…")
					.setValue(this.body)
					.onChange((v) => {
						this.body = v;
					});
				ta.inputEl.rows = 8;
				ta.inputEl.addClass("paperclip-comment-textarea");
			});

		// Submit
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Post comment")
				.setCta()
				.onClick(() => {
					if (!this.body.trim()) return;
					btn.setDisabled(true);
					btn.setButtonText("Posting…");
					void this.onSubmit({
						body: this.body,
						assignAgentId: this.selectedAgentId || undefined,
					}).then(() => {
						this.close();
					});
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
