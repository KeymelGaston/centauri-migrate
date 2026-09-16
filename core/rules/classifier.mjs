/**
 * Classifies a leaf of the logical tree (already correctly isolated inside
 * its AND/OR group by logical-parser.js) into one of the known patterns.
 * The order of checks matters: the ones involving a lookup placeholder must
 * be checked BEFORE the generic ownership check, or a case like
 * "get(orgs).data.ownerId == request.auth.uid" (reversed comparison) gets
 * confused with a direct ownership check on the current row -- this was a
 * real bug found during the spike (the orgs/secrets case).
 */
export function classifyLeaf(text, lookupsByPlaceholder) {
  const t = text.trim();

  if (t === 'request.auth != null' || t === 'request.auth!=null') return { kind: 'auth_guard' };
  if (t === 'true' || t === 'false') return { kind: 'trivial', value: t };

  // bare placeholder -> exists(...) with no further comparison
  if (lookupsByPlaceholder[t]) return { kind: 'lookup_exists', lookup: lookupsByPlaceholder[t] };

  // placeholder.data.field == <something>  or  <something> == placeholder.data.field
  for (const placeholder of Object.keys(lookupsByPlaceholder)) {
    let m = t.match(new RegExp(`^${placeholder}\\.data\\.(\\w+)\\s*==\\s*(.+)$`));
    let reversed = false;
    if (!m) {
      m = t.match(new RegExp(`^(.+)\\s*==\\s*${placeholder}\\.data\\.(\\w+)$`));
      reversed = true;
    }
    if (m) {
      const field = reversed ? m[2] : m[1];
      const rhsRaw = (reversed ? m[1] : m[2]).trim();
      if (rhsRaw === 'request.auth.uid') {
        return { kind: 'lookup_field', lookup: lookupsByPlaceholder[placeholder], field, valueIsIdentity: true };
      }
      const litMatch = rhsRaw.match(/^'([^']+)'$/);
      if (litMatch) {
        return { kind: 'lookup_field', lookup: lookupsByPlaceholder[placeholder], field, value: litMatch[1] };
      }
      return { kind: 'unclassified', text: t }; // compared against something we can't resolve
    }
  }

  // request.auth.uid == <something>  (either order) -- only if no placeholder is involved
  let m = t.match(/^request\.auth\.uid\s*==\s*(.+)$/) || (() => {
    const m2 = t.match(/^(.+)\s*==\s*request\.auth\.uid$/);
    return m2 ? [m2[0], m2[1]] : null;
  })();
  if (m) {
    const other = m[1].trim();
    if (other.startsWith('resource.data.')) return { kind: 'owner_field', field: other.replace('resource.data.', '') };
    return { kind: 'owner_pathvar', pathVar: other };
  }

  m = t.match(/^request\.auth\.token\.(\w+)\.hasAny\(\[([^\]]+)\]\)$/);
  if (m) return { kind: 'custom_claim_hasAny', claim: m[1], values: m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, '')) };

  m = t.match(/^request\.auth\.token\.(\w+)\s*==\s*'([^']+)'$/);
  if (m) return { kind: 'custom_claim_eq', claim: m[1], value: m[2] };

  return { kind: 'unclassified', text: t };
}
