var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// node_modules/openclaw/dist/config-schema-WTc54khc.js
function error(message) {
  return {
    success: false,
    error: { issues: [{
      path: [],
      message
    }] }
  };
}
function emptyPluginConfigSchema() {
  return {
    safeParse(value) {
      if (value === void 0) return {
        success: true,
        data: void 0
      };
      if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
      if (Object.keys(value).length > 0) return error("config must be empty");
      return {
        success: true,
        data: value
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  };
}

// node_modules/openclaw/dist/plugin-entry-BNczxv7M.js
function resolvePluginConfigSchema(configSchema = emptyPluginConfigSchema) {
  return typeof configSchema === "function" ? configSchema() : configSchema;
}
function definePluginEntry({ id, name, description, kind, configSchema = emptyPluginConfigSchema, register }) {
  return {
    id,
    name,
    description,
    ...kind ? { kind } : {},
    configSchema: resolvePluginConfigSchema(configSchema),
    register
  };
}

// src/index.ts
function resolveConfig(raw) {
  return {
    clawtrackUrl: typeof raw?.clawtrackUrl === "string" ? raw.clawtrackUrl : "",
    webhookSecret: typeof raw?.webhookSecret === "string" ? raw.webhookSecret : "",
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
    channelsEnabled: typeof raw?.channelsEnabled === "boolean" ? raw.channelsEnabled : true,
    contextInjectionEnabled: typeof raw?.contextInjectionEnabled === "boolean" ? raw.contextInjectionEnabled : true
  };
}
function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details
  };
}
var index_default = definePluginEntry({
  id: "clawtrack",
  name: "ClawTrack Integration",
  description: "Bidirectional integration between ClawTrack and OpenClaw \u2014 task management, channels, and agent orchestration",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    if (!config.clawtrackUrl || !config.webhookSecret) {
      api.logger.warn("clawtrack: missing clawtrackUrl or webhookSecret \u2014 plugin disabled");
      return;
    }
    if (!config.enabled) {
      api.logger.info("clawtrack: plugin disabled by config");
      return;
    }
    api.logger.info(`clawtrack plugin loaded (url=${config.clawtrackUrl}, channels=${config.channelsEnabled})`);
    function resolveAgentId() {
      const rawId = api.session?.agentId;
      if (!rawId) return "unknown";
      if (rawId.startsWith("agent-")) return rawId;
      return `agent-${rawId}`;
    }
    async function apiCall(endpoint, method = "GET", body) {
      const url = `${config.clawtrackUrl}/api/trpc/${endpoint}`;
      const options = {
        method,
        headers: { "Content-Type": "application/json" }
      };
      if (method === "POST" && body) {
        options.body = JSON.stringify(body);
      }
      const response = await fetch(url, options);
      if (!response.ok) {
        const error2 = await response.text();
        throw new Error(`ClawTrack API error: ${response.status} ${error2}`);
      }
      return response.json();
    }
    async function webhookCall(body) {
      const url = `${config.clawtrackUrl}/api/webhook/openclaw`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, secret: config.webhookSecret, agentId: resolveAgentId() })
      });
      if (!response.ok) {
        const error2 = await response.text();
        throw new Error(`ClawTrack webhook error: ${response.status} ${error2}`);
      }
      return response.json();
    }
    api.registerTool({
      name: "clawtrack_send_message",
      label: "Send message to ClawTrack task",
      description: "Send a message to a ClawTrack task. Use this to proactively update humans about your work on a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          message: { type: "string", description: "The message to send" }
        },
        required: ["taskId", "message"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await apiCall("comments.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(),
            content: args.message
          });
          return textResult("Message sent successfully.", { success: true, messageId: result.result?.messageId });
        } catch (error2) {
          return textResult(`Failed to send message: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_get_task",
      label: "Get ClawTrack task details",
      description: "Get details about a ClawTrack task including title, description, status, and recent messages.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" }
        },
        required: ["taskId"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await apiCall(`tasks.getById?input=${encodeURIComponent(JSON.stringify({ id: args.taskId }))}`);
          return textResult(JSON.stringify(result.result, null, 2), { success: true });
        } catch (error2) {
          return textResult(`Failed to get task: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_reply_to_task",
      label: "Reply to ClawTrack task",
      description: "Reply to a message from a human on a ClawTrack task. Always use this tool (not a regular chat response) when you receive a [CLAWTRACK] tagged message \u2014 otherwise your reply won't appear in the ClawTrack UI.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID to reply to" },
          message: { type: "string", description: "The reply message" }
        },
        required: ["taskId", "message"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await apiCall("comments.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId(),
            content: args.message
          });
          return textResult("Reply sent successfully.", { success: true, messageId: result.result?.messageId });
        } catch (error2) {
          return textResult(`Failed to reply: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_update_task_status",
      label: "Update ClawTrack task status",
      description: "Update the status of a ClawTrack task (e.g., mark as done when you complete work).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "The new status" }
        },
        required: ["taskId", "status"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await apiCall("tasks.webhook", "POST", {
            secret: config.webhookSecret,
            taskId: args.taskId,
            status: args.status,
            agentId: resolveAgentId()
          });
          return textResult(`Task status updated to ${args.status}.`, { success: true, task: result.result });
        } catch (error2) {
          return textResult(`Failed to update task: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_get_project_tasks",
      label: "Get ClawTrack project tasks",
      description: "List tasks in a ClawTrack project. Filter by status if needed.",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "The project key (e.g., CLAW)" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: filter by status" }
        },
        required: ["projectKey"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const input = { projectKey: args.projectKey, limit: 50 };
          if (args.status) input.status = args.status;
          const result = await apiCall(`tasks.list?input=${encodeURIComponent(JSON.stringify(input))}`);
          return textResult(JSON.stringify(result.result, null, 2), { success: true });
        } catch (error2) {
          return textResult(`Failed to list tasks: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_list_tasks",
      label: "List my ClawTrack tasks",
      description: "List tasks assigned to you (the calling agent) in ClawTrack. Optionally filter by status or project.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: filter by status" },
          projectKey: { type: "string", description: "Optional: filter by project key" },
          limit: { type: "number", description: "Maximum tasks to return (default: 50)" }
        }
      },
      execute: async (_toolCallId, args) => {
        try {
          const input = { assigneeId: resolveAgentId(), limit: args.limit || 50 };
          if (args.status) input.status = args.status;
          if (args.projectKey) input.projectKey = args.projectKey;
          const result = await apiCall(`tasks.list?input=${encodeURIComponent(JSON.stringify(input))}`);
          return textResult(JSON.stringify(result.result, null, 2), { success: true });
        } catch (error2) {
          return textResult(`Failed to list tasks: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_update_task",
      label: "Update ClawTrack task",
      description: "Update a ClawTrack task's status, description, and/or priority in a single call.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: new status" },
          description: { type: "string", description: "Optional: new description" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Optional: new priority" }
        },
        required: ["taskId"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const webhookBody = {
            secret: config.webhookSecret,
            taskId: args.taskId,
            agentId: resolveAgentId()
          };
          if (args.status) webhookBody.status = args.status;
          if (args.priority) webhookBody.priority = args.priority;
          const result = await apiCall("tasks.webhook", "POST", webhookBody);
          const updates = [];
          if (args.status) updates.push(`status \u2192 ${args.status}`);
          if (args.priority) updates.push(`priority \u2192 ${args.priority}`);
          return textResult(`Task updated: ${updates.join(", ") || "no changes"}.`, { success: true, task: result.result });
        } catch (error2) {
          return textResult(`Failed to update task: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_log_activity",
      label: "Log ClawTrack activity",
      description: "Log an activity entry in ClawTrack (e.g., tool_called, task_created, agent_message).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Optional: associated task ID" },
          type: { type: "string", description: "Activity type (e.g., tool_called, task_created, agent_message)" },
          description: { type: "string", description: "Human-readable description of the activity" }
        },
        required: ["type", "description"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await webhookCall({
            type: "activity",
            activityType: args.type,
            description: args.description,
            taskId: args.taskId
          });
          return textResult("Activity logged.", { success: true, activityId: result.activityId });
        } catch (error2) {
          return textResult(`Failed to log activity: ${error2}`, { success: false });
        }
      }
    });
    api.registerTool({
      name: "clawtrack_send_message_v2",
      label: "Send message to task (v2)",
      description: "Send a message to a ClawTrack task's chat thread via the unified REST endpoint. Use this when you want the message to also appear in channel-based messaging.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The ClawTrack task ID" },
          message: { type: "string", description: "The message to send" }
        },
        required: ["taskId", "message"]
      },
      execute: async (_toolCallId, args) => {
        try {
          const result = await webhookCall({
            type: "message",
            taskId: args.taskId,
            message: args.message
          });
          return textResult("Message sent.", { success: true, messageId: result.messageId });
        } catch (error2) {
          return textResult(`Failed to send message: ${error2}`, { success: false });
        }
      }
    });
    if (config.channelsEnabled) {
      api.registerTool({
        name: "clawtrack_list_channels",
        label: "List ClawTrack channels",
        description: "List accessible channels in ClawTrack. Filter by type or project.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["dm", "group", "project", "task"], description: "Optional: filter by channel type" },
            projectId: { type: "string", description: "Optional: filter by project ID" }
          }
        },
        execute: async (_toolCallId, args) => {
          try {
            const input = { limit: 50 };
            if (args.type) input.type = args.type;
            if (args.projectId) input.projectId = args.projectId;
            const result = await apiCall(`channels.list?input=${encodeURIComponent(JSON.stringify(input))}`);
            return textResult(JSON.stringify(result.result, null, 2), { success: true });
          } catch (error2) {
            return textResult(`Failed to list channels: ${error2}`, { success: false });
          }
        }
      });
      api.registerTool({
        name: "clawtrack_get_channel",
        label: "Get ClawTrack channel details",
        description: "Get details about a specific channel including recent messages.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "The channel ID" }
          },
          required: ["channelId"]
        },
        execute: async (_toolCallId, args) => {
          try {
            const [channelResult, messagesResult] = await Promise.all([
              apiCall(`channels.getById?input=${encodeURIComponent(JSON.stringify({ id: args.channelId }))}`),
              apiCall(`channelMessages.list?input=${encodeURIComponent(JSON.stringify({ channelId: args.channelId, limit: 20 }))}`)
            ]);
            return textResult(JSON.stringify({ channel: channelResult.result, recentMessages: messagesResult.result }, null, 2), { success: true });
          } catch (error2) {
            return textResult(`Failed to get channel: ${error2}`, { success: false });
          }
        }
      });
      api.registerTool({
        name: "clawtrack_send_channel_message",
        label: "Send ClawTrack channel message",
        description: "Send a message to a ClawTrack channel. Supports @mentions.",
        parameters: {
          type: "object",
          properties: {
            channelId: { type: "string", description: "The channel ID" },
            content: { type: "string", description: "The message to send. Use @name to mention agents." }
          },
          required: ["channelId", "content"]
        },
        execute: async (_toolCallId, args) => {
          try {
            const result = await apiCall("channelMessages.webhook", "POST", {
              secret: config.webhookSecret,
              channelId: args.channelId,
              agentId: resolveAgentId(),
              content: args.content
            });
            return textResult("Channel message sent.", { success: true, messageId: result.result?.messageId });
          } catch (error2) {
            return textResult(`Failed to send channel message: ${error2}`, { success: false });
          }
        }
      });
      api.registerTool({
        name: "clawtrack_create_dm",
        label: "Create ClawTrack DM channel",
        description: "Create or get a direct message channel with another agent or user.",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "The other agent's ID" }
          },
          required: ["agentId"]
        },
        execute: async (_toolCallId, args) => {
          try {
            const result = await apiCall("channels.getOrCreateDM", "POST", {
              participantAId: resolveAgentId(),
              participantBId: args.agentId,
              participantAType: "agent",
              participantBType: "agent"
            });
            return textResult("DM channel ready.", { success: true, channel: result.result });
          } catch (error2) {
            return textResult(`Failed to create DM: ${error2}`, { success: false });
          }
        }
      });
      api.registerTool({
        name: "clawtrack_search_messages",
        label: "Search ClawTrack messages",
        description: "Search for messages across channels in ClawTrack.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            channelId: { type: "string", description: "Optional: limit search to a specific channel" }
          },
          required: ["query"]
        },
        execute: async (_toolCallId, args) => {
          try {
            const input = { query: args.query, limit: 20 };
            if (args.channelId) input.channelId = args.channelId;
            const result = await apiCall(`channelMessages.search?input=${encodeURIComponent(JSON.stringify(input))}`);
            return textResult(JSON.stringify(result.result, null, 2), { success: true });
          } catch (error2) {
            return textResult(`Failed to search messages: ${error2}`, { success: false });
          }
        }
      });
      api.registerTool({
        name: "clawtrack_add_reaction",
        label: "Add ClawTrack message reaction",
        description: "React to a message with an emoji (e.g., thumbs up, celebrate).",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID" },
            emoji: { type: "string", description: "The emoji reaction (e.g., \u{1F44D}, \u{1F389}, \u{1F680})" }
          },
          required: ["messageId", "emoji"]
        },
        execute: async (_toolCallId, args) => {
          try {
            const result = await apiCall("channelMessages.addReaction", "POST", {
              messageId: args.messageId,
              emoji: args.emoji,
              agentId: resolveAgentId()
            });
            return textResult(`Reaction ${args.emoji} added.`, { success: true, reaction: result.result });
          } catch (error2) {
            return textResult(`Failed to add reaction: ${error2}`, { success: false });
          }
        }
      });
    }
    if (config.contextInjectionEnabled) {
      let isNoiseMessage = function(content) {
        const trimmed = content.trim();
        return NOISE_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length === 0;
      }, extractTextContent = function(raw) {
        if (!raw) return "";
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) {
          return raw.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        }
        return "";
      };
      const NOISE_PATTERNS = [
        /^NO_REPLY$/i,
        /^REPLY_SKIP$/i,
        /^ANNOUNCE_SKIP$/i,
        /^ANNOUNCE:$/i,
        /^Agent-to-agent announce step/i,
        /^\[A2A\]/i
      ];
      async function mirrorToClawTrack(sourceAgent, targetAgent, content) {
        const sourceAgentId = sourceAgent.startsWith("agent-") ? sourceAgent : `agent-${sourceAgent}`;
        const targetAgentId = targetAgent.startsWith("agent-") ? targetAgent : `agent-${targetAgent}`;
        try {
          const result = await apiCall("channelMessages.mirrorAgentMessage", "POST", {
            secret: config.webhookSecret,
            senderAgentId: sourceAgentId,
            receiverAgentId: targetAgentId,
            content
          });
          api.logger.info(`clawtrack: mirror API response: ${JSON.stringify(result)}`);
        } catch (err) {
          api.logger.error(`clawtrack: mirror API failed: ${err}`);
          throw err;
        }
      }
      const pendingInterSessionSource = /* @__PURE__ */ new Map();
      api.on("before_message_write", (event, ctx) => {
        const message = event.message;
        if (!message) return;
        const sessionId = api.session?.sessionKey ?? "";
        if (message.role === "user") {
          const provenance = message?.provenance;
          if (provenance?.kind !== "inter_session") return;
          let content = extractTextContent(message?.content);
          if (!content) return;
          content = content.replace(/^\[.*?\]\s*/, "");
          if (isNoiseMessage(content)) return;
          const sourceAgentName = provenance.sourceSessionKey?.split(":")[1];
          const targetAgentName = ctx?.agentId ?? api.session?.agentId;
          if (!sourceAgentName || !targetAgentName) return;
          if (sessionId) {
            pendingInterSessionSource.set(sessionId, sourceAgentName);
          }
          api.logger.info(`clawtrack: mirroring ${sourceAgentName} -> ${targetAgentName}: "${content.substring(0, 80)}"`);
          mirrorToClawTrack(sourceAgentName, targetAgentName, content).catch((err) => {
            api.logger.error(`clawtrack: failed to mirror message: ${err}`);
          });
        } else if (message.role === "assistant") {
          const rawContent = message?.content;
          const hasToolUse = Array.isArray(rawContent) && rawContent.some((b) => b.type === "tool_use");
          if (hasToolUse) return;
          let content = extractTextContent(rawContent);
          if (!content || isNoiseMessage(content)) return;
          const sourceAgentName = sessionId ? pendingInterSessionSource.get(sessionId) : void 0;
          if (!sourceAgentName) return;
          const targetAgentName = ctx?.agentId ?? api.session?.agentId;
          if (!targetAgentName) return;
          pendingInterSessionSource.delete(sessionId);
          api.logger.info(`clawtrack: mirroring response ${targetAgentName} -> ${sourceAgentName}: "${content.substring(0, 80)}"`);
          mirrorToClawTrack(targetAgentName, sourceAgentName, content).catch((err) => {
            api.logger.error(`clawtrack: failed to mirror response: ${err}`);
          });
        }
      });
    }
    const toolNames = [
      "clawtrack_send_message",
      "clawtrack_get_task",
      "clawtrack_reply_to_task",
      "clawtrack_update_task_status",
      "clawtrack_get_project_tasks",
      "clawtrack_list_tasks",
      "clawtrack_update_task",
      "clawtrack_log_activity",
      "clawtrack_send_message_v2"
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
  }
});
