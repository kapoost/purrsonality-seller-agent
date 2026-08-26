// Legacy creative-format conversion for the canonical (3.1) wire.
//
// Creatives in our store carry legacy `{agent_url, id}` refs, and the framework
// must project each one to a canonical declaration before it can answer
// `list_creatives` / `sync_creatives` on a canonical wire. An unmappable ref
// fails the whole response with `INVALID_REQUEST: … contains a legacy creative
// format that cannot be represented canonically`, which took down list_creatives
// entirely — and with it security_baseline, whose test kit uses list_creatives as
// its `auth.probe_task` to prove the auth mechanism works.
//
// What is actually in the store (87 rows, production, 2026-08-24):
//
//   42x  https://purrsonality-seller.fly.dev/mcp        display_300x250
//   42x  https://creative.adcontextprotocol.org         display_300x250
//    1x  https://your-platform.example.com              native_content
//    1x  https://your-platform.example.com              native_in_feed
//    1x  https://your-platform.example.com              native_post
//
// Three distinct owner URLs for what are two format families. Note the second
// row is the AAO catalog *without* its trailing slash — the canonical catalog
// entry is `https://creative.adcontextprotocol.org/`. Matching on the owner URL
// would therefore drop 84 of 87 rows on a punctuation difference, so we resolve
// on the bare id and treat the owner as provenance rather than identity. That is
// sound here because this seller mints the ids it stores; a multi-tenant seller
// proxying several creative agents would need owner-scoped resolution.
import { canonicalDeclarationFromBareId } from '@adcp/sdk/v2/projection';
import type { LegacyFormatConverter } from '@adcp/sdk';

// The SDK attaches the source ref as `v1_format_ref` itself. Returning one from
// the resolver too would point the declaration at the AAO catalog entry rather
// than at the ref we were actually handed — for the `fly.dev/mcp` and
// `your-platform.example.com` rows those are different owners.
type Declaration = NonNullable<ReturnType<LegacyFormatConverter>>;

function withoutLegacyRef(decl: Declaration): Declaration {
  const { v1_format_ref: _drop, ...rest } = decl as Declaration & { v1_format_ref?: unknown };
  return rest as Declaration;
}

export const legacyCreativeFormatConverter: LegacyFormatConverter = ({ formatId }) => {
  const id = (formatId as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const direct = canonicalDeclarationFromBareId(id);
  if (direct != null) {
    return withoutLegacyRef(direct as Declaration);
  }

  // Bare canonical kinds stored as if they were catalogue ids. `image` is not a
  // catalogue id and resolves to nothing, but a row can end up carrying it —
  // storyboards write creatives through this store, and one unresolvable row
  // fails the entire list_creatives response rather than just itself. Seen in
  // production on 2026-08-26: a single `:: image` row took the call down.
  // `native_content` resolves to a `format_kind: image` declaration, so it is
  // the honest minimal shape for a row that only tells us "an image".
  if (id === 'image') {
    const imageDecl = canonicalDeclarationFromBareId('native_content');
    if (imageDecl != null) {
      return withoutLegacyRef(imageDecl as Declaration);
    }
  }

  // `native_in_feed` and `native_post` resolve to nothing, while their sibling
  // `native_content` does. All three are the same fixture family from the same
  // owner and describe the same thing: a native placement whose assets the buyer
  // uploads. Borrow the sibling's canonical shape rather than invent one, so the
  // declaration stays something the catalog actually defines.
  if (id.startsWith('native_')) {
    const sibling = canonicalDeclarationFromBareId('native_content');
    if (sibling != null) {
      return withoutLegacyRef(sibling as Declaration);
    }
  }

  // Fail closed. A wrong declaration is worse than a refused one: it would put a
  // shape on the wire that no catalog backs, and buyers would build against it.
  return null;
};
