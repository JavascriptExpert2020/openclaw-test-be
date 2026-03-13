import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fetchChatLogs, fetchSkills, fetchUsageItems, updateSkill, } from "./openclaw-gateway.js";
dotenv.config();
const app = express();
const port = Number(process.env.PORT || 4000);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "openclaw-be", ts: new Date().toISOString() });
});
app.get("/api/chat-logs", async (req, res) => {
    try {
        const sessionKeyRaw = typeof req.query.sessionKey === "string" ? req.query.sessionKey : "main";
        const limitParsed = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
        const limit = Number.isFinite(limitParsed) ? Math.max(1, Math.min(1000, limitParsed)) : 200;
        const items = await fetchChatLogs(sessionKeyRaw, limit);
        res.json({ items });
    }
    catch (err) {
        res.status(500).json({
            error: err instanceof Error ? err.message : "Failed to load chat logs.",
        });
    }
});
app.get("/api/usage", async (req, res) => {
    try {
        const daysParsed = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
        const days = Number.isFinite(daysParsed) ? Math.max(1, Math.min(90, daysParsed)) : 7;
        const items = await fetchUsageItems(days);
        res.json({ items });
    }
    catch (err) {
        res.status(500).json({
            error: err instanceof Error ? err.message : "Failed to load usage.",
        });
    }
});
app.get("/api/skills", async (_req, res) => {
    try {
        const items = await fetchSkills();
        res.json({ items });
    }
    catch (err) {
        res.status(500).json({
            error: err instanceof Error ? err.message : "Failed to load skills.",
        });
    }
});
app.post("/api/skills/:id/toggle", async (req, res) => {
    try {
        const { id } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ error: "enabled must be a boolean." });
        }
        const item = await updateSkill(id, enabled);
        return res.json({ item });
    }
    catch (err) {
        return res.status(500).json({
            error: err instanceof Error ? err.message : "Failed to update skill.",
        });
    }
});
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[openclaw-be] listening on http://localhost:${port}`);
});
