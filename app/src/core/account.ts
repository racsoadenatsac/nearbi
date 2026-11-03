// NEAR account id validation (named and implicit accounts).
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);
}
