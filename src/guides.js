export function guideText(identity, lang = "zh") {
  if (lang === "en") return englishGuide(identity);
  return chineseGuide(identity);
}

function chineseGuide(identity) {
  if (identity === "admin") {
    return [
      "管理员",
      "",
      "发送 Model / CSC 查询固件，例如：9480 CHC。",
      "在 CSC 后追加完整版本号，可查询指定版本。",
      "例如：SM-S9480 CHC S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1。",
      "查询结果可刷新、清缓存或加入监控。",
      "",
      "管理入口：监控、发布链、用户、管理员。",
      "发布链发现新固件后，由管理员或所有者确认推进。",
      "新固件只通知一次，监控继续运行。",
      "监控间隔：/moninterval 15（1-1440 分钟）。",
      "",
      "详细命令：点击“命令”或发送 /adminhelp。"
    ].join("\n");
  }
  if (identity === "allowed") {
    return [
      "Samsung 固件查询说明",
      "",
      "直接发送型号：9480",
      "精确指定 Model / CSC：SM-S948B EUX",
      "在 CSC 后追加完整版本号，可查询指定版本。",
      "",
      "查询结果下方可实时刷新并查看 Samsung 官方说明。",
      "每位白名单用户同一型号每天最多查询 10 次，不同 CSC 共用次数。",
      "每日次数在北京时间 00:00 重置。",
      "主菜单可查看个人权限、机器人状态和切换语言。"
    ].join("\n");
  }
  return [
    "Samsung 固件查询说明",
    "",
    "你还没有查询权限。",
    "请点击“申请查询权限”，管理员批准后即可使用。",
    "“我的信息”可以查看 Chat ID 和当前权限状态。"
  ].join("\n");
}

function englishGuide(identity) {
  if (identity === "admin") {
    return [
      "Admin quick help",
      "",
      "Send a Model / CSC directly, for example: 9480 CHC.",
      "Append a full firmware version after CSC to query that exact version.",
      "Example: SM-S9480 CHC S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1.",
      "A result can be refreshed, cache-cleared, or added to monitoring.",
      "",
      "Rollout chains advance only after an owner or administrator confirms a detected update.",
      "Target details provide priority, pause/resume, realtime query, and delete actions.",
      "Firmware updates are sent once only. Monitoring continues on its normal schedule without acknowledgement reminders.",
      "Use /moninterval 15 to apply one default 15-minute monitoring interval. The valid range is 1-1440 minutes.",
      "",
      "Open Commands or send /adminhelp for the full list."
    ].join("\n");
  }
  if (identity === "allowed") {
    return [
      "Samsung firmware query",
      "",
      "Send a model: 9480",
      "Send an exact Model / CSC: SM-S948B EUX",
      "Append a full firmware version after CSC to query a specific version.",
      "",
      "Use the buttons below a result for realtime refresh and official notes.",
      "Use Add to My Devices to save a shortcut; /devices manages saved queries and new-version notifications.",
      "Each approved user can query the same model up to 10 times per Beijing day; all CSCs share the counter.",
      "The main menu provides account info, status, and language settings."
    ].join("\n");
  }
  return [
    "Samsung firmware query",
    "",
    "You do not have query access yet.",
    "Tap Request access and wait for administrator approval.",
    "My info shows your Chat ID and current access status."
  ].join("\n");
}

export function adminHelpParts(lang = "zh") {
  if (lang === "en") {
    return [
      [
        "Administrator fallback commands",
        "",
        "Roles: the owner is TELEGRAM_CHAT_ID; added administrators can manage monitoring, users, and rollout confirmations.",
        "Owner only: /admins (list), /adminadd CHAT_ID NAME (add), /admindel CHAT_ID (remove), /chainstage s26 eu (correct a rollout region), /chainstart s25 (recovery restart).",
        "Ask a new administrator to send /whoami privately first, then use the returned Chat ID with /adminadd.",
        "",
        "/refresh MODEL CSC - Force a realtime firmware query",
        "/download MODEL CSC [VERSION] - Verify Samsung firmware, then confirm the VPS download",
        "/add MODEL CSC NAME - Add a monitoring target",
        "/del MODEL CSC - Remove a monitoring target",
        "/useradd CHAT_ID NAME - Add an allowed user",
        "/userdel CHAT_ID - Remove an allowed user",
        "/admins - List administrators (owner only)",
        "/adminadd CHAT_ID NAME - Add an administrator (owner only)",
        "/admindel CHAT_ID - Remove an administrator (owner only)",
        "/chain - Open rollout chains",
        "/chainadd s26 kr MODEL CSC NAME - Add an exact rollout target",
        "/chaininterval s26 15 - Set one rollout-chain interval",
        "/chaintime s26 08:00 23:00 - Set one rollout-chain time window",
        "/chainenable s26 on - Start S26; S25 starts automatically after S26 Korea is confirmed",
        "/chainstage s26 eu - Change the current rollout region (owner only)",
        "/monsnooze MODEL CSC 6h - Pause and automatically resume monitoring",
        "/moninterval 15 - Set one default monitoring interval (1-1440 minutes)",
        "",
        "Firmware updates are sent once; /ack and /pending are no longer required."
      ].join("\n"),
      [
        "Advanced maintenance commands",
        "",
        "/debugquery MODEL CSC - Diagnose Samsung query sources",
        "/cacheclear MODEL CSC - Clear one target cache",
        "/cacheclear all - Clear all query caches",
        "/synccommands - Synchronize Telegram shortcut commands"
      ].join("\n")
    ];
  }
  return [
    [
      "\u7ba1\u7406\u5458\u5907\u7528\u547d\u4ee4",
      "",
      "\u6743\u9650\uff1a\u6240\u6709\u8005\u7531 TELEGRAM_CHAT_ID \u786e\u5b9a\uff1b\u65b0\u589e\u7ba1\u7406\u5458\u53ef\u7ba1\u7406\u76d1\u63a7\u3001\u7528\u6237\u548c\u53d1\u5e03\u94fe\u786e\u8ba4\u3002",
      "\u4ec5\u6240\u6709\u8005\uff1a/admins \u67e5\u770b\u3001/adminadd CHAT_ID \u5907\u6ce8 \u6dfb\u52a0\u3001/admindel CHAT_ID \u79fb\u9664\u3001/chainstage s26 eu \u7ea0\u6b63\u53d1\u5e03\u5730\u533a\u3001/chainstart s25 \u5f02\u5e38\u65f6\u91cd\u65b0\u542f\u52a8 S25\u3002",
      "\u6dfb\u52a0\u7ba1\u7406\u5458\u524d\uff0c\u8ba9\u5bf9\u65b9\u5148\u79c1\u804a\u673a\u5668\u4eba\u53d1\u9001 /whoami\uff0c\u518d\u628a\u8fd4\u56de\u7684 Chat ID \u586b\u5165 /adminadd\u3002",
      "",
      "/refresh MODEL CSC - \u5f3a\u5236\u5b9e\u65f6\u67e5\u8be2",
      "/download MODEL CSC [VERSION] - \u5148\u9a8c\u8bc1\u4e09\u661f\u56fa\u4ef6\uff0c\u786e\u8ba4\u540e\u518d\u4e0b\u8f7d\u5230 VPS",
      "/add MODEL CSC \u540d\u79f0 - \u6dfb\u52a0\u76d1\u63a7\u8bbe\u5907",
      "/del MODEL CSC - \u5220\u9664\u76d1\u63a7\u8bbe\u5907",
      "/useradd CHAT_ID \u5907\u6ce8 - \u6dfb\u52a0\u6388\u6743\u7528\u6237",
      "/userdel CHAT_ID - \u5220\u9664\u6388\u6743\u7528\u6237",
      "/admins - \u67e5\u770b\u7ba1\u7406\u5458\uff08\u4ec5\u6240\u6709\u8005\uff09",
      "/adminadd CHAT_ID \u5907\u6ce8 - \u6dfb\u52a0\u7ba1\u7406\u5458\uff08\u4ec5\u6240\u6709\u8005\uff09",
      "/admindel CHAT_ID - \u79fb\u9664\u7ba1\u7406\u5458\uff08\u4ec5\u6240\u6709\u8005\uff09",
      "/chain - \u67e5\u770b\u53d1\u5e03\u94fe",
      "/chainadd s26 kr MODEL CSC \u540d\u79f0 - \u6dfb\u52a0\u7cbe\u786e\u53d1\u5e03\u94fe\u8bbe\u5907",
      "/chaininterval s26 15 - \u8bbe\u7f6e\u53d1\u5e03\u94fe\u68c0\u67e5\u95f4\u9694",
      "/chaintime s26 08:00 23:00 - \u8bbe\u7f6e\u53d1\u5e03\u94fe\u65f6\u95f4",
      "/chainenable s26 on - \u542f\u52a8 S26\uff1bS25 \u4f1a\u5728 S26 \u97e9\u7248\u786e\u8ba4\u540e\u81ea\u52a8\u542f\u52a8",
      "/chainstage s26 eu - \u4fee\u6539\u5f53\u524d\u53d1\u5e03\u5730\u533a\uff08\u4ec5\u6240\u6709\u8005\uff09",
      "/monsnooze MODEL CSC 6h - \u5b9a\u65f6\u6682\u505c\u540e\u81ea\u52a8\u6062\u590d\u76d1\u63a7",
      "/moninterval 15 - \u7edf\u4e00\u8bbe\u7f6e\u9ed8\u8ba4\u76d1\u63a7\u95f4\u9694\uff081-1440 \u5206\u949f\uff09",
      "",
      "\u65b0\u7248\u672c\u4ec5\u901a\u77e5\u4e00\u6b21\uff0c\u4e0d\u518d\u9700\u8981 /ack \u6216 /pending\u3002"
    ].join("\n"),
    [
      "\u9ad8\u7ea7\u7ef4\u62a4\u547d\u4ee4",
      "",
      "/debugquery MODEL CSC - \u67e5\u8be2\u8bca\u65ad",
      "/cacheclear MODEL CSC - \u6e05\u7406\u6307\u5b9a\u7f13\u5b58",
      "/cacheclear all - \u6e05\u7406\u5168\u90e8\u7f13\u5b58",
      "/synccommands - \u540c\u6b65 Telegram \u5feb\u6377\u547d\u4ee4"
    ].join("\n")
  ];
}
