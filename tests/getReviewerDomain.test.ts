import { describe, it, expect } from 'vitest';
import { getReviewerDomain } from '../src/domain.js';

describe('getReviewerDomain', () => {
  it('returns "backend" for "Senior Backend Reviewer"', () => {
    expect(getReviewerDomain('Senior Backend Reviewer')).toBe('backend');
  });

  it('returns "frontend" for "Senior Frontend Reviewer"', () => {
    expect(getReviewerDomain('Senior Frontend Reviewer')).toBe('frontend');
  });

  it('is case insensitive (uppercase)', () => {
    expect(getReviewerDomain('BACKEND ENGINEER')).toBe('backend');
  });

  it('handles mixed case', () => {
    expect(getReviewerDomain('Frontend Developer')).toBe('frontend');
  });

  it('returns "unknown" for role with neither keyword', () => {
    expect(getReviewerDomain('Software Engineer')).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(getReviewerDomain('')).toBe('unknown');
  });

  it('returns "frontend" when both keywords present (frontend checked first)', () => {
    expect(getReviewerDomain('Full-Stack Frontend Backend Engineer')).toBe('frontend');
  });

  it('matches "backend" as substring', () => {
    expect(getReviewerDomain('fullstack-backend-dev')).toBe('backend');
  });

  it('handles exact match "frontend"', () => {
    expect(getReviewerDomain('frontend')).toBe('frontend');
  });
});
