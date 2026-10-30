import { useEffect, useState } from 'react';
import { Beat } from '~/types/Beat';
import { useNavigationStore } from '~/state/NavigationStore';
import { getAllModulesServerFn } from '~/services/moduleService.server';
import { copyBeatServerFn } from '~/services/beatService.server';

export function CopyBeat({ beat }: { beat: Beat }) {
  const userId = useNavigationStore((state) => state.practiceUserId);
  if (!userId)
    return (
      <a
        className="text-indigo-600 underline"
        href={`/auth/login?returnTo=${encodeURIComponent('/module/' + beat.moduleId)}`}
      >
        Sign in to copy
      </a>
    );
  return <CopyDestination key={`${userId}:${beat.id}`} beat={beat} userId={userId} />;
}

function CopyDestination({ beat, userId }: { beat: Beat; userId: string }) {
  const [open, setOpen] = useState(false);
  const [modules, setModules] = useState<{ id: string; title: string }[] | null>(null);
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    getAllModulesServerFn()
      .then((rows) => {
        if (active) setModules(rows.filter((row) => row.authorId === userId));
      })
      .catch(() => {
        if (active) setError('Unable to load destinations. Retry.');
      });
    return () => {
      active = false;
    };
  }, [open, userId, reload]);
  async function copy() {
    setBusy(true);
    setError('');
    try {
      const result = await copyBeatServerFn({ data: { id: beat.id!, moduleId: destination } });
      if (result && useNavigationStore.getState().practiceUserId === userId) setCreated(result.moduleId);
    } catch {
      setError('Unable to copy. Sign in and select a module you own, then retry.');
    } finally {
      setBusy(false);
    }
  }
  const state = { modules, destination, setDestination, busy, copy, created };
  return (
    <div className="px-2">
      <button className="text-green-700 px-2 border-2 rounded text-sm" onClick={() => setOpen(!open)}>
        Copy
      </button>
      {open && (
        <div className="bg-white border rounded p-4 space-y-2" aria-label="Copy beat">
          {error && <p role="alert">{error}</p>}
          <DestinationChoices {...state} />
          <button
            className="text-indigo-600 underline block"
            onClick={() => {
              setError('');
              setDestination('');
              setReload((value) => value + 1);
            }}
          >
            Refresh destinations
          </button>
        </div>
      )}
    </div>
  );
}

interface DestinationProps {
  modules: { id: string; title: string }[] | null;
  destination: string;
  setDestination: (value: string) => void;
  busy: boolean;
  copy: () => Promise<void>;
  created: string | null;
}
function DestinationChoices({ modules, destination, setDestination, busy, copy, created }: DestinationProps) {
  if (created)
    return (
      <a className="text-indigo-600 underline" href={`/module/${created}`}>
        View copied beat
      </a>
    );
  if (modules === null) return <p>Loading destinations…</p>;
  if (!modules.length)
    return (
      <p>
        You need a module of your own.{' '}
        <a className="text-indigo-600 underline" href="/methods">
          Create a method, then add a module
        </a>
        , and return here to copy.
      </p>
    );
  return (
    <OwnedDestination
      modules={modules}
      destination={destination}
      setDestination={setDestination}
      busy={busy}
      copy={copy}
    />
  );
}

function OwnedDestination({
  modules,
  destination,
  setDestination,
  busy,
  copy,
}: Omit<DestinationProps, 'created' | 'modules'> & { modules: { id: string; title: string }[] }) {
  return (
    <>
      <label>
        Destination module{' '}
        <select
          aria-label="Destination module"
          className="border rounded p-2"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        >
          <option value="">Select your module</option>
          {modules.map((module) => (
            <option key={module.id} value={module.id}>
              {module.title}
            </option>
          ))}
        </select>
      </label>
      <button
        className="bg-green-500 text-white px-4 py-2 rounded disabled:opacity-50"
        disabled={!destination || busy}
        onClick={copy}
      >
        Copy beat
      </button>
    </>
  );
}
