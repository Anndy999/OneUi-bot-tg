import {
  claimNotificationDelivery,
  completeNotificationDelivery
} from "./monitor-scheduler.js";
import { putPendingUpdate, recordMonitorEvent } from "./state.js";
import { sendTelegramMessage } from "./telegram.js";

function queueEnabled(env) {
  return Boolean(env?.NOTIFICATION_QUEUE?.send) &&
    String(env.NOTIFICATION_QUEUE_ENABLED ?? "true").toLowerCase() !== "false";
}

function normalizeMessage(payload) {
  const chatId = String(payload?.chatId || "").trim();
  const text = String(payload?.text || "");
  const id = String(payload?.id || "").trim();
  if (!id || !chatId || !text) throw new Error("Notification id, chatId and text are required");
  return {
    schemaVersion: 1,
    id,
    chatId,
    text,
    replyMarkup: payload.replyMarkup || undefined,
    monitorEvent: payload.monitorEvent || null,
    pendingAfterSuccess: payload.pendingAfterSuccess || null,
    createdAt: payload.createdAt || new Date().toISOString()
  };
}

async function recordDeliveryEvent(env, message) {
  if (!message.monitorEvent || typeof message.monitorEvent !== "object") return;
  try {
    await recordMonitorEvent(env, {
      ...message.monitorEvent,
      type: "notification_delivered",
      detail: "Telegram delivery confirmed",
      at: new Date().toISOString()
    });
  } catch (error) {
    console.log(`Notification delivery event deferred: ${error.message}`);
  }
}

async function sendOnly(env, message) {
  return Boolean(await sendTelegramMessage(
    env,
    message.chatId,
    message.text,
    message.replyMarkup
  ));
}

async function applyPostSuccess(env, message) {
  if (!message.pendingAfterSuccess) return true;
  await putPendingUpdate(env, message.pendingAfterSuccess);
  return true;
}

async function deliverDirect(env, message) {
  const sent = await sendOnly(env, message);
  if (!sent) return false;
  await applyPostSuccess(env, message);
  await recordDeliveryEvent(env, message);
  return true;
}

export async function enqueueTelegramNotification(env, payload) {
  const message = normalizeMessage(payload);
  if (queueEnabled(env)) {
    await env.NOTIFICATION_QUEUE.send(message);
    return { ok: true, queued: true, sent: false };
  }
  const sent = await deliverDirect(env, message);
  return { ok: sent, queued: false, sent };
}

export async function processNotificationQueue(batch, env) {
  for (const queueMessage of batch.messages || []) {
    let message;
    try {
      message = normalizeMessage(queueMessage.body);
    } catch (error) {
      console.log(`Discarding invalid notification queue message: ${error.message}`);
      queueMessage.ack();
      continue;
    }

    const claim = await claimNotificationDelivery(env, message.id);
    if (env.MONITOR_SCHEDULER && !claim) {
      queueMessage.retry({ delaySeconds: 15 });
      continue;
    }
    if (claim?.duplicate) {
      // Telegram was already sent in an earlier attempt. Only finish the
      // idempotent state transition so a transient KV failure cannot cause a
      // duplicate Telegram message on retry.
      try {
        await applyPostSuccess(env, message);
        queueMessage.ack();
      } catch (error) {
        console.log(`Notification post-success update failed for ${message.id}: ${error.message}`);
        queueMessage.retry({ delaySeconds: 30 });
      }
      continue;
    }
    if (claim?.busy) {
      queueMessage.retry({ delaySeconds: 10 });
      continue;
    }

    let markedSent = false;
    try {
      const sent = await sendOnly(env, message);
      if (!sent) {
        await completeNotificationDelivery(env, message.id, claim?.lock || "", false);
        queueMessage.retry({ delaySeconds: 30 });
        continue;
      }

      // Mark the irreversible Telegram side effect first. If the following KV
      // update fails, the retry observes duplicate=true and applies only that
      // state update instead of sending the same Telegram message again.
      const completed = await completeNotificationDelivery(env, message.id, claim?.lock || "", true);
      if (env.MONITOR_SCHEDULER && !completed?.ok) {
        throw new Error("Unable to persist notification delivery state");
      }
      markedSent = true;
      await applyPostSuccess(env, message);
      await recordDeliveryEvent(env, message);
      queueMessage.ack();
    } catch (error) {
      console.log(`Notification queue delivery failed for ${message.id}: ${error.message}`);
      // Only release the claim when Telegram was not durably marked as sent.
      // Once marked, a retry must execute only the post-success state update.
      if (!markedSent) {
        await completeNotificationDelivery(env, message.id, claim?.lock || "", false).catch(() => {});
      }
      queueMessage.retry({ delaySeconds: 30 });
    }
  }
}
