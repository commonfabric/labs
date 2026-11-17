-- Nobody gets the same mail twice. Every send carries a hash of its message
-- (the normalised subject and body); a person who already received a message
-- with that hash, in any real send, is not eligible for another send of it.
-- The hash is kept by a trigger rather than by the code that edits a send, so
-- it follows every writer: the draft editor, duplication, tests, a backfill.
alter table sends add column content_hash text;

-- The body is body_html once an editor migration adds that column (a
-- concurrent branch; that migration must set content_hash to null after
-- filling the column so every row is hashed the same way), and body_markdown
-- until then, or while body_html is empty. Reading the row through jsonb
-- works either way.
create or replace function sends_message_body(row_json jsonb, markdown text)
returns text language sql immutable as $$
  select coalesce(nullif(row_json->>'body_html', ''), markdown, '')
$$;

create or replace function sends_content_hash() returns trigger
language plpgsql as $$
declare
  body text := sends_message_body(to_jsonb(new), new.body_markdown);
  squash text;
begin
  -- Most updates to a send (ticks, status) leave the message alone.
  if tg_op = 'UPDATE' and old.content_hash is not null
    and old.subject is not distinct from new.subject
    and sends_message_body(to_jsonb(old), old.body_markdown) = body then
    new.content_hash := old.content_hash;
    return new;
  end if;
  -- Normalised: every run of whitespace as one space, then trimmed (btrim
  -- alone strips only spaces), so a reflowed paragraph is the same mail.
  squash := btrim(regexp_replace(coalesce(new.subject, ''), '\s+', ' ', 'g'))
    || E'\n' || btrim(regexp_replace(body, '\s+', ' ', 'g'));
  new.content_hash := encode(sha256(convert_to(squash, 'UTF8'
