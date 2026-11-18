import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	createModels, InMemoryCredentialStore, InMemoryModelsStore,
	type Model, type ModelsStoreEntry, type Provider, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { withCodexCatalog, CATALOG_REFRESH_INTERVAL_MS } from "../catalog.ts";

const GENERATED_AT = Date.parse("2026-11-01T00:00:00Z");
const LAST_MODIFIED = "Tue, 17 Nov 2026 12:00:00 GMT";
const model = (id = "old", provider = "openai-codex"): Model<"openai-codex-responses"> => ({
	id, name: id, api: "openai-codex-responses", provider,
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 500000, maxTokens: 128000,
});
function account(id = "codex-work", label = "Work") {
	const base: Provider = {
		id, name: id,
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "secret" } }) } },
		getModels: () => [model("old", id)],
		stream() { throw new Error("unused"); },
		streamSimple() { throw new Error("unused"); },
	};
	return withCodexCatalog(base, label, GENERATED_AT);
}
function context(stored?: ModelsStoreEntry, overrides: Partial<RefreshModelsContext> = {}) {
	const state = { stored, publications: 0 };
	const ctx: RefreshModelsContext = {
		stored, allowNetwork: true, signal: new AbortController().signal,
		async publish(publication) {
			ctx.signal.throwIfAborted();
			state.publications++;
			if (publication.persist !== undefined) state.stored = publication.persist ?? undefined;
			publication.update?.();
			return true;
		},
		...overrides,
	};
	return { state, ctx };
}
const cached = (overrides: Partial<ModelsStoreEntry> = {}): ModelsStoreEntry => ({
	models: [model("new", "codex-work")], lastModified: Date.parse(LAST_MODIFIED),
	checkedAt: Date.now() - CATALOG_REFRESH_INTERVAL_MS - 1000, etag: '"v1"', ...overrides,
});
function mockCatalog(t: TestContext, models: unknown = [model("new")]) {
	return t.mock.method(globalThis, "fetch", async () => Response.json(models, {
		headers: { "last-modified": LAST_MODIFIED, etag: '"v2"' },
	}));
}

test("downloads canonical Codex catalog and merges/restamps/persists metadata", async (t) => {
	const fetch = mockCatalog(t, [model("new"), { ...model("old"), contextWindow: 999999 }]);
	const provider = account();
	const { state, ctx } = context();
	assert.deepEqual(provider.getModels().map(m => m.id), ["old"]);
	await provider.refreshModels!(ctx);
	assert.equal(String(fetch.mock.calls[0].arguments[0]), "https://pi.dev/api/models/providers/openai-codex?types=chat");
	const request = fetch.mock.calls[0].arguments[1] as RequestInit;
	assert.equal(new Headers(request.headers).get("authorization"), null);
	assert.ok(request.signal instanceof AbortSignal);
	assert.equal(provider.refreshModelsAuth, "configured");
	assert.deepEqual(provider.getModels().map(m => [m.id, m.provider, m.name]), [
		["old", "codex-work", "old · Work"], ["new", "codex-work", "new · Work"],
	]);
	assert.equal(provider.getModels()[0].contextWindow, 999999);
	assert.deepEqual(provider.getAllModels!(), provider.getModels());
	assert.equal(state.stored!.etag, '"v2"');
	assert.equal(state.stored!.lastModified, Date.parse(LAST_MODIFIED));
	assert.equal(state.stored!.models[0].name, "new");
	assert.ok(state.stored!.models.every(m => m.provider === "codex-work"));
});

test("restores cached models offline, relabelling exactly once", async (t) => {
	const fetch = mockCatalog(t);
	const provider = account("codex-work", "Renamed");
	await provider.refreshModels!(context(cached(), { allowNetwork: false }).ctx);
	assert.deepEqual(provider.getModels().map(m => m.name), ["old · Renamed", "new · Renamed"]);
	await provider.refreshModels!(context(cached(), { allowNetwork: false }).ctx);
	assert.equal(provider.getModels()[1].name, "new · Renamed");
	assert.equal(fetch.mock.callCount(), 0);
});

test("four-hour freshness suppresses checks, force bypasses it", async (t) => {
	const fetch = mockCatalog(t);
	const provider = account();
	const entry = cached({ checkedAt: Date.now() });
	await provider.refreshModels!(context(entry).ctx);
	assert.equal(fetch.mock.callCount(), 0);
	await provider.refreshModels!(context(entry, { force: true }).ctx);
	assert.equal(fetch.mock.callCount(), 1);
});

test("expired cache sends ETag and a 304 retains body and advances freshness", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 304 }));
	const provider = account();
	const entry = cached();
	const { ctx, state } = context(entry);
	await provider.refreshModels!(ctx);
	const request = fetch.mock.calls[0].arguments[1] as RequestInit;
	assert.equal(new Headers(request.headers).get("if-none-match"), '"v1"');
	assert.deepEqual(state.stored!.models, entry.models);
	assert.ok(state.stored!.checkedAt! > entry.checkedAt!);
	assert.equal(provider.getModels()[1].id, "new");
});

test("does not send a validator without its cached body", async (t) => {
	const fetch = mockCatalog(t);
	await account().refreshModels!(context(cached({ models: [] })).ctx);
	assert.equal(new Headers((fetch.mock.calls[0].arguments[1] as RequestInit).headers).get("if-none-match"), null);
});

test("cache without Last-Modified is rechecked despite recent checkedAt", async (t) => {
	const fetch = mockCatalog(t);
	await account().refreshModels!(context(cached({ lastModified: undefined, checkedAt: Date.now() })).ctx);
	assert.equal(fetch.mock.callCount(), 1);
});

test("catalog older than the bundled baseline cannot overwrite newer metadata", async (t) => {
	mockCatalog(t);
	const base = account();
	await base.refreshModels!(context(cached({ lastModified: GENERATED_AT - 1 }), { allowNetwork: false }).ctx);
	assert.deepEqual(base.getModels().map(m => m.id), ["old"]);
});

for (const status of [404, 501, 503]) {
	test(`HTTP ${status} preserves last-known models`, async (t) => {
		t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
		const provider = account();
		const { state, ctx } = context(cached());
		if (status === 503) await assert.rejects(provider.refreshModels!(ctx), /503/);
		else await provider.refreshModels!(ctx);
		assert.equal(provider.getModels()[1].id, "new");
		assert.equal(state.stored!.etag, '"v1"');
	});
}

test("network failures retain the restored offline catalog", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
	const provider = account();
	await assert.rejects(provider.refreshModels!(context(cached()).ctx), /offline/);
	assert.equal(provider.getModels()[1].id, "new");
});

test("malformed JSON cannot replace last-known models or persisted cache", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("{oops"));
	const provider = account();
	const entry = cached();
	const { state, ctx } = context(entry);
	await assert.rejects(provider.refreshModels!(ctx), SyntaxError);
	assert.deepEqual(state.stored, entry);
	assert.equal(provider.getModels()[1].id, "new");
});

test("ignores non-chat entries and incompatible protocols", async (t) => {
	mockCatalog(t, { models: [model("new"), { ...model("image"), type: "image" },
		{ ...model("other"), api: "openai-responses" }, null, { id: "bad" }] });
	const provider = account();
	await provider.refreshModels!(context().ctx);
	assert.deepEqual(provider.getModels().map(m => m.id), ["old", "new"]);
});

test("supports keyed model catalogs", async (t) => {
	mockCatalog(t, { "chat:new": model("new") });
	const provider = account();
	await provider.refreshModels!(context().ctx);
	assert.equal(provider.getModels()[1].id, "new");
});

test("generation rejection prevents requests and stale updates", async (t) => {
	const fetch = mockCatalog(t);
	const provider = account();
	await provider.refreshModels!(context(cached(), { publish: async () => false }).ctx);
	assert.equal(fetch.mock.callCount(), 0);
	assert.deepEqual(provider.getModels().map(m => m.id), ["old"]);
});

test("cancelled fetch cannot publish a late response", async (t) => {
	const controller = new AbortController();
	t.mock.method(globalThis, "fetch", async () => {
		controller.abort();
		return Response.json([model("late")]);
	});
	const provider = account();
	const entry = cached();
	const { state, ctx } = context(entry, { signal: controller.signal });
	await assert.rejects(provider.refreshModels!(ctx), { name: "AbortError" });
	assert.deepEqual(state.stored, entry);
	assert.equal(provider.getModels()[1].id, "new");
});

test("Pi Models lifecycle refreshes both accounts and restores each cache offline", async (t) => {
	const fetch = mockCatalog(t);
	const store = new InMemoryModelsStore();
	const runtime = createModels({ modelsStore: store });
	for (const [id, name] of [["codex-work", "Work"], ["codex-personal", "Personal"]]) {
		runtime.setProvider(account(id, name));
	}
	const refreshed = await runtime.refresh();
	assert.equal(refreshed.errors.size, 0);
	assert.equal(fetch.mock.callCount(), 2);
	assert.equal((await store.read("codex-personal"))!.models[0].provider, "codex-personal");
	const restarted = createModels({ modelsStore: store });
	for (const [id, name] of [["codex-work", "Work"], ["codex-personal", "Personal"]]) {
		restarted.setProvider(account(id, name));
	}
	await restarted.refresh({ allowNetwork: false });
	assert.equal(fetch.mock.callCount(), 2);
	assert.equal(restarted.getModel("codex-personal", "new")!.name, "new · Personal");
	assert.equal(restarted.getModel("codex-work", "new")!.name, "new · Work");
});

test("expired OAuth cannot block public catalog discovery or leak account tokens", async (t) => {
	const fetch = mockCatalog(t);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("codex-work", async () => ({
		type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: 0,
	}));
	const base = account();
	const provider: Provider = {
		...base,
		auth: { oauth: {
			name: "Test OAuth",
			async login() { throw new Error("must not log in"); },
			async refresh() { throw new Error("must not rotate tokens for model discovery"); },
			async toAuth() { throw new Error("must not resolve account auth for public catalog"); },
		} },
	};
	const runtime = createModels({ credentials });
	runtime.setProvider(provider);
	const result = await runtime.refresh();
	assert.equal(result.errors.size, 0);
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(runtime.getModel("codex-work", "new")!.provider, "codex-work");
	assert.equal((await credentials.read("codex-work"))!.type, "oauth");
});

test("a late generation rejection cannot install downloaded models", async (t) => {
	mockCatalog(t, [model("late")]);
	const provider = account();
	let calls = 0;
	await provider.refreshModels!(context(undefined, {
		async publish(publication) {
			if (++calls > 1) return false;
			publication.update?.();
			return true;
		},
	}).ctx);
	assert.deepEqual(provider.getModels().map(m => m.id), ["old"]);
});

test("unconfigured account providers are not fetched by Pi", async (t) => {
	const fetch = mockCatalog(t);
	const provider = account();
	const runtime = createModels();
	runtime.setProvider({
		...provider,
		auth: { apiKey: { name: "Not configured", resolve: async () => undefined } },
	});
	await runtime.refresh();
	assert.equal(fetch.mock.callCount(), 0);
});
