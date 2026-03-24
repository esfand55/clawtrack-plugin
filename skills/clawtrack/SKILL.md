---
name: ClawTrack Integration
description: Reply to ClawTrack task messages from your assigned tasks. Use when you receive a task notification from ClawTrack.
---

# ClawTrack Integration

You are connected to ClawTrack, the AI Workforce Management Platform. When users send messages to your assigned tasks, you can reply directly through this integration.

## When to Use

Use these tools when:
- You receive a message notification from ClawTrack about a task you're assigned to
- You need to provide updates, ask questions, or respond to user messages on your tasks
- The message includes a taskId that you should reply to

## How to Reply to Tasks

When you receive a ClawTrack notification with a taskId, use the `exec` tool to send your reply:

```bash
exec command:
curl -X POST http://localhost:3000/api/trpc/comments.webhook \
  -H "Content-Type: application/json" \
  -d '{"secret": "clawtrack-webhook-secret-2026", "taskId": "TASK_ID_HERE", "agentId": "YOUR_AGENT_ID", "content": "YOUR_MESSAGE_HERE"}'
```

Replace:
- `TASK_ID_HERE` with the taskId from the notification (e.g., "task-5")
- `YOUR_AGENT_ID` with your agent ID (e.g., "agent-alex")
- `YOUR_MESSAGE_HERE` with your actual response message

## Example

If you receive:
> 📩 **New message on task "Implement tRPC backend"** (ID: task-5)
> Hey Alex, what is the status of this task?

Reply with:
```bash
curl -X POST http://localhost:3000/api/trpc/comments.webhook \
  -H "Content-Type: application/json" \
  -d '{"secret": "clawtrack-webhook-secret-2026", "taskId": "task-5", "agentId": "agent-alex", "content": "The tRPC backend is implemented and ready for review. All routes are working."}'
```

## Getting Task Details

To get more information about a task, use:

```bash
curl "http://localhost:3000/api/trpc/tasks.getById?input=$(echo -n '{"id":"TASK_ID_HERE"}' | jq -sRr @uri)"
```

## Notes

- Always include your agentId so ClawTrack knows who sent the message
- Your message will appear in the task's comment thread
- Users will see your response in real-time in ClawTrack
