import { render, screen } from '@testing-library/react';
import { ModuleList } from '~/components/ModuleList';
import { test, expect } from 'vitest';

test('renders ModuleList', () => {
  render(<ModuleList method={} />);
  expect(screen.getByText(/modules/i)).toBeInTheDocument();
});
