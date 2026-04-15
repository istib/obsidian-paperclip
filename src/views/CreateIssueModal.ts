import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { Agent, Company, Project } from "../api";
import {
	appendContextFileLink,
	getVaultFileSuggestions,
	insertWikiLink,
} from "../utils/vaultContext";

export const ASSIGN_ME_ID = "__me__";

export interface CreateIssueResult {
	companyId: string;
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

interface CompanyOptions {
	agents: Agent[];
	projects: Project[];
}

export class CreateIssueModal extends Modal {
	private issueTitle = "";
	private description = "";
	private priority = "medium";
	private selectedCompanyId = "";
	private selectedAgentId = "";
	private selectedProjectId = "";
	private includeFilePath = false;
	private companies: Company[];
	private agents: Agent[];
	private projects: Project[];
	private activeFilePath: string | null;
	private onSubmit: (result: CreateIssueResult) => Promise<void>;
	private loadCompanyOptions: (companyId: string) => Promise<CompanyOptions>;
	private loadingCompanyOptions = false;
	private companyLoadVersion = 0;
	private descriptionTextarea: HTMLTextAreaElement | null = null;
	private descriptionTextareaShell: HTMLDivElement | null = null;
	private fileAutocompleteEl: HTMLDivElement | null = null;
	private fileAutocompleteMatches: TFile[] = [];
	private fileAutocompleteIndex = 0;
	private fileAutocompleteState: FileAutocompleteState | null = null;

	constructor(
		app: App,
		companies: Company[],
		selectedCompanyId: string,
		agents: Agent[],
		projects: Project[],
		activeFilePath: string | null,
		defaultProjectId: string,
		loadCompanyOptions: (companyId: string) => Promise<CompanyOptions>,
		onSubmit: (result: CreateIssueResult) => Promise<void>,
		prefill?: CreateIssuePrefill,
	) {
		super(app);
		this.companies = companies;
		this.selectedCompanyId = selectedCompanyId;
		this.agents = agents;
		this.projects = projects;
		this.activeFilePath = activeFilePath;
		this.loadCompanyOptions = loadCompanyOptions;
		this.selectedProjectId = prefill?.projectId ?? defaultProjectId;
		this.onSubmit = onSubmit;

		if (prefill) {
			this.issueTitle = prefill.title ?? "";
			this.description = prefill.description ?? "";
			this.priority = prefill.priority ?? "medium";
			if (prefill.assigneeAgentId) this.selectedAgentId = prefill.assigneeAgentId;
		}

		if (!this.selectedAgentId) {
			this.selectedAgentId = this.getDefaultAgentId(agents);
		}
		this.syncCompanySelections();
	}

	onOpen(): void {
		this.renderContent();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private getSelectedCompany(): Company | null {
		return this.companies.find((company) => company.id === this.selectedCompanyId) ?? null;
	}

	private getSelectedCompanyAccent(): string | null {
		const brandColor = this.getSelectedCompany()?.brandColor?.trim();
		if (!brandColor) return null;
		if (typeof CSS !== "undefined" && !CSS.supports("color", brandColor)) return null;
		return brandColor;
	}

	private applyCompanyTheme(): void {
		const brandColor = this.getSelectedCompanyAccent();
		if (brandColor) {
			this.contentEl.style.setProperty("--paperclip-company-accent", brandColor);
			return;
		}

		this.contentEl.style.removeProperty("--paperclip-company-accent");
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paperclip-create-modal");
		this.applyCompanyTheme();
		contentEl.createEl("h3", { text: "Create paperclip issue" });

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

		if (this.companies.length > 1) {
			new Setting(contentEl)
				.setName("Company")
				.addDropdown((dd) => {
					dd.selectEl.addClass("paperclip-company-select");
					for (const company of this.companies) {
						dd.addOption(company.id, company.name);
					}
					dd.setValue(this.selectedCompanyId);
					dd.setDisabled(this.loadingCompanyOptions);
					dd.onChange((value) => {
						void this.handleCompanyChange(value);
					});
				});
		}

		const projectSetting = new Setting(contentEl).setName("Project");
		if (this.loadingCompanyOptions) {
			projectSetting.setDesc("Loading projects…");
		}
		projectSetting.addDropdown((dd) => {
			dd.addOption("", "— no project —");
			for (const project of this.getAvailableProjects()) {
				dd.addOption(project.id, project.name);
			}
			dd.setValue(this.selectedProjectId);
			dd.setDisabled(this.loadingCompanyOptions);
			dd.onChange((value) => {
				this.selectedProjectId = value;
			});
		});

		const assignSetting = new Setting(contentEl).setName("Assign to");
		if (this.loadingCompanyOptions) {
			assignSetting.setDesc("Loading assignees…");
		}
		assignSetting.addDropdown((dd) => {
			dd.addOption(ASSIGN_ME_ID, "👤 assign to me");
			dd.addOption("", "— unassigned —");
			for (const agent of this.agents) {
				dd.addOption(agent.id, `${agent.name} (${agent.role})`);
			}
			dd.setValue(this.selectedAgentId);
			dd.setDisabled(this.loadingCompanyOptions);
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
					companyId: this.selectedCompanyId,
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
				.setDisabled(this.loadingCompanyOptions)
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

	private getDefaultAgentId(agents: Agent[]): string {
		const ceo = agents.find((agent) => agent.role === "ceo");
		return ceo?.id ?? "";
	}

	private getAvailableProjects(): Project[] {
		return this.projects.filter((project) => !project.archivedAt);
	}

	private syncCompanySelections(): void {
		const availableProjectIds = new Set(
			this.getAvailableProjects().map((project) => project.id),
		);
		if (!availableProjectIds.has(this.selectedProjectId)) {
			this.selectedProjectId = "";
		}

		const availableAgentIds = new Set(this.agents.map((agent) => agent.id));
		if (
			this.selectedAgentId !== ASSIGN_ME_ID &&
			this.selectedAgentId &&
			!availableAgentIds.has(this.selectedAgentId)
		) {
			this.selectedAgentId = "";
		}
		if (!this.selectedAgentId) {
			this.selectedAgentId = this.getDefaultAgentId(this.agents);
		}
	}

	private async handleCompanyChange(companyId: string): Promise<void> {
		if (!companyId || companyId === this.selectedCompanyId) return;

		const previousCompanyId = this.selectedCompanyId;
		const previousAgents = this.agents;
		const previousProjects = this.projects;
		const previousAgentId = this.selectedAgentId;
		const previousProjectId = this.selectedProjectId;

		this.selectedCompanyId = companyId;
		this.loadingCompanyOptions = true;
		this.renderContent();

		const loadVersion = ++this.companyLoadVersion;
		try {
			const { agents, projects } = await this.loadCompanyOptions(companyId);
			if (loadVersion !== this.companyLoadVersion) return;
			this.agents = agents;
			this.projects = projects;
			this.syncCompanySelections();
		} catch (error) {
			if (loadVersion !== this.companyLoadVersion) return;
			this.selectedCompanyId = previousCompanyId;
			this.agents = previousAgents;
			this.projects = previousProjects;
			this.selectedAgentId = previousAgentId;
			this.selectedProjectId = previousProjectId;
			new Notice(`Failed to load company data: ${String(error)}`);
		} finally {
			if (loadVersion === this.companyLoadVersion) {
				this.loadingCompanyOptions = false;
				this.renderContent();
			}
		}
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
			item.createDiv({ text: file.name });
			if (file.path !== file.name) {
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

		dropdown.setCssProps({
			width: `${dropdownWidth}px`,
			left: `${Math.min(coords.left, maxLeft)}px`,
			top: `${Math.min(desiredTop, textarea.clientHeight - 12)}px`,
		});

		const overflowBottom =
			dropdown.offsetTop + dropdown.offsetHeight - (textarea.clientHeight - 8);
		if (overflowBottom > 0) {
			dropdown.setCssProps({
				top: `${Math.max(8, dropdown.offsetTop - overflowBottom)}px`,
			});
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

		mirror.setCssProps({
			position: "absolute",
			visibility: "hidden",
			pointerEvents: "none",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			overflowWrap: "break-word",
			top: "0",
			left: "0",
		});

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
