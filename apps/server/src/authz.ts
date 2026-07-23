import type { DocumentsRepo } from "./documents.js";
import { verifyUser } from "./auth.js";
import type { Authorize } from "./hub.js";

/**
 * Strip the editor-mode prefix (`plain:` / `rich:`) so both surfaces of one
 * document map to the same permission set. `plain:abc` and `rich:abc` → `abc`.
 */
export function stripEditorPrefix(docId: string): string {
  const i = docId.indexOf(":");
  if (i < 0) return docId;
  const prefix = docId.slice(0, i);
  return prefix === "plain" || prefix === "rich" ? docId.slice(i + 1) : docId;
}

export interface AuthorizerOptions {
  /** Map a room id to the document whose permissions apply. Default: strip prefix. */
  normalizeDocId?: (docId: string) => string;
  /** Allow anyone into documents that have no permission rows yet. Default: true. */
  publicIfUnclaimed?: boolean;
}

/**
 * Build an {@link Authorize} backed by {@link DocumentsRepo} + signed tokens.
 *
 * Policy:
 *  - a document with **no permission rows** is *unclaimed* → open (so ad-hoc docs
 *    keep working) when `publicIfUnclaimed` is set;
 *  - otherwise the token must resolve to a user with a role: any role may
 *    **read**, only `owner`/`editor` may **write**.
 */
export function makeDocumentAuthorizer(
  repo: DocumentsRepo,
  secret: string,
  opts: AuthorizerOptions = {},
): Authorize {
  const normalize = opts.normalizeDocId ?? stripEditorPrefix;
  const publicIfUnclaimed = opts.publicIfUnclaimed ?? true;

  return async (docId, token, need) => {
    const base = normalize(docId);
    const perms = await repo.listPermissions(base);
    if (perms.length === 0) return publicIfUnclaimed;

    const user = token ? verifyUser(token, secret) : null;
    if (!user) return false;
    const role = perms.find((p) => p.userId === user.userId)?.role;
    if (!role) return false;
    return need === "read" ? true : role === "owner" || role === "editor";
  };
}
