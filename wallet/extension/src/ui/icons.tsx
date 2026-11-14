// The wallet's icons: 24 × 24 strokes in currentColor, so they take the text
// colour and scale with `size`. Paths from Lucide (lucide.dev, ISC License);
// the bridge, the token marks and the brand mark are drawn here.

import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Svg({ size = 18, children, strokeWidth = 2, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const WalletIcon = (p: IconProps) => <Svg {...p}><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></Svg>;
export const SwapIcon = (p: IconProps) => <Svg {...p}><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></Svg>;
/** An arch bridge: the deck, two piers and the arch between them. */
export const BridgeIcon = (p: IconProps) => <Svg {...p}><path d="M2 8h20" /><path d="M5 8v12" /><path d="M19 8v12" /><path d="M5 20a7 10.5 0 0 1 14 0" /></Svg>;
export const PoolIcon = (p: IconProps) => <Svg {...p}><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" /></Svg>;
export const ActivityIcon = (p: IconProps) => <Svg {...p}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></Svg>;
export const SettingsIcon = (p: IconProps) => <Svg {...p}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const LockIcon = (p: IconProps) => <Svg {...p}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>;
export const ChevronDownIcon = (p: IconProps) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const CopyIcon = (p: IconProps) => <Svg {...p}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Svg>;
export const SendIcon = (p: IconProps) => <Svg {...p}><path d="M7 7h10v10" /><path d="M7 17 17 7" /></Svg>;
export const ReceiveIcon = (p: IconProps) => <Svg {...p}><path d="M17 7 7 17" /><path d="M17 17H7V7" /></Svg>;
export const ArrowDownIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Svg>;
export const ArrowUpIcon = (p: IconProps) => <Svg {...p}><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></Svg>;
export const FlipIcon = (p: IconProps) => <Svg {...p}><path d="m21 16-4 4-4-4" /><path d="M17 20V4" /><path d="m3 8 4-4 4 4" /><path d="M7 4v16" /></Svg>;
export const RefreshIcon = (p: IconProps) => <Svg {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Svg>;
export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
export const MinusIcon = (p: IconProps) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const InfoIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Svg>;
export const AlertIcon = (p: IconProps) => <Svg {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></Svg>;
export const ErrorIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></Svg>;
export const ExternalIcon = (p: IconProps) => <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>;
export const SlidersIcon = (p: IconProps) => <Svg {...p}><path d="M21 4h-7" /><path d="M10 4H3" /><path d="M21 12h-9" /><path d="M8 12H3" /><path d="M21 20h-5" /><path d="M12 20H3" /><path d="M14 2v4" /><path d="M8 10v4" /><path d="M16 18v4" /></Svg>;
export const MergeIcon = (p: IconProps) => <Svg {...p}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></Svg>;
export const ShieldCheckIcon = (p: IconProps) => <Svg {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></Svg>;
export const GlobeIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Svg>;
export const LinkIcon = (p: IconProps) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>;
export const ClockIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>;
export const SunIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></Svg>;
export const MoonIcon = (p: IconProps) => <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>;
export const MonitorIcon = (p: IconProps) => <Svg {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></Svg>;
export const KeyIcon = (p: IconProps) => <Svg {...p}><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" /><path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" /></Svg>;
export const TrashIcon = (p: IconProps) => <Svg {...p}><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></Svg>;
export const ServerIcon = (p: IconProps) => <Svg {...p}><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></Svg>;
export const NetworkIcon = (p: IconProps) => <Svg {...p}><rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" /><path d="M12 12V8" /></Svg>;
export const PencilIcon = (p: IconProps) => <Svg {...p}><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></Svg>;
export const CircleCheckIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Svg>;

/** The wallet's mark: Trestly's ribbon T, as on the site and the toolbar icon. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="116 138 1040 1040" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="trestly-top" x1="140" y1="0" x2="1037" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#14F0C8" /><stop offset=".45" stopColor="#00E5B8" /><stop offset=".72" stopColor="#0B9A84" /><stop offset="1" stopColor="#07594C" />
        </linearGradient>
        <linearGradient id="trestly-front" x1="300" y1="1100" x2="1100" y2="300" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0BE3BC" /><stop offset=".55" stopColor="#00EDC2" /><stop offset=".8" stopColor="#34F5D6" /><stop offset="1" stopColor="#12E6C1" />
        </linearGradient>
        <linearGradient id="trestly-fold" x1="240" y1="400" x2="420" y2="620" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0A7E6B" /><stop offset="1" stopColor="#075A4D" />
        </linearGradient>
        <linearGradient id="trestly-back" x1="740" y1="650" x2="520" y2="1050" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#086B5B" /><stop offset=".55" stopColor="#0AB79A" /><stop offset="1" stopColor="#0BE3BC" />
        </linearGradient>
      </defs>
      <path fill="url(#trestly-fold)" d="M355 335C285 365 226 440 226 530C226 575 250 612 290 626L352 628C375 628 387 620 397 600L439 512C446 498 438 492 424 492L350 492C312 492 288 465 288 430C288 390 318 350 355 335Z" />
      <path fill="url(#trestly-back)" d="M811 670C815 659 808 652 795 652L745 652C700 652 662 680 636 735L540 945C530 968 512 992 488 992L440 1060L470 1132C560 1132 628 1060 665 978Z" />
      <path fill="url(#trestly-top)" d="M385 183L940 183C1000 200 1037 258 1037 320C1037 356 1028 392 1012 420C1004 368 970 328 922 328L385 328C282 335 226 440 226 530C226 572 250 612 290 626C196 606 140 530 140 430C140 292 250 183 385 183Z" />
      <path fill="url(#trestly-front)" d="M940 183C1050 190 1132 290 1132 405C1132 530 1030 630 915 630L625 630C582 630 556 655 537 695L450 890C442 910 440 925 440 945C440 975 462 992 488 992L470 1132C370 1132 295 1050 295 950C295 900 315 860 335 815L406 650C445 552 525 490 620 490L915 490C970 490 1012 462 1012 420C1028 392 1037 356 1037 320C1037 258 1000 200 940 183Z" />
    </svg>
  );
}

export type TokenKind = 'kusdt' | 'kas' | 'usdt';

/** Kaspa's mark, from the Kaspa logo: the teal disc with the K cut out. */
const KASPA_MARK = 'm101.36,51.81c-1.91-4.59-4.9-8.85-8.36-12.3-3.46-3.46-7.88-6.05-12.47-7.96-4.43-1.83-9.35-2.75-14.44-2.75s-10.32.18-14.74,2.02c-4.59,1.9-8.43,5.51-11.89,8.97-3.46,3.45-7.47,7.12-9.37,11.71-1.84,4.43-1.24,9.82-1.24,14.91s.37,10.09,2.21,14.52c1.9,4.58,5.77,7.83,9.23,11.28,3.46,3.46,6.59,7.6,11.18,9.5,4.43,1.84,9.53,3.09,14.62,3.09s10.09-1.51,14.51-3.35c4.59-1.9,8.74-4.87,12.19-8.33,3.46-3.46,6.25-7.68,8.15-12.27,1.84-4.43,3.94-9.35,3.94-14.44s-1.69-10.18-3.52-14.6Zm-24.61,36.3l-8.07-1.2,2.31-15.6-16.89,13-4.96-6.49,14.81-11.41-14.81-11.4,4.96-6.49,16.89,13-2.31-15.6,8.07-1.2,3.2,21.69-3.2,21.7Z';
const KASPA_TEAL = '#6fc7ba';
const KASPA_VIEWBOX = '26 26.8 80 80';
/** Tether's mark: the ₮ on its green disc (viewBox 0 0 32 32). */
const TETHER_GLYPH = 'M17.922 17.383v-.002c-.11.008-.677.042-1.942.042-1.01 0-1.721-.03-1.971-.042v.003c-3.888-.171-6.79-.848-6.790-1.658 0-.809 2.902-1.486 6.790-1.660v2.644c.254.018.982.061 1.988.061 1.207 0 1.812-.050 1.925-.060v-2.643c3.880.173 6.775.850 6.775 1.658 0 .810-2.895 1.485-6.775 1.657m0-3.590v-2.366h5.414V7.819H8.595v3.608h5.414v2.365c-4.400.202-7.709 1.074-7.709 2.118 0 1.044 3.309 1.915 7.709 2.118v7.582h3.913v-7.584c4.393-.202 7.694-1.073 7.694-2.116 0-1.043-3.301-1.914-7.694-2.117';
const TETHER_GREEN = '#26A17B';

/**
 * Token marks, the projects' own: KAS is Kaspa's mark; USDT on an EVM chain is
 * Tether's; kUSDT is Tether's with a small Kaspa badge, so it is never taken
 * for USDT on Ethereum or BNB Chain.
 */
export function TokenMark({ kind, size = 36 }: { kind: TokenKind; size?: number }) {
  if (kind === 'kas') {
    return (
      <svg width={size} height={size} viewBox={KASPA_VIEWBOX} aria-hidden="true" focusable="false" className="shrink-0" data-mark="kaspa">
        <path fill={KASPA_TEAL} fillRule="evenodd" d={KASPA_MARK} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="shrink-0" data-mark={kind === 'kusdt' ? 'kusdt' : 'tether'}>
      <circle cx="16" cy="16" r="16" fill={TETHER_GREEN} />
      <path fill="#fff" d={TETHER_GLYPH} />
      {kind === 'kusdt' && (
        <>
          <circle cx="26" cy="26" r="6.6" fill="var(--color-ink-900)" />
          <svg x="20.4" y="20.4" width="11.2" height="11.2" viewBox={KASPA_VIEWBOX}>
            <path fill={KASPA_TEAL} fillRule="evenodd" d={KASPA_MARK} />
          </svg>
        </>
      )}
    </svg>
  );
}
