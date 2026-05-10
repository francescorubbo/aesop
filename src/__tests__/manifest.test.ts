import { describe, it, expect } from 'vitest';
import { manifest } from '../index';

describe('Aesop Extension', () => {
  it('should have correct manifest name', () => {
    expect(manifest.name).toBe('Aesop');
  });

  it('should have a description', () => {
    expect(manifest.description).toBeTruthy();
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('should have an empty tools array', () => {
    expect(manifest.tools).toBeDefined();
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(manifest.tools.length).toBe(0);
  });
});
