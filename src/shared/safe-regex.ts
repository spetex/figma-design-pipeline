export const MAX_INSPECTION_REGEX_LENGTH = 256;

/**
 * Compile a deliberately restricted regular expression for inspection filters.
 *
 * JavaScript has no native regex timeout. Keep this dependency-free by rejecting
 * constructs that can introduce non-linear backtracking while retaining the
 * anchors, character classes, and simple alternation useful for Figma names.
 */
export function compileInspectionRegex(
  pattern: string | undefined,
  label: string
): RegExp | undefined {
  if (pattern === undefined) return undefined;
  assertInspectionRegexSafe(pattern, label);
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw new Error(`Invalid ${label} regex: ${pattern}`);
  }
}

export function assertInspectionRegexSafe(pattern: string, label: string): void {
  if (pattern.length > MAX_INSPECTION_REGEX_LENGTH) {
    throw new Error(
      `Unsafe ${label} regex: maximum length is ${MAX_INSPECTION_REGEX_LENGTH} characters`
    );
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new Error(`Unsafe ${label} regex: backreferences are not supported`);
  }
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) {
    throw new Error(`Unsafe ${label} regex: lookaround is not supported`);
  }

  const groups: Array<{ hasAlternation: boolean; hasQuantifier: boolean }> = [];
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;

    if (character === "(") {
      groups.push({ hasAlternation: false, hasQuantifier: false });
      continue;
    }
    if (character === "|") {
      const group = groups[groups.length - 1];
      if (group) group.hasAlternation = true;
      continue;
    }
    if (character === "?" && pattern[index - 1] === "(" && pattern[index + 1] === ":") {
      continue;
    }
    if (isQuantifierStart(pattern, index)) {
      const group = groups[groups.length - 1];
      if (group) group.hasQuantifier = true;
      continue;
    }
    if (character !== ")") continue;

    const group = groups.pop();
    if (!group) continue;
    const nextIndex = index + 1;
    const groupIsQuantified = isQuantifierStart(pattern, nextIndex);
    if (groupIsQuantified && (group.hasAlternation || group.hasQuantifier)) {
      throw new Error(
        `Unsafe ${label} regex: quantified groups may not contain alternation or quantifiers`
      );
    }
    const parent = groups[groups.length - 1];
    if (parent) {
      parent.hasAlternation ||= group.hasAlternation;
      parent.hasQuantifier ||= group.hasQuantifier || groupIsQuantified;
    }
  }
}

function isQuantifierStart(pattern: string, index: number): boolean {
  const character = pattern[index];
  if (character === "*" || character === "+" || character === "?") return true;
  return character === "{" && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(index));
}
