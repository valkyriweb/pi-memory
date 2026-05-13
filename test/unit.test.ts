/**
 * Unit tests for pi-memory v2.
 *
 * Run: bun test test/unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force PI_MEMORY_DIR before importing modules that capture it.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
process.env.PI_MEMORY_DIR = join(TMP_ROOT, "memory");
process.env.PI_JOURNAL_DIR = join(TMP_ROOT, "journal");

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { appendJournal, buildSavePromptSection, detectPriorityBump, hasMemoryWritesSince, isMemoryPath, isSubstantive, memoryRoot, newJournalState, renderJournalEntry } from "../src/util.js";

function userMsg(text: string, ts: number): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as unknown as AgentMessage;
}

function assistantToolCall(name: string, args: Record<string, unknown>, ts: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc", name, arguments: args }],
		timestamp: ts,
		model: "x",
	} as unknown as AgentMessage;
}

describe("paths", () => {
	test("isMemoryPath identifies files under memoryRoot", () => {
		expect(isMemoryPath(join(memoryRoot(), "profile", "user_foo.md"))).toBe(true);
		expect(isMemoryPath(join(memoryRoot(), "project", "slug", "feedback_x.md"))).toBe(true);
		expect(isMemoryPath("/tmp/elsewhere.md")).toBe(false);
		expect(isMemoryPath(undefined)).toBe(false);
	});
});

describe("priority-bump detector", () => {
	test("save phrases trigger", () => {
		expect(detectPriorityBump("please remember that I hate flaky tests")).toBe("save");
		expect(detectPriorityBump("note that we ship on Fridays")).toBe("save");
		expect(detectPriorityBump("save this for next time")).toBe("save");
		expect(detectPriorityBump("make a note: tabs not spaces")).toBe("save");
	});
	test("correction phrases trigger", () => {
		expect(detectPriorityBump("no, that's wrong")).toBe("correction");
		expect(detectPriorityBump("stop doing that")).toBe("correction");
		expect(detectPriorityBump("don't run prettier")).toBe("correction");
		expect(detectPriorityBump("actually, use sed instead")).toBe("correction");
	});
	test("validation phrases trigger", () => {
		expect(detectPriorityBump("yes exactly")).toBe("validation");
		expect(detectPriorityBump("perfect, ship it")).toBe("validation");
		expect(detectPriorityBump("keep doing that")).toBe("validation");
	});
	test("benign text does NOT false-trigger on 'no' inside other words", () => {
		expect(detectPriorityBump("now do that")).toBeNull();
		expect(detectPriorityBump("the north star")).toBeNull();
		expect(detectPriorityBump("piano lessons")).toBeNull();
		expect(detectPriorityBump("running the build")).toBeNull();
	});
	test("empty/whitespace returns null", () => {
		expect(detectPriorityBump("")).toBeNull();
		expect(detectPriorityBump("   ")).toBeNull();
	});
});

describe("hasMemoryWritesSince (mutex cursor)", () => {
	test("returns true when a write to memory path exists after cursor", () => {
		const memPath = join(memoryRoot(), "profile", "user_foo.md");
		const msgs = [userMsg("hello", 100), assistantToolCall("write", { file_path: memPath, content: "x" }, 200)];
		expect(hasMemoryWritesSince(msgs, undefined)).toBe(true);
		expect(hasMemoryWritesSince(msgs, 50)).toBe(true);
	});
	test("returns false when write target is outside memory dir", () => {
		const msgs = [userMsg("hello", 100), assistantToolCall("write", { file_path: "/tmp/random.md", content: "x" }, 200)];
		expect(hasMemoryWritesSince(msgs, undefined)).toBe(false);
	});
	test("returns false when memory write is BEFORE the cursor", () => {
		const memPath = join(memoryRoot(), "profile", "user_foo.md");
		const msgs = [assistantToolCall("write", { file_path: memPath, content: "x" }, 100), userMsg("next prompt", 200)];
		// cursor at ts=150 — write@100 is before cursor, ignored.
		expect(hasMemoryWritesSince(msgs, 150)).toBe(false);
	});
	test("edit on memory path also counts", () => {
		const memPath = join(memoryRoot(), "project", "slug", "feedback_x.md");
		const msgs = [assistantToolCall("edit", { path: memPath }, 200)];
		expect(hasMemoryWritesSince(msgs, undefined)).toBe(true);
	});
});

describe("journal substantive gate", () => {
	test("trivial session (1 user msg, 0 tools) → not substantive", () => {
		const s = newJournalState();
		s.userMsgCount = 1;
		expect(isSubstantive(s)).toBe(false);
	});
	test("2 user messages → substantive", () => {
		const s = newJournalState();
		s.userMsgCount = 2;
		expect(isSubstantive(s)).toBe(true);
	});
	test("1 user + 1 tool call → substantive", () => {
		const s = newJournalState();
		s.userMsgCount = 1;
		s.toolCounts.set("bash", 1);
		expect(isSubstantive(s)).toBe(true);
	});
	test("substantive but memory was written → not substantive (mutex)", () => {
		const s = newJournalState();
		s.userMsgCount = 5;
		s.toolCounts.set("write", 2);
		s.memoryWrittenThisSession = true;
		expect(isSubstantive(s)).toBe(false);
	});
});

describe("journal entry rendering + append", () => {
	test("renders deterministic structured entry with tools and files sorted", () => {
		const s = newJournalState();
		s.userMsgCount = 3;
		s.assistantMsgCount = 5;
		s.toolCounts.set("bash", 6);
		s.toolCounts.set("read", 2);
		s.toolCounts.set("edit", 4);
		s.fileEditCounts.set("src/a.ts", 3);
		s.fileEditCounts.set("src/b.ts", 1);
		s.firstUser = "rewrite pi-memory to v2";
		s.lastAssistant = "done, all gates pass";
		const out = renderJournalEntry(s, {
			sessionId: "abc123",
			slug: "pi-memory",
			now: new Date("2026-05-13T14:32:00Z"),
		});
		expect(out).toContain("## 2026-05-13T14:32:00Z [sid:abc123]");
		expect(out).toContain("- cwd: pi-memory");
		expect(out).toContain("- msgs: 3 user / 5 assistant");
		expect(out).toMatch(/- tools: bash×6, edit×4, read×2/);
		expect(out).toContain("- files: src/a.ts, src/b.ts");
		expect(out).toContain(`- first_user: "rewrite pi-memory to v2"`);
		expect(out).toContain(`- last_assistant: "done, all gates pass"`);
		// no "None." possible by construction
		expect(out).not.toMatch(/None\./);
	});

	test("appendJournal writes to YYYY-MM-DD.md under journal dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-jour-"));
		process.env.PI_JOURNAL_DIR = dir;
		try {
			const now = new Date("2026-05-13T10:00:00Z");
			const path = appendJournal("## hello\n", now);
			expect(existsSync(path)).toBe(true);
			expect(path).toMatch(/2026-05-13\.md$/);
			expect(readFileSync(path, "utf8")).toBe("## hello\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("prompt injection composition", () => {
	test("save section contains TYPES, WHAT NOT, save-instructions with slug + sid", () => {
		const out = buildSavePromptSection("my-slug", "sid-xyz");
		expect(out).toContain("## Types of memory");
		expect(out).toContain("<name>user</name>");
		expect(out).toContain("<name>feedback</name>");
		expect(out).toContain("<name>project</name>");
		expect(out).toContain("<name>reference</name>");
		expect(out).toContain("## What NOT to save in memory");
		expect(out).toContain("MEMORY.md, AGENTS.md, CLAUDE.md, or skill files");
		expect(out).toContain("my-slug");
		expect(out).toContain("sid-xyz");
		expect(out).toContain("## How to save memories");
	});
});
