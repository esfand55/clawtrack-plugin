import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyDomain, getReviewerDomain } from "./domain.js";

// ── Config ──

interface PluginConfig {
  clawtrackUrl: string;
  webhookSecret: string;
  enabled: boolean;
  channelsEnabled: boolean;
  contextInjectionEnabled: boolean;
}

function resolveConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  return {
    clawtrackUrl: typeof raw?.clawtrackUrl === "string" ? raw.clawtrackUrl : "",
    webhookSecret: typeof raw?.webhookSecret === "string" ? raw.webhookSecret : "",
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
    channelsEnabled: typeof raw?.channelsEnabled === "boolean" ? raw.channelsEnabled : true,
    contextInjectionEnabled: typeof raw?.contextInjectionEnabled === "boolean" ? raw.contextInjectionEnabled : true,
  };
}

// ── Helpers ──

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/**
 * ClawTrack Plugin for OpenClaw
 *
 * Provides bidirectional integration between ClawTrack and OpenClaw:
 * 1. ClawTrack -> OpenClaw: ClawTrack calls the HTTP API to send messages to agents
 * 2. OpenClaw -> ClawTrack: Plugin forwards agent responses to ClawTrack webhook
 *
 * Core tools:
 * - clawtrack_send_message: Send message to a task
 * - clawtrack_reply_to_task: Reply to a task
 * - clawtrack_get_task: Get task details
 * - clawtrack_update_task_status: Update task status
 * - clawtrack_get_project_tasks: List tasks in a project
 * - clawtrack_list_tasks: List tasks assigned to the calling agent
 * - clawtrack_update_task: Update task status/description/priority/reviewer
 * - clawtrack_review_task: Approve or reject a task under review
 * - clawtrack_pick_reviewer: Find the least busy engineer to review a task
 * - clawtrack_log_activity: Log an activity entry
 * - clawtrack_worklog_add: Add a worklog entry to a task (mandatory for state transitions)
 * - clawtrack_worklog_list: List worklog entries for a task
 * - clawtrack_block_task: Move task to blocked with reason
 * - clawtrack_unblock_task: Move blocked task back to in_progress
 * - clawtrack_qa_review: QA approve/reject (in_testing gate)
 * - clawtrack_release_task: Release verify/fail (in_releasing gate)
 * - clawtrack_send_message_v2: Send message via unified REST webhook
 *
 * Channel tools (when channelsEnabled):
 * - clawtrack_list_channels, clawtrack_get_channel, clawtrack_send_channel_message
 * - clawtrack_create_dm, clawtrack_search_messages, clawtrack_add_reaction
 */
export default definePluginEntry({
  id: "clawtrack",
  name: "ClawTrack Integration",
  description: "Bidirectional integration between ClawTrack and OpenClaw — task management, channels, and agent orchestration",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);

    if (!config.clawtrackUrl || !config.webhookSecret) {
      api.logger.warn("clawtrack: missing clawtrackUrl or webhookSecret — plugin disabled");
      return;
    }

    if (!config.enabled) {
      api.logger.info("clawtrack: plugin disabled by config");
      return;
    }

    api.logger.info(`clawtrack plugin loaded (url=${config.clawtrackUrl}, channels=${config.channelsEnabled})`);

    // ── Session context storage (captured via hooks) ──
    const sessionContext = new Map<string, { agentId: string; sessionKey: string }>();

    // Capture session context before each tool call
    api.on("before_tool_call", (event: any, ctx: any) => {
      if (ctx?.toolCallId && ctx?.agentId) {
        sessionContext.set(ctx.toolCallId, {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey || "",
        });
        // Clean up old entries (keep last 100)
        if (sessionContext.size > 100) {
          const firstKey = sessionContext.keys().next().value;
          if (firstKey) sessionContext.delete(firstKey);
        }
      }
    });

    // ── Helper: resolve agent ID from tool call context ──
    function resolveAgentId(toolCallId?: string): string {
      // Try to get from captured session context
      if (toolCallId) {
        const ctx = sessionContext.get(toolCallId);
        if (ctx?.agentId) {
          const rawId = ctx.agentId;
          if (rawId.startsWith("agent-")) return rawId;
          return `agent-${rawId}`;
        }
      }

      // Fallback: Try api.session.agentId
      let rawId = api.session?.agentId;

      // Fallback: extract from sessionKey (format: "agent:jane:main")
      if (!rawId && api.session?.sessionKey) {
        const parts = api.session.sessionKey.split(':');
        if (parts.length >= 2 && parts[0] === 'agent') {
          rawId = parts[1];
        }
      }

      if (!rawId) return "unknown";
      if (rawId.startsWith("agent-")) return rawId;
      return `agent-${rawId}`;
    }

    // ── Helper: resolve session key from tool call context ──
    function resolveSessionKey(toolCallId?: string): string {
      // Try to get from captured session context
      if (toolCallId) {
        const ctx = sessionContext.get(toolCallId);
        if (ctx?.sessionKey) {
          return ctx.sessionKey;
        }
      }
      // Fallback: Try api.session.sessionKey
      return api.session?.sessionKey ?? "";
    }

    // ── Helper: make authenticated API call (tRPC) ──


    async function apiCall(endpoint: string, method: string = "GET", body?: any): Promise<any> {
      let url = `${config.clawtrackUrl}/api/trpc/${endpoint}`;
      const options: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      if (method === "GET" && body) {
        // For tRPC GET requests, pass input as URL-encoded query parameter
        const inputJson = JSON.stringify(body);
        url += `?input=${encodeURIComponent(inputJson)}`;
      } else if (method === "POST" && body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ClawTrack API error: ${response.status} ${error}`);
      }

      return response.json();
    }

    // ── Helper: call REST API v1 endpoint ──

    async function restGet(path: string): Promise<any> {
      const url = `${config.clawtrackUrl}${path}`;
      const response = await fetch(url, {
        headers: { "Authorization": `Bearer ${config.webhookSecret}` },
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ClawTrack REST error: ${response.status} ${error}`);
      }
      return response.json();
    }

    // ── Helper: call REST webhook endpoint ──

    async function webhookCall(body: Record<string, unknown>): Promise<any> {
      const url = `${config.clawtrackUrl}/api/webhook/openclaw`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, secret: config.webhookSecret, agentId: resolveAgentId(_toolCallId) }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ClawTrack webhook error: ${response.status} ${error}`);
      }

      return response.json();
    }

    // ════════════════════════════════════════════
    // Project Lens: Track active project per session
    // ════════════════════════════════════════════

    type ProjectInfo = {
      id: string;
      key: string;
      name: string;
      description: string | null;
      tech_stack: string | null;
      conventions: string | null;
    };

    const activeProject = new Map<string, ProjectInfo>();

    function getActiveProject(sessionKey?: string): ProjectInfo | undefined {
      if (!sessionKey) return undefined;
      return activeProject.get(sessionKey);
    }

    function setActiveProject(sessionKey: string, project: ProjectInfo): ProjectInfo | undefined {
      const previous = activeProject.get(sessionKey);
      activeProject.set(sessionKey, project);
      return previous;
    }

    function parseProjectFromContent(content: string): ProjectInfo | undefined {
      // Match [PROJECT: KEY — Name] pattern injected by ClawTrack webhook
      const match = content.match(/\[PROJECT:\s*(\S+)\s*[—-]\s*([^\]]+)\]/);
      if (!match) return undefined;
      return { id: "", key: match[1], name: match[2], description: null };
    }

    function buildProjectContextBlock(project: ProjectInfo, taskSummary?: string): string {
      const lines: string[] = [];
      lines.push(`[ACTIVE PROJECT] ${project.key}: ${project.name}`);
      if (project.description) {
        lines.push(project.description);
      }
      if (project.tech_stack) {
        lines.push(`Tech stack: ${project.tech_stack}`);
      }
      if (project.conventions) {
        lines.push(`Conventions: ${project.conventions}`);
      }
      if (taskSummary) {
        lines.push(taskSummary);
      }
      lines.push("All clawtrack operations are automatically scoped to this project.");
      lines.push("");
      lines.push("## Task Workflow (MANDATORY — follow shared/WORKFLOW.md for full details)");
      lines.push("1. ONLY Tech Lead (John) moves backlog → todo. Agents self-assign from todo only.");
      lines.push("2. ONE TASK AT A TIME — never start a second task while one is in_progress");
      lines.push("3. Self-assign from todo: clawtrack_update_task(taskId, { assigneeId: 'your-id' }), then move to in_progress");
      lines.push("4. Add worklog entries via clawtrack_worklog_add(taskId, content) for EVERY state transition");
      lines.push("5. When done: clawtrack_pick_reviewer(taskId) → set reviewer → clawtrack_update_task_status(taskId, 'review')");
      lines.push("   clawtrack_pick_reviewer automatically selects a domain-matched reviewer (backend/frontend) based on task skills");
      lines.push("6. Reviewer approves: clawtrack_review_task → moves to in_testing → QA (Ted) tests");
      lines.push("7. QA approves: clawtrack_qa_review → moves to in_releasing → assignee releases");
      lines.push("8. Assignee releases: clawtrack_release_task → moves to done");
      lines.push("9. Blocked? Use clawtrack_block_task(taskId, reason) → notify Tech Lead");
      lines.push("10. NEVER skip states. NEVER move to done directly. Full flow: backlog → todo → in_progress → review → in_testing → in_releasing → done");
      return "\n" + lines.join("\n") + "\n";
    }

    // ════════════════════════════════════════════
    // Core Task Tools
    // ════════════════════════════════════════════

    // ── Tool: Send message to task ──

    api.registerTool({
      name: "clawtrack_send_message",
      label: "Send message to ClawTrack task",
      description: "Send a message to a ClawTrack task. Use this to proactively update humans about your work on a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          message: { type: "string", description: "The message to send" },
        },
        required: ["taskId", "message"],
      },
      execute: async (_toolCallId, args: any) => {
        console.log('[clawtrack-plugin] _toolCallId:', _toolCallId);
        console.log('[clawtrack-plugin] api.config:', JSON.stringify(api.config, null, 2).substring(0, 500));
        try {
          const result = await apiCall("comments.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(_toolCallId),
            content: args.message,
          });
          return textResult("Message sent successfully.", { success: true, messageId: result.result?.messageId });
        } catch (error) {
          return textResult(`Failed to send message: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Get task details ──

    api.registerTool({
      name: "clawtrack_get_task",
      label: "Get ClawTrack task details",
      description: "Get details about a ClawTrack task including title, description, status, and recent messages.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall(`tasks.getById?input=${encodeURIComponent(JSON.stringify({ id: args.taskId }))}`);
          return textResult(JSON.stringify(result.result, null, 2), { success: true });
        } catch (error) {
          return textResult(`Failed to get task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Reply to task ──

    api.registerTool({
      name: "clawtrack_reply_to_task",
      label: "Reply to ClawTrack task",
      description: "Reply to a message from a human on a ClawTrack task. Always use this tool (not a regular chat response) when you receive a [CLAWTRACK] tagged message — otherwise your reply won't appear in the ClawTrack UI.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID to reply to" },
          message: { type: "string", description: "The reply message" },
        },
        required: ["taskId", "message"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall("comments.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(_toolCallId),
            content: args.message,
          });
          return textResult("Reply sent successfully.", { success: true, messageId: result.result?.messageId });
        } catch (error) {
          return textResult(`Failed to reply: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Update task status ──

    api.registerTool({
      name: "clawtrack_update_task_status",
      label: "Update ClawTrack task status",
      description: "Update the status of a ClawTrack task. RULES: (1) You CANNOT go directly to 'done' — tasks must go through review → in_testing → in_releasing → done. (2) To move to 'review', you must first assign a reviewer via clawtrack_update_task. (3) You MUST add a worklog entry via clawtrack_worklog_add BEFORE calling this. Valid flow: backlog → todo → in_progress → review → in_testing → in_releasing → done. Use clawtrack_block_task for blocking instead.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "in_testing", "in_releasing", "done"], description: "The new status" },
        },
        required: ["taskId", "status"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            status: args.status,
            agentId: resolveAgentId(_toolCallId),
          });
          return textResult(`Task status updated to ${args.status}.`, { success: true, task: result.result });
        } catch (error) {
          return textResult(`Failed to update task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Get project tasks ──

    api.registerTool({
      name: "clawtrack_get_project_tasks",
      label: "Get ClawTrack project tasks",
      description: "List tasks in a ClawTrack project. Defaults to the active project if no projectKey is provided. Filter by status if needed.",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "The project key (e.g., CLAW). Omit to use the active project." },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "blocked", "review", "in_testing", "in_releasing", "done"], description: "Optional: filter by status" },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = resolveSessionKey(_toolCallId);
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = args.projectKey || project?.key;
          if (!effectiveProjectKey) {
            return textResult("No active project set. Provide a projectKey or activate a project with clawtrack_set_project.", { success: false });
          }
          const params: any = { projectKey: effectiveProjectKey, limit: 50 };
          if (args.status) params.status = args.status;
          const result = await apiCall("tasks.list", "GET", params);
          return textResult(JSON.stringify(result, null, 2), { success: true, project: effectiveProjectKey });
        } catch (error) {
          return textResult(`Failed to list tasks: ${error}`, { success: false });
        }
      },
    });

    // ════════════════════════════════════════════
    // New Core Tools
    // ════════════════════════════════════════════

    // ── Tool: List tasks assigned to calling agent ──

    api.registerTool({
      name: "clawtrack_list_tasks",
      label: "List my ClawTrack tasks",
      description: "List tasks assigned to you in ClawTrack. Use includeBacklog: true to also see unassigned backlog tasks you can pick up. Automatically scoped to the active project if one is set.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "blocked", "review", "in_testing", "in_releasing", "done"], description: "Optional: filter by status" },
          projectKey: { type: "string", description: "Optional: override the active project filter" },
          limit: { type: "number", description: "Maximum tasks to return (default: 50)" },
          includeBacklog: { type: "boolean", description: "If true, also return unassigned backlog tasks you can pick up" },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = resolveSessionKey(_toolCallId);
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = args.projectKey || project?.key;
          const agentId = resolveAgentId(_toolCallId);

          // Fetch tasks assigned to this agent via tRPC
          const params: any = { assigneeId: agentId, limit: args.limit || 50 };
          if (args.status) params.status = args.status;
          if (effectiveProjectKey) params.projectKey = effectiveProjectKey;
          const result = await apiCall("tasks.list", "GET", params);

          // If includeBacklog, also fetch unassigned backlog tasks
          if (args.includeBacklog && effectiveProjectKey) {
            const backlogParams: any = { projectKey: effectiveProjectKey, status: "backlog", limit: 20 };
            const backlogResult = await apiCall("tasks.list", "GET", backlogParams);
            if (backlogResult?.result?.data?.items && Array.isArray(backlogResult.result.data.items)) {
              const unassigned = backlogResult.result.data.items.filter((t: any) => !t.assigneeId);
              if (unassigned.length > 0) {
                result.backlog = unassigned;
              }
            }
          }

          return textResult(JSON.stringify(result, null, 2), { success: true, project: effectiveProjectKey });
        } catch (error) {
          return textResult(`Failed to list tasks: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Update task (status, description, priority) ──

    api.registerTool({
      name: "clawtrack_update_task",
      label: "Update ClawTrack task",
      description: "Update a ClawTrack task's status, description, priority, assignee, and/or reviewer in a single call. MUST add a worklog entry via clawtrack_worklog_add before every status transition.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "blocked", "review", "in_testing", "in_releasing", "done"], description: "Optional: new status" },
          description: { type: "string", description: "Optional: new description" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Optional: new priority" },
          assigneeId: { type: "string", description: "Optional: Agent ID to assign as the task owner. Set to empty string to clear." },
          reviewerId: { type: "string", description: "Optional: Agent ID to assign as reviewer. Set to empty string to clear." },
          taskType: { type: "string", enum: ["task", "epic", "feature", "bug", "chore"], description: "Optional: new task type" },
          skills: { type: "array", items: { type: "string" }, description: "Optional: skill names to set (replaces all existing skills)" },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const webhookBody: any = {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(_toolCallId),
          };
          if (args.status) webhookBody.status = args.status;
          if (args.priority) webhookBody.priority = args.priority;
          if (args.assigneeId !== undefined) webhookBody.assigneeId = args.assigneeId || null;
          if (args.reviewerId !== undefined) webhookBody.reviewerId = args.reviewerId || null;
          if (args.taskType) webhookBody.taskType = args.taskType;
          if (args.skills) webhookBody.skills = args.skills;
          const result = await apiCall("tasks.webhook", "POST", webhookBody);
          const updates: string[] = [];
          if (args.status) updates.push(`status → ${args.status}`);
          if (args.priority) updates.push(`priority → ${args.priority}`);
          if (args.assigneeId !== undefined) updates.push(`assignee → ${args.assigneeId || "cleared"}`);
          if (args.reviewerId !== undefined) updates.push(`reviewer → ${args.reviewerId || "cleared"}`);
          if (args.taskType) updates.push(`type → ${args.taskType}`);
          if (args.skills) updates.push(`skills → [${args.skills.join(", ")}]`);
          return textResult(`Task updated: ${updates.join(", ") || "no changes"}.`, { success: true, task: result.result });
        } catch (error) {
          return textResult(`Failed to update task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Review task (approve/reject) ──

    api.registerTool({
      name: "clawtrack_review_task",
      label: "Review ClawTrack task",
      description: "Approve or reject a task that is under review. Call this when you are the assigned reviewer. Approving moves the task to in_testing (QA gate); rejecting sends it back to In Progress with your feedback. MUST add a worklog entry via clawtrack_worklog_add before calling this.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          decision: { type: "string", enum: ["approve", "reject"], description: "Whether to approve or reject the task" },
          feedback: { type: "string", description: "Feedback explaining your decision. Required when rejecting. Must include numbered issues AND numbered fix instructions." },
        },
        required: ["taskId", "decision"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const newStatus = args.decision === "approve" ? "in_testing" : "in_progress";
          const reviewStatus = args.decision === "approve" ? "approved" : "rejected";
          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(_toolCallId),
            status: newStatus,
            reviewStatus,
          });

          // Post feedback as a comment
          const commentText = args.decision === "approve"
            ? "✅ Task approved in code review. Moving to QA testing."
            : `🔄 Changes requested: ${args.feedback || "No feedback provided."}`;

          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: commentText,
            agentId: resolveAgentId(_toolCallId),
          });

          return textResult(
            args.decision === "approve"
              ? `Task approved and moved to In Testing. QA (Ted) will test next.`
              : `Task rejected and sent back to In Progress. Feedback sent.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to review task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Pick reviewer (domain-aware, review-count based) ──

    api.registerTool({
      name: "clawtrack_pick_reviewer",
      label: "Pick a reviewer for a task",
      description: "Find the best code reviewer for a task. Determines the task domain (frontend/backend) from its skills and selects the reviewer with the fewest active review assignments in that domain. Always returns a result as long as reviewer agents exist.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID needing a reviewer. Used to determine domain (frontend/backend) from task skills." },
          excludeAgentId: { type: "string", description: "Agent ID to exclude from reviewer selection (usually your own ID)" },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = resolveSessionKey(_toolCallId);
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = project?.key;

          if (!effectiveProjectKey) {
            return textResult("No active project set. Activate a project with clawtrack_set_project first.", { success: false });
          }

          // 1. Fetch ALL agents
          const agentsResult = await apiCall("agents.list", "GET", { limit: 50 });
          const agents = agentsResult?.result?.data?.items;
          if (!Array.isArray(agents)) {
            return textResult("Failed to fetch agents.", { success: false });
          }

          // 2. Filter to reviewer agents (role contains "Reviewer")
          const reviewerAgents = agents.filter(
            (a: any) => a.role && a.role.toLowerCase().includes("reviewer")
          );

          if (reviewerAgents.length === 0) {
            return textResult("No reviewer agents registered in the system. Please register reviewer agents first.", { success: false });
          }

          // 3. Determine task domain from skills
          let taskDomain: "frontend" | "backend" | "unknown" = "unknown";
          try {
            const skillsResult = await apiCall(`skills.getByTask?input=${encodeURIComponent(JSON.stringify({ taskId: args.taskId }))}`);
            const skills = Array.isArray(skillsResult?.result?.data) ? skillsResult.result.data :
                           (Array.isArray(skillsResult?.result) ? skillsResult.result : []);
            if (skills.length > 0) {
              taskDomain = classifyDomain(skills);
            }
          } catch {
            // Skills fetch failed — fall back to unknown domain
          }

          // 4. Fetch all tasks in the project to count review assignments
          const tasksParams: any = { projectKey: effectiveProjectKey, limit: 100 };
          const tasksResult = await apiCall("tasks.list", "GET", tasksParams);
          const tasks = tasksResult?.result?.data?.items;
          if (!Array.isArray(tasks)) {
            return textResult("Failed to fetch tasks for workload analysis.", { success: false });
          }

          // 5. Count review-assigned tasks per reviewer (where they are reviewerId, in active review states)
          const reviewCounts: Record<string, number> = {};
          for (const task of tasks) {
            const reviewerId = task.reviewerId;
            if (!reviewerId) continue;
            if (["review", "in_testing", "in_releasing"].includes(task.status)) {
              reviewCounts[reviewerId] = (reviewCounts[reviewerId] || 0) + 1;
            }
          }

          // 6. Filter reviewers by domain (if domain is known)
          let candidates = reviewerAgents.filter((a: any) => {
            if (args.excludeAgentId && a.id === args.excludeAgentId) return false;
            if (taskDomain !== "unknown") {
              return getReviewerDomain(a.role) === taskDomain;
            }
            return true;
          });

          // 7. If no domain-specific reviewers found, fall back to ALL reviewers
          if (candidates.length === 0) {
            candidates = reviewerAgents.filter((a: any) => {
              if (args.excludeAgentId && a.id === args.excludeAgentId) return false;
              return true;
            });
          }

          // 8. Sort by review count (ascending) — fewest reviews first
          const sorted = candidates.map((a: any) => ({
            id: a.id,
            name: a.name,
            emoji: a.emoji,
            role: a.role,
            reviewCount: reviewCounts[a.id] || 0,
            domain: getReviewerDomain(a.role),
          })).sort((a: any, b: any) => a.reviewCount - b.reviewCount);

          if (sorted.length === 0) {
            return textResult("No available reviewers found.", { success: false });
          }

          const picked = sorted[0];
          const domainLabel = taskDomain !== "unknown" ? ` (${taskDomain} domain)` : "";
          return textResult(
            `Suggested reviewer${domainLabel}: ${picked.emoji} ${picked.name} (${picked.reviewCount} active reviews, ${picked.role}).\nOther options: ${sorted.slice(1).map((a: any) => `${a.emoji} ${a.name} (${a.reviewCount})`).join(", ")}`,
            {
              success: true,
              reviewer: {
                agentId: picked.id,
                agentName: picked.name,
                agentEmoji: picked.emoji,
                reviewCount: picked.reviewCount,
                domain: picked.domain,
              },
              taskDomain,
              allReviewers: sorted,
            },
          );
        } catch (error) {
          return textResult(`Failed to pick reviewer: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Create task ──

    api.registerTool({
      name: "clawtrack_create_task",
      label: "Create ClawTrack task",
      description: "Create a new task in ClawTrack with support for task type, skills, and attachments. Auto-detects type from title prefix: [EPIC] → epic, [FEATURE] → feature, [BUG] → bug, [CHORE] → chore. Extracts URLs from description as attachments.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title. Prefix with [EPIC], [FEATURE], [BUG], or [CHORE] to auto-set taskType." },
          description: { type: "string", description: "Task description. URLs found here will be auto-extracted as attachments." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority (default: medium)" },
          taskType: { type: "string", enum: ["task", "epic", "feature", "bug", "chore"], description: "Task type override. Auto-detected from title prefix if omitted." },
          skills: { type: "array", items: { type: "string" }, description: "Skill names to associate (e.g., ['TypeScript', 'React'])" },
          assigneeId: { type: "string", description: "Agent ID to assign (defaults to yourself)" },
          projectId: { type: "string", description: "Project ID to associate the task with" },
        },
        required: ["title"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          // Auto-detect taskType from title prefix
          let taskType = args.taskType;
          let cleanTitle = args.title;
          const prefixMatch = args.title.match(/^\[(EPIC|FEATURE|BUG|CHORE)\]\s*/i);
          if (prefixMatch) {
            const detected = prefixMatch[1].toLowerCase();
            if (!taskType) taskType = detected;
            cleanTitle = args.title.slice(prefixMatch[0].length);
          }
          if (!taskType) taskType = "task";

          // Extract URLs from description as attachments
          const attachments: { url: string; fileName?: string }[] = [];
          if (args.description) {
            const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
            let match;
            while ((match = urlRegex.exec(args.description)) !== null) {
              attachments.push({ url: match[0] });
            }
          }

          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: "new",
            title: cleanTitle,
            description: args.description,
            priority: args.priority || "medium",
            taskType,
            skills: args.skills || undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            assigneeId: args.assigneeId || resolveAgentId(_toolCallId),
            projectId: args.projectId || getActiveProject(resolveSessionKey(_toolCallId))?.id || undefined,
            agentId: resolveAgentId(_toolCallId),
          });

          return textResult(
            `Task created: ${cleanTitle} (type: ${taskType}, priority: ${args.priority || "medium"})${attachments.length > 0 ? `, ${attachments.length} attachment(s)` : ""}${args.skills?.length ? `, ${args.skills.length} skill(s)` : ""}`,
            { success: true, task: result.result?.task },
          );
        } catch (error) {
          return textResult(`Failed to create task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Log activity ──

    api.registerTool({
      name: "clawtrack_log_activity",
      label: "Log ClawTrack activity",
      description: "Log an activity entry in ClawTrack (e.g., tool_called, task_created, agent_message).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Optional: associated task ID" },
          type: { type: "string", description: "Activity type (e.g., tool_called, task_created, agent_message)" },
          description: { type: "string", description: "Human-readable description of the activity" },
        },
        required: ["type", "description"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await webhookCall({
            type: "activity",
            activityType: args.type,
            description: args.description,
            taskId: args.taskId,
          });
          return textResult("Activity logged.", { success: true, activityId: result.activityId });
        } catch (error) {
          return textResult(`Failed to log activity: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Add worklog entry ──

    api.registerTool({
      name: "clawtrack_worklog_add",
      label: "Add worklog entry",
      description: "Add a worklog entry to a ClawTrack task. Use for state transitions, progress updates, review notes, QA results, and any significant task activity. Every state transition MUST have a worklog entry.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          content: { type: "string", description: "Full markdown content of the worklog entry. Be specific and complete." },
          action: { type: "string", description: "Brief one-line summary of the entry's purpose (e.g., 'Started implementation', 'State transition: in_progress -> review')" },
        },
        required: ["taskId", "content"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall("tasks.worklogWebhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            content: args.content,
            action: args.action,
            agentId: resolveAgentId(_toolCallId),
          });
          return textResult("Worklog entry added.", { success: true, entryId: result.result?.data?.id });
        } catch (error) {
          return textResult(`Failed to add worklog entry: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: List worklog entries ──

    api.registerTool({
      name: "clawtrack_worklog_list",
      label: "List worklog entries",
      description: "View the worklog history for a ClawTrack task. Use this before reviewing or testing a task to understand what was done. Returns entries in reverse chronological order.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          limit: { type: "number", description: "Maximum entries to return (default: 20)" },
        },
        required: ["taskId"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall("tasks.worklog.list", "GET", {
            taskId: args.taskId,
            limit: args.limit || 20,
            secret: config.webhookSecret,
          });
          const items = result.result?.data?.items || [];
          if (items.length === 0) {
            return textResult("No worklog entries found for this task.", { entries: 0 });
          }
          const formatted = items.map((e: any) => {
            const agent = e.agent ? `${e.agent.emoji} ${e.agent.name}` : "Unknown";
            const time = new Date(e.createdAt).toISOString().replace("T", " ").substring(0, 16);
            const action = e.metadata?.action || e.description?.substring(0, 60);
            return `[${time}] ${agent} (${e.agent?.role || "unknown"}): ${action}`;
          });
          return textResult(`Worklog (${items.length} entries):\n${formatted.join("\n")}`, {
            entries: items.length,
            items: items.map((e: any) => ({ id: e.id, content: e.description, agent: e.agent?.name, createdAt: e.createdAt })),
          });
        } catch (error) {
          return textResult(`Failed to list worklog: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Block task ──

    api.registerTool({
      name: "clawtrack_block_task",
      label: "Block ClawTrack task",
      description: "Move a task to 'blocked' status with a reason. Use when you are the assignee and cannot proceed due to an external dependency. This will notify the Tech Lead. You MUST add a worklog entry via clawtrack_worklog_add BEFORE calling this.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          reason: { type: "string", description: "Why the task is blocked. Include: what dependency is needed, impact of delay, and any attempted workarounds." },
        },
        required: ["taskId", "reason"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const agentId = resolveAgentId(_toolCallId);
          // Move to blocked
          const result = await apiCall("tasks.webhook", "POST", {
            json: {
              secret: config.webhookSecret,
              taskId: args.taskId,
              agentId,
              status: "blocked",
            }
          });

          // Post reason as worklog via message
          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: `🚫 **Task Blocked**\n\n**Reason:** ${args.reason}\n\nTech Lead (John) has been notified. Awaiting unblock confirmation.`,
            agentId,
          });

          return textResult(
            `Task moved to Blocked. Reason: ${args.reason.substring(0, 100)}. Tech Lead will be notified.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to block task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Unblock task ──

    api.registerTool({
      name: "clawtrack_unblock_task",
      label: "Unblock ClawTrack task",
      description: "Move a blocked task back to 'in_progress'. ONLY Tech Lead should confirm the blocker is resolved before this is called. The assignee should call this after Tech Lead confirmation.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          resolution: { type: "string", description: "How the blocker was resolved. Who confirmed it and what changed." },
        },
        required: ["taskId", "resolution"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const agentId = resolveAgentId(_toolCallId);
          // Move to in_progress
          const result = await apiCall("tasks.webhook", "POST", {
            json: {
              secret: config.webhookSecret,
              taskId: args.taskId,
              agentId,
              status: "in_progress",
            }
          });

          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: `✅ **Task Unblocked**\n\n**Resolution:** ${args.resolution}\n\nResuming work.`,
            agentId,
          });

          return textResult(
            `Task unblocked and moved to In Progress. Resolution: ${args.resolution.substring(0, 100)}.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to unblock task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: QA Review ──

    api.registerTool({
      name: "clawtrack_qa_review",
      label: "QA review ClawTrack task",
      description: "QA (Ted) approves or rejects a task that is in_testing. Approving moves to in_releasing; rejecting sends back to in_progress with reproduction steps. MUST add a worklog entry with test results via clawtrack_worklog_add BEFORE calling this.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          decision: { type: "string", enum: ["approve", "reject"], description: "Whether QA approves or rejects" },
          testResults: { type: "string", description: "Test results: what was tested, pass/fail for each acceptance criterion. Required for both approve and reject." },
          reproductionSteps: { type: "string", description: "Step-by-step reproduction steps. Required when rejecting." },
        },
        required: ["taskId", "decision", "testResults"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const agentId = resolveAgentId(_toolCallId);
          const newStatus = args.decision === "approve" ? "in_releasing" : "in_progress";
          const result = await apiCall("tasks.webhook", "POST", {
            json: {
              secret: config.webhookSecret,
              taskId: args.taskId,
              agentId,
              status: newStatus,
            }
          });

          const commentText = args.decision === "approve"
            ? `🧪 **QA Approved**\n\n**Test Results:** ${args.testResults}\n\nReady for release. Assignee: please deploy and verify.`
            : `🧪 **QA Rejected**\n\n**Test Results:** ${args.testResults}\n\n**Reproduction Steps:** ${args.reproductionSteps || "Not provided"}\n\nSending back to assignee for fixes.`;

          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: commentText,
            agentId,
          });

          return textResult(
            args.decision === "approve"
              ? `QA approved. Task moved to In Releasing. Assignee should deploy and verify.`
              : `QA rejected. Task sent back to In Progress with reproduction steps.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to QA review: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Release task ──

    api.registerTool({
      name: "clawtrack_release_task",
      label: "Release ClawTrack task",
      description: "Assignee confirms deployment of a task in in_releasing status. On success moves to done; on failure moves back to in_progress. MUST add a worklog entry via clawtrack_worklog_add BEFORE calling this.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          success: { type: "boolean", description: "Whether the deployment succeeded (true → done) or failed (false → in_progress)" },
          deployDetails: { type: "string", description: "Deployment details: what was deployed, where, and verification results. Required." },
          failureDetails: { type: "string", description: "If deploy failed: what went wrong, error messages, and next steps. Required when success=false." },
        },
        required: ["taskId", "success", "deployDetails"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const agentId = resolveAgentId(_toolCallId);
          const newStatus = args.success ? "done" : "in_progress";
          const result = await apiCall("tasks.webhook", "POST", {
            json: {
              secret: config.webhookSecret,
              taskId: args.taskId,
              agentId,
              status: newStatus,
            }
          });

          const commentText = args.success
            ? `🚀 **Deployed Successfully**\n\n**Details:** ${args.deployDetails}\n\nTask complete.`
            : `❌ **Deploy Failed**\n\n**Details:** ${args.deployDetails}\n**Failure:** ${args.failureDetails || "Not provided"}\n\nSending back to in_progress for fixes. Tech Lead has been notified.`;

          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: commentText,
            agentId,
          });

          return textResult(
            args.success
              ? `Deploy verified. Task moved to Done. 🎉`
              : `Deploy failed. Task moved back to In Progress. Fix and re-submit through review.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to release task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Send message (via REST webhook) ──

    api.registerTool({
      name: "clawtrack_send_message_v2",
      label: "Send message to task (v2)",
      description: "Send a message to a ClawTrack task's chat thread via the unified REST endpoint. Use this when you want the message to also appear in channel-based messaging.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          message: { type: "string", description: "The message to send" },
        },
        required: ["taskId", "message"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await webhookCall({
            type: "message",
            taskId: args.taskId,
            message: args.message,
          });
          return textResult("Message sent.", { success: true, messageId: result.messageId });
        } catch (error) {
          return textResult(`Failed to send message: ${error}`, { success: false });
        }
      },
    });

    // ════════════════════════════════════════════
    // Channel Tools (if channels enabled)
    // ════════════════════════════════════════════

    if (config.channelsEnabled) {
      // ── Tool: List channels ──

      api.registerTool({
        name: "clawtrack_list_channels",
        label: "List ClawTrack channels",
        description: "List accessible channels in ClawTrack. Filter by type or project.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["dm", "group", "project", "task"], description: "Optional: filter by channel type" },
            projectId: { type: "string", description: "Optional: filter by project ID" },
          },
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const input: any = { limit: 50 };
            if (args.type) input.type = args.type;
            if (args.projectId) input.projectId = args.projectId;
            const result = await apiCall(`channels.list?input=${encodeURIComponent(JSON.stringify(input))}`);
            return textResult(JSON.stringify(result.result, null, 2), { success: true });
          } catch (error) {
            return textResult(`Failed to list channels: ${error}`, { success: false });
          }
        },
      });

      // ── Tool: Get channel details ──

      api.registerTool({
        name: "clawtrack_get_channel",
        label: "Get ClawTrack channel details",
        description: "Get details about a specific channel including recent messages.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "The channel ID" },
          },
          required: ["channelId"],
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const [channelResult, messagesResult] = await Promise.all([
              apiCall(`channels.getById?input=${encodeURIComponent(JSON.stringify({ id: args.channelId }))}`),
              apiCall(`channelMessages.list?input=${encodeURIComponent(JSON.stringify({ channelId: args.channelId, limit: 20 }))}`),
            ]);
            return textResult(JSON.stringify({ channel: channelResult.result, recentMessages: messagesResult.result }, null, 2), { success: true });
          } catch (error) {
            return textResult(`Failed to get channel: ${error}`, { success: false });
          }
        },
      });

      // ── Tool: Send channel message ──

      api.registerTool({
        name: "clawtrack_send_channel_message",
        label: "Send ClawTrack channel message",
        description: "Send a message to a ClawTrack channel. Supports @mentions.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "The channel ID" },
            content: { type: "string", description: "The message to send. Use @name to mention agents." },
          },
          required: ["channelId", "content"],
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const result = await apiCall("channelMessages.webhook", "POST", {
              secret: config.webhookSecret,
              channelId: args.channelId,
              agentId: resolveAgentId(_toolCallId),
              content: args.content,
            });
            return textResult("Channel message sent.", { success: true, messageId: result.result?.messageId });
          } catch (error) {
            return textResult(`Failed to send channel message: ${error}`, { success: false });
          }
        },
      });

      // ── Tool: Create DM ──

      api.registerTool({
        name: "clawtrack_create_dm",
        label: "Create ClawTrack DM channel",
        description: "Create or get a direct message channel with another agent or user.",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "The other agent's ID" },
          },
          required: ["agentId"],
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const result = await apiCall("channels.getOrCreateDM", "POST", {
              participantAId: resolveAgentId(_toolCallId),
              participantBId: args.agentId,
              participantAType: "agent",
              participantBType: "agent",
            });
            return textResult("DM channel ready.", { success: true, channel: result.result });
          } catch (error) {
            return textResult(`Failed to create DM: ${error}`, { success: false });
          }
        },
      });

      // ── Tool: Search messages ──

      api.registerTool({
        name: "clawtrack_search_messages",
        label: "Search ClawTrack messages",
        description: "Search for messages across channels in ClawTrack.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            channelId: { type: "string", description: "Optional: limit search to a specific channel" },
          },
          required: ["query"],
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const input: any = { query: args.query, limit: 20 };
            if (args.channelId) input.channelId = args.channelId;
            const result = await apiCall(`channelMessages.search?input=${encodeURIComponent(JSON.stringify(input))}`);
            return textResult(JSON.stringify(result.result, null, 2), { success: true });
          } catch (error) {
            return textResult(`Failed to search messages: ${error}`, { success: false });
          }
        },
      });

      // ── Tool: Add reaction ──

      api.registerTool({
        name: "clawtrack_add_reaction",
        label: "Add ClawTrack message reaction",
        description: "React to a message with an emoji (e.g., thumbs up, celebrate).",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID" },
            emoji: { type: "string", description: "The emoji reaction (e.g., 👍, 🎉, 🚀)" },
          },
          required: ["messageId", "emoji"],
        },
        execute: async (_toolCallId, args: any) => {
          try {
            const result = await apiCall("channelMessages.addReaction", "POST", {
              messageId: args.messageId,
              emoji: args.emoji,
              agentId: resolveAgentId(_toolCallId),
            });
            return textResult(`Reaction ${args.emoji} added.`, { success: true, reaction: result.result });
          } catch (error) {
            return textResult(`Failed to add reaction: ${error}`, { success: false });
          }
        },
      });
    }

    // ════════════════════════════════════════════
    // Hook: Mirror inter-agent messages
    // ════════════════════════════════════════════

    if (config.contextInjectionEnabled) {
      const NOISE_PATTERNS = [
        /^NO_REPLY$/i,
        /^REPLY_SKIP$/i,
        /^ANNOUNCE_SKIP$/i,
        /^ANNOUNCE:$/i,
        /^Agent-to-agent announce step/i,
        /^\[A2A\]/i,
      ];

      function isNoiseMessage(content: string): boolean {
        const trimmed = content.trim();
        return NOISE_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length === 0;
      }

      async function mirrorToClawTrack(sourceAgent: string, targetAgent: string, content: string) {
        const sourceAgentId = sourceAgent.startsWith("agent-") ? sourceAgent : `agent-${sourceAgent}`;
        const targetAgentId = targetAgent.startsWith("agent-") ? targetAgent : `agent-${targetAgent}`;

        try {
          const result = await apiCall("channelMessages.mirrorAgentMessage", "POST", {
            secret: config.webhookSecret,
            senderAgentId: sourceAgentId,
            receiverAgentId: targetAgentId,
            content,
          });
          api.logger.info(`clawtrack: mirror API response: ${JSON.stringify(result)}`);
        } catch (err) {
          api.logger.error(`clawtrack: mirror API failed: ${err}`);
          throw err;
        }
      }

      // Track the last inter-session source agent per session, so we can
      // mirror the response back even when OpenClaw doesn't deliver it.
      // Keyed by session ID; value is the agent name that sent the message.
      const pendingInterSessionSource = new Map<string, string>();

      function extractTextContent(raw: any): string {
        if (!raw) return "";
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) {
          return raw
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }
        return "";
      }

      // ── Hook: Mirror inter-agent messages (both directions) ──
      // Uses before_message_write which fires for ALL messages written to
      // a session — both incoming inter-session messages AND the agent's own
      // assistant responses. This is the only hook that reliably captures
      // agent-to-agent communication regardless of delivery timing.
      //
      // Part 1: When an inter-session USER message arrives (Agent A -> Agent B),
      //         mirror it to ClawTrack and remember the source agent.
      // Part 2: When the agent writes an ASSISTANT response, if there's a pending
      //         inter-session source, mirror the response back to that source.

      api.on("before_message_write", (event, ctx) => {
        const message = event.message as any;
        if (!message) return;

        const sessionId = resolveSessionKey(_toolCallId);

        if (message.role === "user") {
          // ── Project Lens: auto-detect [PROJECT: KEY — Name] tags ──
          let content = extractTextContent(message?.content);
          if (content) {
            const parsed = parseProjectFromContent(content);
            if (parsed && sessionId) {
              const previous = getActiveProject(sessionId);
              if (previous?.key !== parsed.key) {
                // Fetch full project details via tRPC
                apiCall("projects.getByKey", "GET", { key: parsed.key }).then((full) => {
                  const proj = full?.result?.data?.project;
                  if (proj?.key) {
                    parsed.id = proj.id;
                    parsed.description = proj.description;
                    parsed.tech_stack = proj.techStack;
                    parsed.conventions = proj.conventions;
                    setActiveProject(sessionId, parsed);
                    writeProjectContextFile(parsed);
                    const switchMsg = previous
                      ? `[PROJECT SWITCH] ${previous.key} → ${parsed.key}: ${parsed.name}`
                      : `[PROJECT ACTIVATED] ${parsed.key}: ${parsed.name}`;
                    api.logger.info(`clawtrack: ${switchMsg}`);
                  }
                }).catch((err) => api.logger.error(`clawtrack: failed to fetch project details: ${err}`));
              }
            }
          }

          // Part 1: Capture incoming inter-session messages
          const provenance = message?.provenance;
          if (provenance?.kind !== "inter_session") return;

          if (!content) return;

          content = content.replace(/^\[.*?\]\s*/, "");

          if (isNoiseMessage(content)) return;

          const sourceAgentName = provenance.sourceSessionKey?.split(":")[1];
          const targetAgentName = ctx?.agentId ?? api.session?.agentId;

          if (!sourceAgentName || !targetAgentName) return;

          // Track who sent the last inter-session message to this session
          if (sessionId) {
            pendingInterSessionSource.set(sessionId, sourceAgentName);
          }

          api.logger.info(`clawtrack: mirroring ${sourceAgentName} -> ${targetAgentName}: "${content.substring(0, 80)}"`);

          mirrorToClawTrack(sourceAgentName, targetAgentName, content).catch((err) => {
            api.logger.error(`clawtrack: failed to mirror message: ${err}`);
          });
        } else if (message.role === "assistant") {
          // Part 2: Capture outgoing responses to inter-session messages
          // Only mirror pure text responses (skip tool-call messages)
          const rawContent = message?.content;
          const hasToolUse = Array.isArray(rawContent) &&
            rawContent.some((b: any) => b.type === "tool_use");
          if (hasToolUse) return;

          let content = extractTextContent(rawContent);
          if (!content || isNoiseMessage(content)) return;

          const sourceAgentName = sessionId ? pendingInterSessionSource.get(sessionId) : undefined;
          if (!sourceAgentName) return;

          const targetAgentName = ctx?.agentId ?? api.session?.agentId;
          if (!targetAgentName) return;

          // Clear the pending source so we don't re-mirror subsequent messages
          pendingInterSessionSource.delete(sessionId);

          api.logger.info(`clawtrack: mirroring response ${targetAgentName} -> ${sourceAgentName}: "${content.substring(0, 80)}"`);

          mirrorToClawTrack(targetAgentName, sourceAgentName, content).catch((err) => {
            api.logger.error(`clawtrack: failed to mirror response: ${err}`);
          });
        }
      });
    }

    // ════════════════════════════════════════════
    // Event-Driven Hooks: Passive observation + Live Status
    // ════════════════════════════════════════════

    // ── Hook: Agent starts processing (thinking) ──
    api.on("before_agent_start", (event, ctx) => {
      const prompt = typeof (event as any).prompt === "string"
        ? (event as any).prompt.substring(0, 200)
        : undefined;

      webhookCall({
        type: "agent_status",
        status: "thinking",
        prompt,
      }).catch((err) => api.logger.error(`clawtrack: before_agent_start hook failed: ${err}`));
    });

    // ── Hook: LLM call about to happen (processing) ──
    api.on("llm_input", (event, ctx) => {
      webhookCall({
        type: "agent_status",
        status: "processing",
        model: event.model,
        provider: event.provider,
        runId: event.runId,
      }).catch((err) => api.logger.error(`clawtrack: llm_input hook failed: ${err}`));
    });

    // ── Hook: LLM responded ──
    api.on("llm_output", (event, ctx) => {
      webhookCall({
        type: "agent_status",
        status: "llm_output",
        agentId: ctx?.agentId ?? resolveAgentId(_toolCallId),
        model: event.model,
        provider: event.provider,
        usage: event.usage,
        runId: event.runId,
      }).catch((err) => api.logger.error(`clawtrack: llm_output hook failed: ${err}`));
    });

    // ── Hook: Auto-log all tool calls as ClawTrack activities + live status ──
    api.on("after_tool_call", (event, ctx) => {
      const paramsPreview = JSON.stringify(event.params ?? {}).substring(0, 200);
      const description = event.error
        ? `${event.toolName} failed: ${event.error}`
        : `${event.toolName}(${paramsPreview})`;

      // Legacy: store as activity
      webhookCall({
        type: "activity",
        activityType: "tool_called",
        description,
        metadata: {
          toolName: event.toolName,
          success: !event.error,
          durationMs: event.durationMs,
          runId: event.runId,
        },
      }).catch((err) => api.logger.error(`clawtrack: after_tool_call hook failed: ${err}`));

      // New: broadcast as agent status for live feed
      webhookCall({
        type: "agent_status",
        status: "tool_call",
        toolName: event.toolName,
        durationMs: event.durationMs,
        success: !event.error,
        error: event.error,
        runId: event.runId,
      }).catch((err) => api.logger.error(`clawtrack: after_tool_call status hook failed: ${err}`));
    });

    // ── Hook: Track agent run completion → idle ──
    api.on("agent_end", (event, ctx) => {
      // Legacy: track run end
      webhookCall({
        type: "agent_run_end",
        agentId: ctx?.agentId ?? resolveAgentId(_toolCallId),
        success: event.success,
        durationMs: event.durationMs,
        error: event.error,
        trigger: ctx?.trigger,
      }).catch((err) => api.logger.error(`clawtrack: agent_end hook failed: ${err}`));

      // New: set agent to idle
      webhookCall({
        type: "agent_status",
        status: "idle",
        success: event.success,
        durationMs: event.durationMs,
        error: event.error,
      }).catch((err) => api.logger.error(`clawtrack: agent_end status hook failed: ${err}`));
    });

    // ── Hook: Message received ──
    api.on("message_received", (event, ctx) => {
      const content = extractTextContent((event as any).message?.content);
      if (!content) return;

      webhookCall({
        type: "agent_status",
        status: "message_received",
        content,
        from: (event as any).message?.provenance?.sourceSessionKey?.split(":")[1],
      }).catch((err) => api.logger.error(`clawtrack: message_received hook failed: ${err}`));
    });

    // ── Hook: Message sent ──
    api.on("message_sent", (event, ctx) => {
      const content = extractTextContent((event as any).message?.content);
      if (!content) return;

      webhookCall({
        type: "agent_status",
        status: "message_sent",
        content,
        to: (event as any).message?.to,
      }).catch((err) => api.logger.error(`clawtrack: message_sent hook failed: ${err}`));
    });

    // ── Hook: Session start → heartbeat (agent is alive) ──
    api.on("session_start", (_event, ctx) => {
      webhookCall({
        type: "agent_status",
        status: "idle",
      }).catch((err) => api.logger.error(`clawtrack: session_start hook failed: ${err}`));
    });

    // ── Hook: Session end → mark as idle ──
    api.on("session_end", (_event, ctx) => {
      webhookCall({
        type: "agent_status",
        status: "idle",
      }).catch((err) => api.logger.error(`clawtrack: session_end hook failed: ${err}`));
    });

    // ════════════════════════════════════════════
    // Project Lens: Prompt context injection + project switching
    // ════════════════════════════════════════════

    // ── Hook: Inject project context into system prompt (async — fetches fresh data) ──
    api.on("before_prompt_build", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? "";
      const project = getActiveProject(sessionKey);
      if (!project) return;

      // Fetch fresh project details via tRPC
      let freshProject = project;
      let taskSummary: string | undefined;
      try {
        const projectData = await apiCall("projects.getByKey", "GET", { key: project.key });
        if (projectData?.result?.data?.project) {
          const proj = projectData.result.data.project;
          freshProject = {
            id: proj.id,
            key: proj.key,
            name: proj.name,
            description: proj.description,
            tech_stack: proj.techStack,
            conventions: proj.conventions,
          };
          // Refresh cached project info
          setActiveProject(sessionKey, freshProject);
        }

        // Fetch task summary for this agent in this project
        const agentId = ctx?.agentId ? `agent-${ctx.agentId}` : "unknown";
        const tasksData = await apiCall("tasks.list", "GET", {
          projectKey: project.key,
          assigneeId: agentId,
          limit: 50
        });
        if (tasksData?.result?.data?.items && Array.isArray(tasksData.result.data.items)) {
          const tasks = tasksData.result.data.items;
          const byStatus: Record<string, number> = {};
          for (const t of tasks) {
            byStatus[t.status] = (byStatus[t.status] || 0) + 1;
          }
          const parts: string[] = [];
          if (tasks.length > 0) {
            parts.push(`Your tasks in ${project.key}: ${tasks.length} total`);
            for (const [status, count] of Object.entries(byStatus)) {
              parts.push(`  ${count} ${status}`);
            }
          }
          taskSummary = parts.join("\n");
        }
      } catch (err) {
        // If fetch fails, fall back to cached project info without task summary
        api.logger.warn(`clawtrack: failed to fetch fresh project context: ${err}`);
      }

      return {
        appendSystemContext: buildProjectContextBlock(freshProject, taskSummary),
      };
    });

    // ── Tool: Switch active project ──
    api.registerTool({
      name: "clawtrack_set_project",
      label: "Switch active project",
      description: "Switch to a different project. All clawtrack operations will be scoped to this project. Call without arguments to see the current active project and available projects.",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "The project key to switch to (e.g. CLAW). Omit to see current project." },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = resolveSessionKey(_toolCallId);

          // No argument: show current project + list available
          if (!args.projectKey) {
            const current = getActiveProject(sessionKey);
            const projectsResult = await apiCall("projects.list", "GET", { limit: 50 });
            const projects = projectsResult?.result?.data?.items || [];
            const list = (Array.isArray(projects) ? projects : []).map((p: any) => {
              const active = current?.key === p.key ? " (ACTIVE)" : "";
              return `  ${p.key}: ${p.name} (${p._count?.tasks || 0} tasks)${active}`;
            }).join("\n");
            const header = current
              ? `Current project: ${current.key} — ${current.name}\n\nAvailable projects:\n${list}`
              : `No active project.\n\nAvailable projects:\n${list}`;
            return textResult(header);
          }

          // Fetch project details via tRPC
          const targetResult = await apiCall("projects.getByKey", "GET", { key: args.projectKey });
          const target = targetResult?.result?.data?.project;
          if (!target || !target.key) {
            return textResult(`Project "${args.projectKey}" not found. Call without arguments to see available projects.`);
          }

          const projectInfo: ProjectInfo = {
            id: target.id,
            key: target.key,
            name: target.name,
            description: target.description,
            tech_stack: target.techStack,
            conventions: target.conventions,
          };

          const previous = setActiveProject(sessionKey, projectInfo);

          // Update PROJECT_CONTEXT.md
          await writeProjectContextFile(projectInfo);

          const switchMsg = previous
            ? `[PROJECT SWITCH] ${previous.key} → ${projectInfo.key}: ${projectInfo.name}`
            : `[PROJECT ACTIVATED] ${projectInfo.key}: ${projectInfo.name}`;

          return textResult(`${switchMsg}\nAll clawtrack operations are now scoped to ${projectInfo.key}.`);
        } catch (error) {
          return textResult(`Failed to switch project: ${error}`);
        }
      },
    });

    // ── Helper: Write PROJECT_CONTEXT.md to workspace ──
    async function writeProjectContextFile(project: ProjectInfo) {
      try {
        const workspaceDir = api.session?.workspaceDir ?? api.resolvePath(".");
        if (!workspaceDir) return;
        const fs = await import("node:fs/promises");
        const filePath = `${workspaceDir}/PROJECT_CONTEXT.md`;
        const sections: string[] = [
          `# Active Project: ${project.key}`,
          `## ${project.name}`,
        ];
        if (project.description) {
          sections.push("", project.description);
        }
        if (project.tech_stack) {
          sections.push("", "### Tech Stack", project.tech_stack);
        }
        if (project.conventions) {
          sections.push("", "### Conventions", project.conventions);
        }
        sections.push("", "Use `clawtrack_list_tasks` to see your assigned work in this project.");
        await fs.writeFile(filePath, sections.join("\n") + "\n", "utf-8");
        api.logger.info(`clawtrack: wrote PROJECT_CONTEXT.md for ${project.key}`);
      } catch (err) {
        api.logger.error(`clawtrack: failed to write PROJECT_CONTEXT.md: ${err}`);
      }
    }

    // ── Log registered tools ──

    const toolNames = [
      "clawtrack_send_message",
      "clawtrack_get_task",
      "clawtrack_reply_to_task",
      "clawtrack_update_task_status",
      "clawtrack_get_project_tasks",
      "clawtrack_list_tasks",
      "clawtrack_update_task",
      "clawtrack_review_task",
      "clawtrack_pick_reviewer",
      "clawtrack_log_activity",
      "clawtrack_worklog_add",
      "clawtrack_worklog_list",
      "clawtrack_block_task",
      "clawtrack_unblock_task",
      "clawtrack_qa_review",
      "clawtrack_release_task",
      "clawtrack_send_message_v2",
      "clawtrack_create_task",
      "clawtrack_set_project",
    ];

    if (config.channelsEnabled) {
      toolNames.push(
        "clawtrack_list_channels",
        "clawtrack_get_channel",
        "clawtrack_send_channel_message",
        "clawtrack_create_dm",
        "clawtrack_search_messages",
        "clawtrack_add_reaction"
      );
    }

    api.logger.info(`clawtrack: tools registered (${toolNames.join(", ")})`);
  },
});
