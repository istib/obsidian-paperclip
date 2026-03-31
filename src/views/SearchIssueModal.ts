import { FuzzySuggestModal } from "obsidian";
import type { App } from "obsidian";
import type { Issue } from "../api";

const ACTIVE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export class SearchIssueModal extends FuzzySuggestModal<Issue> {
	private allIssues: Issue[];
	private activeOnly = false;
	private onSelect: (issue: Issue) => void;

	constructor(app: App, issues: Issue[], onSelect: (issue: Issue) => void) {
		super(app);
		this.allIssues = issues;
		this.onSelect = onSelect;
		this.setPlaceholder("Search issues by name or ID…");
	}

	onOpen(): void {
		super.onOpen();
		const filterBar = document.createElement("div");
		filterBar.addClass("paperclip-search-filter-bar");
		const toggleBtn = filterBar.createEl("button", {
			cls: "paperclip-search-filter-btn",
			text: "Active only",
		});
		toggleBtn.addEventListener("click", (e) => {
			e.preventDefault();
			this.activeOnly = !this.activeOnly;
			toggleBtn.toggleClass("is-active", this.activeOnly);
			// re-trigger FuzzySuggestModal's suggestion update
			this.inputEl.dispatchEvent(new Event("input"));
		});
		this.inputEl.parentElement!.after(filterBar);
	}

	getItems(): Issue[] {
		if (this.activeOnly) {
			return this.allIssues.filter((i) => ACTIVE_STATUSES.has(i.status));
		}
		return this.allIssues;
	}

	getItemText(issue: Issue): string {
		return `${issue.identifier} ${issue.title}`;
	}

	renderSuggestion(match: { item: Issue }, el: HTMLElement): void {
		const issue = match.item;
		const wrapper = el.createDiv({ cls: "paperclip-search-suggestion" });
		wrapper.createSpan({ cls: "paperclip-issue-id", text: issue.identifier });
		wrapper.createSpan({ cls: "paperclip-search-title", text: issue.title });
		wrapper.createSpan({
			cls: `paperclip-status paperclip-status-${issue.status}`,
			text: issue.status.replace("_", " "),
		});
	}

	onChooseItem(issue: Issue): void {
		this.onSelect(issue);
	}
}
