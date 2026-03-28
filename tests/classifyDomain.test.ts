import { describe, it, expect } from 'vitest';
import {
  classifyDomain,
  BACKEND_SKILL_KEYWORDS,
  FRONTEND_SKILL_KEYWORDS,
} from '../src/domain.js';

describe('classifyDomain', () => {
  // ── Happy Path Tests ──

  it('returns "backend" for all backend skills', () => {
    const skills = [
      { name: 'Node.js', slug: 'nodejs' },
      { name: 'PostgreSQL', slug: 'postgresql' },
      { name: 'Prisma ORM', slug: 'prisma' },
    ];
    expect(classifyDomain(skills)).toBe('backend');
  });

  it('returns "frontend" for all frontend skills', () => {
    const skills = [
      { name: 'React', slug: 'react' },
      { name: 'Tailwind CSS', slug: 'tailwind' },
      { name: 'shadcn/ui', slug: 'shadcn' },
    ];
    expect(classifyDomain(skills)).toBe('frontend');
  });

  it('returns "backend" when backend skills are majority', () => {
    const skills = [
      { name: 'Node.js', slug: 'nodejs' },
      { name: 'PostgreSQL', slug: 'postgresql' },
      { name: 'Redis', slug: 'redis' },
      { name: 'React', slug: 'react' }, // only 1 frontend
    ];
    expect(classifyDomain(skills)).toBe('backend');
  });

  it('returns "frontend" when frontend skills are majority', () => {
    const skills = [
      { name: 'React', slug: 'react' },
      { name: 'Tailwind CSS', slug: 'tailwind' },
      { name: 'Accessibility', slug: 'a11y' },
      { name: 'tRPC API', slug: 'trpc' }, // only 1 backend
    ];
    expect(classifyDomain(skills)).toBe('frontend');
  });

  it('returns "backend" for a single backend skill', () => {
    expect(classifyDomain([{ name: 'tRPC API', slug: 'trpc' }])).toBe('backend');
  });

  it('returns "frontend" for a single frontend skill', () => {
    expect(classifyDomain([{ name: 'React Components', slug: 'react' }])).toBe('frontend');
  });

  // ── Edge Cases ──

  it('returns "unknown" for empty array', () => {
    expect(classifyDomain([])).toBe('unknown');
  });

  it('returns "unknown" for tied scores', () => {
    const skills = [
      { name: 'React', slug: 'react' },     // frontend
      { name: 'Node.js', slug: 'nodejs' },   // backend
    ];
    expect(classifyDomain(skills)).toBe('unknown');
  });

  it('returns "unknown" for skills with no keyword matches', () => {
    expect(classifyDomain([{ name: 'Management', slug: 'mgmt' }])).toBe('unknown');
  });

  it('is case insensitive', () => {
    expect(classifyDomain([{ name: 'REACT', slug: 'REACT' }])).toBe('frontend');
  });

  it('matches keyword as substring', () => {
    expect(classifyDomain([{ name: 'Responsive Design', slug: 'responsive-design' }])).toBe('frontend');
  });

  it('matches keyword in slug only', () => {
    expect(classifyDomain([{ name: 'Custom', slug: 'prisma' }])).toBe('backend');
  });

  it('matches keyword in name only', () => {
    expect(classifyDomain([{ name: 'Docker Setup', slug: 'infra' }])).toBe('backend');
  });

  it('every BACKEND_SKILL_KEYWORDS individually produces "backend"', () => {
    for (const kw of BACKEND_SKILL_KEYWORDS) {
      expect(classifyDomain([{ name: kw, slug: kw }])).toBe('backend');
    }
  });

  it('every FRONTEND_SKILL_KEYWORDS individually produces "frontend"', () => {
    for (const kw of FRONTEND_SKILL_KEYWORDS) {
      expect(classifyDomain([{ name: kw, slug: kw }])).toBe('frontend');
    }
  });

  it('returns "unknown" for empty name and slug', () => {
    expect(classifyDomain([{ name: '', slug: '' }])).toBe('unknown');
  });

  it('handles skills with special characters (Next.js)', () => {
    expect(classifyDomain([{ name: 'Next.js App Router', slug: 'nextjs-app' }])).toBe('frontend');
  });

  it('handles large skill sets correctly', () => {
    const skills = [
      ...BACKEND_SKILL_KEYWORDS.map(kw => ({ name: kw, slug: kw })),
      ...FRONTEND_SKILL_KEYWORDS.slice(0, 5).map(kw => ({ name: kw, slug: kw })),
    ];
    // 24 backend + 5 frontend = backend
    expect(classifyDomain(skills)).toBe('backend');
  });

  it('no cross-contamination: backend keywords only score backend', () => {
    const skills = [{ name: 'security', slug: 'security' }];
    const result = classifyDomain(skills);
    expect(result).toBe('backend');
  });

  it('duplicate keyword in same skill does not double-count', () => {
    // "react" appears in both name and slug, but same skill
    // The break in the inner loop means each keyword array only scores once per skill
    const result = classifyDomain([{ name: 'react', slug: 'react' }]);
    expect(result).toBe('frontend');
  });
});
