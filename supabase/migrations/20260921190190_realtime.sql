-- Enable Realtime so the facility map, dashboard, and unassigned queue stay
-- live across simultaneously logged-in employees without a manual refresh.
-- The client subscribes to change events on these tables (see
-- components/realtime/realtime-refresher.tsx) and calls router.refresh().
alter publication supabase_realtime add table
  public.units,
  public.location_assignments,
  public.location_history,
  public.storage_locations,
  public.unit_services,
  public.pickups,
  public.notes,
  public.photos,
  public.activity_logs;
