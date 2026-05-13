import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	appendJournal,
	buildSavePromptSection,
	createExtractor,
	detectPriorityBump,
	type ExtensionContext,
	type Extractor,
	isMemoryPath,
	isSubstantive,
	newJournalState,
	renderJournalEntry,
	resolveProjectSlug,
} from "./src/util.js";

const INJECT_MARKER = "<!-- pi-memory:v2 -->";
export default function piMemoryExtension(pi: ExtensionAPI): void {
	let slug = "unnamed";
	let originSessionId = "";
	let injectedSection = "";
	const journal = newJournalState();
	// Turn counter for Path B cursor. We deliberately do NOT retain the full
	// AgentMessage[] history — pi already keeps it, and storing it here grew the
	// process to OOM on long sessions with large tool-result payloads.
	let turnCount = 0;
	let extractor: Extractor | undefined;
	let priorityBumpPending = false;
	const writesThisTurn = new Map<string, "write" | "edit">();

	pi.on("session_start", async (_e, ctx) => {
		try {
			slug = await resolveProjectSlug(ctx.cwd);
		} catch (err) {
			console.error("[pi-memory] slug resolution failed:", err);
		}
		originSessionId = ctx.sessionManager.getSessionId();
		injectedSection = `${INJECT_MARKER}\n${buildSavePromptSection(slug, originSessionId)}`;
	});

	pi.on("before_agent_start", (event) => {
		if (!injectedSection || event.systemPrompt.includes(INJECT_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${injectedSection}` };
	});

	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") {
			journal.userMsgCount++;
			turnCount++;
			if (!journal.firstUser) journal.firstUser = event.text;
			if (detectPriorityBump(event.text)) priorityBumpPending = true;
		}
		return { action: "continue" };
	});

	pi.on("turn_start", () => {
		writesThisTurn.clear();
	});

	pi.on("tool_call", (event) => {
		journal.toolCounts.set(event.toolName, (journal.toolCounts.get(event.toolName) ?? 0) + 1);
	});

	pi.on("tool_result", (event) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as Record<string, unknown>;
		const fp = input.file_path ?? input.path;
		if (typeof fp !== "string") return;
		journal.fileEditCounts.set(fp, (journal.fileEditCounts.get(fp) ?? 0) + 1);
		if (isMemoryPath(fp)) {
			writesThisTurn.set(fp, event.toolName as "write" | "edit");
			journal.memoryWrittenThisSession = true;
		}
	});

	pi.on("turn_end", async (event, baseCtx) => {
		const ctx = baseCtx as ExtensionContext;
		journal.assistantMsgCount++;
		turnCount++;
		const c = (event.message as { content?: unknown }).content;
		if (event.message.role === "assistant" && Array.isArray(c)) {
			const t = c.find((b) => b && typeof b === "object" && (b as { type?: string }).type === "text") as { text?: unknown } | undefined;
			if (typeof t?.text === "string") journal.lastAssistant = t.text;
		}

		// Path A mutex: main agent wrote memory → transcript + skip fork.
		if (writesThisTurn.size > 0) {
			const paths = [...writesThisTurn.keys()];
			const verb = [...writesThisTurn.values()].every((v) => v === "edit") ? "Improved" : "Saved";
			ctx.transcript.append({ kind: "memory_saved", verb, paths });
			writesThisTurn.clear();
			return;
		}

		if (!extractor) {
			extractor = createExtractor(ctx, {
				slug,
				originSessionId,
				getTurnCount: () => turnCount,
				memoryWrittenThisSession: () => journal.memoryWrittenThisSession,
			});
		}
		const force = priorityBumpPending;
		priorityBumpPending = false;
		// Fire-and-forget: awaiting here blocks the parent's turn on a 6-30s extraction.
		// transcript.append is push-based; drain() on session_shutdown catches in-flight forks.
		void extractor.maybeRun(force).then(
			(saved) => {
				if (saved.length === 0) return;
				ctx.transcript.append({ kind: "memory_saved", verb: "Saved", paths: saved });
				journal.memoryWrittenThisSession = true;
			},
			(err) => console.error("[pi-memory] background extraction failed:", err),
		);
	});

	pi.on("session_shutdown", async (event, baseCtx) => {
		const ctx = baseCtx as ExtensionContext;
		try {
			if (extractor) await extractor.drain(60_000);
		} catch (err) {
			console.error("[pi-memory] drain error:", err);
		}
		if ((event as { reason?: string }).reason === "reload") return;
		if (!isSubstantive(journal)) return;
		try {
			appendJournal(renderJournalEntry(journal, { sessionId: ctx.sessionManager.getSessionId(), slug }));
		} catch (err) {
			console.error("[pi-memory] journal append failed:", err);
		}
	});
}
