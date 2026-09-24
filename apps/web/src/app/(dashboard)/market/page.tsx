import type { Metadata } from 'next';
import type {
  CalendarEvent,
  MarketIndex,
  MediaChannel,
  MediaClip,
  NewsItem,
  SourceStatus,
} from '@robinchan/shared';

import { IndexStrip } from '@/components/market/IndexStrip';
import { LiveVideo } from '@/components/market/LiveVideo';
import { NewsFeed } from '@/components/market/NewsFeed';
import { Catalysts, Highlights, SourcePanel } from '@/components/market/Rail';
import { Tape } from '@/components/market/Tape';
import { PageHeader } from '@/components/ui';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Market',
  description: 'Index, news, filings, and live broadcasts for tokenized stocks.',
};

export const revalidate = 15;

/**
 * Market (brief §6): the most data-dense page. Every news slot in the
 * artboard is deliberately empty — it's filled from the API, each block at
 * its own polling interval.
 */
export default async function MarketPage() {
  const [indices, news, pinned, channels, clips, calendar, sources] = await Promise.all([
    getEnvelope<MarketIndex[]>('/api/market/indices', []),
    getEnvelope<NewsItem[]>('/api/news?limit=20', []),
    getEnvelope<NewsItem[]>('/api/news?limit=12&pinned=true', []),
    getEnvelope<MediaChannel[]>('/api/media/channels', []),
    getEnvelope<MediaClip[]>('/api/media/clips', []),
    getEnvelope<CalendarEvent[]>('/api/calendar?limit=5', []),
    getEnvelope<SourceStatus[]>('/api/sources/status', []),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Market"
        title="What's moving right now"
        lead="Index prices, SEC filings, news, and live broadcasts on one screen. Numbers that haven't refreshed in time still render, marked stale, never hidden."
      />

      <div className="space-y-4">
        <IndexStrip initial={indices} />
        <Tape initial={pinned} />

        <div className="grid-market">
          <div className="min-w-0 space-y-4">
            <LiveVideo initial={channels} />
            <NewsFeed initial={news} />
          </div>

          <aside className="space-y-4">
            <Highlights initial={clips} />
            <Catalysts initial={calendar} />
            <SourcePanel initial={sources} />
          </aside>
        </div>
      </div>
    </>
  );
}
