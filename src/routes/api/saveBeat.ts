import { json } from '@tanstack/react-start';
import { createAPIFileRoute } from '@tanstack/react-start/api';
import prisma from '~/config/db';
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
const parseStaveNote = (note: string): number => {
  const midiMap: Record<string, number> = {
    'g/5/x': 79,
    'e/5': 76,
    'g/4': 67,
  };
  return midiMap[note] || 0;
};

// Function to parse the input string into structured data
const parseBeatString = (input: string) => {
  const lines = input.split('\n');
  const beatNotes: any[] = [];
  const tuples: any[] = [];
  let barNum = 0;
  let beatNum = 0;

  lines.forEach((line) => {
    line = line.trim();
    if (line.startsWith('note,')) {
      console.log(`note: ${line}`);

      // Regular expression to match the note line
      const noteRegex = /^note,(\d+),(\d+[t]?),\[(.+?)\],(\d+),(\d+),(\d+),(\d+),(\d+)$/;
      const match = line.match(noteRegex);

      if (match) {
        const [, index, durationCode, keysString, bar, beat, divisionNum, subDivisionNum, numSubDivisions] = match;
        console.log(`numSubDivisions: ${numSubDivisions} keysString ${keysString}`);
        console.log(
          `note: ${index} ${durationCode} ${keysString} bar ${bar} beat ${beat} div ${divisionNum} sub ${subDivisionNum} of ${numSubDivisions}`
        );

        // // Split the keysString into individual keys
        // const keys = keysString.split(', ').map((key) => key.trim());
        // console.log(`keys: ${keys}`);

        // Create a BeatNote for each key
        // keys.forEach((key) => {
        beatNotes.push({
          index: parseInt(index, 10),
          duration: parseInt(durationCode, 10),
          noteString: keysString,
          barNum: parseInt(bar, 10),
          beatNum: parseInt(beat, 10),
          divisionNum: parseInt(divisionNum, 10),
          subDivisionNum: parseInt(subDivisionNum, 10),
          numSubDivisions: parseInt(numSubDivisions, 10),
          velocity: 127, // Default velocity
        });
        // });
      } else {
        console.warn(`Failed to parse line: ${line}`);
      }
    }
  });

  return { beatNotes, tuples };
};

export const APIRoute = createAPIFileRoute('/api/saveBeat')({
  POST: async ({ request }) => {
    console.log(`/api/saveBeat POST request`);
    try {
      // Parse the JSON body
      const { userId } = await getAuth(request);
      const { name, beatString } = await request.json();
      console.log(`/api/saveBeat POST request: parsed input`);

      if (!userId) {
        throw redirect({
          to: '/sign-in/$',
        });
      }

      console.log(`/api/saveBeat POST request: got user`);

      if (!beatString || typeof beatString !== 'string') {
        return json({ error: 'Invalid beat string' }, { status: 400 });
      }

      await checkUser(request);
      console.log(`/api/saveBeat POST request: checked user`);

      // Parse the beat string into structured data
      const { beatNotes, tuples } = parseBeatString(beatString);
      console.log(`/api/saveBeat POST request: parsed beat string - add to db`);

      // Create the beat and its associated notes in the database
      const beat = await prisma.beat.create({
        data: {
          name: name,
          authorId: userId,
          beatNotes: {
            create: beatNotes,
          },
        },
        include: {
          beatNotes: true, // Include the beatNotes in the response
        },
      });

      console.log(`/api/saveBeat POST request: sent to db - send response`);

      return json({ beat, tuples }, { status: 200 });
    } catch (error) {
      console.error('Error saving beat:', error);
      return json({ error: 'Failed to save beat' }, { status: 500 });
    }
  },
});
