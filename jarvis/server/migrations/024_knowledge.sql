-- Knowledge graph, exclusions and decision log (Master expansion, Phase 5)
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person','business','agent','project','goal','decision','file','topic','place','source','mission')),
  name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','business','public')),
  confidence REAL NOT NULL DEFAULT 0.9,
  origin TEXT NOT NULL DEFAULT 'luke' CHECK (origin IN ('luke','derived','prometheus','chat')),
  source_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX entities_kind_name ON entities(kind, lower(name));
CREATE UNIQUE INDEX entities_source_ref ON entities(source_ref) WHERE source_ref IS NOT NULL;
CREATE TABLE edges (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('works_with','owns','part_of','related_to','decided_by','affects','depends_on','mentions','supports','contradicts','cites','about')),
  note TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.9,
  origin TEXT NOT NULL DEFAULT 'luke' CHECK (origin IN ('luke','derived','prometheus','chat')),
  created_at INTEGER NOT NULL, UNIQUE (from_id, to_id, rel), CHECK (from_id <> to_id)
);
CREATE INDEX edges_to ON edges(to_id);
CREATE TABLE entity_links (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('memory','task','project','artifact','research','person','goal','mission','decision')),
  ref_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'derived', created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, kind, ref_id)
);
CREATE INDEX entity_links_ref ON entity_links(kind, ref_id);
CREATE TABLE exclusions (id TEXT PRIMARY KEY, pattern TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]', assumptions TEXT NOT NULL DEFAULT '[]', scenarios TEXT NOT NULL DEFAULT '[]',
  chosen TEXT NOT NULL DEFAULT '', rationale TEXT NOT NULL DEFAULT '', expected_outcome TEXT NOT NULL DEFAULT '', expected_by TEXT,
  confidence INTEGER, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided','reviewed','dropped')),
  outcome TEXT NOT NULL DEFAULT '', outcome_rating TEXT CHECK (outcome_rating IN ('better','as_expected','worse')),
  challenge TEXT, entity_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, reviewed_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX decisions_status ON decisions(status, expected_by);
