import { readModelSettings } from './model-settings.mjs';
import {
  resolveIssueExecutionSettings,
  executionStarted,
  requireValidExecutionSettings,
} from './issue-execution-settings.mjs';
import { modelAvailability, providerCatalogs, refreshProviderQuota } from './provider-runtime.mjs';
import { readProviderConfig, providerForModel } from './provider-config.mjs';
import { configuredCodexSettings } from './native-codex-settings.mjs';
import { requireThat } from './common.mjs';
import { sessionProvider, agentModel } from './agent-models.mjs';
import { conversationState } from './conversation-store.mjs';

const commands = new Set(['verify', 'publish', 'close', 'cleanup', 'delete-worktree']);
export function blockModelKind(block) {
  if (commands.has(block.kind) || block.readOnly) return 'none';
  if (['retro', 'sol', 'merge', 'update-branch'].includes(block.kind)) return 'fixed';
  return 'select';
}
export function blockExecutionSettings(service, issue, flow, block, { validate = false } = {}) {
  const resolved = resolveIssueExecutionSettings(service.root, issue, flow, {
    started: executionStarted(service, flow),
  });
  if (validate) requireValidExecutionSettings(resolved, block.model);
  return { model: block.model || resolved.values.model, effort: resolved.values.effort };
}
function fixedModel(root, block, defaults, choices) {
  if (block.kind === 'sol') {
    const sol = (providerCatalogs(root).codex?.models || choices).filter((model) =>
      /\bsol\b/i.test(model.id + ' ' + model.name)
    );
    return (
      (
        sol.find((model) =>
          ['available', 'warning', 'unmonitored'].includes(modelAvailability(root, model.id).status)
        ) || sol[0]
      )?.id || null
    );
  }
  if (block.kind === 'retro') return configuredCodexSettings().model;
  return defaults.model;
}
function modelChoices(block, settings) {
  return block.kind === 'request' ? settings.models.filter(({ provider }) => provider === 'codex') : settings.models;
}

function nativeCodexModel() {
  try {
    return configuredCodexSettings().model;
  } catch {
    return null;
  }
}

function effectiveModel(root, block, defaults, choices, kind) {
  if (kind === 'select') return block.model || defaults.model;
  try {
    return fixedModel(root, block, defaults, choices);
  } catch {
    return null;
  }
}

function fixedModelReason(block) {
  if (['merge', 'update-branch'].includes(block.kind))
    return 'This model is used only if AI conflict repair is needed.';
  return 'This operation uses its native Codex helper model.';
}

export function blockModelView(service, issue, flow, block, observed) {
  const kind = blockModelKind(block);
  if (kind === 'none') return { kind };
  const settings = observed?.settings || readModelSettings(service.root);
  const defaults = observed?.defaults || blockExecutionSettings(service, issue, flow, { ...block, model: '' });
  const request = block.kind === 'request';
  const defaultModel = request ? nativeCodexModel() : defaults.model;
  const model = effectiveModel(service.root, block, { model: defaultModel }, settings.models, kind);
  const availability = model
    ? modelAvailability(service.root, model)
    : {
        status: 'unavailable',
        reason:
          'The required native model could not be determined. Configure the native agent and enable its model in Factory settings.',
      };
  const binding = (observed?.conversation || conversationState(service.root, issue.id)).flowBlocks?.[block.id];
  return {
    kind,
    model,
    selected: block.model || '',
    defaultModel,
    ...(request && { defaultLabel: 'Use Codex default' }),
    reason: kind === 'fixed' ? fixedModelReason(block) : null,
    reasonInTooltip: block.kind === 'merge',
    availability,
    defaultAvailability: defaultModel ? modelAvailability(service.root, defaultModel) : availability,
    choices: kind === 'select' ? modelChoices(block, settings) : [],
    conversationProvider: binding?.threadId ? sessionProvider(binding.threadId) : null,
    locked: modelEditingLocked(service, issue, block),
  };
}
function modelEditingLocked(service, issue, block) {
  return Boolean(
    service.flows?.active?.has(issue.id) ||
    block.attempts?.some(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    )
  );
}
export function validateBlockModel(service, issue, flow, block, input) {
  requireThat(block, 'Choose a saved block.');
  requireThat(blockModelKind(block) === 'select', 'This block has no editable model.');
  requireThat(typeof input === 'string' && input.length <= 200, 'Choose a listed model or use the issue default.');
  requireThat(
    !service.flows?.active?.has(issue.id) &&
      !block.attempts.some(
        (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
      ),
    'Stop or reconcile this block before changing its model.'
  );
  const choices = modelChoices(block, readModelSettings(service.root));
  requireThat(
    input === '' || input === block.model || choices.some((entry) => entry.id === input),
    'Choose an enabled, available model.'
  );
  return requiresModelHandoff(service, issue, flow, block, input);
}

function requiresModelHandoff(service, issue, flow, block, input) {
  if (block.kind === 'request') return false;
  const threadId = conversationState(service.root, issue.id).flowBlocks?.[block.id]?.threadId;
  return needsProviderHandoff(threadId, input, () => blockExecutionSettings(service, issue, flow, {}).model);
}

function needsProviderHandoff(threadId, input, defaultModel) {
  return Boolean(threadId && sessionProvider(threadId) !== agentModel(input || defaultModel()).provider);
}
export async function assertBlockModelAvailable(service, issue, flow, block) {
  let view = blockModelView(service, issue, flow, block);
  if (!readProviderConfig(service.root) || view.kind === 'none' || ['merge', 'update-branch'].includes(block.kind))
    return view;
  if (view.model) await refreshProviderQuota(service.root, providerForModel(view.model));
  view = blockModelView(service, issue, flow, block);
  requireThat(['available', 'warning', 'unmonitored'].includes(view.availability.status), view.availability.reason);
  return view;
}

export function issueBlockModels(service, issue, flow, issueSettings, resolveFolder) {
  const observed = {
    settings: readModelSettings(service.root, { resolveFolder }),
    conversation: conversationState(service.root, issue.id),
    defaults: issueSettings
      ? { model: issueSettings.values.model, effort: issueSettings.values.effort }
      : blockExecutionSettings(service, issue, flow, {}),
  };
  return Object.fromEntries(
    flow.blocks.map((block) => [block.id, blockModelView(service, issue, flow, block, observed)])
  );
}
