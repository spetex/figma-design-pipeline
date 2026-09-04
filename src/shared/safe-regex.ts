import { RE2JS } from "re2js";

export const MAX_INSPECTION_REGEX_LENGTH = 256;

/** The deliberately small surface inspection callers need from a regex engine. */
export interface InspectionRegex {
  test(input: string): boolean;
}

/**
 * Compile an inspection filter with RE2JS, a pure-JavaScript RE2 port.
 *
 * Matching is linear in the input length even for overlapping repetitions and
 * nested quantifiers. Constructs RE2 cannot implement in linear time (including
 * backreferences and lookaround) fail closed during compilation.
 */
export function compileInspectionRegex(
  pattern: string | undefined,
  label: string
): InspectionRegex | undefined {
  if (pattern === undefined) return undefined;
  if (pattern.length > MAX_INSPECTION_REGEX_LENGTH) {
    throw new Error(
      `Unsafe ${label} regex: maximum length is ${MAX_INSPECTION_REGEX_LENGTH} characters`
    );
  }
  try {
    return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (
      detail.includes("invalid or unsupported")
      || detail.includes("invalid escape sequence")
      || detail.includes("invalid named capture")
    ) {
      throw new Error(`Unsafe ${label} regex: unsupported by the linear-time engine (${detail})`);
    }
    throw new Error(`Invalid ${label} regex: ${detail}`);
  }
}
