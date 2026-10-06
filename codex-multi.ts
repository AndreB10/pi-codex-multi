/**
 * codex-multi — use multiple ChatGPT (OpenAI Codex) subscriptions in pi.
 *
 * Pi stores OAuth credentials keyed by provider id (`~/.pi/agent/auth.json`),
 * and the Codex API extracts the ChatGPT account id from the access token
 * itself. So the entire built-in `openai-codex` provider can be cloned once
 * per subscription under a distinct provider id — each clone gets its own
 * `/login` entry, its own stored/refreshed tokens, and its own rate limits.
 *
 * Accounts are configured in ~/.pi/agent/codex-accounts.json:
 *
 *   { "accounts": [ { "id": "work", "name": "Work" },
 *                   { "id": "personal", "name": "Personal" } ] }
 *
 * Each account becomes provider `codex-<id>` with models named `<model> · <label>`.
 * Authenticate with `/login codex-<id>`, then pick models via `/model`.
 *
 * Commands:
 *   /codex                    list accounts + auth status
 *   /codex add <id> <label>   register a new account (then /login codex-<id>)
 *   /codex remove <id>        unregister, delete credentials, forget account
 *   /codex use <id>           switch the active model to this account
 */

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_PROVIDER_ID = "openai-codex";
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30})$/i;
const MAX_ACCOUNTS = 20;
const MAX_LABEL_LENGTH = 32;
const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(PI_AGENT_DIR, "codex-accounts.json");
const AUTH_PATH = path.join(PI_AGENT_DIR, "auth.json");

interface AccountConfig {
	/** Short slug; becomes provider id `codex-<id>`. */
	id: string;
	/** Display label shown in provider/model names. Defaults to id. */
	name?: string;
}

interface AuthEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

// ---------------------------------------------------------------- sanitizing

/** Strip C0/C1 control characters (incl. terminal escapes), collapse whitespace. */
function cleanText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Clean a display label; falls back to `fallback` when empty. */
function cleanLabel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const cleaned = cleanText(value).slice(0, MAX_LABEL_LENGTH);
	return cleaned || fallback;
}

/** Clean a value read from a JWT for display; undefined when not a string. */
function cleanClaim(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = cleanText(value).slice(0, 64);
	return cleaned || undefined;
}

// ---------------------------------------------------------------- config I/O

interface AccountState {
	accounts: AccountConfig[];
	/** Non-fatal problems found in the config file, shown by /codex. */
	issues: string[];
}

/**
 * Validate and normalize the accounts list. Config files are hand-editable,
 * so nothing in them is trusted: ids must match the account pattern, entries
 * are deduplicated case-insensitively (provider lookups are case-insensitive
 * but auth.json keys are not), labels are cleaned, and the total is capped.
 */
function sanitizeAccounts(raw: unknown): AccountState {
	const issues: string[] = [];
	if (!Array.isArray(raw)) {
		if (raw !== undefined && raw !== null) {
			issues.push('"accounts" must be an array');
		}
		return { accounts: [], issues };
	}
	const accounts: AccountConfig[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		if (accounts.length >= MAX_ACCOUNTS) {
			issues.push(`too many accounts — keeping the first ${MAX_ACCOUNTS}`);
			break;
		}
		const entry = raw[i];
		const id = (entry as { id?: unknown } | null | undefined)?.id;
		if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id)) {
			issues.push(`entry #${i + 1}: invalid id — skipped`);
			continue;
		}
		const key = id.toLowerCase();
		if (seen.has(key)) {
			issues.push(`entry #${i + 1}: duplicate id "${id}" — skipped`);
			continue;
		}
		seen.add(key);
		const label = cleanLabel((entry as { name?: unknown }).name, id);
		accounts.push(label === id ? { id } : { id, name: label });
	}
	return { accounts, issues };
}

function loadAccountState(): AccountState {
	try {
		const json = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		return sanitizeAccounts(json?.accounts);
	} catch {
		return { accounts: [], issues: [] };
	}
}

function loadAccounts(): AccountConfig[] {
	return loadAccountState().accounts;
}

function saveAccounts(accounts: AccountConfig[]): void {
	try {
		fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
		const payload = JSON.stringify({ accounts }, null, "\t") + "\n";
		fs.writeFileSync(CONFIG_PATH, payload, { flag: "w" });
	} catch {
		// best effort; registration still works for this session
	}
}

function readAuthEntry(providerId: string): AuthEntry | null {
	try {
		const json = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
		return json?.[providerId] ?? null;
	} catch {
		return null;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delete one provider's credential from auth.json.
 *
 * auth.json is owned by pi, which guards concurrent writes with
 * proper-lockfile and refreshes tokens with an async read-modify-write.
 * We cannot take that lock from an extension, so instead each attempt is
 * guarded: if the file changed (mtime/size) between our read and write,
 * another session wrote concurrently and we redo the delete from fresh
 * content. This prevents the dangerous case — reverting another session's
 * freshly rotated refresh token to the stale one we had read.
 *
 * Residual race: a same-session refresh that completes after our write can
 * resurrect the entry (pi merges from content it read before our delete).
 * That leaves an unused orphan token; `/logout codex-<id>` removes it.
 *
 * Returns true when the entry is gone from the file afterwards.
 */
async function deleteAuthEntry(providerId: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const before = fs.statSync(AUTH_PATH);
			const json = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
			if (!(providerId in json)) return true;
			const after = fs.statSync(AUTH_PATH);
			if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
				await sleep(25); // concurrent write — retry from fresh content
				continue;
			}
			delete json[providerId];
			// Match pi's exact format (2-space indent, no trailing newline).
			fs.writeFileSync(AUTH_PATH, JSON.stringify(json, null, 2), { mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

// --------------------------------------------------------------- jwt helpers

interface DecodedJwt {
	email?: string;
	plan?: string;
}

/** Decode (unverified) claims we care about from a Codex access token JWT. */
function decodeCodexJwt(jwt: string | undefined): DecodedJwt | null {
	if (!jwt) return null;
	try {
		const part = jwt.split(".")[1];
		if (!part) return null;
		const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
		const profile = payload?.["https://api.openai.com/profile"];
		const auth = payload?.["https://api.openai.com/auth"];
		return {
			email: cleanClaim(profile?.email),
			plan: cleanClaim(auth?.chatgpt_plan_type),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------- provider cloning

let baseProvider: Provider | undefined;

function getBaseProvider(): Provider {
	if (!baseProvider) {
		baseProvider = builtinProviders().find((p) => p.id === BASE_PROVIDER_ID);
		if (!baseProvider) {
			throw new Error(`Built-in "${BASE_PROVIDER_ID}" provider not found in this pi version`);
		}
	}
	return baseProvider;
}

function providerIdFor(account: AccountConfig): string {
	return `codex-${account.id}`;
}

/** Clone the built-in openai-codex provider under a per-account identity. */
function buildAccountProvider(account: AccountConfig): Provider {
	const base = getBaseProvider();
	const label = account.name || account.id;
	const pid = providerIdFor(account);

	// Clone the catalog, restamping `provider` (models from the builtin catalog
	// are stamped "openai-codex") and renaming so accounts are distinguishable
	// in /model.
	const models: Model<any>[] = base.getModels().map((m) => ({
		...m,
		provider: pid,
		name: `${m.name} · ${label}`,
	}));

	// Give the OAuth entry a distinct label in /login while reusing the exact
	// same battle-tested login/refresh flow as the built-in provider.
	const oauth = base.auth.oauth ? { ...base.auth.oauth, name: `OpenAI Codex (${label})` } : undefined;

	return {
		...base,
		id: pid,
		name: `OpenAI Codex (${label})`,
		auth: oauth ? { oauth } : base.auth,
		getModels: () => models,
	};
}

// ----------------------------------------------------------- auth reporting

function describeAuth(account: AccountConfig): string {
	const entry = readAuthEntry(providerIdFor(account));
	if (!entry) return `not logged in (/login codex-${account.id})`;
	const claims = decodeCodexJwt(entry.access);
	const bits: string[] = [];
	if (claims?.plan) bits.push(claims.plan);
	if (claims?.email) bits.push(claims.email);
	const expired = typeof entry.expires === "number" && entry.expires < Date.now();
	const suffix = expired ? " (token expired, will auto-refresh)" : "";
	return `logged in${bits.length ? `: ${bits.join(" · ")}` : ""}${suffix}`;
}

// ------------------------------------------------------------------ commands

function parseArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

async function handleCodexCommand(pi: ExtensionAPI, argsText: string, ctx: ExtensionContext) {
	const args = parseArgs(argsText);
	const command = args[0]?.toLowerCase();

	if (!command || command === "list" || command === "status") {
		const { accounts, issues } = loadAccountState();
		const parts: string[] = [];
		if (accounts.length === 0) {
			parts.push("No extra Codex accounts configured. Add one with: /codex add <id> <label>");
		} else {
			const lines = accounts.map((a) => {
				const pid = providerIdFor(a);
				const active = ctx.model?.provider === pid ? " ← active" : "";
				return `  ${a.name || a.id}  (${pid}) — ${describeAuth(a)}${active}`;
			});
			parts.push(`Codex accounts:\n${lines.join("\n")}`);
		}
		if (registrationFailures.length > 0) {
			parts.push(`Failed to register: ${registrationFailures.join("; ")}`);
		}
		if (issues.length > 0) {
			parts.push(`Config issues: ${issues.join("; ")}`);
		}
		ctx.ui.notify(parts.join("\n"), "info");
		return;
	}

	if (command === "add") {
		const id = args[1];
		const label = cleanLabel(args.slice(2).join(" "), id ?? "");
		if (!id || !ACCOUNT_ID_PATTERN.test(id)) {
			ctx.ui.notify("Usage: /codex add <id> [label] — id must be alphanumeric (-/_ ok)", "error");
			return;
		}
		const { accounts } = loadAccountState();
		const pid = `codex-${id}`;
		const pidLower = pid.toLowerCase();
		// Case-insensitive: /codex use|remove match ids case-insensitively, so
		// two ids differing only in case would collide in practice.
		if (accounts.some((a) => a.id.toLowerCase() === id.toLowerCase())) {
			ctx.ui.notify(`Account "${id}" already exists`, "error");
			return;
		}
		// Refuse to clobber providers we do not own — built-ins and anything
		// another extension already registered (registerProvider replaces).
		const clash =
			builtinProviders().some((p) => p.id.toLowerCase() === pidLower) ||
			ctx.modelRegistry.getRegisteredProviderIds().some((x) => x.toLowerCase() === pidLower);
		if (clash) {
			ctx.ui.notify(`Provider id "${pid}" is already in use by pi or another extension`, "error");
			return;
		}
		const account: AccountConfig = label === id ? { id } : { id, name: label };
		try {
			pi.registerProvider(buildAccountProvider(account)); // applies immediately
		} catch (error) {
			ctx.ui.notify(
				`Failed to register ${pid}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		accounts.push(account);
		saveAccounts(accounts);
		ctx.ui.notify(
			`Registered ${pid}. Log in with: /login ${pid}\nThen switch models via /model.`,
			"info",
		);
		return;
	}

	if (command === "remove") {
		const id = args[1];
		const { accounts } = loadAccountState();
		const idx = accounts.findIndex((a) => a.id.toLowerCase() === id?.toLowerCase());
		if (idx === -1) {
			ctx.ui.notify(`No such account: ${id ?? "(none given)"}`, "error");
			return;
		}
		const [account] = accounts.splice(idx, 1);
		const pid = providerIdFor(account);
		if (ctx.model?.provider === pid) {
			ctx.ui.notify(
				`${pid} is the active model — switch models before removing it`,
				"error",
			);
			return;
		}
		saveAccounts(accounts);
		pi.unregisterProvider(pid);
		const deleted = await deleteAuthEntry(pid);
		ctx.ui.notify(
			deleted
				? `Removed ${pid} (credentials deleted)`
				: `Removed ${pid}. Stored credentials could not be deleted automatically — run /logout ${pid} to clear them.`,
			deleted ? "info" : "warning",
		);
		return;
	}

	if (command === "use") {
		const id = args[1];
		const account = loadAccounts().find((a) => a.id.toLowerCase() === id?.toLowerCase());
		if (!account) {
			ctx.ui.notify(`No such account: ${id ?? "(none given)"}`, "error");
			return;
		}
		const pid = providerIdFor(account);
		const models = ctx.modelRegistry.getAll().filter((m) => m.provider === pid);
		if (models.length === 0) {
			ctx.ui.notify(`No models registered for ${pid}`, "error");
			return;
		}
		let chosen = models.find((m) => m.reasoning) ?? models[0];
		if (ctx.hasUI && models.length > 1) {
			const picked = await ctx.ui.select("Select model", models.map((m) => m.name));
			if (picked === undefined) return; // dismissed — cancel the switch
			const pickedModel = models.find((m) => m.name === picked);
			if (pickedModel) chosen = pickedModel;
		}
		const ok = await pi.setModel(chosen);
		if (!ok) {
			ctx.ui.notify(
				`Could not activate ${pid}/${chosen.id} — no credentials yet? Run: /login ${pid}`,
				"error",
			);
			return;
		}
		ctx.ui.notify(`Switched to ${pid}/${chosen.id}`, "info");
		return;
	}

	ctx.ui.notify(
		"Usage: /codex [list] | add <id> [label] | remove <id> | use <id>\nLogin per account with: /login codex-<id>",
		"info",
	);
}

// --------------------------------------------------------------------- setup

/** Accounts that failed to register this session (reported by /codex). */
let registrationFailures: string[] = [];

export default function (pi: ExtensionAPI) {
	// Register one cloned provider per configured account at startup.
	// Per-account try/catch: one bad entry must not disable the whole extension
	// (and the /codex command with it).
	registrationFailures = [];
	for (const account of loadAccountState().accounts) {
		try {
			pi.registerProvider(buildAccountProvider(account));
		} catch (error) {
			registrationFailures.push(
				`${account.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	pi.registerCommand("codex", {
		description: "Manage multiple ChatGPT/Codex subscriptions (list | add | remove | use)",
		handler: (args, ctx) => handleCodexCommand(pi, args, ctx),
	});
}
