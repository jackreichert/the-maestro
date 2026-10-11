// Fictional home base builders shared by the home tests: no real stream, ticket or note names.
export const ref = (label: string): { label: string; url: string } => ({ label, url: `obsidian://open?vault=Fictional&file=${label}` });
export const ticket = (id: string, over: Record<string, unknown> = {}): Record<string, any> => ({ id, title: `Ticket ${id}`, status: 'open', priority: 2, ref: ref(id), prs: [], awaitsYou: false, quietDays: null, ...over });
export const epic = (id: string, over: Record<string, unknown> = {}): Record<string, any> => ({
  id, title: `Epic ${id}`, note: ref(id), status: 'open', total: 14, closed: 9, inProgress: 2, blocked: 1, notStarted: 2,
  verify: { required: false, verified: 0 }, awaiting: 1, unknowns: 2, quietDays: null, ...over,
});
export const home = (): Record<string, any> => ({
  stream: 'Avonlea', generatedAt: '2026-01-01T00:00:00Z', seq: '1', mapping: { source: 'config', configFound: true },
  epics: [epic('avonlea-api-042', { next: ticket('avonlea-api-051') }), epic('avonlea-web-007', { total: 3, closed: 3, inProgress: 0, blocked: 0, notStarted: 0 })],
  loose: [ticket('avonlea-misc-001')],
  left: { inProgress: [ticket('avonlea-api-051', { status: 'in-progress', points: 3 })], blocked: [], notStarted: [ticket('avonlea-api-060')], truncated: 0 },
  doneMeans: [], links: [], history: null, unknowns: [{ kind: 'sparse-points', text: 'Too few tickets carry points.' }],
  freshness: { tickets: '2026-01-01T00:00:00Z', prs: { fetchedAt: null, stale: true }, tracker: null },
});

export const epicLine = (id: string, over: Record<string, unknown> = {}): Record<string, any> => ({
  id, title: `Epic ${id}`, note: ref(id), status: 'open', total: 14, closed: 9, inProgress: 2, blocked: 1, notStarted: 2, awaiting: 1, quietDays: null, prs: [], ...over,
});
export const epics = (): Record<string, any> => ({
  generatedAt: '2026-01-01T00:00:00Z',
  streams: [{ stream: 'Avonlea', epics: [epicLine('avonlea-api-042', { next: { id: 'avonlea-api-051', title: 'Ticket avonlea-api-051', ref: ref('avonlea-api-051') }, prs: [{ label: 'avonlea-api#412', url: 'https://github.test/acme/avonlea-api/pull/412' }] })] }, { stream: 'Green Gables', epics: [] }],
  unfiled: [epicLine('loop-lab-002', { total: 1, closed: 0, inProgress: 0, blocked: 0, notStarted: 1, awaiting: 0 })],
});
export const brief = (over: Record<string, unknown> = {}): Record<string, any> => ({
  state: 'fresh', updated: '2026-01-01', ref: ref('avonlea-api-042 brief'),
  blocks: [
    { type: 'heading', level: 3, runs: [{ text: 'Status' }] },
    { type: 'paragraph', runs: [{ text: 'Nine of fourteen are closed, see ' }, { text: 'the plan', link: { url: 'obsidian://open?vault=Fictional&file=plan', kind: 'note' } }, { text: '.' }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'one', strong: true }], children: [{ runs: [{ text: 'nested' }] }] }] },
    { type: 'quote', runs: [{ text: 'quoted', em: true }] },
  ],
  ...over,
});
export const docs = (): Record<string, any> => ({
  groups: [{ kind: 'plan', items: [{ title: 'Rollout plan', kind: 'plan', project: 'avonlea-api', ticket: 'avonlea-api-042', status: 'draft', updated: '2026-01-02', url: 'obsidian://open?vault=Fictional&file=plan' }], more: 2 }, { kind: 'runbook', items: [{ title: 'Cutover runbook', kind: 'runbook', project: '', ticket: 'avonlea-api-042', url: 'https://docs.example.com/cutover' }], more: 0 }],
  unattributedRecent: 3,
});
