import { afterEach, describe, expect, it } from 'vitest';
import { EventRecorderService } from './EventRecorderService';

const capturedCsv = [
  'timestamp,noteIndex,type,note,timing,velocity',
  '0,0,midi,kick,,100',
  '0,0,played,kick,0,27',
  '250,0,timing,,250,',
  '250,0,missed,hihat,,',
  '250,1,midi,crash,,90',
  '250,1,extra,crash,,',
].join('\n');

describe('recorded event replay', () => {
  afterEach(() => EventRecorderService.shutdown());

  it('replays only original inputs in capture order; derived feedback is recalculated by the target', () => {
    const events = EventRecorderService.getInstance();
    events.loadFromCsvText(capturedCsv);
    expect(events.toCsv()).toBe(capturedCsv);
    const inputs: number[][] = [];
    events.replay({
      advanceTime: (interval) => inputs.push([interval]),
      emitMidiNote: (note, velocity) => inputs.push([note, velocity]),
    });
    expect(inputs).toEqual([[36, 100], [250], [49, 90]]);
    expect(events.toCsv()).toBe('timestamp,noteIndex,type,note,timing,velocity');
  });
});
