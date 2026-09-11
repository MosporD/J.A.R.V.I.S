-- The content state machine.
--
-- One idea becomes one piece; one piece fans out into many variants — that
-- asymmetry is the whole design. Generating fifteen independent posts a day
-- collapses into slop; deriving fifteen cuts from one piece of real thinking
-- does not. The schema enforces it: a variant cannot exist without a parent.
--
-- Every stage transition is an explicit status change, so a stalled item says
-- exactly which stage dropped it and can be restarted from there rather than
-- regenerated from scratch.

create extension if not exists "pgcrypto";

-- --- Enumerations -----------------------------------------------------------

-- Ideas are cheap and mostly discarded, so their lifecycle is short.
create type idea_status as enum ('new', 'approved', 'rejected', 'consumed');

-- Pieces and variants walk the same ladder. `approved` is the human gate and
-- the only transition the pipeline may never perform on its own.
create type content_status as enum (
  'draft',         -- script generated, awaiting review
  'approved',      -- a human said yes
  'rendering',     -- claimed by the asset builder
  'ready',         -- assets built, eligible for a posting slot
  'queued',        -- assigned to a slot, waiting for its time
  'publishing',    -- claimed by the publisher, mid-flight
  'published',
  'failed',        -- a stage errored; last_error explains
  'rejected'       -- a human said no
);

create type asset_kind as enum ('audio', 'image', 'video', 'caption', 'thumbnail');

-- --- Ideas ------------------------------------------------------------------

create table ideas (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,              -- 'rss', 'reddit', 'manual', …
  source_ref    text,                       -- permalink or feed item id
  title         text not null,
  summary       text,
  topic         text,                       -- the lane this belongs to
  -- Dedupe key. Harvesters run daily against overlapping feeds, so the same
  -- story arrives repeatedly under different titles; the unique index on this
  -- is what stops the channel republishing itself.
  fingerprint   text not null unique,
  score         numeric(5,2) default 0,     -- ranking, fed by past performance
  status        idea_status not null default 'new',
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index ideas_status_score_idx on ideas (status, score desc);

-- --- Pieces: the unit of real thinking --------------------------------------

create table pieces (
  id            uuid primary key default gen_random_uuid(),
  idea_id       uuid references ideas (id) on delete set null,
  title         text not null,
  -- The master script. Every variant is cut from this, which is what keeps a
  -- day's output saying one coherent thing across five platforms.
  script        text,
  hook          text,                       -- opening line, reused by cuts
  topic         text,
  status        content_status not null default 'draft',
  llm_provider  text,                       -- which model wrote it, for audit
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index pieces_status_idx on pieces (status, created_at);

-- --- Variants: one row per platform × format --------------------------------

create table variants (
  id            uuid primary key default gen_random_uuid(),
  piece_id      uuid not null references pieces (id) on delete cascade,
  platform      text not null,              -- youtube | tiktok | instagram | …
  format        text not null,              -- short | long | text | carousel
  -- Aspect is a property of the cut, not the platform: a 9:16 short goes to
  -- three different platforms unchanged.
  width         int not null default 1080,
  height        int not null default 1920,
  script        text,                       -- narration for this cut
  caption       text,                       -- post body
  hashtags      text[] not null default '{}',
  status        content_status not null default 'draft',
  -- Set when the publisher claims it for a slot. Kept separate from
  -- published_at so a missed slot is visible rather than silently overwritten.
  scheduled_at  timestamptz,
  render_spec   jsonb,                      -- what the render worker was given
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One cut per platform per format per piece. Re-running a stage updates the
  -- row instead of duplicating the post.
  unique (piece_id, platform, format)
);

create index variants_status_idx on variants (status, scheduled_at);
create index variants_ready_idx on variants (platform, status) where status = 'ready';

-- --- Assets: the files a variant is made of ---------------------------------

create table assets (
  id            uuid primary key default gen_random_uuid(),
  variant_id    uuid not null references variants (id) on delete cascade,
  kind          asset_kind not null,
  -- Storage key, not a URL: the bucket may be MinIO today and S3 tomorrow, and
  -- signed URLs expire. The storage provider resolves this to something
  -- fetchable at the moment it is needed.
  storage_key   text not null,
  duration_ms   int,
  bytes         bigint,
  provider      text,                       -- which generator produced it
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index assets_variant_idx on assets (variant_id, kind);

-- --- Publications: proof a variant actually shipped -------------------------

create table publications (
  id            uuid primary key default gen_random_uuid(),
  variant_id    uuid not null references variants (id) on delete cascade,
  platform      text not null,
  -- Platform's own id for the post. Null while a scheduled post is pending on
  -- the publishing provider's side.
  external_id   text,
  url           text,
  provider      text not null,              -- postiz | ayrshare | direct | dry_run
  published_at  timestamptz,
  response      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  unique (variant_id, platform)
);

-- --- Metrics: the loop that closes ------------------------------------------

-- Append-only snapshots rather than mutable counters, so growth curves survive
-- and idea scoring can learn from shape, not just final totals.
create table metrics (
  id              bigserial primary key,
  publication_id  uuid not null references publications (id) on delete cascade,
  captured_at     timestamptz not null default now(),
  views           bigint,
  likes           bigint,
  comments        bigint,
  shares          bigint,
  watch_seconds   bigint,
  raw             jsonb not null default '{}'::jsonb
);

create index metrics_publication_idx on metrics (publication_id, captured_at desc);

-- --- Runs: why a stage failed at 03:00 --------------------------------------

create table runs (
  id            bigserial primary key,
  workflow      text not null,              -- harvest | script | assets | publish | metrics
  subject_type  text,                       -- 'idea' | 'piece' | 'variant'
  subject_id    uuid,
  status        text not null,              -- started | ok | error
  provider      text,
  detail        jsonb not null default '{}'::jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index runs_workflow_idx on runs (workflow, started_at desc);

-- --- updated_at maintenance -------------------------------------------------

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger ideas_touch    before update on ideas    for each row execute function touch_updated_at();
create trigger pieces_touch   before update on pieces   for each row execute function touch_updated_at();
create trigger variants_touch before update on variants for each row execute function touch_updated_at();

-- --- Review view ------------------------------------------------------------

-- What the human gate looks at each morning. NocoDB points at this rather than
-- the raw tables so the daily review is one screen, not a join by hand.
create or replace view review_queue as
select
  p.id           as piece_id,
  p.title,
  p.topic,
  p.hook,
  p.script,
  p.status,
  p.created_at,
  i.source,
  i.source_ref,
  count(v.id)               as variant_count,
  array_agg(distinct v.platform) filter (where v.id is not null) as platforms
from pieces p
left join ideas i    on i.id = p.idea_id
left join variants v on v.piece_id = p.id
where p.status = 'draft'
group by p.id, i.source, i.source_ref
order by p.created_at;
