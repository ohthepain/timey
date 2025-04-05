import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import prisma from '~/config/db';
import { NoteEntry } from '~/lib/ParseBeat';
import { getAuth } from '@clerk/tanstack-react-start/server';
import { redirect } from '@tanstack/react-router';
import { checkUser } from '~/lib/checkUser';

// Helper function to parse durationCode into an integer
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
  const note = keys[0]; // Assuming the first key represents the primary note
  const midiMap: Record<string, number> = {
    'g/5/x': 79, // Example mapping for hihat
    'e/5': 76, // Example mapping for snare
    'g/4': 67, // Example mapping for kick
  };
  return midiMap[note] || 0; // Default to 0 if the note is invalid
};

export const APIRoute = createAPIFileRoute('/api/saveBeat')({
  POST: async ({ request }) => {
    try {
      // Parse the JSON body
      const { userId } = await getAuth(request);
      const { noteEntries } = await request.json();

      if (!userId) {
        // This will error because you're redirecting to a path that doesn't exist yet
        // You can create a sign-in route to handle this
        // See https://clerk.com/docs/references/tanstack-start/custom-sign-in-or-up-page
        throw redirect({
          to: '/sign-in/$',
        });
      }

      if (!noteEntries || !Array.isArray(noteEntries)) {
        return json({ error: 'Invalid note entries' }, { status: 400 });
      }

      checkUser(request);

      // Transform the NoteEntry array into a structure suitable for Prisma
      const beatNotesData = noteEntries.map((note: NoteEntry) => ({
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
      const beat = await prisma.beat.create({
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

      return json(beat, { status: 200 });
    } catch (error) {
      console.error('Error saving beat:', error);
      return json({ error: 'Failed to save beat' }, { status: 500 });
    }
  },
});
