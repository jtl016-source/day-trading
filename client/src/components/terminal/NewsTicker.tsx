// NewsTicker.tsx — horizontal scrolling marquee of real market headlines from /api/news/ticker.
// Titles are clickable (open the article in a new tab). Hover to pause. Refreshes every 5 min.
import { useEffect, useState } from "react";

interface TickerArticle { title: string; url: string; source: string | null; publishedAt: string; }

export function NewsTicker() {
  const [items, setItems] = useState<TickerArticle[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/news/ticker?limit=40")
        .then((r) => r.json())
        .then((d) => { if (alive && Array.isArray(d?.articles)) setItems(d.articles); })
        .catch(() => { /* keep last items on error */ });
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!items.length) return null;
  // Duplicate the list so the -50% keyframe loops seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="tt-ticker">
      <span className="tt-ticker-label">● LIVE NEWS</span>
      <div className="tt-ticker-mask">
        <div className="tt-ticker-track">
          {loop.map((a, i) => (
            <a key={i} className="tt-ticker-item" href={a.url} target="_blank" rel="noopener noreferrer">
              {a.source && <span className="tt-ticker-src">{a.source}</span>}
              <span className="tt-ticker-title">{a.title}</span>
              <span className="tt-ticker-sep">◆</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
