function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramApi(env, method, payload, options = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN is not configured");
    return { ok: false, description: "TELEGRAM_BOT_TOKEN is not configured" };
  }

  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? 2));
  const timeoutMs = Math.max(250, Number(options.timeoutMs ?? 5000));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok !== false) return data;

      const description = String(data?.description || `HTTP ${response.status}`);
      console.log(`Telegram ${method} failed: HTTP ${response.status}: ${description}`);
      const retryAfter = Number(data?.parameters?.retry_after || 0);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt + 1 >= maxAttempts) {
        return {
          ok: false,
          status: response.status,
          description,
          parameters: data?.parameters || null
        };
      }
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 250);
    } catch (error) {
      console.log(`Telegram ${method} network error: ${error.message}`);
      if (attempt + 1 >= maxAttempts) return { ok: false, description: error.message };
      await sleep(200);
    }
  }
  return { ok: false };
}

export async function sendTelegramMessageResult(env, chatId, text, replyMarkup = undefined) {
  if (!chatId) {
    console.log("Telegram chat id is empty");
    return { ok: false, description: "Telegram chat id is empty" };
  }

  const result = await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
  return {
    ...result,
    messageId: result?.result?.message_id || null
  };
}

export async function sendTelegramMessage(env, chatId, text, replyMarkup = undefined) {
  const parts = splitTelegramText(text);
  for (let index = 0; index < parts.length; index += 1) {
    const result = await sendTelegramMessageResult(
      env,
      chatId,
      parts[index],
      index === parts.length - 1 ? replyMarkup : undefined
    );
    if (!result.ok) return false;
  }
  return true;
}

export async function editTelegramMessageResult(env, chatId, messageId, text, replyMarkup = undefined) {
  if (!chatId || !messageId) return { ok: false, description: "Missing chat or message id" };
  const result = await telegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
  if (!result.ok && result.status === 400 && /message is not modified/i.test(String(result.description || ""))) {
    return { ok: true, notModified: true };
  }
  return result;
}

export async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = undefined) {
  const result = await editTelegramMessageResult(env, chatId, messageId, text, replyMarkup);
  return Boolean(result.ok);
}

export async function answerCallbackQuery(env, callbackQueryId, text = "", options = {}) {
  if (!callbackQueryId) return false;
  const payload = { callback_query_id: callbackQueryId, cache_time: 0 };
  if (text) payload.text = String(text).slice(0, 200);
  if (options.showAlert) payload.show_alert = true;
  const result = await telegramApi(env, "answerCallbackQuery", payload, {
    maxAttempts: options.maxAttempts ?? 1,
    timeoutMs: options.timeoutMs ?? 1500
  });
  return Boolean(result.ok);
}

export async function safeEditOrSend(env, chatId, messageId, text, replyMarkup = undefined) {
  const parts = splitTelegramText(text);
  const edited = await editTelegramMessageResult(
    env,
    chatId,
    messageId,
    parts[0],
    parts.length === 1 ? replyMarkup : undefined
  );
  if (!edited.ok) return sendTelegramMessage(env, chatId, text, replyMarkup);
  for (let index = 1; index < parts.length; index += 1) {
    const sent = await sendTelegramMessageResult(
      env,
      chatId,
      parts[index],
      index === parts.length - 1 ? replyMarkup : undefined
    );
    if (!sent.ok) return false;
  }
  return true;
}

function splitTelegramText(text, maxLength = 3900) {
  const value = String(text || "");
  if (value.length <= maxLength) return [value];
  const parts = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = maxLength;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export async function sendTelegramLongMessage(env, chatId, text, replyMarkup = undefined) {
  const parts = splitTelegramText(text);
  let firstMessageId = null;
  for (let index = 0; index < parts.length; index += 1) {
    const result = await sendTelegramMessageResult(
      env,
      chatId,
      parts[index],
      index === parts.length - 1 ? replyMarkup : undefined
    );
    if (!result.ok) return { ok: false, sent: index, firstMessageId };
    if (!firstMessageId) firstMessageId = result.messageId;
  }
  return { ok: true, sent: parts.length, firstMessageId };
}

export function chatIdFromUpdate(update) {
  return update?.message?.chat?.id || update?.edited_message?.chat?.id || update?.callback_query?.message?.chat?.id || "";
}

export function textFromUpdate(update) {
  return update?.message?.text || update?.edited_message?.text || "";
}

export function replyTargetFromMessage(message) {
  const from = message?.reply_to_message?.from;
  if (!from?.id) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id);
  return { chatId: String(from.id), name };
}
