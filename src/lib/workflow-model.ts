export type WorkflowScalar = string | number | boolean | null;
export type WorkflowOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains';

export interface WorkflowConditionLeaf {
  source: 'event' | 'contact';
  path: string;
  operator: WorkflowOperator;
  value?: WorkflowScalar;
}

export type WorkflowCondition =
  | WorkflowConditionLeaf
  | { all: WorkflowCondition[] }
  | { any: WorkflowCondition[] };

export type WorkflowVariableSource = 'contact' | 'trigger_event' | 'latest_event' | 'workflow_config';

export interface WorkflowVariableMapping {
  source: WorkflowVariableSource;
  path: string;
  event?: string;
}

export type WorkflowStepDefinition =
  | { type: 'delay'; duration: string }
  | { type: 'condition'; if: WorkflowCondition; onFalse?: 'exit' | 'continue' }
  | {
    type: 'send';
    stepId: string;
    template: { key: string; version: number };
    variables: Record<string, WorkflowVariableMapping>;
  }
  | { type: 'exit'; reason?: string };

export interface WorkflowDefinition {
  trigger: { event: string };
  entryCondition?: WorkflowCondition;
  config?: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  exitOn: string[];
  reentry: 'never' | 'after_exit';
}

const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const OPERATORS: WorkflowOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireEventName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !EVENT_NAME_PATTERN.test(value)) {
    throw new Error(`${field} must be 1-200 characters using letters, numbers, dot, colon, underscore or hyphen.`);
  }
  return value;
}

function parseCondition(value: unknown, field: string, depth = 0): WorkflowCondition {
  if (depth > 8 || !isObject(value)) throw new Error(`${field} must be a condition object with maximum depth 8.`);
  if ('all' in value || 'any' in value) {
    const key = 'all' in value ? 'all' : 'any';
    const children = value[key];
    if (!Array.isArray(children) || children.length === 0 || children.length > 25) {
      throw new Error(`${field}.${key} must contain 1-25 conditions.`);
    }
    const parsed = children.map((child, index) => parseCondition(child, `${field}.${key}[${index}]`, depth + 1));
    return key === 'all' ? { all: parsed } : { any: parsed };
  }
  if (value.source !== 'event' && value.source !== 'contact') {
    throw new Error(`${field}.source must be event or contact.`);
  }
  if (typeof value.path !== 'string' || !PATH_PATTERN.test(value.path)) {
    throw new Error(`${field}.path is invalid.`);
  }
  if (typeof value.operator !== 'string' || !OPERATORS.includes(value.operator as WorkflowOperator)) {
    throw new Error(`${field}.operator is invalid.`);
  }
  if (value.operator !== 'exists' && !('value' in value)) {
    throw new Error(`${field}.value is required for ${value.operator}.`);
  }
  const scalar = value.value;
  if (scalar !== undefined && scalar !== null && !['string', 'number', 'boolean'].includes(typeof scalar)) {
    throw new Error(`${field}.value must be a string, number, boolean or null.`);
  }
  return {
    source: value.source,
    path: value.path,
    operator: value.operator as WorkflowOperator,
    ...('value' in value ? { value: scalar as WorkflowScalar } : {}),
  };
}

function parseWorkflowConfig(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw new Error('definition.config must be an object.');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('definition.config must be JSON serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > 32_768) {
    throw new Error('definition.config exceeds 32768 bytes.');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseVariableMappings(value: unknown, field: string): Record<string, WorkflowVariableMapping> {
  if (!isObject(value)) throw new Error(`${field} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error(`${field} supports at most 100 mappings.`);
  const parsed: Record<string, WorkflowVariableMapping> = {};
  for (const [name, rawMapping] of entries) {
    if (!VARIABLE_NAME_PATTERN.test(name)) throw new Error(`${field}.${name} has an invalid variable name.`);
    if (!isObject(rawMapping)) throw new Error(`${field}.${name} must be an object.`);
    const source = rawMapping.source;
    if (!['contact', 'trigger_event', 'latest_event', 'workflow_config'].includes(source as string)) {
      throw new Error(`${field}.${name}.source is invalid.`);
    }
    if (typeof rawMapping.path !== 'string' || !PATH_PATTERN.test(rawMapping.path)) {
      throw new Error(`${field}.${name}.path is invalid.`);
    }
    if (source === 'latest_event') {
      const eventName = requireEventName(rawMapping.event, `${field}.${name}.event`);
      parsed[name] = { source, path: rawMapping.path, event: eventName } as WorkflowVariableMapping;
    } else {
      if (rawMapping.event != null) throw new Error(`${field}.${name}.event is only supported for latest_event.`);
      parsed[name] = { source: source as WorkflowVariableSource, path: rawMapping.path };
    }
  }
  return parsed;
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isObject(value)) throw new Error('definition must be an object.');
  if (!isObject(value.trigger)) throw new Error('definition.trigger must be an object.');
  const triggerEvent = requireEventName(value.trigger.event, 'definition.trigger.event');
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 50) {
    throw new Error('definition.steps must contain 1-50 steps.');
  }
  const steps = value.steps.map((step, index): WorkflowStepDefinition => {
    if (!isObject(step)) throw new Error(`definition.steps[${index}] must be an object.`);
    if (step.type === 'delay') {
      if (typeof step.duration !== 'string') throw new Error(`definition.steps[${index}].duration is required.`);
      parseDelayDuration(step.duration);
      return { type: 'delay', duration: step.duration };
    }
    if (step.type === 'condition') {
      const onFalse = step.onFalse ?? 'exit';
      if (onFalse !== 'exit' && onFalse !== 'continue') {
        throw new Error(`definition.steps[${index}].onFalse must be exit or continue.`);
      }
      return { type: 'condition', if: parseCondition(step.if, `definition.steps[${index}].if`), onFalse };
    }
    if (step.type === 'send') {
      const stepId = step.stepId ?? step.id ?? `send-${index}`;
      if (typeof stepId !== 'string' || !STEP_ID_PATTERN.test(stepId)) {
        throw new Error(`definition.steps[${index}].stepId is invalid.`);
      }
      if (!isObject(step.template)) throw new Error(`definition.steps[${index}].template must be an object.`);
      if (typeof step.template.key !== 'string' || !EVENT_NAME_PATTERN.test(step.template.key)) {
        throw new Error(`definition.steps[${index}].template.key is invalid.`);
      }
      if (!Number.isInteger(step.template.version) || (step.template.version as number) < 1) {
        throw new Error(`definition.steps[${index}].template.version must be a positive integer.`);
      }
      return {
        type: 'send',
        stepId,
        template: { key: step.template.key, version: step.template.version as number },
        variables: parseVariableMappings(step.variables ?? {}, `definition.steps[${index}].variables`),
      };
    }
    if (step.type === 'exit') {
      if (step.reason != null && (typeof step.reason !== 'string' || step.reason.length > 300)) {
        throw new Error(`definition.steps[${index}].reason must be at most 300 characters.`);
      }
      return { type: 'exit', ...(step.reason ? { reason: step.reason } : {}) };
    }
    throw new Error(`definition.steps[${index}].type is not enabled in this milestone. Supported: delay, condition, send, exit.`);
  });
  const sendStepIds = steps.filter((step) => step.type === 'send').map((step) => step.stepId);
  if (new Set(sendStepIds).size !== sendStepIds.length) throw new Error('definition send stepId values must be unique.');
  const exitOn = value.exitOn ?? value.exit_on ?? [];
  if (!Array.isArray(exitOn) || exitOn.length > 25) throw new Error('definition.exitOn must be an array of at most 25 event names.');
  const parsedExitOn = exitOn.map((eventName, index) => requireEventName(eventName, `definition.exitOn[${index}]`));
  const reentry = value.reentry ?? 'never';
  if (reentry !== 'never' && reentry !== 'after_exit') {
    throw new Error('definition.reentry must be never or after_exit in this milestone.');
  }
  const config = parseWorkflowConfig(value.config);
  return {
    trigger: { event: triggerEvent },
    ...(value.entryCondition || value.entry_condition
      ? { entryCondition: parseCondition(value.entryCondition ?? value.entry_condition, 'definition.entryCondition') }
      : {}),
    ...(config ? { config } : {}),
    steps,
    exitOn: [...new Set(parsedExitOn)],
    reentry,
  };
}

export function parseDelayDuration(duration: string): number {
  const match = duration.trim().match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) throw new Error('delay duration must use Nm, Nh, Nd or Nw.');
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const milliseconds = amount * multipliers[unit];
  if (amount < 1 || milliseconds > 365 * 86_400_000) throw new Error('delay duration must be between 1 minute and 365 days.');
  return milliseconds;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    return isObject(current) ? current[part] : undefined;
  }, source);
}

function compare(actual: unknown, operator: WorkflowOperator, expected?: WorkflowScalar): boolean {
  if (operator === 'exists') return expected === false ? actual == null : actual != null;
  if (operator === 'eq') return actual === expected;
  if (operator === 'neq') return actual !== expected;
  if (operator === 'contains') return Array.isArray(actual)
    ? actual.includes(expected)
    : typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (operator === 'gt') return actual > expected;
  if (operator === 'gte') return actual >= expected;
  if (operator === 'lt') return actual < expected;
  return actual <= expected;
}

export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  context: { event: Record<string, unknown>; contact: Record<string, unknown> },
): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateWorkflowCondition(child, context));
  if ('any' in condition) return condition.any.some((child) => evaluateWorkflowCondition(child, context));
  return compare(getPath(context[condition.source], condition.path), condition.operator, condition.value);
}
