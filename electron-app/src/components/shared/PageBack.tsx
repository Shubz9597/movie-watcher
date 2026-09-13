// PageBack (M1.4 UI pass): the in-page back affordance — "‹ Label" row at the
// top of page content. With the shell's chevrons removed, pages own their
// back affordance; this is the single shared implementation of that pattern.
import { ArrowLeft } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';

export function PageBack(props: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onBack}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-white/75 transition hover:text-white ${FOCUS_RING_CLASS}`}
    >
      <ArrowLeft className="h-4.5 w-4.5" strokeWidth={1.7} aria-hidden="true" />
      <span>{props.label}</span>
    </button>
  );
}
