import { normalizeCompanyName } from "../../core/normalize.js";
import { nowIso } from "../../core/time.js";
import { fromJson, toJson, type DB } from "../index.js";

export interface CompanyRow {
  id: number;
  name: string;
  normalized_name: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  size: string | null;
  headquarters: string | null;
  description: string | null;
  vault_note: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyInput {
  name: string;
  website?: string | null;
  domain?: string | null;
  industry?: string | null;
  size?: string | null;
  headquarters?: string | null;
  description?: string | null;
  vault_note?: string | null;
  metadata?: Record<string, unknown> | null;
}

function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Idempotent create: returns the existing company when the normalized name matches. Fills empty fields only. */
export function upsertCompany(db: DB, input: CompanyInput): { company: CompanyRow; created: boolean } {
  const normalized = normalizeCompanyName(input.name);
  if (!normalized) throw new Error("Company name is required");
  const now = nowIso();
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM companies WHERE normalized_name = ?").get(normalized) as CompanyRow | undefined;
    if (existing) {
      const patch = {
        website: existing.website ?? input.website ?? null,
        domain: existing.domain ?? input.domain ?? domainFromWebsite(input.website),
        industry: existing.industry ?? input.industry ?? null,
        size: existing.size ?? input.size ?? null,
        headquarters: existing.headquarters ?? input.headquarters ?? null,
        description: existing.description ?? input.description ?? null,
        vault_note: existing.vault_note ?? input.vault_note ?? null,
        metadata_json: input.metadata ? toJson({ ...fromJson(existing.metadata_json, {}), ...input.metadata }) : existing.metadata_json,
      };
      db.prepare(
        `UPDATE companies SET website = @website, domain = @domain, industry = @industry, size = @size, headquarters = @headquarters,
         description = @description, vault_note = @vault_note, metadata_json = @metadata_json, updated_at = @updated_at WHERE id = @id`,
      ).run({ ...patch, updated_at: now, id: existing.id });
      return { company: getCompanyById(db, existing.id)!, created: false };
    }
    const res = db
      .prepare(
        `INSERT INTO companies (name, normalized_name, website, domain, industry, size, headquarters, description, vault_note, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name.trim(),
        normalized,
        input.website ?? null,
        input.domain ?? domainFromWebsite(input.website),
        input.industry ?? null,
        input.size ?? null,
        input.headquarters ?? null,
        input.description ?? null,
        input.vault_note ?? null,
        input.metadata ? toJson(input.metadata) : null,
        now,
        now,
      );
    return { company: getCompanyById(db, Number(res.lastInsertRowid))!, created: true };
  });
  return tx();
}

export function getCompanyById(db: DB, id: number): CompanyRow | null {
  return (db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as CompanyRow | undefined) ?? null;
}

export function getCompanyByName(db: DB, name: string): CompanyRow | null {
  const normalized = normalizeCompanyName(name);
  if (!normalized) return null;
  return (db.prepare("SELECT * FROM companies WHERE normalized_name = ?").get(normalized) as CompanyRow | undefined) ?? null;
}

export type CompanyPatch = Partial<Omit<CompanyInput, "name">> & { name?: string };

export function updateCompany(db: DB, id: number, patch: CompanyPatch): CompanyRow {
  const existing = getCompanyById(db, id);
  if (!existing) throw new Error(`Company ${id} not found`);
  const merged = {
    name: patch.name?.trim() || existing.name,
    website: patch.website !== undefined ? patch.website : existing.website,
    domain: patch.domain !== undefined ? patch.domain : (existing.domain ?? domainFromWebsite(patch.website)),
    industry: patch.industry !== undefined ? patch.industry : existing.industry,
    size: patch.size !== undefined ? patch.size : existing.size,
    headquarters: patch.headquarters !== undefined ? patch.headquarters : existing.headquarters,
    description: patch.description !== undefined ? patch.description : existing.description,
    vault_note: patch.vault_note !== undefined ? patch.vault_note : existing.vault_note,
    metadata_json: patch.metadata ? toJson({ ...fromJson(existing.metadata_json, {}), ...patch.metadata }) : existing.metadata_json,
    updated_at: nowIso(),
    id,
  };
  db.prepare(
    `UPDATE companies SET name = @name, website = @website, domain = @domain, industry = @industry, size = @size, headquarters = @headquarters,
     description = @description, vault_note = @vault_note, metadata_json = @metadata_json, updated_at = @updated_at WHERE id = @id`,
  ).run(merged);
  return getCompanyById(db, id)!;
}

export function searchCompanies(db: DB, query: string, limit = 20): CompanyRow[] {
  const q = `%${(normalizeCompanyName(query) ?? query.toLowerCase()).replace(/\s+/g, "%")}%`;
  return db
    .prepare("SELECT * FROM companies WHERE normalized_name LIKE ? OR lower(domain) LIKE ? ORDER BY name LIMIT ?")
    .all(q, q, limit) as CompanyRow[];
}
