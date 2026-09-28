/**
 * Pollinations transport for Obsidian.
 *
 * Uses Obsidian's requestUrl rather than fetch: it bypasses CORS and works on
 * mobile, where fetch to a third-party host is blocked. Response bodies are
 * never put into a Notice — an error body can echo the bearer token.
 */
import { type RequestUrlResponse, requestUrl } from "obsidian";

export const ENTER = "https://enter.pollinations.ai";
export const GEN = "https://gen.pollinations.ai";
const USER_AGENT = "Pollinations-Obsidian/1.0";

export class PollinationsError extends Error {}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	approvalUrl: string;
	expiresAt: number;
	interval: number;
}

export interface PollinationsModel {
	name: string;
	outputModalities: string[];
	inputModalities: string[];
	resolutions: string[];
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	token?: string;
	/** Generations may legitimately outlive a fixed deadline; null disables it. */
	timeoutMs?: number | null;
}

const messageFor = (status: number): string => {
	if (status === 401)
		return "Your Pollinations authorization expired or was revoked. Connect again.";
	if (status === 402)
		return "Insufficient Pollen or budget. Add Pollen or raise the budget in your account.";
	if (status === 403)
		return "Access denied. Check the model permissions on your Pollinations account.";
	if (status === 429) return "Rate limit reached. Wait a little and try again.";
	return `Pollinations returned HTTP ${status}. Check the request and try again.`;
};

async function send<T>(url: string, options: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = { "User-Agent": USER_AGENT };
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(options.body);
	}

	let response: RequestUrlResponse;
	try {
		response = await requestUrl({
			url,
			method: options.method ?? (body === undefined ? "GET" : "POST"),
			headers,
			body,
			// Read the status ourselves so a 402/429 becomes a sentence, not a throw.
			throw: false,
		});
	} catch {
		throw new PollinationsError(
			"Connection failed. Check your network, and check account activity before retrying a generation.",
		);
	}

	if (response.status >= 400) {
		// Never surface response.text: it can contain the credential.
		throw new PollinationsError(messageFor(response.status));
	}
	try {
		return response.json as T;
	} catch {
		throw new PollinationsError("Pollinations returned an invalid response. Try again later.");
	}
}

/** Step 1 of the device flow: ask for a user code and an approval URL. */
export async function beginDeviceFlow(appKey?: string): Promise<DeviceCode> {
	const payload = appKey ? { client_id: appKey } : {};
	const code = await send<Record<string, unknown>>(`${ENTER}/api/device/code`, { body: payload });
	const deviceCode = code.device_code;
	const userCode = code.user_code;
	const uri = (code.verification_uri_complete ?? code.verification_uri) as string | undefined;
	const expiresIn = code.expires_in;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof uri !== "string" ||
		typeof expiresIn !== "number"
	) {
		throw new PollinationsError("Invalid device authorization response.");
	}
	const approvalUrl = new URL(uri, ENTER).toString();
	// Only ever open our own authorization site.
	if (!approvalUrl.startsWith(ENTER)) {
		throw new PollinationsError("Unexpected authorization site.");
	}
	return {
		deviceCode,
		userCode,
		approvalUrl,
		expiresAt: Date.now() + expiresIn * 1000,
		interval: typeof code.interval === "number" ? Math.max(5, code.interval) : 5,
	};
}

/**
 * Step 2: poll until the user approves. Resolves with a scoped sk_ token.
 * `slow_down` widens the interval; pending keeps waiting; anything else fails.
 */
export async function pollDeviceFlow(
	code: DeviceCode,
	shouldStop: () => boolean,
	wait: (ms: number) => Promise<void>,
): Promise<string> {
	let interval = code.interval;
	while (Date.now() < code.expiresAt) {
		if (shouldStop()) throw new PollinationsError("Connection cancelled.");
		await wait(interval * 1000);
		if (shouldStop()) throw new PollinationsError("Connection cancelled.");
		if (Date.now() >= code.expiresAt) break;

		const result = await send<Record<string, unknown>>(`${ENTER}/api/device/token`, {
			body: { device_code: code.deviceCode },
			timeoutMs: 30_000,
		});
		const token = result.access_token;
		if (typeof token === "string" && token.startsWith("sk_")) return token;
		const error = result.error;
		if (error === "slow_down") interval += 5;
		else if (error === "access_denied")
			throw new PollinationsError("Authorization declined. Connect again when ready.");
		else if (error === "expired_token") break;
		else if (error !== "authorization_pending")
			throw new PollinationsError("Authorization failed. Connect again.");
	}
	throw new PollinationsError("Authorization code expired. Connect again for a new code.");
}

/** Image models the account may use, from the live catalog. */
export async function loadImageModels(token: string): Promise<PollinationsModel[]> {
	const catalog = await send<unknown>(`${GEN}/image/models`, { token });
	if (!Array.isArray(catalog)) throw new PollinationsError("Invalid model catalog.");
	const models = catalog
		.filter(
			(entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
		)
		.filter((entry) => typeof entry.name === "string")
		.filter((entry) => (entry.output_modalities as string[] | undefined)?.includes("image"))
		.filter((entry) => !(entry.output_modalities as string[] | undefined)?.includes("video"))
		.map((entry) => ({
			name: entry.name as string,
			outputModalities: (entry.output_modalities as string[]) ?? [],
			inputModalities: (entry.input_modalities as string[]) ?? [],
			resolutions: (entry.resolutions as string[]) ?? [],
		}));
	if (models.length === 0) {
		throw new PollinationsError(
			"No image models available. Check your account's model permissions and balance.",
		);
	}
	return models;
}

/** Text models the account may use. */
export async function loadTextModels(token: string): Promise<string[]> {
	const catalog = await send<unknown>(`${GEN}/text/models`, { token });
	if (!Array.isArray(catalog)) throw new PollinationsError("Invalid model catalog.");
	return catalog
		.filter(
			(entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
		)
		.map((entry) => entry.name)
		.filter((name): name is string => typeof name === "string");
}

/** One chat completion; returns the assistant text. */
export async function generateText(token: string, model: string, prompt: string): Promise<string> {
	const result = await send<Record<string, unknown>>(`${GEN}/v1/chat/completions`, {
		token,
		body: { model, messages: [{ role: "user", content: prompt }] },
	});
	const choices = result.choices as { message?: { content?: string } }[] | undefined;
	const text = choices?.[0]?.message?.content;
	if (typeof text !== "string") throw new PollinationsError("The model returned no text.");
	return text;
}

/**
 * Generate an image, or edit a source image, returning raw PNG bytes.
 * Editing goes through /v1/images/edits with a data: URL, so the plugin never
 * has to host the source image anywhere.
 */
export async function generateImage(
	token: string,
	model: PollinationsModel,
	prompt: string,
	resolution?: string,
	source?: ArrayBuffer,
): Promise<ArrayBuffer> {
	if (!prompt.trim()) throw new PollinationsError("Enter a prompt.");
	const payload: Record<string, unknown> = {
		model: model.name,
		prompt,
		response_format: "b64_json",
	};
	if (resolution) {
		if (!model.resolutions.includes(resolution)) {
			throw new PollinationsError("This model does not support the selected resolution.");
		}
		payload.resolution = resolution;
	}
	let route = "/v1/images/generations";
	if (source) {
		if (!model.inputModalities.includes("image")) {
			throw new PollinationsError("Choose a model that accepts image input to edit a picture.");
		}
		payload.image = `data:image/png;base64,${toBase64(source)}`;
		route = "/v1/images/edits";
	}

	const result = await send<Record<string, unknown>>(`${GEN}${route}`, {
		token,
		body: payload,
		// Durable generations may outlive a fixed deadline; keep waiting.
		timeoutMs: null,
	});
	const data = result.data as { b64_json?: string }[] | undefined;
	const encoded = data?.[0]?.b64_json;
	if (typeof encoded !== "string" || !encoded) {
		throw new PollinationsError(
			"Generation returned no image. Check your account activity before retrying.",
		);
	}
	return fromBase64(encoded);
}

/** Base64 without Buffer, so this also works on mobile. */
function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function fromBase64(encoded: string): ArrayBuffer {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
