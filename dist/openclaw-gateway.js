import { randomUUID } from "node:crypto";
import WebSocket from "ws";
const PROTOCOL_VERSION = 3;
const DEFAULT_URL = "ws://127.0.0.1:18789";
const DEFAULT_TIMEOUT_MS = 10_000;
const toText = (value) => {
    if (typeof value === "string") {
        return value;
    }
    return "";
};
const extractTextFromMessage = (message) => {
    const directText = toText(message.text) || toText(message.content);
    if (directText) {
        return directText;
    }
    const content = message.content;
    if (Array.isArray(content)) {
        const parts = content
            .map((block) => {
            if (!block || typeof block !== "object") {
                return "";
            }
            const typed = block;
            if (typed.type === "text" && typeof typed.text === "string") {
                return typed.text;
            }
            return "";
        })
            .filter((part) => part.trim().length > 0);
        if (parts.length > 0) {
            return parts.join("\n");
        }
    }
    return "[non-text message]";
};
const toIsoTimestamp = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    return new Date().toISOString();
};
const rawToString = (data) => {
    if (typeof data === "string") {
        return data;
    }
    if (data instanceof Buffer) {
        return data.toString("utf-8");
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf-8");
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf-8");
    }
    return String(data);
};
const getGatewayConfig = () => {
    const url = process.env.OPENCLAW_GATEWAY_URL?.trim() || DEFAULT_URL;
    const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";
    if (!token) {
        throw new Error("OPENCLAW_GATEWAY_TOKEN is not set.");
    }
    return { url, token };
};
export const gatewayRequest = async (method, params, opts) => {
    const { url, token } = getGatewayConfig();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
        let settled = false;
        let connectRequestId = null;
        let mainRequestId = null;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try {
                    ws.close();
                }
                catch {
                    /* ignore */
                }
                reject(new Error("Gateway request timed out."));
            }
        }, timeoutMs);
        const finalize = (err, payload) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            if (err) {
                reject(err);
            }
            else {
                resolve(payload);
            }
        };
        const sendFrame = (frame) => {
            ws.send(JSON.stringify(frame));
        };
        const sendConnect = (nonce) => {
            connectRequestId = randomUUID();
            const connectParams = {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                    id: "gateway-client",
                    displayName: "openclaw-be",
                    version: "0.1.0",
                    platform: process.platform,
                    mode: "backend",
                },
                auth: { token },
                role: "operator",
                scopes: ["operator.admin"],
            };
            sendFrame({ type: "req", id: connectRequestId, method: "connect", params: connectParams });
        };
        const sendRequest = () => {
            mainRequestId = randomUUID();
            sendFrame({ type: "req", id: mainRequestId, method, params });
        };
        ws.on("open", () => {
            // Wait for connect.challenge event before sending connect.
        });
        const isEventFrame = (value) => Boolean(value &&
            typeof value === "object" &&
            value.type === "event" &&
            typeof value.event === "string");
        const isResponseFrame = (value) => Boolean(value &&
            typeof value === "object" &&
            value.type === "res" &&
            typeof value.id === "string");
        ws.on("message", (data) => {
            let parsed;
            try {
                parsed = JSON.parse(rawToString(data));
            }
            catch (err) {
                finalize(new Error(`Gateway sent invalid JSON: ${String(err)}`));
                return;
            }
            if (isEventFrame(parsed)) {
                if (parsed.event === "connect.challenge") {
                    const payload = parsed.payload;
                    const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
                    if (!nonce) {
                        finalize(new Error("Gateway connect challenge missing nonce."));
                        return;
                    }
                    sendConnect(nonce);
                }
                return;
            }
            if (isResponseFrame(parsed)) {
                if (parsed.id === connectRequestId) {
                    if (!parsed.ok) {
                        finalize(new Error(parsed.error?.message ?? "Gateway connect failed."));
                        return;
                    }
                    sendRequest();
                    return;
                }
                if (parsed.id === mainRequestId) {
                    if (parsed.ok) {
                        finalize(undefined, parsed.payload);
                    }
                    else {
                        finalize(new Error(parsed.error?.message ?? "Gateway request failed."));
                    }
                }
            }
        });
        ws.on("error", (err) => {
            finalize(err instanceof Error ? err : new Error(String(err)));
        });
        ws.on("close", (code, reason) => {
            if (settled) {
                return;
            }
            const reasonText = reason ? rawToString(reason) : "";
            finalize(new Error(`Gateway closed (${code}): ${reasonText || "no reason"}`));
        });
    });
};
export const fetchChatLogs = async (sessionKey, limit = 200) => {
    const response = await gatewayRequest("chat.history", {
        sessionKey,
        limit,
    });
    const messages = Array.isArray(response?.messages) ? response.messages : [];
    return messages.map((raw, index) => {
        const entry = raw && typeof raw === "object" ? raw : {};
        const role = typeof entry.role === "string" ? entry.role : "unknown";
        const ts = toIsoTimestamp(entry.timestamp ?? entry.ts);
        const id = (typeof entry.id === "string" && entry.id.trim()) ||
            (typeof entry.messageId === "string" && entry.messageId.trim()) ||
            `${sessionKey}-${index}-${ts}`;
        return {
            id,
            channel: typeof entry.channel === "string" ? entry.channel : role,
            text: extractTextFromMessage(entry),
            ts,
        };
    });
};
export const fetchUsageItems = async (days = 7) => {
    const summary = await gatewayRequest("usage.cost", { days });
    const daily = Array.isArray(summary?.daily) ? summary.daily : [];
    if (daily.length > 0) {
        return daily.map((entry) => ({
            id: entry.date,
            model: `All Models (${entry.date})`,
            tokens: entry.totalTokens,
            costUsd: entry.totalCost,
            ts: new Date(`${entry.date}T00:00:00Z`).toISOString(),
        }));
    }
    const totals = summary?.totals;
    if (totals) {
        return [
            {
                id: "total",
                model: "All Models (Total)",
                tokens: totals.totalTokens,
                costUsd: totals.totalCost,
                ts: new Date(summary.updatedAt ?? Date.now()).toISOString(),
            },
        ];
    }
    return [];
};
export const fetchSkills = async () => {
    const report = await gatewayRequest("skills.status", {});
    const skills = Array.isArray(report?.skills) ? report.skills : [];
    return skills.map((skill) => ({
        id: skill.skillKey,
        name: skill.emoji ? `${skill.emoji} ${skill.name}` : skill.name,
        enabled: skill.disabled !== true,
    }));
};
export const updateSkill = async (skillKey, enabled) => {
    await gatewayRequest("skills.update", { skillKey, enabled });
    const skills = await fetchSkills();
    const updated = skills.find((skill) => skill.id === skillKey);
    if (!updated) {
        return { id: skillKey, name: skillKey, enabled };
    }
    return updated;
};
