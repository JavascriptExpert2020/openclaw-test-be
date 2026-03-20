import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  fetchChatLogs,
  fetchSessions,
  fetchSkills,
  fetchUsageItems,
  updateSkill,
} from "./openclaw-gateway.js";
import { startEmailIngest } from "./email-ingest.js";
import { appendReceiptRow } from "./google-sheets.js";
import { searchContacts, updateContact } from "./ghl.js";

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";

const parseEnvFlag = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return !["0", "false", "no", "off"].includes(normalized);
};

const parseEnvInt = (value: string | undefined, defaultValue: number) => {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

const BOOKKEEPING_SKILL_ID = "bookkeeping";
const BOOKKEEPING_STATUS_TTL_MS = Math.max(
  0,
  parseEnvInt(process.env.BOOKKEEPING_STATUS_TTL_MS, 0),
);

let bookkeepingEnabled = parseEnvFlag(process.env.BOOKKEEPING_ENABLED, true);
let bookkeepingLastChecked = 0;

const resolveBookkeepingEnabled = async (): Promise<boolean> => {
  const now = Date.now();
  if (
    BOOKKEEPING_STATUS_TTL_MS > 0 &&
    now - bookkeepingLastChecked < BOOKKEEPING_STATUS_TTL_MS
  ) {
    return bookkeepingEnabled;
  }
  try {
    const items = await fetchSkills();
    const item = items.find((skill) => skill.id === BOOKKEEPING_SKILL_ID);
    bookkeepingEnabled = item ? item.enabled : false;
    bookkeepingLastChecked = now;
    return bookkeepingEnabled;
  } catch (err) {
    // Fail closed to avoid logging when the gateway cannot be queried.
    return false;
  }
};

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "openclaw-be", ts: new Date().toISOString() });
});

app.get("/api/chat-logs", async (req, res) => {
  try {
    const sessionKeyRaw =
      typeof req.query.sessionKey === "string" ? req.query.sessionKey : "main";
    const limitParsed =
      typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitParsed)
      ? Math.max(1, Math.min(1000, limitParsed))
      : 200;
    const items = await fetchChatLogs(sessionKeyRaw, limit);
    res.json({ items });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to load chat logs.",
    });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const limitParsed =
      typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitParsed)
      ? Math.max(1, Math.min(1000, limitParsed))
      : 200;
    const items = await fetchSessions(limit);
    res.json({ items });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to load sessions.",
    });
  }
});

app.get("/api/usage", async (req, res) => {
  try {
    const daysParsed =
      typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(daysParsed)
      ? Math.max(1, Math.min(90, daysParsed))
      : 7;
    const items = await fetchUsageItems(days);
    res.json({ items });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to load usage.",
    });
  }
});

app.get("/api/skills", async (_req, res) => {
  try {
    const items = await fetchSkills();
    res.json({ items });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to load skills.",
    });
  }
});

app.post("/api/skills/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean." });
    }
    const item = await updateSkill(id, enabled);
    if (item.id === BOOKKEEPING_SKILL_ID) {
      bookkeepingEnabled = item.enabled;
      bookkeepingLastChecked = Date.now();
    }
    return res.json({ item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update skill.";
    if (message.toLowerCase().includes("blocked skill")) {
      // eslint-disable-next-line no-console
      console.warn(
        `[security] skill vetting blocked "${req.params.id}": ${message}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[skills] toggle failed for "${req.params.id}": ${message}`);
    }
    return res.status(500).json({ error: message });
  }
});

app.post("/api/bookkeeping/append", async (req, res) => {
  try {
    const enabled = await resolveBookkeepingEnabled();
    if (!enabled) {
      return res.status(403).json({
        error: "Bookkeeping skill is disabled in the admin portal. Re-enable it to continue.",
      });
    }
    const { date, vendor, amount, category, notes, source } =
      req.body as Record<string, unknown>;
    if (!date || !vendor || !amount || !category) {
      return res.status(400).json({
        error: "date, vendor, amount, and category are required.",
      });
    }
    await appendReceiptRow({
      date: String(date),
      vendor: String(vendor),
      amount: typeof amount === "number" ? amount : String(amount),
      category: String(category),
      notes: typeof notes === "string" ? notes : undefined,
      source: typeof source === "string" ? source : "bookkeeping-agent",
    });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to append row.",
    });
  }
});

app.post("/api/ghl/contacts/search", async (req, res) => {
  try {
    const { query, email, phone, limit } = req.body as Record<string, unknown>;
    const items = await searchContacts({
      query: typeof query === "string" ? query : undefined,
      email: typeof email === "string" ? email : undefined,
      phone: typeof phone === "string" ? phone : undefined,
      limit: typeof limit === "number" ? limit : undefined,
    });
    return res.json({ items });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to search contacts.",
    });
  }
});

app.post("/api/ghl/contacts/update", async (req, res) => {
  try {
    const { contactId, query, email, phone, updates } = req.body as Record<
      string,
      unknown
    >;
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "updates must be an object." });
    }

    let resolvedId = typeof contactId === "string" ? contactId.trim() : "";

    if (!resolvedId) {
      const matches = await searchContacts({
        query: typeof query === "string" ? query : undefined,
        email: typeof email === "string" ? email : undefined,
        phone: typeof phone === "string" ? phone : undefined,
        limit: 5,
      });

      if (matches.length === 0) {
        return res.status(404).json({ error: "No matching contacts found." });
      }

      if (matches.length > 1) {
        return res.status(409).json({
          error:
            "Multiple contacts matched. Provide contactId or refine search.",
          items: matches,
        });
      }

      resolvedId = String(matches[0]?.id || "");
    }

    if (!resolvedId) {
      return res.status(400).json({ error: "contactId is required." });
    }

    const item = await updateContact(
      resolvedId,
      updates as Record<string, unknown>,
    );
    return res.json({ item });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update contact.",
    });
  }
});

const emailHandle = startEmailIngest();

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[openclaw-be] listening on http://localhost:${port}`);
});

process.on("SIGINT", () => {
  emailHandle.stop();
  server.close();
  process.exit(0);
});


