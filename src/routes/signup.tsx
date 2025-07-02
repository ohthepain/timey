import { createFileRoute } from '@tanstack/react-router';
import { RegisterForm } from '~/components/auth/RegisterForm';

export const Route = createFileRoute('/signup')({
  component: SignupPage,
});

function SignupPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <RegisterForm />
    </div>
  );
}
