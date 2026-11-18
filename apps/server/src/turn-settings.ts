import {
  accessModes,
  type AccessMode,
  type ModelOption,
  type TurnSettings,
} from '../../../packages/types.ts';
import { PocketError } from './store.ts';

export function parseTurnSettings(value: unknown): TurnSettings | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PocketError(400, '本轮设置无效');
  const { model, effort, access } = value as Record<string, unknown>;
  if (
    (model !== undefined && (typeof model !== 'string' || !model || model.length > 200)) ||
    (effort !== undefined && (typeof effort !== 'string' || !effort || effort.length > 64)) ||
    (access !== undefined && !accessModes.some((mode) => mode === access))
  )
    throw new PocketError(400, '本轮设置无效');
  if (model === undefined && effort === undefined && access === undefined) return;
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(access === undefined ? {} : { access }),
  } as TurnSettings;
}

export function modelCatalog(data: unknown): ModelOption[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((m) => typeof m?.id === 'string' && !m.hidden)
    .map((m) => ({
      id: m.id,
      model: typeof m.model === 'string' ? m.model : m.id,
      name: m.displayName ?? m.id,
      efforts: Array.isArray(m.supportedReasoningEfforts)
        ? m.supportedReasoningEfforts.flatMap((option: any) =>
            typeof option?.reasoningEffort === 'string' ? [option.reasoningEffort] : [],
          )
        : [],
      defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
      isDefault: m.isDefault === true,
    }));
}

export function resolveTurnSettings(
  settings: TurnSettings | undefined,
  currentModel: string | null,
  models: ModelOption[],
): TurnSettings | undefined {
  if (!settings || (!settings.model && !settings.effort)) return settings;
  const modelId = settings.model ?? currentModel;
  const model = modelId
    ? models.find((option) => option.id === modelId || option.model === modelId)
    : models.find((option) => option.isDefault);
  if (!model) throw new PocketError(400, '模型不可用，请选择可用模型');
  if (settings.effort && !model.efforts.includes(settings.effort))
    throw new PocketError(400, '所选模型不支持此思考强度');
  const effort = settings.effort ?? model.defaultEffort;
  return { ...settings, model: model.model, ...(effort ? { effort } : {}) };
}

export function turnOverrides(settings: TurnSettings | undefined, cwd: string) {
  const sandboxPolicy =
    settings?.access === 'full-access'
      ? { type: 'dangerFullAccess' }
      : settings?.access === 'read-only'
        ? { type: 'readOnly' }
        : settings?.access === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
          : undefined;
  return { model: settings?.model, effort: settings?.effort, sandboxPolicy };
}

export function activeAccess(sandbox: unknown): AccessMode | null {
  if (!sandbox || typeof sandbox !== 'object') return null;
  switch ((sandbox as { type?: string }).type) {
    case 'readOnly':
      return 'read-only';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'dangerFullAccess':
      return 'full-access';
    default:
      return null;
  }
}
