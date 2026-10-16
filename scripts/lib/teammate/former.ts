/** Authors who have left (`former_teammates`): their PRs are never listed on the Others' PRs tab and never reviewed. Logins compare case-insensitively. */
export const isFormerTeammate = (login: string | undefined | null, former: readonly string[] | undefined): boolean =>
  !!login && (former ?? []).some((f) => f.toLowerCase() === login.toLowerCase());
