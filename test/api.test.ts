/**
 * Tests for the Pollinations transport.
 *
 * A real localhost HTTP server stands in for the API — same style as the GIMP
 * plug-in's suite: no external credentials, no Pollen spent, but the requests
 * genuinely go over the wire and the responses are genuinely parsed.
 *
 * Obsidian's requestUrl is not available outside the app, so it is stubbed with
 * a node:http implementation that mirrors its contract (including `throw:false`).
 */
import { type Server, createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface Recorded {
	url: string;
	method: string;
	auth?: string;
	body: string;
}

const seen: Recorded[] = [];
let server: Server;
let origin = "";
/** Set per test to shape the next response. */
let handler: (path: string, body: string) => { status: number; json?: unknown; text?: string };

vi.mock("obsidian", () => ({
	requestUrl: async (param: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		throw?: boolean;
	}) => {
		seen.push({
			url: param.url,
			method: param.method ?? "GET",
			auth: param.headers?.Authorization,
			body: param.body ?? "",
		});
		const path = new URL(param.url).pathname;
		const result = handler(path, param.body ?? "");
		if (result.status >= 400 && param.throw !== false) {
			throw new Error(`HTTP ${result.status}`);
		}
		const text = result.text ?? JSON.stringify(result.json ?? {});
		return {
			status: result.status,
			text,
			json: result.json ?? JSON.parse(text),
			arrayBuffer: new TextEncoder().encode(text).buffer,
			headers: {},
		};
	},
}));

const api = await import("../src/api");

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString();
			const result = handler(new URL(req.url ?? "/", "http://x").pathname, body);
			res.writeHead(result.status, { "content-type": "application/json" });
			res.end(result.text ?? JSON.stringify(result.json ?? {}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address && typeof address === "object") origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
	seen.length = 0;
	handler = () => ({ status: 200, json: {} });
});

/**
 * The real API returns approval URLs on enter.pollinations.ai, and beginDeviceFlow
 * refuses to hand the user any other site. Tests therefore advertise the real
 * host in the payload even though the stub server answers on localhost — that
 * keeps the same-origin guard under test rather than bypassing it.
 */
const APPROVAL = "https://enter.pollinations.ai/device";

const codePayload = (extra: Record<string, unknown> = {}) => ({
	device_code: "dev-abc",
	user_code: "NRX8V2H8",
	verification_uri: APPROVAL,
	verification_uri_complete: `${APPROVAL}?user_code=NRX8V2H8`,
	expires_in: 1800,
	interval: 5,
	...extra,
});

describe("device flow", () => {
	it("asks for a code and returns an approval URL on the Pollinations site", async () => {
		handler = () => ({ status: 200, json: codePayload() });
		const code = await api.beginDeviceFlow();
		expect(code.userCode).toBe("NRX8V2H8");
		expect(code.deviceCode).toBe("dev-abc");
		expect(code.interval).toBe(5);
		expect(code.approvalUrl).toBe(`${APPROVAL}?user_code=NRX8V2H8`);
		expect(code.expiresAt).toBeGreaterThan(Date.now());
		expect(seen[0].method).toBe("POST");
		expect(seen[0].url).toContain("/api/device/code");
	});

	it("refuses an approval URL that is not the authorization site", async () => {
		handler = () => ({
			status: 200,
			json: {
				device_code: "d",
				user_code: "c",
				verification_uri: "https://evil.example.com/device",
				expires_in: 60,
			},
		});
		await expect(api.beginDeviceFlow()).rejects.toThrow(/Unexpected authorization site/);
	});

	it("rejects an incomplete authorization response", async () => {
		handler = () => ({ status: 200, json: { device_code: "d" } });
		await expect(api.beginDeviceFlow()).rejects.toThrow(/Invalid device authorization/);
	});

	it("keeps waiting on authorization_pending and returns the sk_ token", async () => {
		let calls = 0;
		handler = (path) => {
			if (path === "/api/device/code") return { status: 200, json: codePayload() };
			calls += 1;
			return calls < 3
				? { status: 200, json: { error: "authorization_pending" } }
				: { status: 200, json: { access_token: "sk_live_token" } };
		};
		const code = await api.beginDeviceFlow();
		const token = await api.pollDeviceFlow(
			code,
			() => false,
			async () => undefined,
		);
		expect(token).toBe("sk_live_token");
		expect(calls).toBe(3);
	});

	it("widens the interval on slow_down instead of failing", async () => {
		let calls = 0;
		handler = (path) => {
			if (path === "/api/device/code") return { status: 200, json: codePayload() };
			calls += 1;
			if (calls === 1) return { status: 200, json: { error: "slow_down" } };
			return { status: 200, json: { access_token: "sk_after_slowdown" } };
		};
		const waits: number[] = [];
		const code = await api.beginDeviceFlow();
		const token = await api.pollDeviceFlow(
			code,
			() => false,
			async (ms) => {
				waits.push(ms);
			},
		);
		expect(token).toBe("sk_after_slowdown");
		// 5s then 10s: the second wait is wider because of slow_down.
		expect(waits[1]).toBeGreaterThan(waits[0]);
	});

	it("stops when the user cancels", async () => {
		handler = () => ({ status: 200, json: { error: "authorization_pending" } });
		const code = {
			deviceCode: "d",
			userCode: "c",
			approvalUrl: `${origin}/device`,
			expiresAt: Date.now() + 600_000,
			interval: 5,
		};
		await expect(
			api.pollDeviceFlow(
				code,
				() => true,
				async () => undefined,
			),
		).rejects.toThrow(/cancelled/);
	});

	it("reports a declined authorization", async () => {
		handler = () => ({ status: 200, json: { error: "access_denied" } });
		const code = {
			deviceCode: "d",
			userCode: "c",
			approvalUrl: `${origin}/device`,
			expiresAt: Date.now() + 600_000,
			interval: 5,
		};
		await expect(
			api.pollDeviceFlow(
				code,
				() => false,
				async () => undefined,
			),
		).rejects.toThrow(/declined/);
	});
});

describe("error messages", () => {
	it.each([
		[401, /expired or was revoked/],
		[402, /Insufficient Pollen/],
		[403, /Access denied/],
		[429, /Rate limit/],
		[500, /HTTP 500/],
	])("turns HTTP %i into a sentence", async (status, pattern) => {
		handler = () => ({ status, text: '{"error":"secret sk_leaked_token in body"}' });
		await expect(api.loadTextModels("sk_x")).rejects.toThrow(pattern);
	});

	it("never puts the response body into the error message", async () => {
		handler = () => ({ status: 402, text: "sk_leaked_token_should_not_appear" });
		await expect(api.loadTextModels("sk_x")).rejects.not.toThrow(/sk_leaked_token/);
	});
});

describe("catalog", () => {
	it("keeps image models and drops video-only ones", async () => {
		handler = () => ({
			status: 200,
			json: [
				{ name: "a/image", output_modalities: ["image"], input_modalities: [] },
				{ name: "b/video", output_modalities: ["video"] },
				{
					name: "c/editor",
					output_modalities: ["image"],
					input_modalities: ["image", "text"],
					resolutions: ["1024"],
				},
				{ name: "d/text", output_modalities: ["text"] },
			],
		});
		const models = await api.loadImageModels("sk_x");
		expect(models.map((m) => m.name)).toEqual(["a/image", "c/editor"]);
		expect(models[1].inputModalities).toContain("image");
		expect(models[1].resolutions).toEqual(["1024"]);
	});

	it("fails with a useful message when no image model is available", async () => {
		handler = () => ({ status: 200, json: [{ name: "x", output_modalities: ["video"] }] });
		await expect(api.loadImageModels("sk_x")).rejects.toThrow(/No image models available/);
	});
});

describe("generation", () => {
	const model = {
		name: "openai/gpt-image-1-mini",
		outputModalities: ["image"],
		inputModalities: ["image", "text"],
		resolutions: ["1024"],
	};

	it("requests base64 and decodes the image", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		handler = () => ({
			status: 200,
			json: { data: [{ b64_json: Buffer.from(bytes).toString("base64") }] },
		});
		const result = new Uint8Array(await api.generateImage("sk_x", model, "a fox"));
		expect([...result]).toEqual([...bytes]);
		const sent = JSON.parse(seen[0].body);
		expect(sent.response_format).toBe("b64_json");
		expect(sent.model).toBe("openai/gpt-image-1-mini");
		expect(seen[0].url).toContain("/v1/images/generations");
		expect(seen[0].auth).toBe("Bearer sk_x");
	});

	it("edits through /v1/images/edits with a data URL", async () => {
		handler = () => ({ status: 200, json: { data: [{ b64_json: "AAAA" }] } });
		const source = new Uint8Array([1, 2, 3]).buffer;
		await api.generateImage("sk_x", model, "make it gold", undefined, source);
		const sent = JSON.parse(seen[0].body);
		expect(seen[0].url).toContain("/v1/images/edits");
		expect(sent.image.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("refuses to edit with a model that takes no image input", async () => {
		const textOnly = { ...model, inputModalities: ["text"] };
		await expect(
			api.generateImage("sk_x", textOnly, "x", undefined, new Uint8Array([1]).buffer),
		).rejects.toThrow(/accepts image input/);
	});

	it("refuses a resolution the model does not advertise", async () => {
		await expect(api.generateImage("sk_x", model, "x", "4096")).rejects.toThrow(
			/does not support the selected resolution/,
		);
	});

	it("refuses an empty prompt", async () => {
		await expect(api.generateImage("sk_x", model, "  ")).rejects.toThrow(/Enter a prompt/);
	});

	it("reports a response with no image data", async () => {
		handler = () => ({ status: 200, json: { data: [] } });
		await expect(api.generateImage("sk_x", model, "x")).rejects.toThrow(/returned no image/);
	});
});

describe("text generation", () => {
	it("returns the assistant content", async () => {
		handler = () => ({
			status: 200,
			json: { choices: [{ message: { content: "hello from the model" } }] },
		});
		await expect(api.generateText("sk_x", "openai/gpt-oss-20b", "hi")).resolves.toBe(
			"hello from the model",
		);
	});

	it("fails when the model returns no text", async () => {
		handler = () => ({ status: 200, json: { choices: [] } });
		await expect(api.generateText("sk_x", "m", "hi")).rejects.toThrow(/returned no text/);
	});
});
