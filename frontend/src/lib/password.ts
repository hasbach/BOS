export const MIN_PASSWORD_LENGTH = 10;

export type PasswordProblem = "tooShort" | "mismatch" | null;

/** Client-side checks that save a round trip; the server stays the authority (weak_password). */
export function checkNewPassword(password: string, confirm: string): { password?: "tooShort"; confirm?: "mismatch" } {
  const problems: { password?: "tooShort"; confirm?: "mismatch" } = {};
  if (password.length < MIN_PASSWORD_LENGTH) problems.password = "tooShort";
  else if (confirm !== password) problems.confirm = "mismatch";
  return problems;
}
