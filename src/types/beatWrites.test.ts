import { describe, expect, it } from 'vitest';
import { copiedBeatName, createBeatInput, musicalNote } from './beatWrites';

const note = {
  index: 0,
  duration: 8,
  noteString: 'g/4',
  barNum: 0,
  beatNum: 0,
  divisionNum: 0,
  subDivisionNum: 0,
  numSubDivisions: 1,
  velocity: 127,
};
const beat = { name: 'Beat', moduleId: 'destination', beatNotes: [note] };

describe('new beat content contract', () => {
  it('accepts musical content and rejects identity and authority claims', () => {
    expect(createBeatInput.parse(beat).index).toBe(0);
    for (const field of ['id', 'authorId', 'userId', 'role', 'token', 'enableAdmin', 'performances']) {
      expect(createBeatInput.safeParse({ ...beat, [field]: 'forged' }).success).toBe(false);
    }
    for (const field of ['id', 'beatId', 'performanceId']) {
      expect(createBeatInput.safeParse({ ...beat, beatNotes: [{ ...note, [field]: 'forged' }] }).success).toBe(false);
    }
  });
  it('rejects invalid musical values', () => {
    for (const changes of [{ duration: 0 }, { velocity: 128 }, { index: 1.5 }, { numSubDivisions: 0 }]) {
      expect(createBeatInput.safeParse({ ...beat, beatNotes: [{ ...note, ...changes }] }).success).toBe(false);
    }
  });
  it('projects musical fields with no private or relational data', () => {
    const source = { ...note, id: 'source', beatId: 'beat', performanceId: 'private' };
    expect(musicalNote(source)).toEqual({ ...note, microtiming: 0 });
  });
  it('preserves copy naming', () => {
    expect(copiedBeatName('Beat 7')).toBe('Beat 8');
    expect(copiedBeatName('Beat')).toBe('Copy of Beat');
  });
});
