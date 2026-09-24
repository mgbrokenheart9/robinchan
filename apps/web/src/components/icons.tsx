import {
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Bot,
  Briefcase,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Flame,
  Home,
  Image as ImageGlyph,
  KeyRound,
  LayoutGrid,
  LineChart,
  Lock,
  Menu,
  MessageSquareText,
  Play,
  Moon,
  RotateCw,
  SendHorizontal,
  Smile,
  Sparkles,
  Star,
  Sun,
  Volume2,
  VolumeX,
  Wallet,
  X,
  type LucideProps,
} from 'lucide-react';

/**
 * Icon set backed by lucide-react, re-exported under names that describe how
 * each one is used in this app. Each wrapper carries the default size that
 * fit the slot it was designed for — call sites can still override `size`,
 * `width`, `height`, or `className` as usual.
 */

function wrap(Icon: typeof Home, defaultSize: number, defaultStrokeWidth = 1.75) {
  function Wrapped(props: LucideProps) {
    return <Icon size={defaultSize} strokeWidth={defaultStrokeWidth} aria-hidden {...props} />;
  }
  Wrapped.displayName = `Icon(${Icon.displayName ?? Icon.name})`;
  return Wrapped;
}

export const HomeIcon = wrap(Home, 18);
/** Robinchan nav icon and chat avatar glyph — stands in for the character. */
export const PodIcon = wrap(Bot, 18);
export const MarketIcon = wrap(LineChart, 18);
export const TradeIcon = wrap(ArrowLeftRight, 18);
export const HeatIcon = wrap(Flame, 18);
export const PortfolioIcon = wrap(Briefcase, 18);
export const MenuIcon = wrap(Menu, 20);
export const CloseIcon = wrap(X, 20);
export const ArrowRightIcon = wrap(ArrowRight, 16);
export const LockIcon = wrap(Lock, 14);
export const WaveformIcon = wrap(AudioLines, 16);
export const ExternalIcon = wrap(ExternalLink, 14);

// Light / dark theme switch.
export const SunIcon = wrap(Sun, 18);
export const MoonIcon = wrap(Moon, 18);
/** Placeholder on a video clip that has no thumbnail yet. */
export const PlayIcon = wrap(Play, 18);

// Floating chrome on the full-screen `/robinchan` chat.
export const SmileIcon = wrap(Smile, 16);
export const BackgroundIcon = wrap(ImageGlyph, 16);
export const TiersIcon = wrap(Sparkles, 16);
export const VoiceOnIcon = wrap(Volume2, 20);
export const VoiceOffIcon = wrap(VolumeX, 20);
export const SendIcon = wrap(SendHorizontal, 20);

// Dashboard pages: Heat, Portfolio, Trade, and the wallet control.
export const WalletIcon = wrap(Wallet, 16);
export const RefreshIcon = wrap(RotateCw, 14);
export const StarIcon = wrap(Star, 16);
export const ChevronDownIcon = wrap(ChevronDown, 16);
export const ChevronLeftIcon = wrap(ChevronLeft, 16);
export const ChevronRightIcon = wrap(ChevronRight, 16);
export const CheckIcon = wrap(Check, 14);
export const CopyIcon = wrap(Copy, 14);

// Home feature-card glyphs (design.md §10) — not used in the dashboard.
export const GridIcon = wrap(LayoutGrid, 20);
export const ChatIcon = wrap(MessageSquareText, 20);
export const KeyIcon = wrap(KeyRound, 20);
