import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

// How long the wake-up worker stays silent before sending the next nudge.
const nudgeIntervalMs = Number(process.env.PI_WAKEUP_NUDGE_INTERVAL_MINUTES ?? 2) * 60 * 1000;
// How long Telegram must stay quiet after confirmation before Pi shuts down,
// so that follow-up messages in the same wake-up window are still answered.
const idleDrainMs = 5 * 60 * 1000;
if (!Number.isFinite(nudgeIntervalMs) || nudgeIntervalMs < 60_000) {
  throw new Error("PI_WAKEUP_NUDGE_INTERVAL_MINUTES must be a number of minutes, at least 1.");
}
const startTime = Date.now();
const agentDir = path.join(homedir(), ".pi", "agent");
const telegramDir = path.join(agentDir, "tmp", "telegram");
const journalPath = path.join(telegramDir, "inbox.json");
const statusPath = path.join(telegramDir, "state.json");
const completionPath = process.env.PI_WAKEUP_COMPLETED_FILE;
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const promptDir = path.join(workspace, ".github", "prompts");
const startPrompt = readFileSync(path.join(promptDir, "telegram-wakeup-start.md"), "utf8").trim();
const nudgePrompt = readFileSync(path.join(promptDir, "telegram-wakeup-nudge.md"), "utf8").trim();

if (!completionPath) throw new Error("PI_WAKEUP_COMPLETED_FILE is not configured.");
if (!process.env.PI_TELEGRAM_MODEL) throw new Error("PI_TELEGRAM_MODEL is not configured.");

let lastResponseAt;
let lastResponseCount;
let sawUpdates = false;
let lastMessageAt;
let nextNudgeAt;
let activeAgent = false;
let connected = false;
let finished = false;
let stderrText = "";
let sawAgentStart = false;
const recentRpcEvents = [];
const extensionFailures = [];
const pendingPromptIds = new Set();
let connectResponse = "not-received";
let failure;
let wakeupCompleteAt;
let nudgeSequence = 0;

const initialJournal = readJson(journalPath);
const hadCursor = Number.isSafeInteger(initialJournal?.acceptedThroughUpdateId);
if (!hadCursor) throw new Error("Telegram inbox cursor is not initialized.");

const child = spawn("pi", [
  "--mode", "rpc",
  "--model", process.env.PI_TELEGRAM_MODEL,
], {
  cwd: path.join(process.env.RUNNER_TEMP, "pi-telegram-wakeup-workspace"),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  stderrText = `${stderrText}${chunk.toString("utf8")}`.slice(-16_384);
});
child.once("error", () => { failure = new Error("Pi could not be started."); });
child.once("close", (code) => {
  if (!finished && code !== 0) failure ??= new Error("Pi exited before the wake-up run completed.");
});

function send(command) {
  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }
}

function sendPiPrompt(id, message) {
  pendingPromptIds.add(id);
  send({ id, type: "prompt", message });
}

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }

  if (typeof event.type === "string") {
    const label = `${safeLabel(event.type)}${event.method ? `:${safeLabel(event.method)}` : ""}`;
    recentRpcEvents.push(label);
    if (recentRpcEvents.length > 20) recentRpcEvents.shift();
  }
  if (event.type === "extension_error") {
    const error = event.error;
    const message = typeof error === "string" ? error : error?.message ?? error?.name ?? event.message;
    extensionFailures.push(classifyDiagnostic(message));
    if (extensionFailures.length > 8) extensionFailures.shift();
  }
  if (event.type === "agent_start") { activeAgent = true; sawAgentStart = true; }
  if (event.type === "agent_settled") {
    activeAgent = false;
    if (!wakeupCompleteAt) nextNudgeAt = Date.now() + nudgeIntervalMs;
  }
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    send({ type: "extension_ui_response", id: event.id, cancelled: true });
  }
  if (event.id === "telegram-connect" && event.type === "response") {
    connectResponse = event.success === false ? "failed" : "received";
    if (event.success === false) failure = new Error("Pi Telegram connection command failed.");
  }
  if (typeof event.id === "string" && pendingPromptIds.has(event.id) && event.type === "response") {
    pendingPromptIds.delete(event.id);
    if (event.success === false) failure = new Error("Pi could not accept a wake-up prompt.");
  }
});

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

function getPendingCount() {
  const journal = readJson(journalPath);
  return Array.isArray(journal?.entries) ? journal.entries.length : 0;
}

function getPollingState() {
  return readJson(statusPath)?.runtime?.polling;
}

function getWakeupCompletionTime() {
  try {
    const stat = lstatSync(completionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (readFileSync(completionPath, "utf8").trim() !== "confirmed") return undefined;
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLabel(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : "unknown";
}

function classifyDiagnostic(value) {
  const message = String(value ?? "").toLowerCase();
  if (/\b401\b|unauthorized|invalid bot token|token rejected/.test(message)) return "auth";
  if (/\b409\b|terminated by other getupdates|poller conflict/.test(message)) return "poller-conflict";
  if (/\b429\b|too many requests|rate limit/.test(message)) return "rate-limited";
  if (/enotfound|eai_again|econn|etimedout|network|fetch failed|socket/.test(message)) return "network";
  if (/environment variable .*not set|missing .*environment|environment .*missing/.test(message)) return "missing-env";
  if (/cannot find (module|package)|module not found|enoent|no such file/.test(message)) return "missing-file-or-module";
  if (/permission denied|eacces|eperm/.test(message)) return "permission";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/invalid|malformed|syntaxerror|parse error/.test(message)) return "invalid-config-or-state";
  return /error|failed|exception/.test(message) ? "other-error" : "info";
}

function getSafeDiagnostics() {
  const logPath = path.join(telegramDir, "logs.jsonl");
  let events = [];
  try {
    events = readFileSync(logPath, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.kind === "event");
  } catch { /* diagnostics are optional */ }
  const runtime = events.slice(-12).map((event) =>
    `${safeLabel(event.category)}:${safeLabel(event.details?.phase)}:${classifyDiagnostic(event.message)}`,
  );
  const polling = getPollingState();
  return `status=${existsSync(statusPath) ? safeLabel(polling?.phase) : "missing"}, agent-start=${sawAgentStart}, rpc=${recentRpcEvents.join(",") || "none"}, extension-errors=${extensionFailures.join(",") || "none"}, runtime=${runtime.join(",") || "none"}, stderr=${classifyDiagnostic(stderrText)}`;
}

async function shutdown() {
  finished = true;
  lines.close();
  if (child.exitCode !== null || child.killed) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end();
  const forcedStop = setTimeout(() => child.kill("SIGTERM"), 15_000);
  await closed;
  clearTimeout(forcedStop);
}

async function run() {
  const startupPromptId = "telegram-wakeup-start";
  let startupDeadline;
  let firstResponseDeadline;

  try {
    send({ id: "telegram-connect", type: "prompt", message: "/telegram-connect" });
    startupDeadline = Date.now() + 120_000;
    while (Date.now() < startupDeadline) {
      if (failure) throw failure;
      const polling = getPollingState();
      if (Number.isFinite(polling?.startedAtMs) && polling.startedAtMs >= startTime - 5_000) {
        connected = true;
        break;
      }
      if (child.exitCode !== null) throw new Error("Pi exited before Telegram polling started.");
      await wait(500);
    }
    if (!connected) {
      const polling = getPollingState();
      throw new Error(`Pi Telegram polling did not start within two minutes (connect=${connectResponse}, phase=${safeLabel(polling?.phase)}, stop=${safeLabel(polling?.stopReason)}).`);
    }

    lastMessageAt = Date.now();
    nextNudgeAt = Date.now() + nudgeIntervalMs;
    firstResponseDeadline = Date.now() + 90_000;
    sendPiPrompt(startupPromptId, startPrompt);

    while (true) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("Pi exited before the wake-up run completed.");

      const polling = getPollingState();
      if (polling?.phase === "stopped" && polling?.stopReason === "persistent-conflict") {
        throw new Error("Another Telegram getUpdates poller owns this bot token.");
      }
      if (polling?.phase === "stopped" && polling?.startedAtMs >= startTime &&
          polling?.stopReason && polling.stopReason !== "requested") {
        throw new Error("Pi Telegram polling stopped unexpectedly.");
      }

      const responseAt = polling?.lastSuccessfulResponseAtMs;
      const responseCount = polling?.lastSuccessfulResponseUpdateCount;
      if (Number.isFinite(responseAt) && responseAt !== lastResponseAt) {
        lastResponseAt = responseAt;
        lastResponseCount = Number.isSafeInteger(responseCount) ? responseCount : 0;
        if (lastResponseCount > 0) {
          sawUpdates = true;
          lastMessageAt = responseAt;
          nextNudgeAt = responseAt + nudgeIntervalMs;
        }
      }
      if (!Number.isFinite(lastResponseAt) && Date.now() > firstResponseDeadline) {
        throw new Error("Pi Telegram polling did not receive its first update response.");
      }

      if (!wakeupCompleteAt) {
        wakeupCompleteAt = getWakeupCompletionTime();
        if (wakeupCompleteAt) {
          lastMessageAt = Math.max(lastMessageAt ?? wakeupCompleteAt, wakeupCompleteAt);
          console.log("Pi marked the wake-up task complete; waiting for Telegram to be idle.");
        }
      }

      if (wakeupCompleteAt && Number.isFinite(lastMessageAt) && Number.isFinite(lastResponseAt) &&
          lastResponseCount === 0 &&
          lastResponseAt >= Math.max(lastMessageAt, wakeupCompleteAt) + idleDrainMs &&
          !activeAgent && getPendingCount() === 0) {
        break;
      }

      if (!wakeupCompleteAt && Date.now() >= nextNudgeAt && !activeAgent &&
          pendingPromptIds.size === 0 && getPendingCount() === 0) {
        nudgeSequence += 1;
        const promptId = `telegram-wakeup-nudge-${nudgeSequence}`;
        sendPiPrompt(promptId, nudgePrompt);
        nextNudgeAt = Date.now() + nudgeIntervalMs;
      }
      await wait(500);
    }

    await shutdown();
    const drainMinutes = Math.round(idleDrainMs / 60_000);
    console.log(sawUpdates
      ? `Pi confirmed the wake-up task is complete; Telegram was idle for ${drainMinutes} minutes and Pi shut down cleanly.`
      : `Pi completed the wake-up task; Telegram was idle for ${drainMinutes} minutes and Pi shut down cleanly.`);
  } catch (error) {
    await shutdown();
    console.error(`Pi Telegram diagnostics: ${getSafeDiagnostics()}`);
    // Deliberately omit provider responses, Telegram text, and raw errors.
    console.error(error?.message || "Pi Telegram wake-up worker failed.");
    process.exitCode = 1;
  }
}

run();
