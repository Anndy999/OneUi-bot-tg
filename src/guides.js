export function guideText(identity, lang = "zh") {
  const en = lang === "en";
  if (identity === "admin") {
    return en
      ? [
          "Administrator help",
          "",
          "Query: send MODEL CSC, for example SM-S948B EUX.",
          "Specific version: append the full version after CSC.",
          "Short revision: 9110 TGY ZF5. Confirm the full version shown by the bot.",
          "",
          "Use Firmware download to verify and download an official firmware file.",
          "Use Rollout chain to review and advance the automatic monitoring order.",
          "The owner also manages users and administrators from the main menu."
        ].join("\n")
      : [
          "管理员帮助",
          "",
          "查询：发送“型号 CSC”，例如：SM-S948B EUX。",
          "指定版本：在 CSC 后追加完整版本号。",
          "简写版本：9110 TGY ZF5，机器人会显示完整版本并请求确认。",
          "",
          "“下载”用于验证并下载三星官方固件。",
          "“发布链”用于查看和推进自动监控顺序。",
          "所有者还可在主菜单管理用户和管理员。"
        ].join("\n");
  }
  if (identity === "allowed") {
    return en
      ? [
          "Samsung firmware query",
          "",
          "Send MODEL CSC, for example SM-S948B EUX.",
          "Append a full version to query a specific release.",
          "You can also use a short revision: 9110 TGY ZF5.",
          "",
          "When monitored firmware is updated, every authorized user receives one notification."
        ].join("\n")
      : [
          "三星固件查询",
          "",
          "发送“型号 CSC”，例如：SM-S948B EUX。",
          "在 CSC 后添加完整版本号可查询指定版本。",
          "也可使用版本尾号，例如：9110 TGY ZF5。",
          "",
          "监控到新固件后，所有已授权用户都会收到一次通知。"
        ].join("\n");
  }
  return en
    ? "Samsung firmware query\n\nYou do not have query access yet. Tap Request access and wait for approval."
    : "三星固件查询\n\n你还没有查询权限。请点击“申请权限”，等待管理员批准。";
}

export function adminHelpParts(lang = "zh") {
  const en = lang === "en";
  return [en
    ? [
        "Administrator fallback commands",
        "",
        "/download MODEL CSC [VERSION] - verify and download official firmware",
        "/chain - open rollout chain",
        "/refresh MODEL CSC - realtime query",
        "",
        "Owner only:",
        "/useradd CHAT_ID NAME, /userdel CHAT_ID",
        "/adminadd CHAT_ID NAME, /admindel CHAT_ID, /admins",
        "",
        "Ask a new administrator to send /whoami privately first."
      ].join("\n")
    : [
        "管理员备用命令",
        "",
        "/download 型号 CSC [版本] - 验证并下载官方固件",
        "/chain - 打开发布链",
        "/refresh 型号 CSC - 实时查询",
        "",
        "仅所有者：",
        "/useradd CHAT_ID 备注、/userdel CHAT_ID",
        "/adminadd CHAT_ID 备注、/admindel CHAT_ID、/admins",
        "",
        "添加管理员前，请让对方先私聊机器人发送 /whoami。"
      ].join("\n")];
}
