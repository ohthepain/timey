import { create } from 'zustand'
import {produce} from 'immer'

export class MidiDeviceSettings {
    deviceId: string = "";
    deviceName: string = "";
    track: boolean = true;
    sync: boolean = false;
    remote: boolean = false;
}

export class MidiDevicePreferences {
    inputs: Array<MidiDeviceSettings> = []
    outputs: Array<MidiDeviceSettings> = []

    constructor(fake: any) {
        //console.log(`MidiDevicePreferences.constructor ${JSON.stringify(fake)}`)
        if (fake.inputs) {
            this.inputs = [...fake.inputs]
        }
        if (fake.outputs) {
            this.outputs = [...fake.outputs]
        }
    }

    getMidiInputDevicePreferences(deviceId: string, deviceName: string | undefined = undefined) : MidiDeviceSettings | undefined {
        //console.log(`MidiDevicePreferences.getMidiInputDevicePreferences(${deviceId},${deviceName})`)
        var settings: MidiDeviceSettings | undefined = this.inputs.find(candidate => candidate.deviceId === deviceId)
        if (settings === undefined && deviceName !== undefined) {
            settings = this.inputs.find(candidate => candidate.deviceName === deviceName)
        }

        return settings
    }

    getMidiOutputDevicePreferences(deviceId: string, deviceName?: string) : MidiDeviceSettings | undefined {
        //console.log(`MidiDevicePreferences.getMidiOutputDevicePreferences(${deviceId},${deviceName})`)
        var settings: MidiDeviceSettings | undefined = this.outputs.find(candidate => candidate.deviceId === deviceId)
        if (settings === undefined && deviceName !== undefined) {
            settings = this.outputs.find(candidate => candidate.deviceName === deviceName)
        }

        return settings
    }

    isTrackingEnabledForMidiInputId(deviceId: string) : boolean {
        const deviceSettings: MidiDeviceSettings | undefined = this.getMidiInputDevicePreferences(deviceId)
        const enabled =  deviceSettings !== undefined ? deviceSettings.track : true
        // console.log(`isTrackingEnabledForMidiInputId: ${enabled} deviceId ${deviceId} ${JSON.stringify(deviceSettings)}`)
        return enabled
    }

    isRemoteEnabledForMidiInputId(deviceId: string) : boolean {
        const deviceSettings: MidiDeviceSettings | undefined = this.getMidiInputDevicePreferences(deviceId)
        const enabled =  deviceSettings !== undefined ? deviceSettings.remote : true
        // console.log(`isTrackingEnabledForMidiInputId: ${enabled} deviceId ${deviceId} ${JSON.stringify(deviceSettings)}`)
        return enabled
    }

    isTrackingEnabledForMidiOutputId(deviceId: string) : boolean {
        const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId)
        const enabled =  deviceSettings !== undefined ? deviceSettings.track : true
        // console.log(`isTrackingEnabledForMidiInputId: ${enabled} deviceId ${deviceId} ${JSON.stringify(deviceSettings)}`)
        return enabled
    }

    isSyncEnabledForMidiOutputId(deviceId: string) : boolean {
        const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId)
        const enabled =  deviceSettings !== undefined ? deviceSettings.sync : false
        // console.log(`isTrackingEnabledForMidiInputId: ${enabled} deviceId ${deviceId} ${JSON.stringify(deviceSettings)}`)
        return enabled
    }

    isRemoteEnabledForMidiOutputId(deviceId: string) : boolean {
        const deviceSettings: MidiDeviceSettings | undefined = this.getMidiOutputDevicePreferences(deviceId)
        const enabled =  deviceSettings !== undefined ? deviceSettings.remote : true
        // console.log(`isTrackingEnabledForMidiInputId: ${enabled} deviceId ${deviceId} ${JSON.stringify(deviceSettings)}`)
        return enabled
    }
}

export type PreferencesState = {
    midiDevicePreferences: MidiDevicePreferences;
    // getMidiDevicePreferences: (deviceId: string, deviceName: string) => MidiDeviceSettings | undefined;
    loadMidiDevicePreferences: (midiDeviceSettings: MidiDevicePreferences) => void;
    setMidiInputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => void;
    setMidiOutputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => void;
}

const loadMidiDevicePreferences = (draft: PreferencesState, midiDevicePreferences: MidiDevicePreferences) => {
    draft.midiDevicePreferences = midiDevicePreferences
}

const setMidiInputDeviceSettings = (draft: PreferencesState, midiDeviceSettings: MidiDeviceSettings) => {

    //console.log(`setMidiInputDeviceSettings.setMidiInputDeviceSettings(${JSON.stringify(midiDeviceSettings)})`)
    var index: number = draft.midiDevicePreferences.inputs.findIndex(candidate => candidate.deviceId === midiDeviceSettings.deviceId)
    if (index === -1) {
        index = draft.midiDevicePreferences.inputs.findIndex(candidate => candidate.deviceName === midiDeviceSettings.deviceName)
    }

    if (index !== -1) {
        draft.midiDevicePreferences.inputs[index] = {...midiDeviceSettings}
    } else {
        draft.midiDevicePreferences.inputs.push({...midiDeviceSettings})
    }
}

const setMidiOutputDeviceSettings = (draft: PreferencesState, midiDeviceSettings: MidiDeviceSettings) => {

    //console.log(`setMidiInputDeviceSettings.setMidiOutputDeviceSettings(${JSON.stringify(midiDeviceSettings)})`)
    var index: number = draft.midiDevicePreferences.outputs.findIndex(candidate => candidate.deviceId === midiDeviceSettings.deviceId)
    if (index === -1) {
        index = draft.midiDevicePreferences.outputs.findIndex(candidate => candidate.deviceName === midiDeviceSettings.deviceName)
    }

    if (index !== -1) {
        draft.midiDevicePreferences.outputs[index] = {...midiDeviceSettings}
    } else {
        draft.midiDevicePreferences.outputs.push({...midiDeviceSettings})
    }
}

export const usePreferencesStore = create<PreferencesState>(set => ({
    midiDevicePreferences: new MidiDevicePreferences({}),
    loadMidiDevicePreferences: (midiDevicePreferences: MidiDevicePreferences) => set(produce(state => loadMidiDevicePreferences(state, midiDevicePreferences))),
    // getMidiDevicePreferences: (deviceId: string, deviceName: string) => getMidiDevicePreferences(state, deviceId, deviceName) },
    setMidiInputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => set(produce(state => setMidiInputDeviceSettings(state, midiDeviceSettings))),
    setMidiOutputDeviceSettings: (midiDeviceSettings: MidiDeviceSettings) => set(produce(state => setMidiOutputDeviceSettings(state, midiDeviceSettings))),
}))
