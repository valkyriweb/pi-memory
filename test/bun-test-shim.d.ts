// Minimal ambient declaration for bun:test so tsc --noEmit passes without
// pulling in the full bun types. Runtime is provided by `bun test`.
declare module "bun:test" {
	export const describe: (name: string, fn: () => void) => void;
	export const test: (name: string, fn: () => void | Promise<void>) => void;
	export const it: typeof test;
	export const beforeEach: (fn: () => void | Promise<void>) => void;
	export const afterEach: (fn: () => void | Promise<void>) => void;
	export const beforeAll: (fn: () => void | Promise<void>) => void;
	export const afterAll: (fn: () => void | Promise<void>) => void;
	interface Matchers {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toContain(expected: unknown): void;
		toMatch(expected: RegExp | string): void;
		toBeNull(): void;
		toBeUndefined(): void;
		toBeDefined(): void;
		toBeTruthy(): void;
		toBeFalsy(): void;
		toThrow(expected?: unknown): void;
		not: Matchers;
	}
	export function expect(actual: unknown): Matchers;
}
