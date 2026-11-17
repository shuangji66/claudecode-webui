// 访问密码的复杂度判定：与后端 authz.ValidatePassword 同一条规则。
//
// 前端先判是为了即时反馈（保存按钮置灰 + 说明哪一条不满足），后端仍会独立
// 校验一次——不要把它当成唯一的把关点。

/** 密码最短长度（按字符计）。 */
export const PASSWORD_MIN_LENGTH = 8;
/** 密码最长长度（按字符计）。 */
export const PASSWORD_MAX_LENGTH = 128;

/** 密码不满足规则的原因；null 表示合规。 */
export type PasswordIssue = "short" | "long" | "control" | "letter" | "digit" | null;

export function passwordIssue(pwd: string): PasswordIssue {
  const chars = Array.from(pwd);
  if (chars.length < PASSWORD_MIN_LENGTH) return "short";
  if (chars.length > PASSWORD_MAX_LENGTH) return "long";
  let letter = false;
  let digit = false;
  for (const ch of chars) {
    if (/\p{Cc}/u.test(ch)) return "control";
    if (/\p{L}/u.test(ch)) letter = true;
    if (/\p{Nd}/u.test(ch)) digit = true;
  }
  if (!letter) return "letter";
  if (!digit) return "digit";
  return null;
}
