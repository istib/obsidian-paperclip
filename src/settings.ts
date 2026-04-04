import { App, PluginSettingTab, Setting } from "obsidian";
import type PaperclipPlugin from "./main";

export interface PaperclipSettings {
	apiBaseUrl: string;
	apiKey: string;
	defaultCompanyId: string;
	refreshIntervalSec: number;
	openaiApiKey: string;
}

export const DEFAULT_SETTINGS: PaperclipSettings = {
	apiBaseUrl: "http://localhost:3100",
	apiKey: "",
	defaultCompanyId: "",
	refreshIntervalSec: 60,
	openaiApiKey: "",
};

export class PaperclipSettingTab extends PluginSettingTab {
	plugin: PaperclipPlugin;

	constructor(app: App, plugin: PaperclipPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Paperclip server URL (e.g. http://localhost:3100)")
			.addText((text) =>
				text
					.setPlaceholder("Enter server URL")
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				"Optional bearer token for authenticated/private mode instances",
			)
			.addText((text) =>
				text
					.setPlaceholder("Leave empty for local_trusted mode")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default company ID")
			.setDesc(
				"Company to select on open (leave empty to show selector)",
			)
			.addText((text) =>
				text
					.setPlaceholder("UUID")
					.setValue(this.plugin.settings.defaultCompanyId)
					.onChange(async (value) => {
						this.plugin.settings.defaultCompanyId = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("OpenAI key")
			.setDesc(
				"For AI-powered issue creation from selected text",
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter API key")
					.setValue(this.plugin.settings.openaiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Refresh interval")
			.setDesc("Auto-refresh issue list (seconds, 0 to disable)")
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(
						String(this.plugin.settings.refreshIntervalSec),
					)
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.refreshIntervalSec = n;
							await this.plugin.saveSettings();
						}
					}),
			);
	}
}
