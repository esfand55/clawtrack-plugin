<p align="center">
  <h1 align="center">ClawTrack Plugin for OpenClaw</h1>
  <p align="center">
    Bidirectional integration between <strong>ClawTrack</strong> and <strong>OpenClaw</strong> —<br/>
    Chat with AI agents directly in task tickets, and let agents respond from their sessions.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/openclaw-plugin-blue?style=flat-square" alt="OpenClaw Plugin">
  <img src="https://img.shields.io/badge/status-active-brightgreen?style=flat-square" alt="Status">
</p>

> **Killer Feature:** In-ticket agent chat — no other AI workforce management tool lets you chat with assigned agents directly under each task. ClawTrack does.

---

## Quick Start

```bash
# Clone or copy the plugin to your OpenClaw extensions folder
cp -r clawtrack ~/.openclaw/extensions/

# Install dependencies
cd ~/.openclaw/extensions/clawtrack && npm install

# Restart OpenClaw Gateway
openclaw gateway restart
```

**Prerequisites:**
- [OpenClaw](https://github.com/openclaw/openclaw) v0.20+ with Gateway running
- [ClawTrack](https://github.com/esfand55/clawtrack) instance (self-hosted or cloud)
- Agents configured in ClawTrack with matching `openclawId` values

---

## Configure

Add the plugin configuration to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": [
      {
        "id": "clawtrack",
        "enabled": true,
        "config": {
          "clawtrackUrl": "http://localhost:3000",
          "webhookSecret": "your-shared-secret-here"
        }
      }
    ]
  }
}
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `clawtrackUrl` | string | ✅ | Base URL of your ClawTrack instance |
| `webhookSecret` | string | ✅ | Shared secret for webhook authentication |
| `enabled` | boolean | ❌ | Enable/disable the plugin (default: `true`) |

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BIDIRECTIONAL FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐      HTTP API       ┌─────────────┐                        │
│  │  ClawTrack  │ ──────────────────► │   OpenClaw  │                        │
│  │   (Web UI)  │     sessions_send   │   Gateway   │                        │
│  └─────────────┘                     └──────┬──────┘                        │
│         │                                   │                               │
│         │                                   │ delivers to                   │
│         │                                   ▼                               │
│         │                            ┌─────────────┐                        │
│         │                            │    Agent    │                        │
│         │                            │   Session   │                        │
│         │                            └──────┬──────┘                        │
│         │                                   │                               │
│         │         webhook                   │                               │
│         ◄───────────────────────────────────┘                               │
│         │     comments.webhook              │                               │
│         │     (agent replies)               │                               │
│         ▼                                   ▼                               │
│  ┌─────────────┐                     ┌─────────────┐                        │
│  │   Message   │                     │   Message   │                        │
│  │  stored in  │                     │  delivered  │                        │
│  │  database   │                     │  to agent   │                        │
│  └─────────────┘                     └─────────────┘                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Flow Breakdown

1. **User sends message in ClawTrack** → Message stored in database → OpenClaw `sessions_send` API notifies assigned agent
2. **Agent responds in OpenClaw** → Plugin calls ClawTrack webhook → Message stored in database → Visible in task chat

---

## Tools Exposed

The plugin exposes three tools that agents can use:

### `clawtrack_send_message`

Send a message to a ClawTrack task. Use when you need to proactively communicate with humans about a task.

```typescript
// Parameters
{
  taskId: string,   // The ClawTrack task ID
  message: string   // The message content
}

// Returns
{
  success: boolean,
  messageId?: string,
  error?: string
}
```

### `clawtrack_reply_to_task`

Reply to a ClawTrack task. Use when responding to a message from a human in a task context.

```typescript
// Parameters
{
  taskId: string,   // The ClawTrack task ID
  message: string   // The reply message
}

// Returns
{
  success: boolean,
  messageId?: string,
  message?: string,
  error?: string
}
```

### `clawtrack_get_task`

Get details about a ClawTrack task including title, description, status, and recent messages.

```typescript
// Parameters
{
  taskId: string   // The ClawTrack task ID
}

// Returns
{
  success: boolean,
  task?: {
    id: string,
    title: string,
    description?: string,
    status: string,
    // ... other task fields
  },
  error?: string
}
```

---

## ClawTrack Setup

### 1. Environment Variables

Add these to your ClawTrack `.env.local`:

```bash
# OpenClaw Integration
WEBHOOK_SECRET="your-shared-secret-here"
OPENCLAW_GATEWAY_URL="http://127.0.0.1:18789"
OPENCLAW_GATEWAY_TOKEN="your-openclaw-gateway-token"
OPENCLAW_ENABLED="true"
```

### 2. Database Schema

Ensure your ClawTrack database has the required schema:

```prisma
model Agent {
  id          String   @id
  name        String
  emoji       String
  role        String
  openclawId  String?  // Maps to OpenClaw session key (e.g., "agent:john:main")
  status      AgentStatus @default(offline)
  // ...
}

model Message {
  id        String   @id @default(cuid())
  content   String
  role      MessageRole
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id])
  agentId   String?
  agent     Agent?   @relation(fields: [agentId], references: [id])
  createdAt DateTime @default(now())
  // ...
}

enum MessageRole {
  user
  agent
  system
}
```

### 3. Webhook Endpoint

ClawTrack must expose a webhook endpoint at `/api/trpc/comments.webhook`:

```typescript
// Expected request body
{
  secret: string,      // Must match WEBHOOK_SECRET
  taskId: string,      // Target task ID
  agentId: string,     // Agent ID in ClawTrack
  content: string      // Message content
}

// Success response
{
  success: true,
  messageId: "cmmx..."
}
```

---

## Agent Configuration

For agents to receive messages from ClawTrack, they need:

1. **Matching IDs**: The agent's ClawTrack `openclawId` must match their OpenClaw session key
2. **sessions_send access**: The `sessions_send` tool must be allowed in OpenClaw config

### Example Agent Setup

```json
// In openclaw.json
{
  "agents": {
    "entries": [
      {
        "id": "john",
        "identity": {
          "name": "John",
          "theme": "You are the Tech Lead..."
        },
        "tools": {
          "sessions_send": true  // Allow receiving messages from ClawTrack
        }
      }
    ]
  }
}
```

In ClawTrack, create an agent with:
- **ID**: `agent-john`
- **Name**: `John`
- **openclawId**: `agent:john:main`

---

## Troubleshooting

### Plugin not loading

```bash
# Check OpenClaw Gateway logs
openclaw gateway logs | grep clawtrack

# Verify plugin is installed
ls -la ~/.openclaw/extensions/clawtrack/
```

### Messages not reaching agents

1. **Check Gateway is running**: `openclaw gateway status`
2. **Verify sessions_send is allowed**: Check `openclaw.json` → `gateway.tools.denyList`
3. **Check agent session exists**: Use `sessions_list` tool to verify agent is active

### Webhook authentication failing

1. **Verify secrets match**: `WEBHOOK_SECRET` in ClawTrack `.env.local` must match `webhookSecret` in plugin config
2. **Restart ClawTrack** after changing environment variables

### Test the integration

```bash
# Test OpenClaw API
curl -X POST http://127.0.0.1:18789/tools/invoke \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "sessions_list", "args": {}}'

# Test ClawTrack webhook
curl -X POST http://localhost:3000/api/trpc/comments.webhook \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "your-webhook-secret",
    "taskId": "test-task-id",
    "agentId": "test-agent-id",
    "content": "Test message"
  }'
```

---

## Architecture

```
~/.openclaw/extensions/clawtrack/
├── openclaw.plugin.json    # Plugin manifest (id, name, config schema)
├── package.json            # npm dependencies
├── src/
│   └── index.ts            # Plugin implementation (tools, hooks)
└── README.md               # This file
```

---

## License

MIT

---

## Links

- [ClawTrack Repository](https://github.com/esfand55/clawtrack)
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [OpenClaw Discord](https://discord.com/invite/clawd)
