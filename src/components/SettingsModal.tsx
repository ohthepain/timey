import { useEffect, useId, type ReactNode } from 'react';

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  overlayClassName?: string;
  panelClassName?: string;
};

export function SettingsModal({
  open,
  onClose,
  title,
  children,
  overlayClassName = 'fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50',
  panelClassName = 'bg-white rounded shadow-lg p-6 min-w-[320px] relative',
}: SettingsModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previouslyFocused?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={overlayClassName}
      onClick={onClose}
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      role="dialog"
    >
      <div className={panelClassName} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="absolute top-2 right-2 text-gray-500 hover:text-gray-700 text-xl"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        {title && (
          <h2 id={titleId} className="text-lg font-bold mb-4">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>
  );
}
