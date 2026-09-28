import {
	type App,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import {
	beginDeviceFlow,
	generateImage,
	generateText,
	loadImageModels,
	PollinationsError,
	pollDeviceFlow,
	type PollinationsModel,
} from "./api";
import { TokenStore } from "./store";

interface Settings {
	textModel: string;
	imageModel: string;
	resolution: string;
	imageFolder: string;
	appKey: string;
}

const DEFAULTS: Settings = {
	textModel: "openai/gpt-oss-20b",
	imageModel: "",
	resolution: "",
	imageFolder: "pollinations",
	appKey: "",
};

export default class PollinationsPlugin extends Plugin {
	settings: Settings = { ...DEFAULTS };
	private token: string | null = null;
	private store!: TokenStore;
	private cancelPolling = false;
	private imageModels: PollinationsModel[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new TokenStore(this.app, this.manifest.dir ?? this.manifest.id);
		this.token = await this.store.load();

		this.addCommand({
			id: "connect-account",
			name: "Connect account",
			callback: () => void this.connect(),
		});
		this.addCommand({
			id: "disconnect-account",
			name: "Disconnect account",
			callback: () => void this.disconnect(),
		});
		this.addCommand({
			id: "generate-text",
			name: "Generate text from prompt",
			callback: () => void this.promptForText(false),
		});
		this.addCommand({
			id: "generate-text-from-selection",
			name: "Generate text from selection",
			callback: () => void this.promptForText(true),
		});
		this.addCommand({
			id: "generate-image",
			name: "Generate image",
			callback: () => void this.promptForImage(false),
		});
		this.addCommand({
			id: "edit-image",
			name: "Edit image under cursor",
			callback: () => void this.promptForImage(true),
		});

		this.addSettingTab(new PollinationsSettingTab(this.app, this));
	}

	onunload(): void {
		this.cancelPolling = true;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private requireToken(): string {
		if (!this.token) {
			new Notice("Pollinations: connect your account first (command: Connect account).");
			throw new PollinationsError("Not connected.");
		}
		return this.token;
	}

	async connect(): Promise<void> {
		try {
			const code = await beginDeviceFlow(this.settings.appKey || undefined);
			this.cancelPolling = false;
			const modal = new ApprovalModal(this.app, code.userCode, code.approvalUrl, () => {
				this.cancelPolling = true;
			});
			modal.open();
			new Notice(`Pollinations: approve ${code.userCode} in your browser.`);

			const token = await pollDeviceFlow(
				code,
				() => this.cancelPolling,
				(ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
			);
			await this.store.save(token);
			this.token = token;
			modal.close();
			new Notice("Pollinations: account connected.");
		} catch (error) {
			new Notice(`Pollinations: ${this.describe(error)}`);
		}
	}

	async disconnect(): Promise<void> {
		await this.store.clear();
		this.token = null;
		new Notice("Pollinations: disconnected on this device.");
	}

	private describe(error: unknown): string {
		if (error instanceof PollinationsError) return error.message;
		if (error instanceof Error) return error.message;
		return "Something went wrong.";
	}

	private async promptForText(fromSelection: boolean): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Pollinations: open a note first.");
			return;
		}
		const editor = view.editor;
		const selection = fromSelection ? editor.getSelection() : "";
		const captured = editor.getCursor();

		new PromptModal(this.app, fromSelection ? "Describe the change" : "Prompt", async (prompt) => {
			try {
				const token = this.requireToken();
				new Notice("Pollinations: generating text…");
				const text = await generateText(token, this.settings.textModel, prompt);
				editor.replaceRange(text, captured);
			} catch (error) {
				new Notice(`Pollinations: ${this.describe(error)}`);
			}
		}, selection).open();
	}

	private async promptForImage(edit: boolean): Promise<void> {
		if (!this.token) {
			new Notice("Pollinations: connect your account first (command: Connect account).");
			return;
		}
		try {
			if (this.imageModels.length === 0) {
				this.imageModels = await loadImageModels(this.token);
			}
		} catch (error) {
			new Notice(`Pollinations: ${this.describe(error)}`);
			return;
		}

		const file = edit ? this.app.workspace.getActiveFile() : null;
		new PromptModal(this.app, edit ? "Describe the edit" : "Prompt", async (prompt) => {
			try {
				const token = this.requireToken();
				const model =
					this.imageModels.find((m) => m.name === this.settings.imageModel) ?? this.imageModels[0];
				let source: ArrayBuffer | undefined;
				if (edit) {
					if (!file) {
						new Notice("Pollinations: open the image you want to edit.");
						return;
					}
					source = await this.app.vault.readBinary(file);
				}
				new Notice("Pollinations: generating image…");
				const bytes = await generateImage(
					token,
					model,
					prompt,
					this.settings.resolution || undefined,
					source,
				);
				await this.saveImage(bytes, prompt, file);
			} catch (error) {
				new Notice(`Pollinations: ${this.describe(error)}`);
			}
		}).open();
	}

	private async saveImage(bytes: ArrayBuffer, prompt: string, source: TFile | null): Promise<void> {
		const folder = this.settings.imageFolder.trim() || "pollinations";
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		const stem = prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "image";
		const name = `${folder}/${stem}-${Date.now().toString(36)}.png`;
		const saved = await this.app.vault.createBinary(name, bytes);

		// Embed the result in the note, at the cursor when there is one.
		if (source) {
			new Notice(`Pollinations: saved ${saved.path} (source unchanged).`);
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			view.editor.replaceRange(`![[${saved.path}]]\n`, view.editor.getCursor());
		}
		new Notice(`Pollinations: saved ${saved.path}`);
	}
}

class PromptModal extends Modal {
	constructor(
		app: App,
		private label: string,
		private onSubmit: (value: string) => Promise<void>,
		private initial = "",
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.label });
		const input = contentEl.createEl("textarea", { cls: "pollinations-prompt" });
		input.value = this.initial;
		input.rows = 4;
		input.style.width = "100%";
		const button = contentEl.createEl("button", { text: "Generate" });
		button.style.marginTop = "0.5rem";
		button.addEventListener("click", () => {
			const value = input.value.trim();
			if (!value) return;
			this.close();
			void this.onSubmit(value);
		});
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ApprovalModal extends Modal {
	constructor(
		app: App,
		private userCode: string,
		private url: string,
		private onCancel: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Approve Pollinations" });
		contentEl.createEl("p", { text: "Enter this code in the browser window that opened:" });
		const code = contentEl.createEl("code", { text: this.userCode });
		code.style.fontSize = "1.6em";
		code.style.display = "block";
		code.style.margin = "0.5rem 0";
		const link = contentEl.createEl("a", { text: this.url, href: this.url });
		link.style.display = "block";
		link.style.marginBottom = "0.5rem";
		const cancel = contentEl.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => {
			this.onCancel();
			this.close();
		});
		window.open(this.url, "_blank");
	}

	onClose(): void {
		this.onCancel();
		this.contentEl.empty();
	}
}

class PollinationsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PollinationsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Pollinations" });

		new Setting(containerEl)
			.setName("Text model")
			.setDesc("Model id from the live text catalog")
			.addText((text) =>
				text.setValue(this.plugin.settings.textModel).onChange(async (value) => {
					this.plugin.settings.textModel = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Image model")
			.setDesc("Leave empty to use the first model the account can access")
			.addText((text) =>
				text.setValue(this.plugin.settings.imageModel).onChange(async (value) => {
					this.plugin.settings.imageModel = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Resolution")
			.setDesc("Only used when the chosen model advertises it")
			.addText((text) =>
				text.setValue(this.plugin.settings.resolution).onChange(async (value) => {
					this.plugin.settings.resolution = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Image folder")
			.setDesc("Vault folder generated images are saved to")
			.addText((text) =>
				text.setValue(this.plugin.settings.imageFolder).onChange(async (value) => {
					this.plugin.settings.imageFolder = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("App key (optional)")
			.setDesc("A publishable pk_ key, so usage is attributed to this plugin")
			.addText((text) =>
				text.setValue(this.plugin.settings.appKey).onChange(async (value) => {
					this.plugin.settings.appKey = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Account")
			.setDesc("Connect or disconnect your Pollinations account on this device")
			.addButton((button) =>
				button.setButtonText("Connect").onClick(async () => {
					await this.plugin.connect();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					await this.plugin.disconnect();
				}),
			);
	}
}
