import { Input, Output, WebMidi } from 'webmidi';

export async function ensureWebMidiEnabled() {
  if (typeof window === 'undefined') return false;
  if (WebMidi.enabled) return true;
  console.log('WebMidi not enabled, enabling...');
  try {
    await WebMidi.enable({ sysex: true });
    return true;
  } catch (error) {
    console.error('Error enabling WebMidi:', error);
    return false;
  }
}

function bindMidiOutput(deviceId: string, channelNum: number) {
  const device = WebMidi.getOutputById(deviceId);
  if (!device) throw new Error(`MIDI output device not found: ${deviceId}`);
  return { device, channel: device.channels[channelNum] };
}

function bindMidiInput(deviceId: string) {
  const device = WebMidi.getInputById(deviceId);
  if (!device) throw new Error(`MIDI input device not found: ${deviceId}`);
  return device;
}

export type BoundMidiDevices = {
  midiOutputDevice?: Output;
  midiOutputChannel?: Output['channels'][number];
  midiInputDevice?: Input;
  midiInputChannel?: Input['channels'][number];
};

export function bindConfiguredMidiDevices(
  midiInputDeviceId: string | null,
  midiOutputDeviceId: string | null,
  midiInputChannelNum: number,
  midiOutputChannelNum: number
): BoundMidiDevices {
  const bound: BoundMidiDevices = {};
  if (midiOutputDeviceId) {
    const output = bindMidiOutput(midiOutputDeviceId, midiOutputChannelNum);
    bound.midiOutputDevice = output.device;
    bound.midiOutputChannel = output.channel;
  }
  if (midiInputDeviceId) {
    bound.midiInputDevice = bindMidiInput(midiInputDeviceId);
    bound.midiInputChannel = bound.midiInputDevice.channels[midiInputChannelNum];
  }
  return bound;
}
