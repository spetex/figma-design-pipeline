export const PIPELINE_INITIATOR_META_KEY = "io.github.spetex/figma-pipeline-harness";

export interface HarnessInitiator {
  name: string;
  version?: string;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export function parseHarnessInitiator(meta: unknown): HarnessInitiator | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const candidate = (meta as Record<string, unknown>)[PIPELINE_INITIATOR_META_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const name = boundedString(record.name, 128);
  if (!name) return undefined;
  const version = boundedString(record.version, 64);
  return { name, ...(version ? { version } : {}) };
}
