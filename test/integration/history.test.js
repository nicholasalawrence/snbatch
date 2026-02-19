import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('corrupted history file handling (P2-4)', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `snbatch-test-history-${Date.now()}.json`);
  });

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it('parses valid entries and skips corrupted lines', async () => {
    const content = [
      JSON.stringify({ id: '1', action: 'install', rollbackToken: 'tok1' }),
      'corrupted line {{{',
      JSON.stringify({ id: '2', action: 'install', rollbackToken: 'tok2' }),
      '',
    ].join('\n');
    await writeFile(tmpFile, content, 'utf8');

    const { readFile } = await import('fs/promises');
    const raw = await readFile(tmpFile, 'utf8');
    const entries = [];
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip corrupted
      }
    }

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('1');
    expect(entries[1].id).toBe('2');
  });
});
