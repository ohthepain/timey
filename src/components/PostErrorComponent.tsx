import React from 'react';

interface PostErrorComponentProps {
  error: string;
}

export const PostErrorComponent: React.FC<PostErrorComponentProps> = ({ error }) => {
  return (
    <div className="post-error bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
      <strong className="font-bold">Error:</strong>
      <span className="block sm:inline"> {error}</span>
    </div>
  );
};
