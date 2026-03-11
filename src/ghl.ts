type GhlConfig = {
  baseUrl: string;
  apiKey: string;
  version: string;
  locationId?: string;
};

export type GhlContact = Record<string, unknown> & {
  id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
};

type GhlRequestInit = {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_VERSION = "2021-07-28";

const getGhlConfig = (): GhlConfig => {
  const apiKey = process.env.GHL_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error("GHL_API_KEY is not set.");
  }
  return {
    baseUrl: process.env.GHL_API_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    version: process.env.GHL_API_VERSION?.trim() || DEFAULT_VERSION,
    locationId: process.env.GHL_LOCATION_ID?.trim() || undefined,
  };
};

const buildUrl = (baseUrl: string, path: string, query?: GhlRequestInit["query"]): string => {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") {
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
};

const debugEnabled = process.env.GHL_DEBUG === "1";

const logDebug = (message: string, meta?: Record<string, unknown>) => {
  if (!debugEnabled) {
    return;
  }
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[ghl] ${message}${suffix}`);
};

const formatBodyPreview = (body: unknown): Record<string, unknown> | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  if (Array.isArray(body)) {
    return { arrayLength: body.length };
  }
  const entries = Object.entries(body as Record<string, unknown>);
  const preview: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      preview[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      preview[key] = value;
    } else if (value === null || value === undefined) {
      preview[key] = value;
    } else {
      preview[key] = typeof value;
    }
  }
  return preview;
};

const readResponsePayload = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

class GhlHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ghlRequest = async (init: GhlRequestInit): Promise<unknown> => {
  const config = getGhlConfig();
  const url = buildUrl(config.baseUrl, init.path, init.query);
  const method = init.method ?? (init.body ? "POST" : "GET");
  logDebug("request", {
    method,
    url,
    body: formatBodyPreview(init.body),
  });
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Version: config.version,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    const payload = await readResponsePayload(res);
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    logDebug("response.error", { status: res.status, statusText: res.statusText, detail });
    throw new GhlHttpError(
      res.status,
      `GHL request failed (${res.status} ${res.statusText}): ${detail}`,
    );
  }

  const payload = await readResponsePayload(res);
  logDebug("response.ok", { status: res.status });
  return payload;
};

const extractContacts = (payload: unknown): GhlContact[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.contacts,
    record.items,
    record.data,
    record.results,
    record.contacts && typeof record.contacts === "object"
      ? (record.contacts as Record<string, unknown>).items
      : undefined,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate as GhlContact[];
    }
  }
  if (record.contact && typeof record.contact === "object") {
    return [record.contact as GhlContact];
  }
  return [];
};

const normalizeSearchInput = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const searchContacts = async (params: {
  query?: string;
  email?: string;
  phone?: string;
  limit?: number;
}): Promise<GhlContact[]> => {
  const config = getGhlConfig();
  const query = normalizeSearchInput(params.query);
  const email = normalizeSearchInput(params.email);
  const phone = normalizeSearchInput(params.phone);
  const limit = params.limit ?? 5;
  const unifiedQuery = query ?? email ?? phone;

  const attempts: GhlRequestInit[] = [];

  if (unifiedQuery) {
    attempts.push({
      method: "POST",
      path: "/contacts/search",
      body: {
        query: unifiedQuery,
        locationId: config.locationId,
        limit,
      },
    });
  }

  attempts.push({
    method: "GET",
    path: "/contacts/",
    query: {
      query: unifiedQuery,
      locationId: config.locationId,
      limit,
    },
  });

  if (config.locationId) {
    attempts.push({
      method: "GET",
      path: `/locations/${config.locationId}/contacts`,
      query: {
        query: unifiedQuery,
        limit,
      },
    });
  }

  let lastError: Error | null = null;
  let lastContacts: GhlContact[] = [];
  let hadSuccess = false;
  for (const attempt of attempts) {
    try {
      const payload = await ghlRequest(attempt);
      const contacts = extractContacts(payload);
      hadSuccess = true;
      lastError = null;
      lastContacts = contacts;
      if (contacts.length > 0 || attempts.length === 1) {
        return contacts;
      }
    } catch (err) {
      if (err instanceof GhlHttpError && err.status === 404) {
        // Endpoint not supported on this account; try the next option.
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (hadSuccess) {
    return lastContacts;
  }

  if (lastError) {
    throw lastError;
  }
  return [];
};

export const updateContact = async (
  contactId: string,
  updates: Record<string, unknown>,
): Promise<GhlContact> => {
  const payload = await ghlRequest({
    method: "PUT",
    path: `/contacts/${contactId}`,
    body: updates,
  });

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.contact && typeof record.contact === "object") {
      return record.contact as GhlContact;
    }
  }
  return payload as GhlContact;
};
