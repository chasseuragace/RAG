/**
 * Shared JSON extraction for LLM-backed policies/judges.
 * LLM responses may include markdown fences or preamble text around the
 * JSON payload — this strips both and returns the parsed object, or null
 * if nothing parseable is found. Used by LLMPolicy and LLMJudge so the
 * parsing behavior (and any future fixes to it) lives in exactly one place.
 */
function extractJson(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const stripped = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

module.exports = { extractJson };