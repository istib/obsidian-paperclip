import { App, SuggestModal } from "obsidian";
import type { Agent } from "../api";

/** Sentinel value for "assign to me" */
export const ASSIGN_TO_ME = "__me__";

interface AgentOption {
	agent: Agent | null;
	display: string;
	special?: string;
}

export class AssignModal extends SuggestModal<AgentOption> {
	private agents: Agent[];
	private onChoose: (agent: Agent | null, special?: string) => Promise<void>;

	constructor(
		app: App,
		agents: Agent[],
		onChoose: (agent: Agent | null, special?: string) => Promise<void>,
	) {
		super(app);
		this.agents = agents;
		this.onChoose = onChoose;
		this.setPlaceholder("Select agent to assign…");
	}

	getSuggestions(query: string): AgentOption[] {
		const q = query.toLowerCase();
		const options: AgentOption[] = [
			{ agent: null, display: "👤 Assign to me", special: ASSIGN_TO_ME },
			{ agent: null, display: "Unassign" },
			...this.agents.map((a) => ({
				agent: a,
				display: `${a.name} — ${a.role}${a.title ? ` (${a.title})` : ""} [${a.status}]`,
			})),
		];
		if (!q) return options;
		return options.filter((o) => o.display.toLowerCase().includes(q));
	}

	renderSuggestion(item: AgentOption, el: HTMLElement): void {
		el.createDiv({ text: item.display });
	}

	async onChooseSuggestion(item: AgentOption): Promise<void> {
		await this.onChoose(item.agent, item.special);
	}
}
