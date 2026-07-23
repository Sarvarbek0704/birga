import type { Queryable } from "./postgres.js";

export type Role = "owner" | "editor" | "viewer";

export interface Document {
  id: string;
  ownerId: string;
  title: string;
  updatedAt: string;
}

export interface DocumentWithRole extends Document {
  role: Role;
}

interface DocRow {
  id: string;
  owner_id: string;
  title: string;
  updated_at: string;
}
interface DocRoleRow extends DocRow {
  role: Role;
}
interface RoleRow {
  role: Role;
}

const toDoc = (r: DocRow): Document => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  updatedAt: r.updated_at,
});

/**
 * Document metadata + share permissions (owner / editor / viewer). Sits beside
 * {@link PostgresDocStore} on the same database but owns the `documents` and
 * `permissions` tables. Presence stays in Redis and is never touched here.
 */
export class DocumentsRepo {
  constructor(private readonly db: Queryable) {}

  /** Create a document owned by `ownerId` (also grants them the owner role). */
  async create(id: string, ownerId: string, title = "Untitled"): Promise<Document> {
    const { rows } = await this.db.query<DocRow>(
      `INSERT INTO documents (id, owner_id, title) VALUES ($1, $2, $3)
       RETURNING id, owner_id, title, updated_at`,
      [id, ownerId, title],
    );
    await this.db.query(
      `INSERT INTO permissions (document_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = 'owner'`,
      [id, ownerId],
    );
    return toDoc(rows[0]!);
  }

  async get(id: string): Promise<Document | null> {
    const { rows } = await this.db.query<DocRow>(
      `SELECT id, owner_id, title, updated_at FROM documents WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDoc(rows[0]) : null;
  }

  /** Every document `userId` can see, newest first, with their role. */
  async listForUser(userId: string): Promise<DocumentWithRole[]> {
    const { rows } = await this.db.query<DocRoleRow>(
      `SELECT d.id, d.owner_id, d.title, d.updated_at, p.role
       FROM documents d
       JOIN permissions p ON p.document_id = d.id
       WHERE p.user_id = $1
       ORDER BY d.updated_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ ...toDoc(r), role: r.role }));
  }

  async rename(id: string, title: string): Promise<void> {
    await this.db.query(`UPDATE documents SET title = $2, updated_at = now() WHERE id = $1`, [
      id,
      title,
    ]);
  }

  async remove(id: string): Promise<void> {
    // permissions cascade; op log/snapshots are pruned separately if desired.
    await this.db.query(`DELETE FROM documents WHERE id = $1`, [id]);
  }

  /** Grant or change a share role. Owners cannot be demoted through this path. */
  async setRole(documentId: string, userId: string, role: Role): Promise<void> {
    await this.db.query(
      `INSERT INTO permissions (document_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [documentId, userId, role],
    );
  }

  async revoke(documentId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM permissions WHERE document_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [documentId, userId],
    );
  }

  /** All users with a role on the document (owner's view of sharing). */
  async listPermissions(documentId: string): Promise<Array<{ userId: string; role: Role }>> {
    const { rows } = await this.db.query<{ user_id: string; role: Role }>(
      `SELECT user_id, role FROM permissions WHERE document_id = $1 ORDER BY role`,
      [documentId],
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
  }

  async roleFor(documentId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.db.query<RoleRow>(
      `SELECT role FROM permissions WHERE document_id = $1 AND user_id = $2`,
      [documentId, userId],
    );
    return rows[0]?.role ?? null;
  }

  /** Can this user write? owners and editors may; viewers may not. */
  async canEdit(documentId: string, userId: string): Promise<boolean> {
    const role = await this.roleFor(documentId, userId);
    return role === "owner" || role === "editor";
  }
}
