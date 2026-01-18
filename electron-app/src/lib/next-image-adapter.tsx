// Adapter for next/image to work in Electron
import { ImgHTMLAttributes } from 'react';

type ImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string | null | undefined;
  alt: string;
  fill?: boolean;
  sizes?: string;
  priority?: boolean;
  width?: number;
  height?: number;
};

export default function Image({ src, alt, fill, className, ...props }: ImageProps) {
  if (!src) {
    return <div className={className} style={{ backgroundColor: '#1e293b' }} />;
  }

  const imgProps: ImgHTMLAttributes<HTMLImageElement> = {
    src: src.startsWith('http') ? src : `https://image.tmdb.org/t/p/w342${src}`,
    alt,
    className,
    ...props,
  };

  if (fill) {
    return (
      <img
        {...imgProps}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          ...props.style,
        }}
      />
    );
  }

  return <img {...imgProps} />;
}



