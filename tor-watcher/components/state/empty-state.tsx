export default function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: string;
}) {
  return (
    <div className="grid place-items-center rounded-2xl border border-slate-800 bg-[#0F141A] p-10 text-center">
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      {action && <p className="mt-3 text-xs text-slate-500">{action}</p>}
    </div>
  );
}