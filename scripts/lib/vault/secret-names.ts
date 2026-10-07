/**
 * Names that can hold secrets. The vault reader checks every path segment against this table BEFORE it lstats, lists or
 * opens anything, and a match wins over every allowlist: a denied name is never opened, never listed and never named in a
 * response. Matching is on the lower-cased name. Pure.
 */
export interface SecretRule { name: string; test: RegExp }

export const SECRET_RULES: readonly SecretRule[] = [
  { name: 'env file', test: /^\.env(\..*)?$/ },
  { name: 'ssm export', test: /^ssm-.*\.json$/ },
  { name: 'terraform variables', test: /\.tfvars(\.json)?$/ },
  { name: 'terraform state', test: /tfstate/ },
  { name: 'key or certificate', test: /\.(pem|key|p12|pfx|kdbx)$/ },
  { name: 'ssh key', test: /^id_(rsa|ed25519|ecdsa|dsa)/ },
  { name: 'package registry auth', test: /^\.(npmrc|netrc|pypirc)$/ },
  { name: 'credentials', test: /^credentials/ },
];

/** Whether a single path segment is a secret-file name. */
export const isSecretName = (segment: string): boolean => SECRET_RULES.some((r) => r.test.test(segment.toLowerCase()));

/** Whether any segment of a `/`-separated path is a secret-file name. */
export const hasSecretSegment = (path: string): boolean => path.split('/').some(isSecretName);
