-- Reference data required for the app to function in any environment
-- (not sample/demo data — that lives in supabase/seed.sql).

insert into public.unit_statuses (code, label, color, icon, sort_order, is_terminal) values
  ('scheduled_for_arrival', 'Scheduled for Arrival', 'slate',  'calendar-clock', 10,  false),
  ('arrived',               'Arrived',               'blue',   'anchor',         20,  false),
  ('needs_intake',          'Needs Intake',          'amber',  'clipboard-list', 30,  false),
  ('needs_location',        'Needs Location',        'amber',  'map-pin-off',    40,  false),
  ('stored',                'Stored',                'green',  'warehouse',      50,  false),
  ('needs_service',         'Needs Service',         'orange', 'wrench',         60,  false),
  ('service_in_progress',   'Service In Progress',   'orange', 'loader',         70,  false),
  ('service_complete',      'Service Complete',      'teal',   'check-circle',   80,  false),
  ('needs_detailing',       'Needs Detailing',       'orange', 'sparkles',       90,  false),
  ('detailing_complete',    'Detailing Complete',    'teal',   'sparkle',        100, false),
  ('needs_spring_prep',     'Needs Spring Prep',     'orange', 'sun',            110, false),
  ('ready_for_pickup',      'Ready for Pickup',      'purple', 'package-check',  120, false),
  ('pickup_scheduled',      'Pickup Scheduled',      'purple', 'calendar-check', 130, false),
  ('removed_from_storage',  'Removed From Storage',  'gray',   'log-out',        140, true);

insert into public.service_types (name, category) values
  ('Winterization', 'seasonal'),
  ('Summarization', 'seasonal'),
  ('Oil Change', 'mechanical'),
  ('Gear Lube', 'mechanical'),
  ('Battery Service', 'mechanical'),
  ('Battery Charging', 'mechanical'),
  ('Detailing', 'cosmetic'),
  ('Shrink Wrap', 'cosmetic'),
  ('Propeller Repair', 'mechanical'),
  ('Engine Repair', 'mechanical'),
  ('Trailer Service', 'mechanical'),
  ('Electronics Installation', 'mechanical'),
  ('Other', 'other');
