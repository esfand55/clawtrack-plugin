// ── Domain classification for reviewer matching ──

export const BACKEND_SKILL_KEYWORDS = [
  'node', 'nodejs', 'python', 'postgresql', 'supabase', 'redis', 'docker',
  'api', 'trpc', 'prisma', 'backend', 'database', 'rest', 'graphql',
  'authentication', 'authorization', 'security', 'migration', 'sql',
  'server', 'middleware', 'cron', 'queue', 'worker',
];

export const FRONTEND_SKILL_KEYWORDS = [
  'react', 'next.js', 'nextjs', 'typescript', 'tailwind', 'css', 'html',
  'frontend', 'ui', 'ux', 'component', 'accessibility', 'a11y', 'responsive',
  'shadcn', 'radix', 'design-system', 'jest', 'playwright', 'storybook',
  'animation', 'chart', 'form', 'modal', 'toast', 'table', 'theme',
];

export function classifyDomain(skills: { name: string; slug: string }[]): 'frontend' | 'backend' | 'unknown' {
  let frontendScore = 0;
  let backendScore = 0;
  for (const skill of skills) {
    const text = (skill.name + ' ' + skill.slug).toLowerCase();
    for (const kw of FRONTEND_SKILL_KEYWORDS) {
      if (text.includes(kw)) { frontendScore++; break; }
    }
    for (const kw of BACKEND_SKILL_KEYWORDS) {
      if (text.includes(kw)) { backendScore++; break; }
    }
  }
  if (frontendScore > backendScore) return 'frontend';
  if (backendScore > frontendScore) return 'backend';
  return 'unknown';
}

export function getReviewerDomain(role: string): 'frontend' | 'backend' | 'unknown' {
  const r = role.toLowerCase();
  if (r.includes('frontend')) return 'frontend';
  if (r.includes('backend')) return 'backend';
  return 'unknown';
}
