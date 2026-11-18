import type { Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";

// Match Pi's native pi.dev catalog policy, using its public Provider refresh
// contract (the native withRemoteCatalog helper is not a public export).
export const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CATALOG_URL = "https://pi.dev/api/models/providers/openai-codex?types=chat";
const REQUEST_TIMEOUT_MS = 4_000;

type ChatModel = Model<any>;

function parseCatalog(value: unknown, providerId: string): ChatModel[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? "models" in value && Array.isArray(value.models)
				? value.models
				: Object.values(value)
			: undefined;
	if (!entries) throw new Error("Invalid OpenAI Codex model catalog");
	return entries
		.filter((entry): entry is ChatModel =>
			typeof entry === "object" && entry !== null &&
			typeof entry.id === "string" && typeof entry.name === "string" &&
			(entry.type === undefined || entry.type === "chat") &&
			entry.api === "openai-codex-responses",
		)
		.map((model) => ({ ...model, provider: providerId }));
}

/** Add Pi's public Codex catalog to an account-stamped, unlabelled baseline. */
export function withCodexCatalog(provider: Provider, label: string, generatedAt?: number): Provider {
	let dynamicModels: ChatModel[] = [];
	const newerModels = (entry: Readonly<ModelsStoreEntry> | undefined): ChatModel[] =>
		entry && (generatedAt === undefined || (entry.lastModified !== undefined && entry.lastModified > generatedAt))
			? parseCatalog(entry.models, provider.id)
			: [];
	const getModels = () => {
		const merged = new Map<string, ChatModel>();
		for (const model of [...provider.getModels(), ...dynamicModels]) merged.set(model.id, model);
		return [...merged.values()].map((model) => ({ ...model, name: `${model.name} · ${label}` }));
	};

	return {
		...provider,
		getModels,
		getAllModels: getModels,
		// pi.dev needs no account tokens; an expired OAuth token must not block
		// discovery or be refreshed just to fetch public model metadata.
		refreshModelsAuth: "configured",
		async refreshModels(context) {
			const stored = context.stored;
			const restored = newerModels(stored);
			if (!(await context.publish({ update: () => { dynamicModels = restored; } }))) return;
			if (!context.allowNetwork || context.signal.aborted) return;
			if (!context.force && stored?.checkedAt !== undefined && stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < CATALOG_REFRESH_INTERVAL_MS) return;

			const headers: Record<string, string> = {
				accept: "application/json",
				"User-Agent": "pi-codex-multi",
			};
			if (stored?.models.length && stored.etag) headers["if-none-match"] = stored.etag;
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
			const response = await fetch(CATALOG_URL, { headers, signal });
			signal.throwIfAborted();
			const checkedAt = Date.now();
			if (response.status === 304 && stored?.models.length) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				return;
			}
			if (!response.ok) {
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`OpenAI Codex model catalog request failed: ${response.status}`);
			}
			const models = parseCatalog(await response.json(), provider.id);
			signal.throwIfAborted();
			const timestamp = Date.parse(response.headers.get("last-modified") ?? "");
			const entry: ModelsStoreEntry = {
				models,
				lastModified: Number.isNaN(timestamp) ? 0 : timestamp,
				etag: response.headers.get("etag") ?? undefined,
				checkedAt,
			};
			const published = newerModels(entry);
			await context.publish({ persist: entry, update: () => { dynamicModels = published; } });
		},
	};
}
