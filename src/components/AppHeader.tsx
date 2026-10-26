import { Link } from '@tanstack/react-router';
import { LoginButton } from '~/components/auth/LoginButton';
import { UserMenu } from '~/components/auth/UserMenu';
import { usePersistedStore } from '~/state/PersistedStore';
import { useNavigationStore } from '~/state/NavigationStore';

type AppHeaderProps = {
  onOpenMetronome: () => void;
  onOpenMidi: () => void;
};

function toggleButtonClass(active: boolean, activeColor: string) {
  const color = active ? activeColor : 'gray';
  return `text-${color}-700 px-2 py-1 rounded hover:bg-${color}-200 border-${color}-600 border-2 rounded-e-md text-sm`;
}

export function AppHeader({ onOpenMetronome, onOpenMidi }: AppHeaderProps) {
  const { enableAdmin, setAdmin, devMode, setDevMode, midiSlave, setMidiSlave } = usePersistedStore();
  const { isUsingExternalMidiClock } = useNavigationStore();

  return (
    <div className="p-2 flex justify-between items-center text-lg">
      <div className="flex gap-6 items-center ml-8">
        <Link to="/" activeProps={{ className: 'font-bold' }} activeOptions={{ exact: true }}>
          Home
        </Link>
        <Link to="/methods" activeProps={{ className: 'font-bold' }}>
          Methods
        </Link>
        <Link to="/sequence" activeProps={{ className: 'font-bold' }}>
          Sequence
        </Link>
        <Link to="/users" activeProps={{ className: 'font-bold' }}>
          Users
        </Link>
      </div>
      <div className="flex gap-2 items-center">
        <button className={toggleButtonClass(devMode, 'orange')} onClick={() => setDevMode(!devMode)} title="Toggle Dev Mode">
          Dev
        </button>
        <button
          className={toggleButtonClass(enableAdmin, 'blue')}
          onClick={() => setAdmin(!enableAdmin)}
          title="Toggle Admin Mode"
        >
          Admin
        </button>
        <button
          className={`${toggleButtonClass(midiSlave, 'red')} border-${midiSlave ? 'blue' : 'gray'}-600`}
          onClick={() => setMidiSlave(!midiSlave)}
          title="Toggle MIDI Slave Mode"
        >
          {midiSlave ? 'Slave' : 'INT'}
        </button>
        <button
          className="text-amber-800 px-2 py-1 rounded hover:bg-amber-200 border-amber-700 border-2 rounded-e-md text-sm"
          onClick={onOpenMetronome}
          title="Metronome Settings"
        >
          Metronome
        </button>
        <div className={`text-${isUsingExternalMidiClock ? 'red' : 'green'}-600`}>EXT</div>
        <button
          className="text-green-700 px-2 py-1 rounded hover:bg-green-200 border-green-600 border-2 rounded-e-md text-sm"
          onClick={onOpenMidi}
          title="MIDI Settings"
        >
          MIDI
        </button>
        <LoginButton />
        <UserMenu />
      </div>
    </div>
  );
}
