import { validateModelCsc, targetKey } from "./targets.js";
import { normalizeFirmwareVersion } from "./utils.js";
import {
  getFlagshipProposal,
  putFlagshipProposal,
  upsertMonitorItem
} from "./state.js";

function text(value) {
  return String(value || "").trim();
}

function normalizeExactTarget(raw, fallbackName = "") {
  const target = validateModelCsc(raw?.model, raw?.csc);
  return {
    model: target.model,
    csc: target.csc,
    name: text(raw?.name || fallbackName || `${target.model} ${target.csc}`)
  };
}

export function normalizeFlagshipLinkageRules(rules) {
  if (!Array.isArray(rules)) throw new Error("Flagship linkage rules must be an array");
  const seenSources = new Set();
  return rules.map((raw, index) => {
    if (Array.isArray(raw?.models) || Array.isArray(raw?.cscs)) {
      throw new Error(`Flagship linkage rule ${index + 1} cannot generate model × CSC combinations`);
    }
    const source = normalizeExactTarget(raw?.source, `Current flagship ${index + 1}`);
    const sourceKey = targetKey(source.model, source.csc);
    if (seenSources.has(sourceKey)) throw new Error(`Duplicate flagship source: ${sourceKey}`);
    seenSources.add(sourceKey);

    const previousRaw = raw?.previousTargets;
    if (!Array.isArray(previousRaw) || !previousRaw.length) {
      throw new Error(`Flagship linkage rule ${index + 1} requires previousTargets`);
    }
    const seenTargets = new Set();
    const previousTargets = previousRaw.map((item) => normalizeExactTarget(item)).filter((item) => {
      const key = targetKey(item.model, item.csc);
      if (key === sourceKey || seenTargets.has(key)) return false;
      seenTargets.add(key);
      return true;
    });
    if (!previousTargets.length) throw new Error(`Flagship linkage rule ${index + 1} has no usable previous targets`);

    return {
      id: text(raw?.id || `flagship-link-${index + 1}`),
      name: text(raw?.name || `${source.name} → previous flagship`),
      source,
      previousTargets
    };
  });
}

export function flagshipLinkageEnabled(env) {
  return String(env?.FLAGSHIP_LINKAGE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

export function flagshipLinkageRules(env) {
  if (!flagshipLinkageEnabled(env)) return [];
  const raw = env?.FLAGSHIP_LINKAGE_RULES_JSON || "[]";
  try {
    return normalizeFlagshipLinkageRules(JSON.parse(raw));
  } catch (error) {
    console.log(`Invalid FLAGSHIP_LINKAGE_RULES_JSON: ${error.message}`);
    return [];
  }
}

export function flagshipRuleForSource(env, model, csc) {
  const key = targetKey(model, csc);
  return flagshipLinkageRules(env).find((rule) => targetKey(rule.source.model, rule.source.csc) === key) || null;
}

export function buildFlagshipActivationProposal(env, sourceItem, parsed, now = new Date()) {
  const rule = flagshipRuleForSource(env, sourceItem.model, sourceItem.csc);
  if (!rule) return null;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    id,
    type: "activate_previous_flagship",
    status: "pending",
    ruleId: rule.id,
    ruleName: rule.name,
    source: {
      model: sourceItem.model,
      csc: sourceItem.csc,
      name: sourceItem.name || rule.source.name,
      version: normalizeFirmwareVersion(parsed.latest) || parsed.latest || ""
    },
    targets: rule.previousTargets,
    createdAt: now.toISOString(),
    decidedAt: "",
    decision: ""
  };
}

export function buildLinkedTargetReviewProposal(item, parsed, now = new Date()) {
  if (item.priority !== "high" || item.prioritySource !== "flagship_linkage") return null;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    id,
    type: "review_linked_priority",
    status: "pending",
    source: {
      model: item.model,
      csc: item.csc,
      name: item.name || `${item.model} ${item.csc}`,
      version: normalizeFirmwareVersion(parsed.latest) || parsed.latest || ""
    },
    targets: [{ model: item.model, csc: item.csc, name: item.name || `${item.model} ${item.csc}` }],
    linkedFrom: item.linkedFrom || "",
    linkedRuleId: item.linkedRuleId || "",
    createdAt: now.toISOString(),
    decidedAt: "",
    decision: ""
  };
}

export function activationPromptText(proposal, lang = "zh") {
  const targets = proposal.targets.map((target, index) => `${index + 1}. ${target.name}\n   ${target.model} / ${target.csc}`).join("\n");
  if (lang === "en") {
    return [
      "🚀 Current flagship update detected",
      "",
      `${proposal.source.name}`,
      `${proposal.source.model} / ${proposal.source.csc}`,
      `Version: ${proposal.source.version}`,
      "",
      "Promote the corresponding previous-generation straight flagship targets to HIGH priority and add missing targets to monitoring?",
      "",
      targets,
      "",
      "No model/CSC pairs are generated automatically; only the exact configured targets above will be changed."
    ].join("\n");
  }
  return [
    "🚀 最新直板旗舰发现正式更新",
    "",
    `${proposal.source.name}`,
    `${proposal.source.model} / ${proposal.source.csc}`,
    `版本：${proposal.source.version}`,
    "",
    "是否将上一代对应地区版本 + TGY 自动加入监控并提升为高优先级？",
    "",
    targets,
    "",
    "只会处理上面列出的精确 Model / CSC，不会自动拼接地区。"
  ].join("\n");
}

export function activationPromptKeyboard(proposal, lang = "zh") {
  return {
    inline_keyboard: [
      [
        { text: lang === "en" ? "Promote & monitor" : "✅ 添加并提升", callback_data: `flagship:approve:${proposal.id}` },
        { text: lang === "en" ? "Not now" : "暂不处理", callback_data: `flagship:skip:${proposal.id}` }
      ],
      [{ text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }]
    ]
  };
}

export function reviewPromptText(proposal, lang = "zh") {
  const target = proposal.targets[0];
  if (lang === "en") {
    return [
      "🎯 Linked previous flagship has received an update",
      "",
      `${target.name}`,
      `${target.model} / ${target.csc}`,
      `Version: ${proposal.source.version}`,
      proposal.linkedFrom ? `Promoted by: ${proposal.linkedFrom}` : "",
      "",
      "Choose the monitoring state. This question will appear again after the next update when HIGH is kept."
    ].filter(Boolean).join("\n");
  }
  return [
    "🎯 上一代联动旗舰已发现正式更新",
    "",
    `${target.name}`,
    `${target.model} / ${target.csc}`,
    `版本：${proposal.source.version}`,
    proposal.linkedFrom ? `联动来源：${proposal.linkedFrom}` : "",
    "",
    "请选择后续监控状态。若继续保持高优先级，下次更新后仍会再次询问。"
  ].filter(Boolean).join("\n");
}

export function reviewPromptKeyboard(proposal, lang = "zh") {
  return {
    inline_keyboard: [
      [
        { text: lang === "en" ? "Restore NORMAL" : "恢复普通优先级", callback_data: `flagship:normal:${proposal.id}` },
        { text: lang === "en" ? "Keep HIGH" : "继续高优先级", callback_data: `flagship:keep:${proposal.id}` }
      ],
      [
        { text: lang === "en" ? "Pause monitoring" : "暂停监控", callback_data: `flagship:pause:${proposal.id}` }
      ],
      [{ text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }]
    ]
  };
}

async function updateProposal(env, proposal, decision) {
  const next = {
    ...proposal,
    status: "decided",
    decision,
    decidedAt: new Date().toISOString()
  };
  await putFlagshipProposal(env, next);
  return next;
}

export async function applyFlagshipProposalDecision(env, proposalId, decision) {
  const proposal = await getFlagshipProposal(env, proposalId);
  if (!proposal) return { ok: false, reason: "missing" };
  if (proposal.status !== "pending") return { ok: false, reason: "already_decided", proposal };

  const now = new Date().toISOString();
  if (proposal.type === "activate_previous_flagship") {
    if (decision === "skip") {
      await updateProposal(env, proposal, "skip");
      return { ok: true, decision: "skip", proposal, items: [] };
    }
    if (decision !== "approve") return { ok: false, reason: "invalid_decision", proposal };
    const items = [];
    for (const target of proposal.targets) {
      items.push(await upsertMonitorItem(env, {
        ...target,
        enabled: true,
        paused: false,
        priority: "high",
        prioritySource: "flagship_linkage",
        linkedFrom: `${proposal.source.model}/${proposal.source.csc}`,
        linkedRuleId: proposal.ruleId || "",
        linkedAt: now,
        adminDecision: "activated",
        pauseReason: ""
      }));
    }
    await updateProposal(env, proposal, "approve");
    return { ok: true, decision: "approve", proposal, items };
  }

  if (proposal.type !== "review_linked_priority") return { ok: false, reason: "invalid_type", proposal };
  const target = proposal.targets[0];
  if (!target) return { ok: false, reason: "missing_target", proposal };
  const base = {
    ...target,
    linkedFrom: proposal.linkedFrom || "",
    linkedRuleId: proposal.linkedRuleId || "",
    prioritySource: "flagship_linkage"
  };
  let item;
  if (decision === "normal") {
    item = await upsertMonitorItem(env, {
      ...base,
      enabled: true,
      paused: false,
      priority: "normal",
      adminDecision: "normal",
      pauseReason: ""
    });
  } else if (decision === "keep") {
    item = await upsertMonitorItem(env, {
      ...base,
      enabled: true,
      paused: false,
      priority: "high",
      adminDecision: "keep_high",
      pauseReason: ""
    });
  } else if (decision === "pause") {
    item = await upsertMonitorItem(env, {
      ...base,
      enabled: false,
      paused: true,
      priority: "high",
      adminDecision: "paused",
      pauseReason: "admin_pause_after_update"
    });
  } else {
    return { ok: false, reason: "invalid_decision", proposal };
  }
  await updateProposal(env, proposal, decision);
  return { ok: true, decision, proposal, items: [item] };
}
