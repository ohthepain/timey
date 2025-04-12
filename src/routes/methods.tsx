import { MethodsAdminPage } from '~/components/MethodsAdminPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/methods')({
  component: Home,
});

function Home() {
  return <MethodsAdminPage />;
}
