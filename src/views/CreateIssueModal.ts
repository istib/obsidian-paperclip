import { App, Modal, Setting, TFile } from "obsidian";
import type { Agent, Project } from "../api";
import {
	appendContextFileLink,
	getVaultFileSuggestions,
	insertWikiLink,
} from "../utils/vaultContext";

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

interface FileAutocompleteState {
	query: string;
	rangeStart: number;
	rangeEnd: number;
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
	private descriptionTextarea: HTMLTextAreaElement | null = null;
	private descriptionTextareaShell: HTMLDivElement | null = null;
	private fileAutocompleteEl: HTMLDivElement | null = null;
	private fileAutocompleteMatches: TFile[] = [];
	private fileAutocompleteIndex = 0;
	private fileAutocompleteState: FileAutocompleteState | null = null;

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

		if (prefill) {
			this.issueTitle = prefill.title ?? "";
			this.description = prefill.description ?? "";
			this.priority = prefill.priority ?? "medium";
			if (prefill.assigneeAgentId) this.selectedAgentId = prefill.assigneeAgentId;
		}

		if (!this.selectedAgentId) {
			const ceo = agents.find((a) => a.role === "ceo");
			if (ceo) this.selectedAgentId = ceo.id;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paperclip-create-modal");
		contentEl.createEl("h3", { text: "Create Paperclip issue" });

		new Setting(contentEl)
			.setName("Title")
			.addText((text) =>
				text
					.setPlaceholder("Issue title")
					.setValue(this.issueTitle)
					.onChange((value) => {
						this.issueTitle = value;
					}),
			);

		const descriptionField = contentEl.createDiv({ cls: "paperclip-create-field" });
		descriptionField.createDiv({ cls: "paperclip-create-field-label", text: "Description" });
		const descriptionShell = descriptionField.createDiv({
			cls: "paperclip-create-textarea-shell paperclip-textarea-wrapper",
		});
		const descriptionTextarea = descriptionShell.createEl("textarea", {
			cls: "paperclip-comment-textarea",
			attr: {
			placeholder: "Describe the issue… use [[file name]] to include files as context.",
				rows: "8",
			},
		});
		descriptionTextarea.value = this.description;
		descriptionTextarea.addEventListener("input", () => {
			this.description = descriptionTextarea.value;
		});
		this.descriptionTextarea = descriptionTextarea;
		this.descriptionTextareaShell = descriptionShell;
		this.wireFileAutocomplete(descriptionTextarea);

		new Setting(contentEl)
			.setName("Include current file as context")
			.setDesc(this.activeFilePath ?? "No file open")
			.addToggle((toggle) => {
				toggle.setValue(this.includeFilePath);
				if (!this.activeFilePath) {
					toggle.setDisabled(true);
				} else {
					toggle.onChange((value) => {
						this.includeFilePath = value;
					});
				}
			});

		if (this.projects.length > 0) {
			new Setting(contentEl)
				.setName("Project")
				.addDropdown((dd) => {
					dd.addOption("", "— no project —");
					for (const project of this.projects.filter((project) => !project.archivedAt)) {
						dd.addOption(project.id, project.name);
					}
					dd.setValue(this.selectedProjectId);
					dd.onChange((value) => {
						this.selectedProjectId = value;
					});
				});
		}

		new Setting(contentEl)
			.setName("Assign to")
			.addDropdown((dd) => {
				dd.addOption(ASSIGN_ME_ID, "👤 assign to me");
				dd.addOption("", "— unassigned —");
				for (const agent of this.agents) {
					dd.addOption(agent.id, `${agent.name} (${agent.role})`);
				}
				dd.setValue(this.selectedAgentId);
				dd.onChange((value) => {
					this.selectedAgentId = value;
				});
			});

		new Setting(contentEl)
			.setName("Priority")
			.addDropdown((dd) => {
				dd.addOption("critical", "Critical");
				dd.addOption("high", "High");
				dd.addOption("medium", "Medium");
				dd.addOption("low", "Low");
				dd.setValue(this.priority);
				dd.onChange((value) => {
					this.priority = value;
				});
			});

		let submitting = false;
		const doSubmit = async () => {
			if (submitting || !this.issueTitle.trim()) return;
			submitting = true;

			let description = this.description;
			if (this.includeFilePath && this.activeFilePath) {
				description = appendContextFileLink(this.app, description, this.activeFilePath);
			}

			const isMe = this.selectedAgentId === ASSIGN_ME_ID;
			try {
				await this.onSubmit({
					title: this.issueTitle,
					description,
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
				.onClick(() => {
					void doSubmit();
				}),
		);

		contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void doSubmit();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private wireFileAutocomplete(textarea: HTMLTextAreaElement): void {
		const shell = this.descriptionTextareaShell;
		if (!shell) return;

		this.fileAutocompleteEl = shell.createDiv({ cls: "paperclip-file-ac is-hidden" });

		const refreshAutocomplete = () => {
			this.updateFileAutocomplete();
		};

		textarea.addEventListener("input", refreshAutocomplete);
		textarea.addEventListener("click", refreshAutocomplete);
		textarea.addEventListener("keyup", refreshAutocomplete);
		textarea.addEventListener("blur", () => {
			window.setTimeout(() => this.dismissFileAutocomplete(), 150);
		});
		textarea.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (this.fileAutocompleteMatches.length === 0) return;

			if (event.key === "ArrowDown") {
				event.preventDefault();
				this.fileAutocompleteIndex =
					(this.fileAutocompleteIndex + 1) % this.fileAutocompleteMatches.length;
				this.renderFileAutocomplete();
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				this.fileAutocompleteIndex =
					(this.fileAutocompleteIndex - 1 + this.fileAutocompleteMatches.length) %
					this.fileAutocompleteMatches.length;
				this.renderFileAutocomplete();
			} else if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				this.applyFileAutocomplete(this.fileAutocompleteMatches[this.fileAutocompleteIndex]);
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.dismissFileAutocomplete();
			}
		});
	}

	private updateFileAutocomplete(): void {
		if (!this.descriptionTextarea) return;

		const state = this.getFileAutocompleteState(this.descriptionTextarea);
		if (!state) {
			this.dismissFileAutocomplete();
			return;
		}

		this.fileAutocompleteState = state;
		this.fileAutocompleteMatches = getVaultFileSuggestions(this.app, state.query, 12);
		this.fileAutocompleteIndex = 0;
		this.renderFileAutocomplete();
	}

	private renderFileAutocomplete(): void {
		if (!this.fileAutocompleteEl || !this.descriptionTextarea) return;
		this.fileAutocompleteEl.empty();

		if (this.fileAutocompleteMatches.length === 0) {
			this.dismissFileAutocomplete();
			return;
		}

		this.fileAutocompleteEl.removeClass("is-hidden");
		for (let i = 0; i < this.fileAutocompleteMatches.length; i++) {
			const file = this.fileAutocompleteMatches[i];
			const item = this.fileAutocompleteEl.createDiv({
				cls: `paperclip-file-ac-item${i === this.fileAutocompleteIndex ? " is-selected" : ""}`,
			});
			item.createDiv({ text: file.basename });
			if (file.path !== file.basename) {
				item.createSmall({
					text: file.path,
					cls: "paperclip-file-suggestion-path",
				});
			}
			item.addEventListener("mousedown", (event) => {
				event.preventDefault();
				this.applyFileAutocomplete(file);
			});
		}

		this.positionFileAutocomplete();
	}

	private dismissFileAutocomplete(): void {
		if (this.fileAutocompleteEl) this.fileAutocompleteEl.addClass("is-hidden");
		this.fileAutocompleteMatches = [];
		this.fileAutocompleteState = null;
	}

	private applyFileAutocomplete(file: TFile): void {
		this.insertFileLink(file.path, true);
	}

	private insertFileLink(filePath: string, replaceAutocompleteTarget: boolean): void {
		if (!this.descriptionTextarea) return;

		const textarea = this.descriptionTextarea;
		const rangeStart = replaceAutocompleteTarget && this.fileAutocompleteState
			? this.fileAutocompleteState.rangeStart
			: textarea.selectionStart ?? textarea.value.length;
		const rangeEnd = replaceAutocompleteTarget && this.fileAutocompleteState
			? this.fileAutocompleteState.rangeEnd
			: textarea.selectionEnd ?? textarea.value.length;

		const { value, cursor } = insertWikiLink(textarea.value, rangeStart, rangeEnd, filePath);
		textarea.value = value;
		textarea.setSelectionRange(cursor, cursor);
		textarea.focus();
		this.description = value;
		this.dismissFileAutocomplete();
	}

	private getFileAutocompleteState(textarea: HTMLTextAreaElement): FileAutocompleteState | null {
		const cursor = textarea.selectionStart ?? textarea.value.length;
		const beforeCursor = textarea.value.slice(0, cursor);
		const openIndex = beforeCursor.lastIndexOf("[[");
		if (openIndex === -1) return null;

		const token = beforeCursor.slice(openIndex + 2);
		if (token.includes("]]") || token.includes("\n")) return null;

		return {
			query: token.trim(),
			rangeStart: openIndex,
			rangeEnd: cursor,
		};
	}

	private positionFileAutocomplete(): void {
		if (!this.fileAutocompleteEl || !this.descriptionTextarea) return;

		const coords = this.getCaretCoordinates(
			this.descriptionTextarea,
			this.descriptionTextarea.selectionStart ?? this.descriptionTextarea.value.length,
		);
		const textarea = this.descriptionTextarea;
		const dropdown = this.fileAutocompleteEl;
		const dropdownWidth = Math.min(Math.max(textarea.clientWidth * 0.6, 220), 360);
		const maxLeft = Math.max(8, textarea.clientWidth - dropdownWidth - 8);
		const lineHeight = this.getTextareaLineHeight(textarea);
		const desiredTop = coords.top + lineHeight + 6;

		dropdown.style.width = `${dropdownWidth}px`;
		dropdown.style.left = `${Math.min(coords.left, maxLeft)}px`;
		dropdown.style.top = `${Math.min(desiredTop, textarea.clientHeight - 12)}px`;

		const overflowBottom =
			dropdown.offsetTop + dropdown.offsetHeight - (textarea.clientHeight - 8);
		if (overflowBottom > 0) {
			dropdown.style.top = `${Math.max(8, dropdown.offsetTop - overflowBottom)}px`;
		}
	}

	private getTextareaLineHeight(textarea: HTMLTextAreaElement): number {
		const computed = window.getComputedStyle(textarea);
		const parsed = Number.parseFloat(computed.lineHeight);
		if (Number.isFinite(parsed)) return parsed;
		const fontSize = Number.parseFloat(computed.fontSize);
		return Number.isFinite(fontSize) ? fontSize * 1.4 : 20;
	}

	private getCaretCoordinates(
		textarea: HTMLTextAreaElement,
		position: number,
	): { left: number; top: number } {
		const shell = this.descriptionTextareaShell;
		if (!shell) return { left: 8, top: 8 };

		const computed = window.getComputedStyle(textarea);
		const mirror = document.createElement("div");
		const properties = [
			"boxSizing",
			"width",
			"height",
			"overflowX",
			"overflowY",
			"borderTopWidth",
			"borderRightWidth",
			"borderBottomWidth",
			"borderLeftWidth",
			"paddingTop",
			"paddingRight",
			"paddingBottom",
			"paddingLeft",
			"fontStyle",
			"fontVariant",
			"fontWeight",
			"fontStretch",
			"fontSize",
			"fontFamily",
			"lineHeight",
			"letterSpacing",
			"textTransform",
			"textIndent",
			"textAlign",
			"whiteSpace",
			"wordBreak",
			"overflowWrap",
		] as const;

		mirror.style.position = "absolute";
		mirror.style.visibility = "hidden";
		mirror.style.pointerEvents = "none";
		mirror.style.whiteSpace = "pre-wrap";
		mirror.style.wordBreak = "break-word";
		mirror.style.overflowWrap = "break-word";
		mirror.style.top = "0";
		mirror.style.left = "0";

		for (const property of properties) {
			// Mirror textarea layout so span offsets line up with the caret position.
			mirror.style[property] = computed[property];
		}

		mirror.textContent = textarea.value.slice(0, position);
		const caret = document.createElement("span");
		caret.textContent = textarea.value.slice(position, position + 1) || " ";
		mirror.appendChild(caret);
		shell.appendChild(mirror);

		const left = Math.max(8, caret.offsetLeft - textarea.scrollLeft + 8);
		const top = Math.max(8, caret.offsetTop - textarea.scrollTop + 8);
		mirror.remove();

		return { left, top };
	}
}
