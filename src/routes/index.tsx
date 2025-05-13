import { createFileRoute, Link } from '@tanstack/react-router';
import { Speedometer } from '~/components/Speedometer';
import { useState, useEffect } from 'react';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const [value, setValue] = useState(100);
  const [time, setTime] = useState(0);
  const [amplitude, setAmplitude] = useState(20);

  useEffect(() => {
    const interval = setInterval(() => {
      setTime((prev) => prev + 0.1);
      setAmplitude((prev) => Math.max(0.1, prev * 0.99));
    }, 50);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const noise = (Math.random() - 0.5) * amplitude * 0.7;
    setValue(120 + Math.sin(time) * amplitude + noise);
  }, [time, amplitude]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero Section */}
      <div className="relative bg-gradient-to-br from-orange-500 to-purple-900 rounded-3xl m-16">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32 lg:flex lg:items-center lg:gap-x-10 lg:px-8">
          <div className="mx-auto max-w-2xl lg:mx-0 lg:flex-auto">
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-6xl">themethod.live</h1>
            <p className="mt-6 text-2xl leading-8 text-white">Your intelligent time management assistant</p>
            <div className="mt-10 flex items-center gap-x-6">
              <Link
                to="/methods"
                className="rounded-md bg-indigo-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              >
                Get Started
              </Link>
              <a href="#" className="text-sm font-semibold leading-6 text-white">
                Learn more <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
          <div className="bg-white rounded-xl p-2 mt-16 flex items-center justify-center lg:mt-0 lg:ml-10 lg:w-full lg:max-w-lg lg:flex-none xl:ml-32">
            <div className="w-full flex-none rounded-xl bg-gray-100">
              <Speedometer min={100} max={140} value={value} />
            </div>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
            Everything you need to manage your beats
          </h2>
          <ul className="mt-4 text-left list-disc pl-5 text-lg">
            <li className="leading-8 text-gray-600">e-drums plugged into MIDI</li>
            <li className="leading-8 text-gray-600">a browser that supports WebMIDI (Chrome, Opera, Firefox soon!)</li>
            <li className="leading-8 text-gray-600">Time to relax and groove</li>
          </ul>
        </div>
        <div className="mx-auto mt-16 max-w-2xl sm:mt-20 lg:mt-24 lg:max-w-none">
          <dl className="grid max-w-xl grid-cols-1 gap-x-8 gap-y-16 lg:max-w-none lg:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-base font-semibold leading-7 text-gray-900">Popular Exercises</dt>
              <dd className="mt-2 flex flex-auto flex-col text-base leading-7 text-gray-600">
                <p className="flex-auto">Exercises from the best drum books, based on public-doman beats.</p>
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-base font-semibold leading-7 text-gray-900">Meter Meter</dt>
              <dd className="mt-2 flex flex-auto flex-col text-base leading-7 text-gray-600">
                <p className="flex-auto">Grade your ability to stay on beat. It's metronome on steroids.</p>
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-base font-semibold leading-7 text-gray-900">Keep Progressing</dt>
              <dd className="mt-2 flex flex-auto flex-col text-base leading-7 text-gray-600">
                <p className="flex-auto">Start slow or just get moving! A lifetime of practice is waiting.</p>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
