function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

export function validateModelCsc(model, csc, options = {}) {
  const normalizedModel = normalizeText(model);
  const normalizedCsc = normalizeText(csc);
  if (!/^(?:SM|SC)-[A-Z0-9]+$/.test(normalizedModel)) {
    throw new Error(`Invalid Samsung model: ${normalizedModel || "<empty>"}`);
  }
  if (!/^[A-Z0-9]{3}$/.test(normalizedCsc)) {
    throw new Error(`Invalid Samsung CSC: ${normalizedCsc || "<empty>"}`);
  }

  const key = `${normalizedModel}:${normalizedCsc}`;
  if (options.allowedTargets) {
    const allowed = options.allowedTargets instanceof Set
      ? options.allowedTargets
      : new Set(options.allowedTargets.map((target) =>
        typeof target === "string" ? target : `${normalizeText(target.model)}:${normalizeText(target.csc)}`
      ));
    if (!allowed.has(key)) {
      throw new Error(`Model/CSC target is not configured for monitoring: ${normalizedModel}/${normalizedCsc}`);
    }
  }
  return { model: normalizedModel, csc: normalizedCsc, key };
}

export function normalizeTarget(target) {
  const { model, csc } = validateModelCsc(target?.model, target?.csc);
  return {
    model,
    csc,
    name: String(target?.name || "").trim()
  };
}

export function targetKey(model, csc) {
  return validateModelCsc(model, csc).key;
}

export function normalizeReleaseWindowGroups(groups) {
  if (!Array.isArray(groups)) throw new Error("Release-window groups must be an array");

  return groups.map((group, index) => {
    if (Array.isArray(group?.models) || Array.isArray(group?.cscs)) {
      throw new Error(
        `Release-window group ${index + 1} uses models/cscs arrays. ` +
        "Cartesian model × CSC generation is forbidden; configure exact targets instead."
      );
    }

    const id = String(group?.id || `group-${index + 1}`).trim();
    const rawTargets = group?.targets;
    if (!Array.isArray(rawTargets) || rawTargets.length < 2) {
      throw new Error(`Release-window group ${id} must contain at least two exact targets`);
    }

    const seen = new Set();
    const targets = [];
    for (const rawTarget of rawTargets) {
      const target = normalizeTarget(rawTarget);
      const key = targetKey(target.model, target.csc);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }

    if (targets.length < 2) {
      throw new Error(`Release-window group ${id} must contain at least two unique exact targets`);
    }

    return {
      id,
      name: String(group?.name || id).trim(),
      targets
    };
  });
}

export function releaseWindowGroups(env) {
  const raw = env?.RELEASE_WINDOW_GROUPS_JSON || "[]";
  try {
    return normalizeReleaseWindowGroups(JSON.parse(raw));
  } catch (error) {
    console.log(`Invalid RELEASE_WINDOW_GROUPS_JSON: ${error.message}`);
    return [];
  }
}

export function releaseWindowPeers(env, model, csc) {
  const sourceKey = targetKey(model, csc);
  const peers = new Map();

  for (const group of releaseWindowGroups(env)) {
    if (!group.targets.some((target) => targetKey(target.model, target.csc) === sourceKey)) continue;
    for (const target of group.targets) {
      const key = targetKey(target.model, target.csc);
      if (key === sourceKey) continue;
      peers.set(key, { ...target, groupId: group.id, groupName: group.name });
    }
  }

  return [...peers.values()];
}

export function isExactReleaseWindowTarget(env, model, csc) {
  const key = targetKey(model, csc);
  return releaseWindowGroups(env).some((group) =>
    group.targets.some((target) => targetKey(target.model, target.csc) === key)
  );
}
