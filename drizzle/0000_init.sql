CREATE TYPE "public"."agent_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_stage" AS ENUM('queued', 'triage', 'investigating', 'implementing', 'verifying', 'pr', 'waiting', 'merged', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('active', 'idle', 'ended');--> statement-breakpoint
CREATE TABLE "agents" (
	"tool_use_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text,
	"parent_agent_id" text,
	"subagent_type" text,
	"description" text,
	"model" text,
	"status" "agent_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"input_tokens" double precision DEFAULT 0 NOT NULL,
	"output_tokens" double precision DEFAULT 0 NOT NULL,
	"cache_read_tokens" double precision DEFAULT 0 NOT NULL,
	"cache_write_tokens" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "agents_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"session_id" text PRIMARY KEY NOT NULL,
	"cwd" text,
	"repo" text,
	"branch" text,
	"issue_key" text,
	"t3_thread_id" text,
	"title" text,
	"status" "run_status" DEFAULT 'active' NOT NULL,
	"stage" "run_stage",
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"model" text,
	"input_tokens" double precision DEFAULT 0 NOT NULL,
	"output_tokens" double precision DEFAULT 0 NOT NULL,
	"cache_read_tokens" double precision DEFAULT 0 NOT NULL,
	"cache_write_tokens" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agents_session_idx" ON "agents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "events_session_at_idx" ON "events" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "runs_last_event_at_idx" ON "runs" USING btree ("last_event_at");