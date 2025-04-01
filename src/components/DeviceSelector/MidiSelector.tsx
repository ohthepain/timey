import { useState, useEffect } from 'react';
import { WebMidi } from 'webmidi';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';

export default function MidiSelector() {
  const {
    midiInputDeviceId,
    midiOutputDeviceId,
    midiInputDeviceName,
    midiOutputDeviceName,
    midiInputChannelNum,
    midiOutputChannelNum,
    setMidiInputDevice,
    setMidiOutputDevice,
  } = useMidiSettingsStore();
  const [midiInputs, setMidiInputs] = useState<any[]>([]);
  const [midiOutputs, setMidiOutputs] = useState<any[]>([]);

  function getDeviceNameById(deviceId: string, isInput: boolean): string | null {
    const devices = isInput ? WebMidi.inputs : WebMidi.outputs;
    const device = devices.find((d) => d.id === deviceId);
    return device ? device.name : null;
  }

  const onChangeMidiOutputDeviceId = (e: any) => {
    console.log(`onChangeMidiOutputDeviceId ${e.target.value}`);
    const deviceId = e.target.value;
    const deviceName = getDeviceNameById(deviceId, false);
    console.log(`onChangeMidiOutputDeviceId ${deviceId}: ${deviceName}`);
    setMidiOutputDevice(deviceId, deviceName || 'no name', midiOutputChannelNum);
  };

  const onChangeMidiInputDeviceId = (e: any) => {
    console.log(`onChangeMidiInputDeviceId ${e.target.value}`);
    const deviceId = e.target.value;
    const deviceName = getDeviceNameById(deviceId, true);
    console.log(`onChangeMidiInputDeviceId ${deviceId}: ${deviceName}`);
    setMidiInputDevice(deviceId, deviceName || 'no name', midiInputChannelNum);
    // startMidiListeners();
  };

  const onChangeMidiInputChannel = (e: any) => {
    console.log(`onChangeMidiInputChannel ${e.target.value}`);
    const midiInputChannelNum = parseInt(e.target.value);
    setMidiInputDevice(midiInputDeviceId, midiInputDeviceName || 'no name', midiInputChannelNum);
    // MidiService.setMidiInputChannel(parseInt(e.target.value))
  };

  const onChangeMidiOutputChannel = (e: any) => {
    console.log(`onChangeMidiOutputChannel ${e.target.value}`);
    const midiOutputChannelNum = parseInt(e.target.value);
    setMidiOutputDevice(midiOutputDeviceId, midiOutputDeviceName || 'no name', midiOutputChannelNum);
    // MidiService.setMidiOutputChannel(parseInt(e.target.value))
  };

  const getMidiDevices = () => {
    if (typeof navigator.requestMIDIAccess === 'function') {
      console.log('This browser supports WebMIDI!');
      navigator.requestMIDIAccess({ sysex: false }).then(
        (access: MIDIAccess) => {
          console.log('MIDI Access Object:', access);

          // Log available inputs
          const inputs: any[] = [];
          const ins = Array.from(access.inputs.values());
          console.log('MIDI Inputs:', ins);
          for (const input of ins) {
            inputs.push(input);
          }
          setMidiInputs(inputs);

          // Log available outputs
          const outputs: any[] = [];
          const outs = Array.from(access.outputs.values());
          console.log('MIDI Outputs:', outputs);
          for (const output of outs) {
            outputs.push(output);
          }
          setMidiOutputs(outputs);

          if (inputs.length === 0) {
            console.warn('No MIDI inputs found.');
          }

          // Listen for state changes
          access.onstatechange = (event: MIDIConnectionEvent) => {
            console.log('MIDI state change:', event.port?.name, event.port?.manufacturer, event.port?.state);
          };
        },
        (error: DOMException) => {
          console.error('Failed to get MIDI access:', error);
        }
      );
    } else {
      alert('This browser does not support MIDI. Chrome and Opera. Try one of those.');
    }
  };

  useEffect(() => {
    getMidiDevices();
  }, []);

  return (
    <div className="flex flex-col pb-2 bg-purple-300 gap-y-2">
      <div className="flex flex-row input-group col-lg-4 gap-x-4">
        MIDI In:
        <div className="flex">
          <select onChange={onChangeMidiInputDeviceId}>
            <option value={''}> {'All MIDI devices'} </option>
            {midiInputs.map((input) => {
              return (
                <option value={input.id} key={input.id}>
                  {' '}
                  {input.name.substring(0, 40)}{' '}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex">
          <select onChange={onChangeMidiInputChannel}>
            <option value={''}> {'All channels'} </option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => {
              return (
                <option key={n} value={n}>
                  {' '}
                  {n}{' '}
                </option>
              );
            })}
          </select>
        </div>
      </div>
      <div className="flex flex-row input-group col-lg-4 gap-x-4">
        MIDI Out:
        <div className="flex">
          <select onChange={onChangeMidiOutputDeviceId}>
            <option value={''}> {'All MIDI devices'} </option>
            {midiOutputs.map((output) => {
              return (
                <option value={output.id} key={output.id}>
                  {' '}
                  {output.name.substring(0, 40)}{' '}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex">
          <select onChange={onChangeMidiOutputChannel}>
            <option value={''}> {'All channels'} </option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => {
              return (
                <option key={n} value={n}>
                  {' '}
                  {n}{' '}
                </option>
              );
            })}
          </select>
        </div>
      </div>
    </div>
  );
}
