import { ParseBeatSource, ParseBeatString } from '~/lib/ParseBeat';
import { BeatSource } from '~/types/BarSource';
import { Beat } from '~/types/Beat';

/** Shared disposable beat used in tests and BeatTestUtil fixtures. */
export function createTestBeat(moduleId: string = 'test-module'): Beat {
  const beatSource = new BeatSource([
    {
      kick: 'k,,,,k,,,',
      hihat: 'h,h,h,h,h,h,h,h',
      snare: ',,s,,,,s,',
      accent: 'a,,a,,a,,a,',
    },
  ]);

  const beatString = ParseBeatSource(beatSource);
  const { beatNotes } = ParseBeatString(beatString);
  return new Beat({
    id: 'testBeat',
    name: 'testBeat',
    index: 0,
    authorId: '',
    createdAt: new Date(),
    modifiedAt: new Date(),
    beatNotes: beatNotes,
    description: '',
    moduleId: moduleId,
  });
}
