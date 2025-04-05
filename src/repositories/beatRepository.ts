import prisma from '../config/db';
import { Prisma } from '@prisma/client';
import { User } from '@clerk/clerk-react';

// Temporary import for populating db
import { NoteEntry } from '~/lib/ParseBeat';

export const getBeatById = async (id: string) => {
  return prisma.beat.findUnique({ where: { id }, include: { beatNotes: true } });
};

export const getBeatsByUser = async (userId: string) => {
  return prisma.beat.findMany({ where: { authorId: userId }, include: { beatNotes: true } });
};

export const createBeat = async (authorId: string) => {
  return prisma.beat.create({
    data: {
      authorId,
    },
  });
};

export const updateBeat = async (id: string, data: Prisma.BeatUpdateInput) => {
  return prisma.beat.update({ where: { id }, data });
};

export const deleteBeat = async (id: string) => {
  return prisma.beat.delete({ where: { id } });
};

export const saveBeatToDb = async (noteEntries: NoteEntry[], userId: string) => {
  if (!userId) {
    throw new Error('User ID is not available');
  }

  // Transform the NoteEntry array into a structure suitable for Prisma
  const beatNotesData = noteEntries.map((note) => ({
    index: note.index,
    duration: parseDuration(note.durationCode), // Convert durationCode to an integer
    staveNote: parseStaveNote(note.keys), // Convert keys to a MIDI note number
    barNum: note.barNum,
    beatNum: note.beatNum,
    divisionNum: note.divisionNum,
    subDivisionNum: note.subDivisionNum,
    numSubDivisions: note.numSubDivisions,
    velocity: 127, // Default velocity (can be adjusted as needed)
  }));

  // Create the beat and its associated notes in the database
  return prisma.beat.create({
    data: {
      authorId: userId,
      beatNotes: {
        create: beatNotesData,
      },
    },
    include: {
      beatNotes: true, // Include the beatNotes in the response
    },
  });
};

// Helper function to parse durationCode into an integer (e.g., "quarter" -> 4)
const parseDuration = (durationCode: string): number => {
  const durationMap: Record<string, number> = {
    whole: 1,
    half: 2,
    quarter: 4,
    eighth: 8,
    sixteenth: 16,
    thirtysecond: 32,
  };
  return durationMap[durationCode] || 0; // Default to 0 if durationCode is invalid
};

// Helper function to parse keys into a MIDI note number
const parseStaveNote = (keys: string[]): number => {
  // Assuming the first key represents the primary note (e.g., "C4")
  const note = keys[0];
  const midiMap: Record<string, number> = {
    'g/5/x': 79, // Example mapping for hihat
    'e/5': 76, // Example mapping for snare
    'g/4': 67, // Example mapping for kick
  };
  return midiMap[note] || 0; // Default to 0 if the note is invalid
};
