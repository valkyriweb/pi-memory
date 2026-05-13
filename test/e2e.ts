/**
 * pi-memory v2 e2e: register the extension against a mock ExtensionAPI and
 * verify the right hooks are wired, no tools are registered, and no calls
 * to registerMessageRenderer (the v1 API drift bug source).
 *
 * Run: npx tsx test/e2e.ts
 */

import piMemory from "../index.js";

const events: string[] = [];
let toolsRegistered = 0;
let messageRenderersRegistered = 0;
let commandsRegistered = 0;

const pi = {
	on(event: string, _h: unknown) {
		events.push(event);
	},
	registerTool() {
		toolsRegistered++;
	},
	registerCommand() {
		commandsRegistered++;
	},
	registerShortcut() {},
	registerFlag() {},
	getFlag() {
		return undefined;
	},
	registerMessageRenderer() {
		messageRenderersRegistered++;
	},
	sendMessage() {},
	sendUserMessage() {},
	appendEntry() {},
	setSessionName() {},
	getSessionName() {
		return undefined;
	},
	setLabel() {},
	async exec() {
		return { stdout: "", stderr: "", exitCode: 0 } as never;
	},
	getActiveTools() {
		return [];
	},
	getAllTools() {
		return [];
	},
	setActiveTools() {},
	getCommands() {
		return [];
	},
	async setModel() {
		return true;
	},
	getThinkingLevel() {
		return "off" as const;
	},
	setThinkingLevel() {},
	registerProvider() {},
	unregisterProvider() {},
	events: {} as never,
};

piMemory(pi as unknown as Parameters<typeof piMemory>[0]);

const required = ["session_start", "before_agent_start", "input", "turn_start", "tool_call", "tool_result", "turn_end", "session_shutdown"];
const missing = required.filter((e) => !events.includes(e));

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

assert(missing.length === 0, `all required hooks wired (missing: ${missing.join(",") || "none"})`);
assert(toolsRegistered === 0, "ZERO tools registered");
assert(commandsRegistered === 0, "ZERO commands registered");
assert(messageRenderersRegistered === 0, "ZERO messageRenderers registered (memory_saved renderer lives in pi core)");

console.log(`\nevents wired: ${events.join(", ")}`);
console.log("e2e: PASS");
