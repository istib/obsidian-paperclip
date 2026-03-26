import { App, SuggestModal } from "obsidian";
import type { Project } from "../api";

const CREATE_NEW = "__create_new__";

interface ProjectOption {
	project: Project | null;
	display: string;
	isCreate?: boolean;
	createName?: string;
}

export class ProjectModal extends SuggestModal<ProjectOption> {
	private projects: Project[];
	private onChoose: (project: Project | null) => Promise<void>;
	private onCreate: ((name: string) => Promise<Project>) | null;

	constructor(
		app: App,
		projects: Project[],
		onChoose: (project: Project | null) => Promise<void>,
		onCreate?: (name: string) => Promise<Project>,
	) {
		super(app);
		this.projects = projects;
		this.onChoose = onChoose;
		this.onCreate = onCreate ?? null;
		this.setPlaceholder("Select or type to create project…");
	}

	getSuggestions(query: string): ProjectOption[] {
		const q = query.toLowerCase().trim();
		const existing: ProjectOption[] = this.projects
			.filter((p) => !p.archivedAt)
			.map((p) => ({ project: p, display: p.name }));

		const filtered = q
			? existing.filter((o) => o.display.toLowerCase().includes(q))
			: existing;

		const options: ProjectOption[] = [
			{ project: null, display: "— No project —" },
			...filtered,
		];

		// Offer to create if query doesn't exactly match an existing project
		if (
			q &&
			this.onCreate &&
			!existing.some((o) => o.display.toLowerCase() === q)
		) {
			options.push({
				project: null,
				display: `+ Create "${query.trim()}"`,
				isCreate: true,
				createName: query.trim(),
			});
		}

		return options;
	}

	renderSuggestion(item: ProjectOption, el: HTMLElement): void {
		if (item.isCreate) {
			el.createDiv({ text: item.display, cls: "paperclip-create-option" });
		} else {
			el.createDiv({ text: item.display });
		}
	}

	onChooseSuggestion(item: ProjectOption): void {
		if (item.isCreate && item.createName && this.onCreate) {
			void this.onCreate(item.createName).then((newProject) => {
				void this.onChoose(newProject);
			});
		} else {
			void this.onChoose(item.project);
		}
	}
}
