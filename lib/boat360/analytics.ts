// Analytics events for the 360° viewer.
//
// The viewer calls `track()`; this module fans the event out to whatever is
// on the page, without the viewer depending on any vendor SDK:
//   - window.dataLayer (Google Tag Manager / GA4)
//   - a DOM CustomEvent "boat360:analytics" (for any other listener)
//   - console.debug in development
//
// Every event carries boatId so 360 engagement can later be joined to leads
// and sales to answer "do customers who spin the boat convert better?".

export type Boat360EventName =
  | "360_view_opened"
  | "360_rotated"
  | "hotspot_clicked"
  | "engine_viewed"
  | "interior_viewed"
  | "trailer_viewed"
  | "gallery_image_viewed"
  | "video_played"
  | "condition_issue_viewed"
  | "zoom_used"
  | "fullscreen_entered"
  | "financing_clicked"
  | "trade_clicked"
  | "contact_clicked"
  | "details_clicked";

export type Boat360EventProps = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

export function track(event: Boat360EventName, boatId: string, props: Boat360EventProps = {}) {
  if (typeof window === "undefined") return;
  const payload = { event, boat_id: boatId, ...props, ts: Date.now() };
  window.dataLayer?.push(payload);
  window.dispatchEvent(new CustomEvent("boat360:analytics", { detail: payload }));
  if (process.env.NODE_ENV !== "production") console.debug("[boat360]", event, payload);
}
