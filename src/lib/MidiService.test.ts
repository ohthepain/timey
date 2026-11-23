import { EventEmitter } from 'events';
import { afterEach, expect, it, vi } from 'vitest';

vi.unmock('./MidiService');
vi.mock('~/lib/midiDeviceBinding', () => ({
  bindConfiguredMidiDevices: vi.fn(),
  ensureWebMidiEnabled: vi.fn(async () => false),
}));

import { WebMidi, type Input } from 'webmidi';
import { midiService } from './MidiService';

function fakeInput(id: string) {
  const input = new EventEmitter() as EventEmitter & { id: string; channels: EventEmitter[] };
  input.id = id;
  input.channels = Array.from({ length: 17 }, () => new EventEmitter());
  return input;
}

function noteOn(note: number) {
  return { message: { type: 'noteon', dataBytes: [note, 100] } };
}

it('owns input listeners across selection changes and service lifetime', async () => {
  const inputA = fakeInput('A');
  const inputB = fakeInput('B');
  const enabled = vi.spyOn(WebMidi, 'enabled', 'get').mockReturnValue(true);
  const time = vi.spyOn(WebMidi, 'time', 'get').mockReturnValue(100);
  const inputs = vi
    .spyOn(WebMidi, 'inputs', 'get')
    .mockReturnValue([inputA as unknown as Input, inputB as unknown as Input]);
  const inputById: Record<string, Input> = {
    A: inputA as unknown as Input,
    B: inputB as unknown as Input,
  };
  const getInputById = vi.spyOn(WebMidi, 'getInputById').mockImplementation((id) => inputById[id]);

  afterEach(() => {
    enabled.mockRestore();
    time.mockRestore();
    inputs.mockRestore();
    getInputById.mockRestore();
  });

  const service = midiService;
  const notes: number[] = [];
  let pulses = 0;
  let clockLosses = 0;
  vi.useFakeTimers();
  service.on('midiNote', ({ note }) => notes.push(note));
  service.on('midiClockPulse', () => pulses++);
  service.on('midiClockLost', () => clockLosses++);

  service.midiInputDeviceId = 'A';
  service.midiInputChannelNum = 10;
  service.listenToInput();
  inputA.channels[10].emit('noteon', noteOn(36));
  inputA.emit('clock');
  inputA.emit('clock');
  expect(notes).toEqual([36]);
  expect(pulses).toBe(1);

  service.midiInputDeviceId = 'B';
  service.listenToInput();
  inputA.channels[10].emit('noteon', noteOn(38));
  inputA.emit('clock');
  inputB.channels[10].emit('noteon', noteOn(40));
  expect(notes).toEqual([36, 40]);

  service.midiInputChannelNum = 11;
  service.listenToInput();
  inputB.channels[10].emit('noteon', noteOn(42));
  inputB.channels[11].emit('noteon', noteOn(44));
  inputB.emit('clock');
  expect(notes).toEqual([36, 40, 44]);

  service.midiInputDeviceId = null;
  service.listenToInput();
  inputB.channels[11].emit('noteon', noteOn(46));
  inputB.emit('clock');
  expect(notes).toEqual([36, 40, 44]);
  expect(pulses).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(clockLosses).toBe(0);
  vi.useRealTimers();

  service.midiInputDeviceId = 'A';
  service.listenToInput();
  service.listenToInput();
  inputA.channels[11].emit('noteon', noteOn(48));
  expect(notes).toEqual([36, 40, 44, 48]);
  const addListener = vi.spyOn(WebMidi, 'addListener');
  const removeListener = vi.spyOn(WebMidi, 'removeListener');
  service.initListeners();
  service.initListeners();
  expect(addListener.mock.calls.filter(([event]) => event === 'connected')).toHaveLength(1);
  expect(addListener.mock.calls.filter(([event]) => event === 'disconnected')).toHaveLength(1);
  service.dispose();
  inputA.channels[11].emit('noteon', noteOn(50));
  inputA.emit('clock');
  expect(notes).toEqual([36, 40, 44, 48]);
  expect(removeListener).toHaveBeenCalledWith('connected', expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith('disconnected', expect.any(Function));
  addListener.mockRestore();
  removeListener.mockRestore();
});
