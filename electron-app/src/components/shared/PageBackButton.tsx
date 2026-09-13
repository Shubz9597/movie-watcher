import { ChevronLeft } from 'lucide-react';
import { useRouter } from '../../lib/router-adapter';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';

// The mobile shell already supplies top and bottom Back controls. Standalone
// pages retain this control for desktop and their existing preview surfaces.
export function PageBackButton() {
  const router = useRouter();
  return (
    <button type="button" onClick={router.back} aria-label="Go back" className={`page-back-control inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white/85 ${FOCUS_RING_CLASS}`}>
      <ChevronLeft className="h-6 w-6" strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}
