import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Cosmocopia — tiny pixel worlds',
  description: 'Conjoin two planets. Get a third. On Stellar.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
