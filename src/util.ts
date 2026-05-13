import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext as BaseCtx } from "@mariozechner/pi-coding-agent";
export const memoryRoot = (): string => (process.env.PI_MEMORY_DIR?.length ? resolve(process.env.PI_MEMORY_DIR) : join(homedir(), ".pi", "agent", "memory"));
export const profileDir = (): string => join(memoryRoot(), "profile");
export const projectDir = (slug: string): string => join(memoryRoot(), "project", slug);
export const journalDir = (): string => (process.env.PI_JOURNAL_DIR?.length ? resolve(process.env.PI_JOURNAL_DIR) : join(homedir(), ".pi", "agent", "journal"));
export function isMemoryPath(p: string | undefined): boolean {
	if (!p) return false;
	const abs = resolve(p);
	const r = memoryRoot();
	return abs === r || abs.startsWith(r + sep);
}

// slug — vendored from dream-memory-harness/src/store.ts; slug-map persistence dropped. TODO: extract into shared @howaboua/pi-slug package.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const norm = (raw: string): string => {
	const s = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "unnamed";
};
async function findUp(start: string, name: string): Promise<string | null> {
	let dir = resolve(start);
	for (;;) {
		const c = join(dir, name);
		if (existsSync(c)) return c;
		const p = dirname(dir);
		if (p === dir) return null;
		dir = p;
	}
}
export async function resolveProjectSlug(cwd: string): Promise<string> {
	const abs = resolve(cwd);
	let slug: string | null = null;
	const y = await findUp(abs, ".dream-memory.yml");
	if (y) {
		try {
			const m = /^[ \t]*project_slug[ \t]*:[ \t]*["']?([^"'\n#]+)["']?/m.exec(await readFile(y, "utf8"));
			if (m?.[1]) slug = norm(m[1].trim());
		} catch {}
	}
	if (!slug) {
		const gitDir = await findUp(abs, ".git");
		const cfg = gitDir && join(gitDir, "config");
		if (cfg && existsSync(cfg)) {
			const rs = [...(await readFile(cfg, "utf8")).matchAll(/\[remote "([^"]+)"\][^[]*?url\s*=\s*(\S+)/g)];
			const url = (rs.find((m) => m[1] === "origin") ?? rs[0])?.[2];
			const seg = url
				?.replace(/\.git$/, "")
				.split(/[/:]/)
				.filter(Boolean)
				.pop();
			if (seg) slug = norm(seg);
		}
	}
	if (!slug) slug = norm(basename(abs));
	if (!SLUG_RE.test(slug)) throw new Error(`resolveProjectSlug: invalid slug "${slug}" for ${abs}`);
	return slug;
}

// `\bno\b` naturally rejects "now"/"north"/"piano".
const SAVE_RES = [/\bremember\b/i, /\bnote that\b/i, /\bfor next time\b/i, /\bsave this\b/i, /\bmake a note\b/i],
	CORR_RES = [/\bno\b/i, /\bstop doing\b/i, /\bdon't\b/i, /\bactually\b/i],
	VAL_RES = [/\byes exactly\b/i, /\bperfect\b/i, /\bkeep doing\b/i];
export type TriggerKind = "save" | "correction" | "validation";
export function detectPriorityBump(text: string): TriggerKind | null {
	if (!text) return null;
	if (SAVE_RES.some((r) => r.test(text))) return "save";
	if (VAL_RES.some((r) => r.test(text))) return "validation";
	if (CORR_RES.some((r) => r.test(text))) return "correction";
	return null;
}

const PROMPTS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "prompts");
const loadPrompt = (n: string): string => readFileSync(join(PROMPTS_DIR, n), "utf8").trimEnd();
const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);

function memVars(slug: string, originSessionId: string): Record<string, string> {
	return { PROJECT_SLUG: slug, ORIGIN_SESSION_ID: originSessionId, MEMORY_ROOT: memoryRoot(), PROFILE_DIR: profileDir(), PROJECT_DIR: projectDir(slug) };
}
export function buildSavePromptSection(slug: string, originSessionId: string): string {
	const parts = [
		`# Memory\n\nYou have a persistent memory system rooted at \`${memoryRoot()}/\`.`,
		loadPrompt("types-individual.md"),
		loadPrompt("what-not-to-save.md"),
		fill(loadPrompt("save-instructions.md"), memVars(slug, originSessionId)),
		loadPrompt("recall-guidance.md"),
	];
	return parts.join("\n\n");
}
export function buildExtractPrompt(o: { newMessageCount: number; existingMemories: string; slug: string; originSessionId: string }): string {
	const block = o.existingMemories.trim()
		? `## Existing memory files\n\n${o.existingMemories.trim()}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
		: "";
	return fill(loadPrompt("extract-prompt.md"), { NEW_MESSAGE_COUNT: String(o.newMessageCount), EXISTING_MEMORIES_BLOCK: block, ...memVars(o.slug, o.originSessionId) });
}

export interface JournalState {
	userMsgCount: number;
	assistantMsgCount: number;
	toolCounts: Map<string, number>;
	fileEditCounts: Map<string, number>;
	firstUser: string | undefined;
	lastAssistant: string | undefined;
	memoryWrittenThisSession: boolean;
}
export const newJournalState = (): JournalState => ({
	userMsgCount: 0,
	assistantMsgCount: 0,
	toolCounts: new Map(),
	fileEditCounts: new Map(),
	firstUser: undefined,
	lastAssistant: undefined,
	memoryWrittenThisSession: false,
});
/** ≥2 user msgs OR ≥1 tool call, AND no memory write this session (mutex). */
export function isSubstantive(s: JournalState): boolean {
	if (s.memoryWrittenThisSession) return false;
	if (s.userMsgCount >= 2) return true;
	let t = 0;
	for (const n of s.toolCounts.values()) t += n;
	return t >= 1;
}
const trim1 = (s: string | undefined, max = 200): string => {
	const f = (s ?? "").replace(/\s+/g, " ").trim();
	return f.length > max ? `${f.slice(0, max - 1)}…` : f;
};
export function renderJournalEntry(s: JournalState, i: { sessionId: string; slug: string; now?: Date }): string {
	const ts = (i.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
	const sortByCount = <T>(m: Map<T, number>) => [...m].sort((a, b) => b[1] - a[1]);
	const tools = sortByCount(s.toolCounts)
		.map(([n, c]) => `${n}×${c}`)
		.join(", ");
	const files = sortByCount(s.fileEditCounts)
		.slice(0, 5)
		.map(([f]) => f);
	const out = [`## ${ts} [sid:${i.sessionId}]`, `- cwd: ${i.slug}`, `- msgs: ${s.userMsgCount} user / ${s.assistantMsgCount} assistant`];
	if (tools) out.push(`- tools: ${tools}`);
	if (files.length) out.push(`- files: ${files.join(", ")}`);
	if (s.firstUser) out.push(`- first_user: "${trim1(s.firstUser)}"`);
	if (s.lastAssistant) out.push(`- last_assistant: "${trim1(s.lastAssistant)}"`);
	return `${out.join("\n")}\n\n`;
}
export function appendJournal(entry: string, now: Date = new Date()): string {
	const d = journalDir();
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	const file = join(d, `${now.toISOString().slice(0, 10)}.md`);
	appendFileSync(file, entry, "utf8");
	return file;
}

function snapshot(slug: string): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (d: string, left: number): void => {
		if (!existsSync(d)) return;
		for (const e of readdirSync(d)) {
			const f = join(d, e);
			try {
				const st = statSync(f);
				if (st.isDirectory() && left > 0) walk(f, left - 1);
				else if (st.isFile() && e.endsWith(".md")) out.set(f, st.mtimeMs);
			} catch {}
		}
	};
	walk(profileDir(), 2);
	walk(projectDir(slug), 2);
	return out;
}
export interface Extractor {
	maybeRun(force: boolean): Promise<string[]>;
	drain(timeoutMs?: number): Promise<void>;
}
const ALLOWED_FORK_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"];

// Min new turns since the last fork run before a non-forced fork is worth running.
// Trivial follow-ups burn ~30k tokens otherwise.
const MIN_NEW_TURNS_FOR_FORK = 3;

export function createExtractor(
	ctx: ExtensionContext,
	opts: {
		slug: string;
		originSessionId: string;
		/** Total user+assistant turns observed by the parent so far. */
		getTurnCount: () => number;
		/** Session-wide flag flipped by the tool_result watcher when a memory write
		 * lands. Acts as the Path A↔Path B mutex — once Path A writes, Path B stops
		 * firing for the rest of the session. */
		memoryWrittenThisSession: () => boolean;
		model?: string;
		/** Called whenever a fork run saves at least one memory file. Fires for both
		 * the in-flight run and any coalesced trailing run, so transcript.append is
		 * always reached regardless of coalescing depth. */
		onSaved?: (paths: string[]) => void;
	},
): Extractor {
	let cursorTurns = 0;
	let cur: Promise<string[]> | null = null;
	let next: { force: boolean } | null = null;

	async function runOnce(force: boolean): Promise<string[]> {
		const turnsNow = opts.getTurnCount();
		// Mutex: once the main agent has written memory this session, Path B is
		// redundant. Skip and let the cursor stay where it is.
		if (opts.memoryWrittenThisSession()) {
			cursorTurns = turnsNow;
			return [];
		}
		const newTurns = turnsNow - cursorTurns;
		if (!force && newTurns < MIN_NEW_TURNS_FOR_FORK) return [];
		const before = snapshot(opts.slug);
		try {
			const { handle } = await ctx.forkAgent({
				prompt: buildExtractPrompt({
					newMessageCount: Math.max(newTurns, 1),
					existingMemories: [...before.keys()].map((f) => `- ${f}`).join("\n"),
					slug: opts.slug,
					originSessionId: opts.originSessionId,
				}),
				allowedTools: ALLOWED_FORK_TOOLS,
				model: opts.model,
				description: "pi-memory extraction",
			});
			await handle.wait();
			cursorTurns = turnsNow;
			const after = snapshot(opts.slug);
			const changed: string[] = [];
			for (const [p, t] of after) if (before.get(p) !== t) changed.push(p);
			if (changed.length > 0) opts.onSaved?.(changed);
			return changed;
		} catch (err) {
			console.error("[pi-memory] fork failed:", err);
			return [];
		}
	}
	function maybeRun(force: boolean): Promise<string[]> {
		if (cur) {
			next = { force: (next?.force ?? false) || force };
			return cur;
		}
		cur = (async (): Promise<string[]> => {
			try {
				return await runOnce(force);
			} finally {
				const n = next;
				next = null;
				cur = null;
				if (n) cur = maybeRun(n.force);
			}
		})();
		return cur;
	}
	async function drain(timeoutMs = 60_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (cur && Date.now() < deadline) {
			await Promise.race([cur.catch(() => {}), new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref?.())]);
		}
	}
	return { maybeRun, drain };
}

export type TranscriptEntry = { kind: "memory_saved"; verb: "Saved" | "Improved"; paths: string[] };
export interface ExtensionContext extends BaseCtx {
	forkAgent(opts: { prompt: string; allowedTools?: string[]; model?: string; signal?: AbortSignal; description?: string; silent?: boolean }): Promise<{
		handle: { wait(): Promise<unknown>; abort(): Promise<void>; readonly status: unknown };
		sessionId: string;
	}>;
	readonly transcript: { append(entry: TranscriptEntry): void };
}
