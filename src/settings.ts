import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PaperclipPlugin from "./main";
import type { AuthMode } from "./auth";
import {
	AI_PROVIDER_LABELS,
	applyAiProviderPreset,
	type AiProviderId,
} from "./ai";

const AUTH_MODE_OPTIONS: Record<AuthMode, string> = {
	none: "No auth (local_trusted)",
	bearer: "Bearer token",
	session: "Paperclip session",
	custom_header: "Custom header",
};

export class PaperclipSettingTab extends PluginSettingTab {
	plugin: PaperclipPlugin;
	private sessionPassword = "";

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
			.setName("Auth mode")
			.setDesc("How this plugin should authenticate to the Paperclip API")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(AUTH_MODE_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.authMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.authMode = value as AuthMode;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (this.plugin.settings.authMode === "bearer") {
			new Setting(containerEl)
				.setName("Bearer token")
				.setDesc(
					"Board API token or bearer token for authenticated/private instances",
				)
				.addText((text) =>
					text
						.setPlaceholder("Enter bearer token")
						.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		if (this.plugin.settings.authMode === "custom_header") {
			new Setting(containerEl)
				.setName("Header name")
				.setDesc("Custom auth header name, e.g. X-Forwarded-User")
				.addText((text) =>
					text
						.setPlaceholder("Header name")
						.setValue(this.plugin.settings.customAuthHeaderName)
						.onChange(async (value) => {
							this.plugin.settings.customAuthHeaderName = value.trim();
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Header value")
				.setDesc("Custom auth header value sent with every Paperclip API request")
				.addText((text) =>
					text
						.setPlaceholder("Header value")
						.setValue(this.plugin.settings.customAuthHeaderValue)
						.onChange(async (value) => {
							this.plugin.settings.customAuthHeaderValue = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		if (this.plugin.settings.authMode === "session") {
			new Setting(containerEl)
				.setName("Session email")
				.setDesc("Email address for Better Auth sign-in")
				.addText((text) =>
					text
						.setPlaceholder("name@example.com")
						.setValue(this.plugin.settings.sessionEmail)
						.onChange(async (value) => {
							this.plugin.settings.sessionEmail = value.trim();
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Session password")
				.setDesc("Used only for sign-in and not saved to plugin settings")
				.addText((text) => {
					text.setPlaceholder("Enter password");
					text.inputEl.type = "password";
					text.setValue(this.sessionPassword);
					text.onChange((value) => {
						this.sessionPassword = value;
					});
				});

			new Setting(containerEl)
				.setName("Session status")
				.setDesc(this.plugin.getSessionStatusLabel())
				.addButton((button) =>
					button
						.setButtonText("Sign in")
						.setCta()
						.onClick(async () => {
							const email = this.plugin.settings.sessionEmail.trim();
							if (!email) {
								new Notice("Enter your Paperclip account email first");
								return;
							}
							if (!this.sessionPassword) {
								new Notice("Enter your Paperclip account password first");
								return;
							}
							try {
								await this.plugin.signInWithSession(
									email,
									this.sessionPassword,
								);
								this.sessionPassword = "";
								this.display();
							} catch (error) {
								new Notice(`Paperclip sign-in failed: ${String(error)}`);
							}
						}),
				)
				.addButton((button) =>
					button
						.setButtonText("Check session")
						.onClick(async () => {
							try {
								await this.plugin.refreshSessionStatus();
								this.display();
							} catch (error) {
								new Notice(`Paperclip session check failed: ${String(error)}`);
							}
						}),
				)
				.addButton((button) =>
					button
						.setButtonText("Sign out")
						.setDisabled(!this.plugin.settings.sessionCookie)
						.onClick(async () => {
							try {
								await this.plugin.signOutSession();
								this.sessionPassword = "";
								this.display();
							} catch (error) {
								new Notice(`Paperclip sign-out failed: ${String(error)}`);
							}
						}),
				);
		}

		new Setting(containerEl)
			.setName("Default company ID")
			.setDesc("Company to select on open (leave empty to show selector)")
			.addText((text) =>
				text
					.setPlaceholder("UUID")
					.setValue(this.plugin.settings.defaultCompanyId)
					.onChange(async (value) => {
						this.plugin.settings.defaultCompanyId = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "AI provider" });

		new Setting(containerEl)
			.setName("Provider preset")
			.setDesc(
				"Choose the AI provider used for Smart action, Work on document, and Review document.",
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(AI_PROVIDER_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.ai.providerId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.ai = applyAiProviderPreset(
						this.plugin.settings.ai,
						value as AiProviderId,
					);
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (this.plugin.settings.ai.providerId !== "openai") {
			new Setting(containerEl)
				.setName("Provider name")
				.setDesc("Optional label for this compatible gateway or custom provider")
				.addText((text) =>
					text
						.setPlaceholder("Compatible gateway")
						.setValue(this.plugin.settings.ai.customName)
						.onChange(async (value) => {
							this.plugin.settings.ai.customName = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc(
				this.plugin.settings.ai.providerId === "openai"
					? "OpenAI-compatible API base URL"
					: "OpenAI-compatible API base URL, for example http://localhost:4000/v1",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.ai.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.ai.apiBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model name sent to the configured AI provider")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o-mini")
					.setValue(this.plugin.settings.ai.model)
					.onChange(async (value) => {
						this.plugin.settings.ai.model = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Bearer token used for AI-powered issue creation")
			.addText((text) => {
				text.setPlaceholder("Enter AI provider API key");
				text.setValue(this.plugin.settings.ai.apiKey);
				text.inputEl.type = "password";
				text.onChange(async (value) => {
					this.plugin.settings.ai.apiKey = value;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h4", { text: "Extra headers" });
		const extraHeaders = this.plugin.settings.ai.extraHeaders;
		if (extraHeaders.length === 0) {
			containerEl.createEl("p", {
				text: "No extra headers configured.",
				cls: "setting-item-description",
			});
		}
		extraHeaders.forEach((header, index) => {
			new Setting(containerEl)
				.setName(`Header ${index + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Header name")
						.setValue(header.name)
						.onChange(async (value) => {
							this.plugin.settings.ai.extraHeaders[index].name = value;
							await this.plugin.saveSettings();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder("Header value")
						.setValue(header.value)
						.onChange(async (value) => {
							this.plugin.settings.ai.extraHeaders[index].value = value;
							await this.plugin.saveSettings();
						}),
				)
				.addButton((button) =>
					button.setButtonText("Remove").onClick(async () => {
						this.plugin.settings.ai.extraHeaders.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
				);
		});

		new Setting(containerEl)
			.setName("Header actions")
			.setDesc("Optional headers for compatible gateways or proxy setups")
			.addButton((button) =>
				button.setButtonText("Add header").onClick(async () => {
					this.plugin.settings.ai.extraHeaders.push({ name: "", value: "" });
					await this.plugin.saveSettings();
					this.display();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Test provider").setCta().onClick(async () => {
					try {
						await this.plugin.testAiProvider();
						new Notice("AI provider test succeeded");
					} catch (error) {
						new Notice(`AI provider test failed: ${String(error)}`);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Refresh interval")
			.setDesc("Auto-refresh issue list (seconds, 0 to disable)")
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.refreshIntervalSec))
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
