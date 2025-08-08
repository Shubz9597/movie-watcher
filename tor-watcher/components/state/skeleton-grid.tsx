import { Skeleton } from "@/components/ui/skeleton";

export default function SkeletonGrid({ count = 18 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-[2/3] w-full rounded-2xl" />
          <div className="flex items-center justify-between px-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}