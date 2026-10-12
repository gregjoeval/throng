// The arena scenario's browser: Playwright's Chromium on throng-web, signed in as the e2e user.
//
// throng-web forwards `/api/*` to the platform only for an Access session, and the e2e user has
// none. So the page's own `/api/*` requests are sent from here to the platform's public hostname
// with the e2e user's Throng token instead, which every route the task page calls accepts. The UI
// and its code run as deployed; only the Access hop (`apps/web/src/server/forward.ts`, unit-tested
// there) is left out.

import { chromium } from "playwright";
import type { Page } from "playwright";

/** The page's request headers the platform reads; everything else stays behind. */
const FORWARDED_HEADERS = ["accept", "content-type"];

/** A browser page on throng-web whose API calls reach the platform as the token's user. */
export interface BrowserSession {
  page: Page;
  /** Every API request the page made, as `path?query`, in order. */
  apiRequests: string[];
  close: () => Promise<void>;
}

/** Where a page's `/api/*` request goes on the platform at `platform`: the same path and query. */
export function platformUrl(pageUrl: string, platform: string): string {
  const { pathname, search } = new URL(pageUrl);
  return `${platform}${pathname}${search}`;
}

/** Opens a page on `web` whose `/api/*` calls go to `platform` with `token`. */
export async function openBrowser({
  web,
  platform,
  token,
}: {
  web: string;
  platform: string;
  token: string;
}): Promise<BrowserSession> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const apiRequests: string[] = [];
  const { origin } = new URL(web);
  const isApi = (url: URL) => url.origin === origin && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
  await page.route(isApi, async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    apiRequests.push(`${pathname}${search}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const name of FORWARDED_HEADERS) {
      const value = await request.headerValue(name);
      if (value !== null) headers[name] = value;
    }
    const response = await route.fetch({ url: platformUrl(request.url(), platform), headers });
    await route.fulfill({ response });
  });
  return { page, apiRequests, close: () => browser.close() };
}
