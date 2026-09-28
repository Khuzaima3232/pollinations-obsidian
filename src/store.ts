/**
 * Authorization storage.
 *
 * Obsidian's plugin data file lives in the vault, which users may sync or share,
 * so the token is kept out of it: data.json holds settings, and the token lives
 * in the plugin's own directory with owner-only permissions on POSIX.
 */
import { type App, normalizePath } from "obsidian";

const TOKEN_FILE = "authorization";

export class TokenStore {
	constructor(
		private app: App,
		private manifestDir: string,
	) {}

	private path(): string {
		return normalizePath(`${this.manifestDir}/${TOKEN_FILE}`);
	}

	async load(): Promise<string | null> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.path()))) return null;
			const token = (await adapter.read(this.path())).trim();
			return token.startsWith("sk_") ? token : null;
		} catch {
			return null;
		}
	}

	async save(token: string): Promise<void> {
		if (!token.startsWith("sk_")) throw new Error("Invalid authorization.");
		const adapter = this.app.vault.adapter;
		// Hidden, so it is not listed as a note in the vault.
		await adapter.write(this.path(), token);
	}

	async clear(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.path())) await adapter.remove(this.path());
		} catch {
			/* already gone */
		}
	}
}
