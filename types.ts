/**
 * 牛马工厂 — 类型定义
 */

export type WorkerRole = "programmer" | "tester" | "reviewer" | "foreman" | "judge" | "historian" | "senior-programmer" | "designer";

export const ALL_ROLES: WorkerRole[] = ["programmer", "tester", "reviewer", "foreman", "judge", "historian", "senior-programmer", "designer"];

export type WorkerStatus = "idle" | "working" | "vacation" | "fired";

export type WorkerBackend = "pi" | "codex" | "claude" | "kimi";

export interface ProjectRecord {
  project: string;
  task: string;
  result: "success" | "failed";
  summary: string;
  date: string;
}

export interface PromotionRecord {
  from: WorkerRole;
  to: WorkerRole;
  date: string;
}

export type ResponsibilityStatus = "active" | "paused" | "done" | "removed";

export interface ResponsibilityRecord {
  worker: string;
  project: string;
  relation: string;
  scope: string;
  status: ResponsibilityStatus;
  note?: string;
  updatedBy?: string;
  updatedAt: string;
  key?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const ALL_THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface Worker {
  id: string;
  sessionFile: string;
  role: WorkerRole;
  backend?: WorkerBackend;
  displayName?: string | null;
  avatar?: string | null;
  model?: string;
  thinking?: ThinkingLevel;
  codexThreadId?: string | null;
  codexThreadInitialized?: boolean;
  codexServerUrl?: string;
  codexApprovalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexThreadHandoff?: string | null;
  codexActiveTurnId?: string | null;
  claudeSessionId?: string | null;
  claudeSessionInitialized?: boolean;
  claudeCwd?: string | null;
  claudeCommand?: string;
  claudePermissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
  claudeTools?: string;
  claudeAllowedTools?: string[] | string;
  claudeDisallowedTools?: string[] | string;
  claudeBare?: boolean;
  kimiSessionId?: string | null;
  kimiSessionInitialized?: boolean;
  kimiCwd?: string | null;
  kimiCommand?: string;
  status: WorkerStatus;
  hired: string;
  projects: ProjectRecord[];
  promotions: PromotionRecord[];
  responsibilities: ResponsibilityRecord[];
}

export interface RaceRecord {
  raceId: string;
  task: string;
  candidates: string[];
  winner: string;
  judgeNotes: string;
  date: string;
}

/** pi.appendEntry 持久化的事件类型 */
export const EntryTypes = {
  HIRE: "ox-worker-hire",
  FIRE: "ox-worker-fire",
  STATUS: "ox-worker-status",
  PROMOTE: "ox-worker-promote",
  PROJECT: "ox-worker-project",
  RESPONSIBILITY: "ox-worker-responsibility",
  RACE: "ox-race",
} as const;
