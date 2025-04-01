import { useEffect, useState } from 'react';
import { Input, Output, WebMidi } from 'webmidi';

class MidiService {
  receivedResponse: boolean = false;

  getMidiInputs(): Array<{ id: string; label: string }> {
    return WebMidi.inputs.map((input: Input) => ({ id: input.id, label: input.name }));
  }

  getMidiOutputs(): Array<{ id: string; label: string }> {
    return WebMidi.outputs.map((output: Output) => ({ id: output.id, label: output.name }));
  }

  getDeviceNameById(deviceId: string, isInput: boolean): string | null {
    const devices = isInput ? WebMidi.inputs : WebMidi.outputs;
    const device = devices.find((d) => d.id === deviceId);
    return device ? device.name : null;
  }

  playNote(
    midiOutputDeviceId: string,
    channelNum: number,
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) {
    let midiOutputDevice = WebMidi.getOutputById(midiOutputDeviceId);
    if (!midiOutputDevice) {
      const midiOutputDeviceName = this.getDeviceNameById(midiOutputDeviceId, false);
      console.warn(`No MIDI output device found: ${midiOutputDeviceName}/${midiOutputDeviceId}`);
      return;
    }

    const outputChannel = midiOutputDevice.channels[channelNum];
    if (!outputChannel) {
      throw new Error('MIDI output channel is undefined');
    }

    const attack = velocity / 127;

    outputChannel.playNote(note, { attack: attack, duration, time: WebMidi.time + delayMsec });
  }

  sendControlChange(midiSettings: any, ccNumber: number, value: number) {
    if (!midiSettings.midiOutputDeviceId) {
      console.warn('MidiService.sendControlChange: Please select output device');
      return;
    }
    if (midiSettings.midiOutputChannelNum == null) {
      console.warn('MidiService.sendControlChange: Please select output channel');
      return;
    }

    const midiOutputDevice = WebMidi.getOutputById(midiSettings.midiOutputDeviceId);
    if (!midiOutputDevice) {
      console.warn(`Output device ${midiSettings.midiOutputDeviceId} not found`);
      return;
    }

    const outputChannel = midiOutputDevice.channels[midiSettings.midiOutputChannelNum];
    outputChannel.sendControlChange(ccNumber, value);
  }
}

export const midiService = new MidiService();

export function useMidiService() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [midiInputs, setMidiInputs] = useState<Array<{ id: string; label: string }>>([]);
  const [midiOutputs, setMidiOutputs] = useState<Array<{ id: string; label: string }>>([]);

  const getDeviceNameById = (deviceId: string, isInput: boolean): string | null => {
    return midiService.getDeviceNameById(deviceId, isInput);
  };

  const playNote = (
    midiOutputDeviceId: string,
    channelNum: number,
    note: number | string | number[] | string[],
    velocity: number,
    duration?: number,
    delayMsec: number = 0
  ) => {
    midiService.playNote(midiOutputDeviceId, channelNum, note, velocity, duration, delayMsec);
  };

  useEffect(() => {
    WebMidi.enable({ sysex: true })
      .then(() => {
        console.log('WebMidi enabled');
        setIsEnabled(true);
        setMidiInputs(midiService.getMidiInputs());
        setMidiOutputs(midiService.getMidiOutputs());

        WebMidi.addListener('connected', () => {
          setMidiInputs(midiService.getMidiInputs());
          setMidiOutputs(midiService.getMidiOutputs());
        });

        WebMidi.addListener('disconnected', () => {
          setMidiInputs(midiService.getMidiInputs());
          setMidiOutputs(midiService.getMidiOutputs());
        });
      })
      .catch((err) => {
        console.error('Failed to enable WebMidi:', err);
      });

    return () => {
      WebMidi.removeListener('connected');
      WebMidi.removeListener('disconnected');
    };
  }, []);

  return { isEnabled, midiInputs, midiOutputs, getDeviceNameById, playNote };
}
