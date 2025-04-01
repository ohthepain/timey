import { useState, useEffect } from 'react';
import { useMidiSettingsStore } from '~/state/MidiSettingsStore';
import { useMidiService } from '~/lib/MidiService';

export default function MidiSelector() {
  const { midiInputs, midiOutputs, getDeviceNameById } = useMidiService();
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

  return (
    <div className="flex flex-col pb-2 bg-purple-300 gap-y-2">
      <div className="flex flex-row input-group col-lg-4 gap-x-4">
        MIDI In:
        <div className="flex">
          <select value={midiInputDeviceId || 'All MIDI devices'} onChange={onChangeMidiInputDeviceId}>
            <option value={''}> {'All MIDI devices'} </option>
            {midiInputs.map((input) => {
              return (
                <option value={input.id} key={input.id}>
                  {' '}
                  {input.label.substring(0, 40)}{' '}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex">
          <select value={midiInputChannelNum} onChange={onChangeMidiInputChannel}>
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
          <select value={midiOutputDeviceId} onChange={onChangeMidiOutputDeviceId}>
            <option value={''}> {'All MIDI devices'} </option>
            {midiOutputs.map((output) => {
              return (
                <option value={output.id} key={output.id}>
                  {' '}
                  {output.label.substring(0, 40)}{' '}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex">
          <select value={midiOutputChannelNum} onChange={onChangeMidiOutputChannel}>
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
