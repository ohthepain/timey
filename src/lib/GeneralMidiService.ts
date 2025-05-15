export class GeneralMidiService {
  private static readonly DRUM_MAP: Record<string, number> = {
    'hihat-open-edge-td27': 26,
    // Bass Drums
    kick: 36,
    kick2: 35,
    // Snare Drums
    rim: 37,
    snare: 38,
    clap: 39,
    snare2: 40,
    // Tom Toms
    'floor-tom': 41,
    hihat: 42,
    'floor-tom2': 43,
    'hihat-pedal': 44,
    tom1: 45,
    'hihat-open': 46,
    tom2: 47,
    tom3: 48,
    // Cymbals
    crash: 49,
    tom4: 50,
    ride: 51,
    china: 52,
    'ride-bell': 53,
    tamb: 54,
    splash: 55,
    cowbell: 56,
    crash2: 57,
    vibraslap: 58,
    ride2: 59,
    // Other
    'bongo-hi': 60,
    'bongo-lo': 61,
    'conga-mute': 62,
    'conga-open': 63,
    'conga-lo': 64,
    'timbale-hi': 65,
    'timbale-lo': 66,
    'agogo-hi': 67,
    'agogo-lo': 68,
    cabasa: 69,
    maracas: 70,
    'whistle-short': 71,
    'whistle-long': 72,
    'guiro-short': 73,
    'guiro-long': 74,
    claves: 75,
    'wood-hi': 76,
    'wood-lo': 77,
    'cuica-mute': 78,
    'cuica-open': 79,
    'triangle-mute': 80,
    'triangle-open': 81,
  };

  private static readonly REVERSE_MAP: Record<number, string> = Object.entries(GeneralMidiService.DRUM_MAP).reduce(
    (acc, [name, number]) => {
      acc[number] = name;
      return acc;
    },
    {} as Record<number, string>
  );

  /**
   * Get the MIDI note number for a drum name
   * @param drumName The name of the drum
   * @returns The MIDI note number, or undefined if not found
   */
  static getNoteNumber(drumName: string): number | undefined {
    return this.DRUM_MAP[drumName];
  }

  /**
   * Get the drum name for a MIDI note number
   * @param noteNumber The MIDI note number
   * @returns The drum name, or undefined if not found
   */
  static getDrumName(noteNumber: number): string | undefined {
    return this.REVERSE_MAP[noteNumber];
  }

  /**
   * Check if a MIDI note number is a valid drum note
   * @param noteNumber The MIDI note number to check
   * @returns true if the note number corresponds to a drum
   */
  static isDrumNote(noteNumber: number): boolean {
    return noteNumber in this.REVERSE_MAP;
  }

  /**
   * Get all available drum names
   * @returns Array of all drum names
   */
  static getAllDrumNames(): string[] {
    return Object.keys(this.DRUM_MAP);
  }

  /**
   * Get all available MIDI note numbers for drums
   * @returns Array of all drum MIDI note numbers
   */
  static getAllNoteNumbers(): number[] {
    return Object.keys(this.REVERSE_MAP).map(Number);
  }
}
