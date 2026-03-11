import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import {
  fetchLatestAssistantMessage,
  sendChatMessage,
  waitForRun,
} from "./openclaw-gateway.js";

type EmailIngestHandle = {
  stop: () => void;
};

const getAddress = (value?: AddressObject | string | null): string => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  const first = value.value?.[0];
  if (!first) {
    return "";
  }
  if (first.name && first.address) {
    return `${first.name} <${first.address}>`;
  }
  return first.address || first.name || "";
};

const extractEmail = (value?: AddressObject | string | null): string => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    const match = value.match(/<([^>]+)>/);
    if (match?.[1]) {
      return match[1].trim().toLowerCase();
    }
    const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return emailMatch ? emailMatch[0].toLowerCase() : value.trim().toLowerCase();
  }
  const first = value.value?.[0];
  return first?.address?.trim().toLowerCase() || "";
};

const collectEmails = (...values: Array<AddressObject | string | null | undefined>): string[] => {
  const emails: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (typeof value === "string") {
      const parts = value.split(",");
      for (const part of parts) {
        const email = extractEmail(part);
        if (email) {
          emails.push(email);
        }
      }
      continue;
    }
    for (const entry of value.value ?? []) {
      if (entry?.address) {
        emails.push(entry.address.trim().toLowerCase());
      }
    }
  }
  return emails;
};

const parseCsv = (value?: string): string[] =>
  (value || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

const matchAllowlist = (from: string, allowEmails: string[], allowDomains: string[]): boolean => {
  if (!allowEmails.length && !allowDomains.length) {
    return true;
  }
  if (!from) {
    return false;
  }
  if (allowEmails.includes(from)) {
    return true;
  }
  const domain = from.split("@")[1] || "";
  return Boolean(domain && allowDomains.includes(domain));
};

const headerValue = (mail: ParsedMail, key: string): string => {
  const value = mail.headers?.get(key);
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(String).join(",");
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
};

const isLikelyBulk = (mail: ParsedMail): boolean => {
  const precedence = headerValue(mail, "precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return true;
  }
  const autoSubmitted = headerValue(mail, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return true;
  }
  if (headerValue(mail, "list-unsubscribe") || headerValue(mail, "list-id")) {
    return true;
  }
  if (headerValue(mail, "x-autoreply") || headerValue(mail, "x-autorespond")) {
    return true;
  }
  if (headerValue(mail, "x-auto-response-suppress")) {
    return true;
  }
  return false;
};

const ensureReplySubject = (subject: string): string => {
  if (!subject) {
    return "Re: (no subject)";
  }
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
};

const stripQuotedText = (text: string): string => {
  if (!text) {
    return "";
  }
  const patterns = [
    /^-----Original Message-----/m,
    /^----- Forwarded message -----/m,
    /^On .* wrote:$/m,
    /^From: .+$/m,
    /^Sent: .+$/m,
  ];
  let cutoff = text.length;
  for (const pattern of patterns) {
    const matchIndex = text.search(pattern);
    if (matchIndex !== -1) {
      cutoff = Math.min(cutoff, matchIndex);
    }
  }
  const sliced = text.slice(0, cutoff);
  const cleaned = sliced
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n");
  return cleaned.trim();
};

const extractThreadText = (mail: ParsedMail): string => {
  const text = mail.text || mail.textAsHtml || "";
  return stripQuotedText(text);
};

const tryParseForwarded = async (mail: ParsedMail): Promise<ParsedMail | null> => {
  const attachments = Array.isArray(mail.attachments) ? mail.attachments : [];
  for (const attachment of attachments) {
    const filename = attachment.filename?.toLowerCase() || "";
    if (
      attachment.contentType === "message/rfc822" ||
      filename.endsWith(".eml") ||
      filename.endsWith(".msg")
    ) {
      if (attachment.content instanceof Buffer) {
        return await simpleParser(attachment.content);
      }
    }
  }
  return null;
};

const buildSessionKey = (value: string): string => {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `agent:main:email:${hash}`;
};

const buildAgentPrompt = (mail: ParsedMail, forwarded?: ParsedMail | null): string => {
  const target = forwarded ?? mail;
  const subject = target.subject || mail.subject || "";
  const from = getAddress(target.from || mail.from);
  const body = extractThreadText(target);
  const context = body || "(no body text detected)";
  return [
    "You are replying to an email thread.",
    `Subject: ${subject || "(no subject)"}`,
    `From: ${from || "Unknown sender"}`,
    "Thread context:",
    context,
    "Write a concise, professional reply. Return plain text only.",
  ].join("\n\n");
};

const sendReplyEmail = async (params: {
  transporter: nodemailer.Transporter;
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string | string[];
}) => {
  await params.transporter.sendMail({
    from: params.from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    inReplyTo: params.inReplyTo,
    references: params.references,
  });
};

export const startEmailIngest = (): EmailIngestHandle => {
  const imapHost = process.env.EMAIL_IMAP_HOST?.trim() || "";
  const imapPort = Number(process.env.EMAIL_IMAP_PORT || 993);
  const imapUser = process.env.EMAIL_IMAP_USER?.trim() || "";
  const imapPass = process.env.EMAIL_IMAP_PASS?.trim() || "";
  const smtpHost = process.env.EMAIL_SMTP_HOST?.trim() || "";
  const smtpPort = Number(process.env.EMAIL_SMTP_PORT || 465);
  const smtpUser = process.env.EMAIL_SMTP_USER?.trim() || "";
  const smtpPass = process.env.EMAIL_SMTP_PASS?.trim() || "";
  const fromAddress = process.env.EMAIL_FROM?.trim() || imapUser;
  const pollSeconds = Number(process.env.EMAIL_POLL_SECONDS || 60);
  const maxMessages = Number(process.env.EMAIL_MAX_MESSAGES || 20);
  const sinceHours = Number(process.env.EMAIL_SINCE_HOURS || 24);
  const mailbox = process.env.EMAIL_IMAP_MAILBOX?.trim() || "INBOX";
  const debug = process.env.EMAIL_DEBUG === "1";
  const inboxAddress = (process.env.EMAIL_INGEST_INBOX || imapUser).trim().toLowerCase();
  const requireForwarded = process.env.EMAIL_REQUIRE_FORWARDED === "1";
  const skipBulk = process.env.EMAIL_SKIP_BULK !== "0";
  const sendReplies = process.env.EMAIL_SEND_REPLIES !== "0";
  const allowEmails = parseCsv(process.env.EMAIL_ALLOWED_SENDERS);
  const allowDomains = parseCsv(process.env.EMAIL_ALLOWED_DOMAINS);

  const log = (...args: unknown[]) => {
    if (debug) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  };

  if (!imapHost || !imapUser || !imapPass || !smtpHost || !smtpUser || !smtpPass) {
    // eslint-disable-next-line no-console
    console.log("[email] ingest disabled (missing IMAP/SMTP config)");
    return { stop: () => undefined };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  log(
    `[email] ingest enabled (imap=${imapHost}:${imapPort} user=${imapUser} mailbox=${mailbox} poll=${pollSeconds}s max=${maxMessages} since=${sinceHours}h inbox=${inboxAddress} requireForwarded=${requireForwarded} skipBulk=${skipBulk} sendReplies=${sendReplies})`,
  );

  let stopped = false;
  let polling = false;

  const pollOnce = async () => {
    if (stopped || polling) {
      return;
    }
    polling = true;
    log("[email] poll start");
    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: imapUser, pass: imapPass },
      logger: false,
    });

    try {
      await client.connect();
      await client.mailboxOpen(mailbox);

      const sinceDate = new Date(Date.now() - Math.max(1, sinceHours) * 60 * 60 * 1000);
      const unseen = await client.search({ seen: false, since: sinceDate });
      const recent = unseen.slice(Math.max(0, unseen.length - Math.max(1, maxMessages)));
      log(`[email] unseen=${unseen.length} recent=${recent.length}`);
      if (!sendReplies) {
        log("[email] replies disabled (EMAIL_SEND_REPLIES=0); skipping this poll.");
        return;
      }
      for (const uid of recent) {
        const message = await client.fetchOne(uid, { source: true, envelope: true });
        if (!message?.source) {
          continue;
        }
        const parsed = await simpleParser(message.source);
        const forwarded = await tryParseForwarded(parsed);
        const prompt = buildAgentPrompt(parsed, forwarded);
        const fromEmail = extractEmail(parsed.from);
        const toEmails = collectEmails(parsed.to, parsed.cc, parsed.bcc);
        const addressedToInbox = !inboxAddress || toEmails.includes(inboxAddress);
        const subject = parsed.subject || "";
        const bodyText = parsed.text || parsed.textAsHtml || "";
        const forwardedMarkers = /forwarded message|original message/i;
        const isForwarded =
          Boolean(forwarded) || /^(fwd?|fw):/i.test(subject) || forwardedMarkers.test(bodyText);

        if (!addressedToInbox) {
          log(`[email] skip uid=${uid} reason=not-addressed-to-inbox`);
          continue;
        }
        if (skipBulk && isLikelyBulk(parsed)) {
          log(`[email] skip uid=${uid} reason=bulk-detected`);
          continue;
        }
        if (!matchAllowlist(fromEmail, allowEmails, allowDomains)) {
          log(`[email] skip uid=${uid} reason=sender-not-allowed from=${fromEmail}`);
          continue;
        }
        if (requireForwarded && !isForwarded) {
          log(`[email] skip uid=${uid} reason=not-forwarded`);
          continue;
        }

        log(
          `[email] processing uid=${uid} from=${getAddress(parsed.from)} subject=${subject}`,
        );

        const sessionKey = buildSessionKey(parsed.messageId || parsed.subject || String(uid));
        const runId = await sendChatMessage(sessionKey, prompt, { timeoutMs: 30_000 });
        await waitForRun(runId, 90_000);
        const reply = await fetchLatestAssistantMessage(sessionKey, 50);

        const target = forwarded ?? parsed;
        const toAddress = getAddress(target.replyTo || target.from || parsed.from);
        if (toAddress && reply.trim()) {
          const subject = ensureReplySubject(target.subject || parsed.subject || "");
          await sendReplyEmail({
            transporter,
            from: fromAddress,
            to: toAddress,
            subject,
            text: reply.trim(),
            inReplyTo: target.messageId || undefined,
            references: target.references || target.messageId || undefined,
          });
          log(`[email] replied to ${toAddress}`);
        } else {
          log(`[email] skipped uid=${uid} (no reply or address)`);
        }

        await client.messageFlagsAdd(uid, ["\\Seen"]);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[email] ingest error", err);
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
      polling = false;
    }
  };

  const intervalMs = Math.max(15, Number.isFinite(pollSeconds) ? pollSeconds : 60) * 1000;
  const timer = setInterval(pollOnce, intervalMs);
  void pollOnce();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
