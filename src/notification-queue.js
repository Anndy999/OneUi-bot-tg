import {
  claimNotificationDelivery,
  completeNotificationDelivery,
  deleteFirmwareNotificationBatch,
  getFirmwareNotificationBatch
} from "./monitor-scheduler.js";
import {
  getAdminChatIds,
  getAllowedUsers,
  getUserLanguage,
  putPendingUpdate,
  recordMonitorEvent
} from "./state.js";
import { notifyAllowedUsersOnUpdate } from "./config.js";
import { formatFirmwareUpdateBatch } from "./utils.js";
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

function batchMenuKeyboard(lang = "zh") {
  return {
    inline_keyboard: [[{
      text: lang === "en" ? "Open menu" : "打开菜单",
      callback_data: "menu:home"
    }]]
  };
}

async function enqueueFirmwareBatchRecipients(env, batch) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  if (!events.length) return { attempted: 0, queued: 0, sent: 0 };
  const adminIds = await getAdminChatIds(env);
  const managerSet = new Set(adminIds.map((id) => String(id || "")));
  const allowedUsers = notifyAllowedUsersOnUpdate(env)
    ? await getAllowedUsers(env)
    : [];
  const recipients = new Map();

  if (events.some((event) => event.notifyManagers !== false)) {
    for (const chatId of adminIds) {
      recipients.set(String(chatId), {
        chatId: String(chatId),
        audience: "owner",
        events: events.filter((event) => event.notifyManagers !== false)
      });
    }
  }

  for (const user of allowedUsers) {
    const chatId = String(user.chatId || "").trim();
    if (!chatId || managerSet.has(chatId)) continue;
    const userEvents = events.filter((event) => event.notifyAllowedUsers !== false);
    if (!userEvents.length) continue;
    recipients.set(chatId, { chatId, audience: "allowed_user", events: userEvents });
  }

  let queued = 0;
  let sent = 0;
  const now = new Date();
  for (const recipient of recipients.values()) {
    const lang = await getUserLanguage(env, recipient.chatId);
    const scopedBatch = {
      ...batch,
      events: recipient.events,
      series: batch.series || recipient.events[0]?.series || "",
      csc: batch.csc || recipient.events[0]?.csc || ""
    };
    const delivery = await enqueueTelegramNotification(env, {
      id: `firmware-update-batch:${batch.id}:${recipient.chatId}`,
      chatId: recipient.chatId,
      text: formatFirmwareUpdateBatch(scopedBatch, now, lang),
      replyMarkup: batchMenuKeyboard(lang),
      monitorEvent: {
        model: recipient.events[0]?.model || "",
        csc: scopedBatch.csc,
        name: `${scopedBatch.series || "Samsung"} firmware batch`,
        audience: recipient.audience,
        source: "Samsung SmartHistory",
        detail: `Merged ${recipient.events.length} latest firmware update${recipient.events.length === 1 ? "" : "s"}`
      }
    });
    if (delivery.queued) queued += 1;
    if (delivery.sent) sent += 1;
  }
  return { attempted: recipients.size, queued, sent };
}

async function flushFirmwareUpdateBatch(env, payload) {
  const batchKey = String(payload?.batchKey || "");
  const batchId = String(payload?.batchId || "");
  const result = await getFirmwareNotificationBatch(env, batchKey, batchId);
  if (!result?.ok || !result.found || !result.batch) return { ok: true, missing: true };
  const batch = result.batch;
  const events = Array.isArray(batch.events) ? batch.events : [];
  if (!events.length) {
    await deleteFirmwareNotificationBatch(env, batchKey, batchId);
    return { ok: true, empty: true };
  }
  const [series, csc] = String(batchKey).split(":");
  batch.series = batch.series || String(series || "").toUpperCase();
  batch.csc = batch.csc || String(csc || "").toUpperCase();
  const delivery = await enqueueFirmwareBatchRecipients(env, batch);
  const deleted = await deleteFirmwareNotificationBatch(env, batchKey, batchId);
  if (deleted?.ok === false) throw new Error("Unable to clear delivered firmware notification batch");
  return { ok: true, ...delivery };
}

export async function processNotificationQueue(batch, env) {
  for (const queueMessage of batch.messages || []) {
    if (queueMessage?.body?.kind === "firmware_update_batch_flush") {
      try {
        await flushFirmwareUpdateBatch(env, queueMessage.body);
        queueMessage.ack();
      } catch (error) {
        console.log(`Firmware notification batch flush failed: ${error.message}`);
        queueMessage.retry({ delaySeconds: 15 });
      }
      continue;
    }

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
