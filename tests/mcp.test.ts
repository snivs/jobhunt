import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

const REQUIRED_TOOLS = [
  "search_jobs", "get_job", "create_job", "update_job", "get_company", "create_company", "update_company",
  "search_skills", "create_skill", "record_job_skill", "get_skill_market_demand", "record_compensation", "get_compensation_statistics",
  "calculate_job_match", "get_matching_jobs", "create_search_run", "complete_search_run", "get_search_run",
  "record_application", "get_application", "update_application", "record_application_event", "get_application_candidates",
  "get_application_statistics", "get_source_statistics", "get_market_statistics", "get_schedule_status", "check_can_submit",
];

let client: Client;
let tmp: string;

function text(res: unknown): unknown {
  const r = res as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const first = r.content[0];
  return first ? JSON.parse(first.text) : null;
}

describe("jobhunt-db MCP server (stdio round-trip)", () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunt-mcp-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(ROOT, "src", "mcp", "server.ts")],
      cwd: ROOT,
      env: { ...process.env, JOBHUNT_DB_PATH: path.join(tmp, "test.db"), JOBHUNT_LOG_STDERR: "0" } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes the high-level tools (no raw SQL)", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of REQUIRED_TOOLS) expect(tools, `missing ${name}`).toContain(name);
    expect(tools.some((t) => /sql/i.test(t))).toBe(false);
  });

  it("creates, scores and applies through the tools", async () => {
    const created = text(await client.callTool({ name: "create_job", arguments: { source_key: "remotive", external_id: "m1", url: "https://remotive.com/remote-jobs/m1", title: "Senior TypeScript Engineer", company_name: "Acme", description: "TypeScript, Node.js, AWS. Remote worldwide.", salary: { min: 100000, max: 130000, currency: "USD", period: "year" } } })) as { job: { id: number }; outcome: string };
    expect(created.outcome).toBe("created");
    const again = text(await client.callTool({ name: "create_job", arguments: { source_key: "remotive", external_id: "m1", url: "https://remotive.com/remote-jobs/m1", title: "Senior TypeScript Engineer", company_name: "Acme", description: "TypeScript, Node.js, AWS. Remote worldwide.", salary: { min: 100000, max: 130000, currency: "USD", period: "year" } } })) as { outcome: string };
    expect(again.outcome).toBe("unchanged");

    const noProfile = await client.callTool({ name: "calculate_job_match", arguments: { job_id: created.job.id } });
    expect((noProfile as { isError?: boolean }).isError).toBe(true);

    await client.callTool({ name: "update_candidate_profile", arguments: { full_name: "Test Candidate", seniority: "senior", years_experience: 10, years_leadership: 3, country: "Mexico", languages: [{ code: "en", level: "c1" }], interview_completed: true } });
    await client.callTool({ name: "set_candidate_skill", arguments: { skill_name: "TypeScript", level: "expert", years: 8 } });
    await client.callTool({ name: "set_candidate_skill", arguments: { skill_name: "Node.js", level: "expert", years: 8 } });
    await client.callTool({ name: "set_candidate_preference", arguments: { key: "compensation", value: { minimum: 80000, target: 110000, currency: "USD", period: "year" }, is_hard_constraint: true } });
    await client.callTool({ name: "set_candidate_preference", arguments: { key: "work_modes", value: ["remote"], is_hard_constraint: true } });

    const match = text(
      await client.callTool({
        name: "calculate_job_match",
        arguments: {
          job_id: created.job.id,
          work_mode: "remote",
          remote_scope: "Worldwide",
          skills: [
            { name: "TypeScript", mention_type: "explicit_required", evidence: "TypeScript" },
            { name: "node", mention_type: "explicit_required" },
            { name: "Kubernetes", mention_type: "expected" },
          ],
          compensation: { min: 100000, max: 130000, currency: "USD", period: "year", explicit: true },
        },
      }),
    ) as { match: { overall_score: number; eligible: boolean }; explanation: string };
    expect(match.match.eligible).toBe(true);
    expect(match.match.overall_score).toBeGreaterThan(80);
    expect(match.explanation).toContain("required skill match");

    const job = text(await client.callTool({ name: "get_job", arguments: { job_id: created.job.id } })) as { skills: Array<{ skill_slug: string; mention_type: string }>; compensation: unknown[] };
    expect(job.skills.map((s) => s.skill_slug).sort()).toEqual(["kubernetes", "nodejs", "typescript"]);
    expect(job.skills.find((s) => s.skill_slug === "kubernetes")?.mention_type).toBe("expected");
    expect(job.compensation).toHaveLength(1);

    const run = text(await client.callTool({ name: "create_search_run", arguments: { trigger: "manual", holder: "mcp-test" } })) as { status: string; run: { id: number } };
    expect(run.status).toBe("started");
    const app = text(await client.callTool({ name: "record_application", arguments: { job_id: created.job.id, run_id: run.run.id, initial_status: "MATCHED" } })) as { application: { id: number }; created: boolean };
    expect(app.created).toBe(true);
    const check = text(await client.callTool({ name: "check_can_submit", arguments: { application_id: app.application.id, run_id: run.run.id } })) as { ok: boolean; reasons: string[] };
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/discover_only/);
    const bad = await client.callTool({ name: "record_application_event", arguments: { application_id: app.application.id, to_status: "SUBMITTED", event_type: "x" } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    const done = text(await client.callTool({ name: "complete_search_run", arguments: { run_id: run.run.id, holder: "mcp-test", status: "completed", stats: { jobs_new: 1 } } })) as { status: string };
    expect(done.status).toBe("completed");
    const stats = text(await client.callTool({ name: "get_market_statistics", arguments: { period_days: 7 } })) as { jobs: { total: number }; compensation: { explicit: { sample_size: number } } };
    expect(stats.jobs.total).toBe(1);
    expect(stats.compensation.explicit.sample_size).toBe(1);
  }, 60_000);
});
