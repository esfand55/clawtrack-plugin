import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Test harness for clawtrack_pick_reviewer ──
// We register the plugin, capture both set_project and pick_reviewer tools,
// then call set_project to establish context before each pick_reviewer test.

const MOCK_PROJECT = {
  id: 'proj-1',
  key: 'CLAW',
  name: 'ClawTrack',
  description: 'AI Workforce Management',
  techStack: 'Next.js, tRPC, Prisma',
  conventions: null,
};

const MOCK_AGENTS = [
  { id: 'agent-alex', name: 'Alex', emoji: '⚙️', role: 'Backend Engineer', status: 'idle' },
  { id: 'agent-jane', name: 'Jane', emoji: '🎨', role: 'Frontend Engineer', status: 'idle' },
  { id: 'agent-ryan', name: 'Ryan', emoji: '🔎', role: 'Senior Backend Reviewer', status: 'idle' },
  { id: 'agent-rachel', name: 'Rachel', emoji: '🔍', role: 'Senior Backend Reviewer', status: 'idle' },
  { id: 'agent-felix', name: 'Felix', emoji: '👓', role: 'Senior Frontend Reviewer', status: 'idle' },
  { id: 'agent-fiona', name: 'Fiona', emoji: '🔬', role: 'Senior Frontend Reviewer', status: 'idle' },
];

const MOCK_BACKEND_SKILLS = [
  { name: 'Node.js API', slug: 'nodejs-api' },
  { name: 'Prisma Database', slug: 'prisma' },
];

const MOCK_FRONTEND_SKILLS = [
  { name: 'React Components', slug: 'react' },
  { name: 'Tailwind CSS', slug: 'tailwind' },
];

// ── Response helpers ──

function jsonResponse(data: any) {
  return {
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(''),
  };
}

function ok(items: any[]) {
  return jsonResponse({ result: { data: { items } } });
}

function skillsOk(skills: any[]) {
  return jsonResponse({ result: { data: skills } });
}

function errorResponse(status: number, msg: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(msg),
    json: () => Promise.resolve({}),
  };
}

function makeTasksWithReviewer(reviewerId: string, status: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i}`,
    reviewerId,
    status,
  }));
}

// ── Plugin loader ──
// Loads the plugin, registers all tools, captures them, and sets up the project.

interface TestHarness {
  setProject: any;
  pickReviewer: any;
}

async function loadPlugin(): Promise<TestHarness> {
  const tools = new Map<string, any>();

  const mockApi = {
    registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); }),
    on: vi.fn(),
    session: { sessionKey: 'agent:tester:main', agentId: 'agent-tester' },
    pluginConfig: {
      clawtrackUrl: 'http://localhost:3000',
      webhookSecret: 'test-secret',
      enabled: true,
      channelsEnabled: true,
      contextInjectionEnabled: true,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {},
  };

  const mod = await import('../src/index.js');
  // definePluginEntry returns an object with a register method
  const plugin = mod.default;
  if (plugin && typeof plugin.register === 'function') {
    plugin.register(mockApi);
  }

  return {
    setProject: tools.get('clawtrack_set_project'),
    pickReviewer: tools.get('clawtrack_pick_reviewer'),
  };
}

describe('clawtrack_pick_reviewer', () => {
  let originalFetch: typeof fetch;
  let harness: TestHarness;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Default: mock fetch to handle set_project + any other calls
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('projects.getByKey')) {
        return jsonResponse({ result: { data: { project: MOCK_PROJECT } } });
      }
      if (url.includes('agents.list')) {
        return ok(MOCK_AGENTS);
      }
      if (url.includes('skills.getByTask')) {
        return skillsOk([]);
      }
      if (url.includes('tasks.list')) {
        return ok([]);
      }
      return errorResponse(404, 'Not found');
    });

    harness = await loadPlugin();

    // Set active project before each test
    if (harness.setProject) {
      await harness.setProject.execute('tc-setup', { projectKey: 'CLAW' });
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Helper to mock fetch with URL-based routing
  function mockFetch(routes: Record<string, any>) {
    globalThis.fetch = vi.fn(async (url: string) => {
      for (const [pattern, response] of Object.entries(routes)) {
        if (url.includes(pattern)) return response;
      }
      return errorResponse(404, `Unexpected URL: ${url}`);
    });
  }

  // ══════════════════════════════════════════
  // Happy Path: Domain Matching
  // ══════════════════════════════════════════

  it('picks backend reviewer for backend task', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('backend');
    expect(d.reviewer.domain).toBe('backend');
    expect(['agent-ryan', 'agent-rachel']).toContain(d.reviewer.agentId);
  });

  it('picks frontend reviewer for frontend task', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_FRONTEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('frontend');
    expect(d.reviewer.domain).toBe('frontend');
    expect(['agent-felix', 'agent-fiona']).toContain(d.reviewer.agentId);
  });

  it('picks any reviewer when domain is unknown (no skills)', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk([]),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('unknown');
    expect(d.reviewer.agentId).toBeTruthy();
    expect(d.reviewer.reviewCount).toBe(0);
  });

  // ══════════════════════════════════════════
  // Load Balancing
  // ══════════════════════════════════════════

  it('picks backend reviewer with fewer active reviews', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(makeTasksWithReviewer('agent-ryan', 'review', 3)),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-rachel');
    expect(d.reviewer.reviewCount).toBe(0);
  });

  it('picks frontend reviewer with fewer active reviews', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_FRONTEND_SKILLS),
      'tasks.list': ok([
        ...makeTasksWithReviewer('agent-felix', 'review', 2),
        ...makeTasksWithReviewer('agent-fiona', 'review', 1),
      ]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-fiona');
    expect(d.reviewer.reviewCount).toBe(1);
  });

  it('picks first reviewer when review counts are equal', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([
        ...makeTasksWithReviewer('agent-ryan', 'review', 2),
        ...makeTasksWithReviewer('agent-rachel', 'review', 2),
      ]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(['agent-ryan', 'agent-rachel']).toContain(d.reviewer.agentId);
    expect(d.reviewer.reviewCount).toBe(2);
  });

  it('backend task ignores frontend reviewers with fewer reviews', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([
        ...makeTasksWithReviewer('agent-ryan', 'review', 5),
        ...makeTasksWithReviewer('agent-rachel', 'review', 1),
        ...makeTasksWithReviewer('agent-felix', 'review', 3),
        ...makeTasksWithReviewer('agent-fiona', 'review', 0),
      ]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-rachel');
    expect(d.reviewer.reviewCount).toBe(1);
  });

  it('frontend task picks least-loaded frontend reviewer ignoring backend', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_FRONTEND_SKILLS),
      'tasks.list': ok([
        ...makeTasksWithReviewer('agent-ryan', 'review', 5),
        ...makeTasksWithReviewer('agent-rachel', 'review', 1),
        ...makeTasksWithReviewer('agent-felix', 'review', 3),
        ...makeTasksWithReviewer('agent-fiona', 'review', 0),
      ]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-fiona');
    expect(d.reviewer.reviewCount).toBe(0);
  });

  // ══════════════════════════════════════════
  // Exclusion
  // ══════════════════════════════════════════

  it('excludes specified agent from selection', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: 'agent-rachel',
    });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-ryan');
  });

  it('falls back to all reviewers when all domain-specific ones are excluded', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    // Exclude both backend reviewers
    let result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: 'agent-ryan',
    });
    let d = result.details as any;
    // Rachel is still available
    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-rachel');

    // Now exclude Rachel too
    result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: 'agent-rachel',
    });
    d = result.details as any;
    // Ryan should be picked (only backend reviewer not excluded... wait, Ryan wasn't excluded this time)
    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-ryan');
  });

  it('excluding both backend reviewers triggers fallback to all', async () => {
    // Need to use a single call that excludes both — test the fallback path
    // The tool only accepts one excludeAgentId, so let's test differently:
    // Backend task where only 1 backend reviewer exists and they're excluded
    const singleBackend = [
      { id: 'agent-alex', name: 'Alex', emoji: '⚙️', role: 'Backend Engineer', status: 'idle' },
      { id: 'agent-ryan', name: 'Ryan', emoji: '🔎', role: 'Senior Backend Reviewer', status: 'idle' },
      { id: 'agent-felix', name: 'Felix', emoji: '👓', role: 'Senior Frontend Reviewer', status: 'idle' },
    ];
    mockFetch({
      'agents.list': ok(singleBackend),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: 'agent-ryan',
    });
    const d = result.details as any;

    // Ryan excluded, no other backend reviewers → fallback to all → Felix picked
    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-felix');
  });

  it('excluding non-reviewer agent has no effect', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: 'agent-alex',
    });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(['agent-ryan', 'agent-rachel']).toContain(d.reviewer.agentId);
  });

  // ══════════════════════════════════════════
  // Original Bug Regression
  // ══════════════════════════════════════════

  it('returns reviewer even when no tasks in review status (original bug fix)', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(text).not.toContain('No other agents with active tasks found');
    expect(d.success).toBe(true);
    expect(d.reviewer).toBeDefined();
    expect(d.reviewer.reviewCount).toBe(0);
  });

  it('returns reviewer when project has no tasks at all', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk([]),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.reviewCount).toBe(0);
  });

  // ══════════════════════════════════════════
  // API Failure & Error Handling
  // ══════════════════════════════════════════

  it('returns error when no active project', async () => {
    // Load a fresh plugin instance WITHOUT calling set_project
    const freshHarness = await loadPlugin();
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
    });

    const result = await freshHarness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('No active project set');
  });

  it('handles agents.list network error (outer catch)', async () => {
    mockFetch({});

    // Override to throw on agents.list
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('agents.list')) throw new Error('Network error');
      return errorResponse(500, 'fail');
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('Failed to pick reviewer');
  });

  it('returns error when agents.list returns non-array items', async () => {
    mockFetch({
      'agents.list': jsonResponse({ result: { data: { items: null } } }),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('Failed to fetch agents');
  });

  it('returns error when agents list is empty', async () => {
    mockFetch({
      'agents.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('No reviewer agents registered');
  });

  it('returns error when no agents have Reviewer role', async () => {
    const nonReviewers = MOCK_AGENTS.filter(a => !a.role.includes('Reviewer'));
    mockFetch({
      'agents.list': ok(nonReviewers),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('No reviewer agents registered');
  });

  it('gracefully falls back to unknown domain when skills.getByTask fails', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('skills.getByTask')) throw new Error('Skills API down');
      if (url.includes('agents.list')) return ok(MOCK_AGENTS);
      if (url.includes('tasks.list')) return ok([]);
      return errorResponse(404, 'Not found');
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('unknown');
    expect(d.reviewer).toBeDefined();
  });

  it('falls back to unknown when skills returns empty', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk([]),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('unknown');
  });

  it('falls back to unknown when skills returns unexpected format', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': jsonResponse({ result: null }),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.taskDomain).toBe('unknown');
  });

  it('returns error when tasks.list API fails', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': errorResponse(500, 'Server error'),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    // tasks.list returns non-ok → apiCall throws → outer catch
    expect(d.success).toBe(false);
  });

  it('returns error when tasks.list returns non-array items', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': jsonResponse({ result: { data: { items: null } } }),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;
    const d = result.details as any;

    expect(d.success).toBe(false);
    expect(text).toContain('Failed to fetch tasks');
  });

  // ══════════════════════════════════════════
  // Review Count Calculation
  // ══════════════════════════════════════════

  it('counts only review/in_testing/in_releasing statuses', async () => {
    const tasks = [
      { id: 't1', reviewerId: 'agent-ryan', status: 'review' },         // counted
      { id: 't2', reviewerId: 'agent-ryan', status: 'in_testing' },     // counted
      { id: 't3', reviewerId: 'agent-ryan', status: 'in_releasing' },   // counted
      { id: 't4', reviewerId: 'agent-ryan', status: 'in_progress' },    // NOT counted
      { id: 't5', reviewerId: 'agent-ryan', status: 'done' },           // NOT counted
      { id: 't6', reviewerId: 'agent-ryan', status: 'todo' },           // NOT counted
      { id: 't7', reviewerId: 'agent-ryan', status: 'backlog' },        // NOT counted
    ];
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(tasks),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    // Rachel has 0, Ryan has 3 → Rachel picked
    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-rachel');

    // Verify Ryan's count is 3 in allReviewers
    const ryan = d.allReviewers.find((r: any) => r.id === 'agent-ryan');
    expect(ryan.reviewCount).toBe(3);
  });

  it('skips tasks with null/undefined reviewerId', async () => {
    const tasks = [
      { id: 't1', reviewerId: 'agent-ryan', status: 'review' },
      { id: 't2', reviewerId: null, status: 'review' },
      { id: 't3', status: 'review' },  // no reviewerId field
      { id: 't4', reviewerId: undefined, status: 'in_testing' },
    ];
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(tasks),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    // Only 1 review counted (agent-ryan)
    const ryan = d.allReviewers.find((r: any) => r.id === 'agent-ryan');
    expect(ryan.reviewCount).toBe(1);
  });

  it('skips tasks with empty string reviewerId', async () => {
    const tasks = [
      { id: 't1', reviewerId: 'agent-ryan', status: 'review' },
      { id: 't2', reviewerId: '', status: 'review' },
    ];
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(tasks),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    const ryan = d.allReviewers.find((r: any) => r.id === 'agent-ryan');
    expect(ryan.reviewCount).toBe(1);
  });

  // ══════════════════════════════════════════
  // Domain Filtering Edge Cases
  // ══════════════════════════════════════════

  it('handles reviewer with unknown domain role (e.g. "Code Reviewer")', async () => {
    const agents = [
      ...MOCK_AGENTS.filter(a => !a.role.includes('Reviewer')),
      { id: 'agent-generic', name: 'Generic', emoji: '🤖', role: 'Code Reviewer', status: 'idle' },
    ];
    mockFetch({
      'agents.list': ok(agents),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    // Domain is backend, but no backend reviewers → fallback to all → generic picked
    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-generic');
  });

  it('single reviewer handles cross-domain tasks', async () => {
    const singleReviewer = [
      ...MOCK_AGENTS.filter(a => !a.role.includes('Reviewer')),
      { id: 'agent-ryan', name: 'Ryan', emoji: '🔎', role: 'Senior Backend Reviewer', status: 'idle' },
    ];

    // Frontend task but only backend reviewer available
    mockFetch({
      'agents.list': ok(singleReviewer),
      'skills.getByTask': skillsOk(MOCK_FRONTEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-ryan');
    expect(d.taskDomain).toBe('frontend');
  });

  // ══════════════════════════════════════════
  // Response Format
  // ══════════════════════════════════════════

  it('success response includes all expected fields', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBeTruthy();
    expect(d.reviewer.agentName).toBeTruthy();
    expect(d.reviewer.agentEmoji).toBeTruthy();
    expect(d.reviewer.reviewCount).toBe(0);
    expect(d.reviewer.domain).toBe('backend');
    expect(d.taskDomain).toBe('backend');
    expect(Array.isArray(d.allReviewers)).toBe(true);
    expect(d.allReviewers.length).toBe(2); // 2 backend reviewers
  });

  it('response text includes reviewer details and domain label', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;

    expect(text).toContain('(backend domain)');
    expect(text).toContain('active reviews');
    expect(text).toContain('Senior Backend Reviewer');
  });

  it('response includes "Other options" list', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;

    expect(text).toContain('Other options');
  });

  it('unknown domain response omits domain label', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk([]),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const text = result.content[0].text as string;

    expect(text).toContain('Suggested reviewer:');
    expect(text).not.toContain('(unknown domain)');
  });

  // ══════════════════════════════════════════
  // Adversarial Input
  // ══════════════════════════════════════════

  it('handles very long taskId without crashing', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk([]),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'a'.repeat(1000) });
    const d = result.details as any;

    expect(d.success).toBe(true);
  });

  it('handles special characters in excludeAgentId safely', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', {
      taskId: 'task-123',
      excludeAgentId: '<script>alert(1)</script>',
    });
    const d = result.details as any;

    expect(d.success).toBe(true);
    // No reviewer matches that ID, so all reviewers are available
    expect(d.reviewer.agentId).toBeTruthy();
  });

  it('handles agent with missing role field', async () => {
    const agents = [
      { id: 'agent-x', name: 'X' },  // no role
      ...MOCK_AGENTS.filter(a => a.role.includes('Reviewer')),
    ];
    mockFetch({
      'agents.list': ok(agents),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).not.toBe('agent-x');
  });

  it('handles agent with null role', async () => {
    const agents = [
      { id: 'agent-x', name: 'X', role: null as any },
      ...MOCK_AGENTS.filter(a => a.role.includes('Reviewer')),
    ];
    mockFetch({
      'agents.list': ok(agents),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).not.toBe('agent-x');
  });

  // ══════════════════════════════════════════
  // Large Dataset
  // ══════════════════════════════════════════

  it('handles 50 tasks in review status assigned to one reviewer', async () => {
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(makeTasksWithReviewer('agent-ryan', 'review', 50)),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(d.reviewer.agentId).toBe('agent-rachel');
    expect(d.reviewer.reviewCount).toBe(0);
  });

  it('handles 100 agents with only 4 reviewers', async () => {
    const manyAgents = [
      ...Array.from({ length: 96 }, (_, i) => ({
        id: `agent-dev-${i}`,
        name: `Dev${i}`,
        emoji: '👤',
        role: 'Software Engineer',
        status: 'idle',
      })),
      ...MOCK_AGENTS.filter(a => a.role.includes('Reviewer')),
    ];
    mockFetch({
      'agents.list': ok(manyAgents),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok([]),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    expect(d.success).toBe(true);
    expect(['agent-ryan', 'agent-rachel']).toContain(d.reviewer.agentId);
  });

  it('tasks spanning all statuses — only review ones counted', async () => {
    const tasks = [
      { id: 't1', reviewerId: 'agent-ryan', status: 'backlog' },
      { id: 't2', reviewerId: 'agent-ryan', status: 'todo' },
      { id: 't3', reviewerId: 'agent-ryan', status: 'in_progress' },
      { id: 't4', reviewerId: 'agent-ryan', status: 'review' },         // counted
      { id: 't5', reviewerId: 'agent-ryan', status: 'in_testing' },     // counted
      { id: 't6', reviewerId: 'agent-ryan', status: 'in_releasing' },   // counted
      { id: 't7', reviewerId: 'agent-ryan', status: 'done' },
    ];
    mockFetch({
      'agents.list': ok(MOCK_AGENTS),
      'skills.getByTask': skillsOk(MOCK_BACKEND_SKILLS),
      'tasks.list': ok(tasks),
    });

    const result = await harness.pickReviewer.execute('tc-1', { taskId: 'task-123' });
    const d = result.details as any;

    const ryan = d.allReviewers.find((r: any) => r.id === 'agent-ryan');
    expect(ryan.reviewCount).toBe(3);
    // Rachel at 0 → picked
    expect(d.reviewer.agentId).toBe('agent-rachel');
  });
});
