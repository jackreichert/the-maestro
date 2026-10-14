/**
 * Who counts as a bot on GitHub, in one place for the reply helper. The definition is strict on purpose: a bot's thread is answered without
 * the person's approval, so a human must never be taken for one. GitHub itself says an account is a Bot (`__typename`/`type`), no person can
 * register a login ending in `[bot]`, and the two review accounts that carry neither marker are named. An author that is missing (a deleted
 * account) is NOT a bot, so its comments wait for the person.
 */
export const KNOWN_BOT_LOGINS: readonly string[] = ['copilot-pull-request-reviewer', 'aikido-pr-checks'];

/** True for a login that is certainly a bot by name alone. */
export const isBotLogin = (login: string | undefined | null): boolean => {
  const l = (login ?? '').toLowerCase();
  return l.endsWith('[bot]') || KNOWN_BOT_LOGINS.includes(l);
};

/** True for a GitHub author object as the API returns it. */
export const isBotAuthor = (a: { login?: string | null; __typename?: string | null; type?: string | null } | null | undefined): boolean =>
  !!a && (a.__typename === 'Bot' || a.type === 'Bot' || isBotLogin(a.login));
