import { enqueueTelegramNotification } from "../notification-queue.js";
import { getAdminChatIds, getAllowedUsers } from "../state.js";

// This is intentionally a fixed, one-time notice. Its durable marker prevents
// service restarts from sending repeated apologies to the same users.
const TESTING_APOLOGY_NOTICE_ID = "testing-apology-2026-08-v1";
const NOTICE_STORAGE_KEY = `oneui:ordinary-user-notice:${TESTING_APOLOGY_NOTICE_ID}`;
const NOTICE_LOCK_KEY = `${NOTICE_STORAGE_KEY}:lock`;
const NOTICE_LOCK_MS = 60_000;

function storageFor(runtime) {
  return runtime?.context?.storage || runtime?.env?.FIRMWARE_KV || null;
}

function ordinaryAllowedUserIds(users = [], adminIds = []) {
  const admins = new Set((adminIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  return [...new Set((users || [])
    .map((user) => String(user?.chatId || "").trim())
    .filter((chatId) => chatId && !admins.has(chatId)))]
    .sort();
}

function testingApologyText() {
  return [
    "📣 服务公告 / Service Notice",
    "",
    "因机器人正在测试，近期可能出现异常或重复推送。抱歉打扰，望理解。",
    "",
    "The bot is currently undergoing testing. You may have received abnormal or duplicate notifications recently. We sincerely apologize for the disturbance and appreciate your understanding."
  ].join("\n");
}

/**
 * Queue one bilingual apology for ordinary allowed users only. Test-firmware
 * messages remain owner-only; this is a separate, explicitly requested notice.
 */
export async function broadcastTestingApologyToAllowedUsers(runtime, logger = console) {
  const storage = storageFor(runtime);
  if (!storage?.get || !storage?.put) {
    logger.warn?.("Testing apology notice skipped because durable storage is unavailable");
    return { queued: false, reason: "storage_unavailable", recipients: 0 };
  }

  let lock = null;
  const locks = runtime?.context?.locks;
  if (locks?.acquire) {
    lock = await locks.acquire(NOTICE_LOCK_KEY, NOTICE_LOCK_MS);
    if (!lock?.acquired) return { queued: false, reason: "busy", recipients: 0 };
  }

  try {
    if (await storage.get(NOTICE_STORAGE_KEY)) {
      return { queued: false, reason: "already_sent", recipients: 0 };
    }

    const [admins, users] = await Promise.all([
      getAdminChatIds(runtime.env),
      getAllowedUsers(runtime.env)
    ]);
    const recipients = ordinaryAllowedUserIds(users, admins);
    const text = testingApologyText();
    let deliveries = 0;
    const failures = [];

    for (const chatId of recipients) {
      try {
        const delivery = await enqueueTelegramNotification(runtime.env, {
          id: `service-notice:${TESTING_APOLOGY_NOTICE_ID}:${chatId}`,
          chatId,
          text,
          monitorEvent: {
            type: "service_notice",
            audience: "allowed_user",
            source: "testing-apology"
          }
        });
        if (delivery?.queued || delivery?.sent) deliveries += 1;
        else failures.push(chatId);
      } catch (error) {
        failures.push(chatId);
        logger.warn?.(`Testing apology notice queue failed for ${chatId}: ${String(error?.message || error).slice(0, 160)}`);
      }
    }

    // Do not persist completion after a partial enqueue. In production the
    // fixed BullMQ job IDs make the next startup safe while the failed
    // recipient is retried without duplicate queued notifications.
    if (failures.length) {
      return {
        queued: false,
        reason: "enqueue_failed",
        recipients: recipients.length,
        deliveries,
        failures: failures.length
      };
    }

    await storage.put(NOTICE_STORAGE_KEY, JSON.stringify({
      noticeId: TESTING_APOLOGY_NOTICE_ID,
      recipients: recipients.length,
      deliveries,
      createdAt: new Date().toISOString()
    }));
    logger.info?.(`Queued one-time testing apology notice for ${deliveries}/${recipients.length} ordinary users`);
    return { queued: true, recipients: recipients.length, deliveries };
  } finally {
    if (lock?.acquired) await locks.release(NOTICE_LOCK_KEY, lock.token).catch(() => {});
  }
}

export {
  NOTICE_STORAGE_KEY as TESTING_APOLOGY_NOTICE_STORAGE_KEY,
  TESTING_APOLOGY_NOTICE_ID,
  ordinaryAllowedUserIds,
  testingApologyText
};
