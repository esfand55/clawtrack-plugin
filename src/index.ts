import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

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

    // ── Helper: resolve agent ID ──

    function resolveAgentId(): string {
      const rawId = api.session?.agentId;
      if (!rawId) return "unknown";
      if (rawId.startsWith("agent-")) return rawId;
      return `agent-${rawId}`;
    }

    // ── Helper: make authenticated API call (tRPC) ──

    async function apiCall(endpoint: string, method: string = "GET", body?: any): Promise<any> {
      const url = `${config.clawtrackUrl}/api/trpc/${endpoint}`;
      const options: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      if (method === "POST" && body) {
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
        body: JSON.stringify({ ...body, secret: config.webhookSecret, agentId: resolveAgentId() }),
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
      return { key: match[1], name: match[2], description: null };
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
      lines.push("## Task Workflow (MANDATORY — follow this on every task)");
      lines.push("1. Pick work: call clawtrack_list_tasks({ includeBacklog: true }) to see unassigned backlog tasks, self-assign the highest priority one");
      lines.push("2. ONE TASK AT A TIME — never start a second task while one is in_progress");
      lines.push("3. Move picked task to 'todo', sort your todo list by priority, start the top one → 'in_progress'");
      lines.push("4. When done: call clawtrack_pick_reviewer() to find the least busy engineer, set them as reviewer");
      lines.push("5. Set reviewer via clawtrack_update_task(taskId, { reviewerId: '...' })");
      lines.push("6. Move to 'review' via clawtrack_update_task_status(taskId, 'review') and message the reviewer");
      lines.push("7. NEVER call clawtrack_update_task_status(taskId, 'done') — only reviewers approve tasks via clawtrack_review_task()");
      lines.push("8. If you are the assigned reviewer: finish your current task first (no context switching), then review");
      lines.push("9. Use clawtrack_review_task(taskId, decision, feedback) to approve or reject");
      lines.push("10. If you reject: explain clearly what needs to change so the assignee can fix it");
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
        try {
          const result = await apiCall("comments.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(),
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
            agentId: resolveAgentId(),
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
      description: "Update the status of a ClawTrack task. RULES: (1) You CANNOT go directly to 'done' — tasks must go through review first. (2) To move to 'review', you must first assign a reviewer via clawtrack_update_task. Valid flow: backlog → todo → in_progress → review → done.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "The new status" },
        },
        required: ["taskId", "status"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            status: args.status,
            agentId: resolveAgentId(),
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
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: filter by status" },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = api.session?.sessionKey ?? "";
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = args.projectKey || project?.key;
          if (!effectiveProjectKey) {
            return textResult("No active project set. Provide a projectKey or activate a project with clawtrack_set_project.", { success: false });
          }
          const params = new URLSearchParams({ project_key: effectiveProjectKey, limit: "50" });
          if (args.status) params.set("status", args.status);
          const result = await restGet(`/api/v1/tasks/?${params}`);
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
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: filter by status" },
          projectKey: { type: "string", description: "Optional: override the active project filter" },
          limit: { type: "number", description: "Maximum tasks to return (default: 50)" },
          includeBacklog: { type: "boolean", description: "If true, also return unassigned backlog tasks you can pick up" },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = api.session?.sessionKey ?? "";
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = args.projectKey || project?.key;

          // Fetch tasks assigned to this agent
          const params = new URLSearchParams({ agent_id: resolveAgentId(), limit: String(args.limit || 50) });
          if (args.status) params.set("status", args.status);
          if (effectiveProjectKey) params.set("project_key", effectiveProjectKey);
          const result = await restGet(`/api/v1/tasks/?${params}`);

          // If includeBacklog, also fetch unassigned backlog tasks
          if (args.includeBacklog && effectiveProjectKey) {
            const backlogParams = new URLSearchParams({ project_key: effectiveProjectKey, status: "backlog", limit: "20" });
            const backlogResult = await restGet(`/api/v1/tasks/?${backlogParams}`);
            if (backlogResult?.data && Array.isArray(backlogResult.data)) {
              const unassigned = backlogResult.data.filter((t: any) => !t.assignee_id && !t.assigneeId);
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
      description: "Update a ClawTrack task's status, description, priority, and/or reviewer in a single call.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: new status" },
          description: { type: "string", description: "Optional: new description" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Optional: new priority" },
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
            agentId: resolveAgentId(),
          };
          if (args.status) webhookBody.status = args.status;
          if (args.priority) webhookBody.priority = args.priority;
          if (args.reviewerId !== undefined) webhookBody.reviewerId = args.reviewerId || null;
          if (args.taskType) webhookBody.taskType = args.taskType;
          if (args.skills) webhookBody.skills = args.skills;
          const result = await apiCall("tasks.webhook", "POST", webhookBody);
          const updates: string[] = [];
          if (args.status) updates.push(`status → ${args.status}`);
          if (args.priority) updates.push(`priority → ${args.priority}`);
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
      description: "Approve or reject a task that is under review. Call this when you are the assigned reviewer. Approving moves the task to Done; rejecting sends it back to In Progress with your feedback.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          decision: { type: "string", enum: ["approve", "reject"], description: "Whether to approve or reject the task" },
          feedback: { type: "string", description: "Feedback explaining your decision. Required when rejecting." },
        },
        required: ["taskId", "decision"],
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const newStatus = args.decision === "approve" ? "done" : "in_progress";
          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(),
            status: newStatus,
          });

          // Post feedback as a comment
          const commentText = args.decision === "approve"
            ? "Task approved."
            : `Changes requested: ${args.feedback || "No feedback provided."}`;

          await webhookCall({
            type: "message",
            taskId: args.taskId,
            role: "agent",
            content: commentText,
            agentId: resolveAgentId(),
          });

          return textResult(
            args.decision === "approve"
              ? `Task approved and moved to Done.`
              : `Task rejected and sent back to In Progress. Feedback sent.`,
            { success: true, task: result.result },
          );
        } catch (error) {
          return textResult(`Failed to review task: ${error}`, { success: false });
        }
      },
    });

    // ── Tool: Pick reviewer (find least busy engineer) ──

    api.registerTool({
      name: "clawtrack_pick_reviewer",
      label: "Pick a reviewer for a task",
      description: "Find the best engineer to review a task. Returns the agent with the fewest active tasks (todo + in_progress). Excludes the specified agent (usually yourself). Use this when you need to assign a reviewer after completing work.",
      parameters: {
        type: "object",
        properties: {
          excludeAgentId: { type: "string", description: "Agent ID to exclude from reviewer selection (usually your own ID)" },
        },
      },
      execute: async (_toolCallId, args: any) => {
        try {
          const sessionKey = api.session?.sessionKey ?? "";
          const project = getActiveProject(sessionKey);
          const effectiveProjectKey = project?.key;

          if (!effectiveProjectKey) {
            return textResult("No active project set. Activate a project with clawtrack_set_project first.", { success: false });
          }

          // Fetch all tasks in the project to count per agent
          const params = new URLSearchParams({ project_key: effectiveProjectKey, limit: "100" });
          const result = await restGet(`/api/v1/tasks/?${params}`);
          const tasks = result?.data;
          if (!Array.isArray(tasks)) {
            return textResult("Failed to fetch tasks for workload analysis.", { success: false });
          }

          // Count active tasks per agent (todo + in_progress)
          const workload: Record<string, { count: number; name: string; emoji: string; id: string }> = {};
          for (const task of tasks) {
            const assigneeId = task.assignee_id || task.assigneeId;
            if (!assigneeId) continue;
            const status = task.status;
            if (status !== "todo" && status !== "in_progress") continue;
            if (assigneeId === args.excludeAgentId) continue;
            if (!workload[assigneeId]) {
              workload[assigneeId] = { count: 0, name: task.assignee_name || task.assignee?.name || assigneeId, emoji: task.assignee_emoji || task.assignee?.emoji || "👤", id: assigneeId };
            }
            workload[assigneeId].count++;
          }

          // Sort by task count (ascending) — least busy first
          const sorted = Object.values(workload).sort((a, b) => a.count - b.count);

          if (sorted.length === 0) {
            return textResult("No other agents with active tasks found in this project.", { success: false });
          }

          const picked = sorted[0];
          return textResult(
            `Suggested reviewer: ${picked.emoji} ${picked.name} (${picked.count} active tasks).\nOther options: ${sorted.slice(1).map(a => `${a.emoji} ${a.name} (${a.count})`).join(", ")}`,
            { success: true, reviewer: { agentId: picked.id, agentName: picked.name, agentEmoji: picked.emoji, taskCount: picked.count }, allAgents: sorted },
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
            assigneeId: args.assigneeId || resolveAgentId(),
            projectId: args.projectId,
            agentId: resolveAgentId(),
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
              agentId: resolveAgentId(),
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
              participantAId: resolveAgentId(),
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
              agentId: resolveAgentId(),
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

        const sessionId = api.session?.sessionKey ?? "";

        if (message.role === "user") {
          // ── Project Lens: auto-detect [PROJECT: KEY — Name] tags ──
          let content = extractTextContent(message?.content);
          if (content) {
            const parsed = parseProjectFromContent(content);
            if (parsed && sessionId) {
              const previous = getActiveProject(sessionId);
              if (previous?.key !== parsed.key) {
                // Fetch full project details from REST API
                restGet(`/api/v1/projects/${parsed.key}`).then((full) => {
                  if (full?.project_key) {
                    parsed.description = full.description;
                    parsed.tech_stack = full.tech_stack;
                    parsed.conventions = full.conventions;
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
        agentId: ctx?.agentId ?? resolveAgentId(),
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
        agentId: ctx?.agentId ?? resolveAgentId(),
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

      // Fetch fresh project details from REST API
      let freshProject = project;
      let taskSummary: string | undefined;
      try {
        const projectData = await restGet(`/api/v1/projects/${project.key}`);
        if (projectData) {
          freshProject = {
            key: projectData.project_key,
            name: projectData.name,
            description: projectData.description,
            tech_stack: projectData.tech_stack,
            conventions: projectData.conventions,
          };
          // Refresh cached project info
          setActiveProject(sessionKey, freshProject);
        }

        // Fetch task summary for this agent in this project
        const agentId = resolveAgentId();
        const tasksData = await restGet(
          `/api/v1/tasks/?project_key=${project.key}&agent_id=${encodeURIComponent(agentId)}&limit=50`
        );
        if (tasksData?.data && Array.isArray(tasksData.data)) {
          const tasks = tasksData.data;
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
          const sessionKey = api.session?.sessionKey ?? "";

          // No argument: show current project + list available
          if (!args.projectKey) {
            const current = getActiveProject(sessionKey);
            const projects = await restGet("/api/v1/projects/");
            const list = (Array.isArray(projects) ? projects : []).map((p: any) => {
              const active = current?.key === p.project_key ? " (ACTIVE)" : "";
              return `  ${p.project_key}: ${p.name} (${p.task_count} tasks)${active}`;
            }).join("\n");
            const header = current
              ? `Current project: ${current.key} — ${current.name}\n\nAvailable projects:\n${list}`
              : `No active project.\n\nAvailable projects:\n${list}`;
            return textResult(header);
          }

          // Fetch project details from REST API
          const target = await restGet(`/api/v1/projects/${args.projectKey}`);
          if (!target || !target.project_key) {
            return textResult(`Project "${args.projectKey}" not found. Call without arguments to see available projects.`);
          }

          const projectInfo: ProjectInfo = {
            key: target.project_key,
            name: target.name,
            description: target.description,
            tech_stack: target.tech_stack,
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
