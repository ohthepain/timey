import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { SettingsModal } from './SettingsModal';

afterEach(cleanup);

describe('SettingsModal dismissal', () => {
  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open settings
        </button>
        <SettingsModal open={open} onClose={() => setOpen(false)} title="Settings">
          <button type="button">Inside</button>
        </SettingsModal>
      </>
    );
  }

  it('keeps inside clicks open and closes from the backdrop, restoring focus', () => {
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('dialog', { name: 'Settings' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes from the top-right button without submitting its contents', () => {
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open settings' })).toHaveFocus();
  });
});
