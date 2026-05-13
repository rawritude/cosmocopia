import type { ReactNode } from 'react';
import TopNav from '../components/TopNav';
import './globals.css';

export const metadata = {
  title: 'Cosmocopia — tiny pixel worlds',
  description: 'Conjoin two planets. Get a third. On Stellar.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Preconnect to Google Fonts so the JetBrains Mono + Space Grotesk + VT323
            triple loads on the first paint. globals.css does the actual @import. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
