export function AuthFeedback({ failure }: { failure: string }) {
  if (!failure) return null;
  return (
    <p role="alert" className="text-red-700 dark:text-red-400">
      {failure}
    </p>
  );
}
