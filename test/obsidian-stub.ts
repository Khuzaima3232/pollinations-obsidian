/**
 * Stand-in for the `obsidian` runtime module under test.
 *
 * The published package ships types only, so Vitest cannot resolve a runtime
 * entry for it. Tests import this instead; requestUrl is still replaced per-test
 * with a real node:http call, so no network behaviour is faked away.
 */
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Notice {}
export class Setting {}
export class MarkdownView {}
export class TFile {}
export const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/");
export const requestUrl = async (): Promise<never> => {
	throw new Error("requestUrl must be stubbed in tests");
};
