// Adapter for next/link to work in Electron
import { ReactNode, MouseEvent } from 'react';
import { useRouter } from './router-adapter';

type LinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
};

export default function Link({ href, children, className, onClick }: LinkProps) {
  const router = useRouter();
  
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (onClick) onClick(e);
    // Parse href like "/title/movie/123" or "/watch?magnet=..."
    let path = href;
    if (path.startsWith('/')) path = path.slice(1);
    const [route, query] = path.split('?');
    const params = query ? Object.fromEntries(new URLSearchParams(query)) : {};
    router.push(route, params);
  };

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}



