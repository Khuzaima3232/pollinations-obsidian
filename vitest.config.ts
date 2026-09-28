import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// The obsidian package is types-only, so tests resolve it to a stub.
			obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
	},
});
